/** Live translation for a meeting: every participant may hear every other
 * participant translated, each into a language of their own choosing.
 *
 * Work is shared, never repeated per listener:
 * - one hearing per (participant, from): the speaker's clean track is heard once
 *   per source-language choice ("" = detect), by the same overlapping-window
 *   Interpreter nixamp uses;
 * - one target per (participant, from, to): each phrase is translated once and
 *   voiced once, then fanned out to everyone who chose it.
 * A listener whose language is the speaker's own hears the original track and
 * receives the original words as text only.
 *
 * Audio arrives from the room's clients, not from a server-side media
 * subscriber: any client that already receives a participant's track may feed
 * it, and one feeder per participant is elected by lease so the others back
 * off. Everything is billed to one payer (the host) through `TranslationMeter`. */
import { randomUUID } from "node:crypto";
import { Interpreter, type Caption } from "./interpreter.ts";
import { LIVE_VOICE_LANGUAGES, type LiveVoice } from "./live-voice.ts";
import type { TranslationMeter, TranslationUsage } from "./passes.ts";
import { transientAudioError } from "./recovery.ts";
import type { SharedEvent } from "./shared-events.ts";
import { SpeechError } from "./speech.ts";
import type { TextTranslator } from "./types.ts";
import type { RoomChoice } from "./room-choice.ts";
export type { RoomChoice } from "./room-choice.ts";

export interface RoomListener { id: string; choices: RoomChoice[]; send: (event: SharedEvent) => void; close: () => void; }

const CODE = /^[a-z]{2,3}$/;
const ID = /^[\w.:@-]{1,128}$/;
const CHUNK = 64_000; // 2 s of s16le mono at 16 kHz
const LEASE_MS = 6000;

export function validChoices(raw: unknown, self = ""): RoomChoice[] {
  if (!Array.isArray(raw) || raw.length > 32) throw new SpeechError("Choose up to 32 participants to translate.", 400);
  const seen = new Set<string>();
  const choices: RoomChoice[] = [];
  for (const item of raw) {
    const one = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const participant = String(one["participant"] ?? ""), from = String(one["from"] ?? ""), to = String(one["to"] ?? "");
    if (!ID.test(participant) || (from && !CODE.test(from)) || (to && !CODE.test(to))) throw new SpeechError("Invalid translation choice.", 400);
    if (participant === self || seen.has(participant)) continue;
    const audio = one["audio"] === true && to !== "" && LIVE_VOICE_LANGUAGES.has(to), text = one["text"] === true;
    if (!audio && !text) continue;
    seen.add(participant);
    choices.push({ participant, from, to, audio, text });
  }
  return choices;
}

interface Target { to: string; queue: Caption[]; busy: boolean; failures: number; }
interface Hearing {
  key: string; participant: string; from: string;
  interpreter: Interpreter; controller: AbortController;
  previous: Buffer; pending: Buffer; until: number;
  targets: Map<string, Target>;
}

export class RoomTranslator {
  private readonly listeners = new Set<RoomListener>();
  private readonly hearings = new Map<string, Hearing>();
  private readonly leases = new Map<string, { client: string; seen: number }>();
  private readonly meter: TranslationMeter | undefined;
  private readonly now: () => number;
  constructor(private readonly options: {
    room: string; payer: string; voice: LiveVoice; translator: TextTranslator;
    billing?: TranslationMeter; now?: () => number; onEmpty?: () => void;
  }) {
    this.now = options.now ?? Date.now;
    const billing = options.billing, payer = options.payer, room = options.room;
    // Every charge in a room lands on its payer, whoever spoke or listened.
    this.meter = billing && {
      require: () => billing.require(payer, room),
      reserve: (_by: string, kind: TranslationUsage, units: number) => billing.reserve(payer, kind, units, room),
      commit: id => billing.commit(id),
      refund: id => billing.refund(id),
    };
  }
  get size(): number { return this.listeners.size; }
  get room(): string { return this.options.room; }

  /** Whether anyone wants this participant translated or transcribed. */
  wanted(participant: string): boolean {
    for (const listener of this.listeners) if (listener.choices.some(choice => choice.participant === participant)) return true;
    return false;
  }

  async listen(listener: RoomListener): Promise<() => void> {
    if (!this.options.voice.available()) throw new SpeechError("Translated audio is unavailable.", 503);
    if (this.listeners.size >= 64) throw new SpeechError("This meeting has too many translation listeners.", 429);
    await this.options.billing?.begin?.(this.options.payer, this.options.room);
    this.listeners.add(listener);
    this.sync();
    this.status();
    return () => this.leave(listener);
  }
  private leave(listener: RoomListener): void {
    if (!this.listeners.delete(listener)) return;
    this.sync(); this.status();
    if (!this.listeners.size) this.options.onEmpty?.();
  }
  close(): void {
    for (const listener of [...this.listeners]) { this.leave(listener); listener.close(); }
  }
  private status(): void { this.broadcast(() => true, { type: "status", listeners: this.listeners.size }); }

  /** Accept a 2-second chunk of one participant's track from one client.
   * Answers whether that client holds the feeder lease and whether anyone is
   * listening, so a client that is not needed stops uploading. */
  feed(participant: string, client: string, pcm: Uint8Array): { feeder: boolean; wanted: boolean } {
    if (!ID.test(participant) || !ID.test(client)) throw new SpeechError("Invalid audio feed.", 400);
    if (!this.wanted(participant)) { this.leases.delete(participant); return { feeder: false, wanted: false }; }
    const now = this.now(), lease = this.leases.get(participant);
    if (lease && lease.client !== client && now - lease.seen < LEASE_MS) return { feeder: false, wanted: true };
    this.leases.set(participant, { client, seen: now });
    if (pcm.length % 2 || pcm.length > CHUNK * 2) throw new SpeechError("Send up to 4 seconds of 16 kHz mono PCM.", 400);
    const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (const hearing of this.hearings.values()) if (hearing.participant === participant) this.push(hearing, bytes);
    return { feeder: true, wanted: true };
  }

  /** Start and stop pipelines to match what listeners currently choose. */
  private sync(): void {
    const wantedHearings = new Map<string, Set<string>>();
    for (const listener of this.listeners) for (const choice of listener.choices) {
      const key = `${choice.participant}|${choice.from}`;
      const targets = wantedHearings.get(key) ?? new Set<string>();
      if (choice.to) targets.add(choice.to);
      wantedHearings.set(key, targets);
    }
    for (const [key, hearing] of this.hearings) if (!wantedHearings.has(key)) this.drop(hearing);
    for (const [key, targets] of wantedHearings) {
      const hearing = this.hearings.get(key) ?? this.make(key);
      for (const to of [...hearing.targets.keys()]) if (!targets.has(to)) hearing.targets.delete(to);
      for (const to of targets) if (!hearing.targets.has(to)) hearing.targets.set(to, { to, queue: [], busy: false, failures: 0 });
    }
  }
  private drop(hearing: Hearing): void {
    hearing.controller.abort(); hearing.interpreter.reset(); hearing.targets.clear();
    this.hearings.delete(hearing.key);
  }
  private make(key: string): Hearing {
    const [participant = "", from = ""] = key.split("|");
    const controller = new AbortController();
    const by = `${this.options.room}:${participant}`;
    const hearing = { key, participant, from, controller, previous: Buffer.alloc(0), pending: Buffer.alloc(0), until: this.now(), targets: new Map() } as unknown as Hearing;
    hearing.interpreter = new Interpreter({
      // No target: the Interpreter only hears and phrases; targets translate.
      language: () => "", speakers: () => true, voices: () => [], channel: () => this.options.room,
      sourceLanguage: () => from,
      status: () => undefined,
      failed: message => this.fail(hearing, message),
      lines: lines => this.heard(hearing, lines),
      hear: async (wav, { language, signal }) => this.options.voice.hear(wav, by, AbortSignal.any([signal, controller.signal]), this.meter, this.options.room, language),
    });
    this.hearings.set(key, hearing);
    return hearing;
  }
  private push(hearing: Hearing, bytes: Buffer): void {
    if (hearing.controller.signal.aborted) return;
    hearing.pending = Buffer.concat([hearing.pending, bytes]);
    while (hearing.pending.length >= CHUNK) {
      const fresh = hearing.pending.subarray(0, CHUNK); hearing.pending = hearing.pending.subarray(CHUNK);
      const pcm = Buffer.concat([hearing.previous, fresh]); hearing.previous = pcm.subarray(-2 * CHUNK);
      hearing.until += 2000;
      if (Math.abs(this.now() - hearing.until) > 2000) hearing.until = this.now();
      const samples = new Float32Array(pcm.length / 2);
      for (let index = 0; index < samples.length; index++) samples[index] = pcm.readInt16LE(index * 2) / 32768;
      hearing.interpreter.push({ samples, at: hearing.until - samples.length / 16, until: hearing.until, freshAt: hearing.until - 2000 });
    }
  }

  private choosers(hearing: Hearing, test: (choice: RoomChoice) => boolean): Map<RoomListener, RoomChoice> {
    const found = new Map<RoomListener, RoomChoice>();
    for (const listener of this.listeners) {
      const choice = listener.choices.find(one => one.participant === hearing.participant && one.from === hearing.from);
      if (choice && test(choice)) found.set(listener, choice);
    }
    return found;
  }
  private heard(hearing: Hearing, lines: Caption[]): void {
    for (const line of lines) {
      const spoken = line.language ?? "";
      // The speaker's own language (or no translation asked): original words, original voice.
      const original = this.choosers(hearing, choice => choice.text && (!choice.to || choice.to === spoken));
      const id = randomUUID();
      for (const listener of original.keys()) this.send(listener, { type: "line", id, line, participant: hearing.participant, audio: false });
      for (const target of hearing.targets.values()) {
        if (target.to === spoken) continue;
        target.queue.push(line);
        target.queue = target.queue.filter(one => this.now() - one.until <= 12_000).slice(-24);
        if (!target.busy) void this.speak(hearing, target);
      }
    }
  }
  private async speak(hearing: Hearing, target: Target): Promise<void> {
    target.busy = true;
    const signal = hearing.controller.signal;
    try {
      while (target.queue.length && !signal.aborted && hearing.targets.get(target.to) === target) {
        const line = target.queue.shift()!;
        if (this.now() - line.until > 12_000 || !line.language) continue;
        try {
          const done = await this.options.translator.translate([line.text], line.language, target.to, { by: `${this.options.room}:${hearing.participant}`, deadline: this.now() + 10_000, signal });
          const text = done.texts[0]?.trim();
          if (!text) continue;
          const translated: Caption = { ...line, original: line.text, sourceLanguage: line.language, language: target.to, text };
          const wants = (choice: RoomChoice): boolean => choice.to === target.to;
          const readers = this.choosers(hearing, choice => wants(choice) && choice.text && !choice.audio);
          const hearers = this.choosers(hearing, choice => wants(choice) && choice.audio);
          if (readers.size) {
            const id = randomUUID();
            for (const listener of readers.keys()) this.send(listener, { type: "line", id, line: translated, participant: hearing.participant, audio: false });
          }
          if (hearers.size) await this.voice(hearing, translated, hearers);
          target.failures = 0;
        } catch (error) {
          if (signal.aborted) return;
          if (!transientAudioError(error) || ++target.failures >= 3) throw error;
        }
      }
    } catch (error) {
      if (!signal.aborted) this.fail(hearing, error instanceof SpeechError ? error.message : "Translated audio was interrupted.", target.to);
    } finally { target.busy = false; }
  }
  private async voice(hearing: Hearing, line: Caption, hearers: Map<RoomListener, RoomChoice>): Promise<void> {
    const response = await this.options.voice.stream({ text: line.text, language: line.language!, channel: this.options.room, speaker: hearing.participant },
      `${this.options.room}:${hearing.participant}`, hearing.controller.signal, this.meter);
    const id = randomUUID();
    for (const [listener, choice] of hearers) this.send(listener, { type: "line", id, line: choice.text ? line : { ...line, text: "" }, participant: hearing.participant, audio: true });
    const reader = response.body!.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        for (let at = 0; at < value.length; at += 16_384) {
          const data = Buffer.from(value.subarray(at, at + 16_384)).toString("base64");
          for (const listener of hearers.keys()) this.send(listener, { type: "audio", id, data });
        }
      }
    } finally { reader.releaseLock(); for (const listener of hearers.keys()) this.send(listener, { type: "end", id }); }
  }

  /** A pipeline failure ends that participant's translation, not the room. */
  private fail(hearing: Hearing, error: string, to?: string): void {
    const affected = this.choosers(hearing, choice => to === undefined || choice.to === to);
    for (const listener of affected.keys()) {
      this.send(listener, { type: "error", error, participant: hearing.participant });
      listener.choices = listener.choices.filter(choice => choice.participant !== hearing.participant);
    }
    this.sync();
  }
  private send(listener: RoomListener, event: SharedEvent): void {
    try { listener.send(event); } catch { this.leave(listener); listener.close(); }
  }
  private broadcast(test: (listener: RoomListener) => boolean, event: SharedEvent): void {
    for (const listener of [...this.listeners]) if (test(listener)) this.send(listener, event);
  }
}

/** One RoomTranslator per meeting in this process, dropped when its last listener leaves. */
export class RoomTranslators {
  private readonly rooms = new Map<string, RoomTranslator>();
  constructor(private readonly options: { voice: LiveVoice; translator: TextTranslator; billing?: TranslationMeter; now?: () => number; maxRooms?: number }) {}
  get(room: string): RoomTranslator | undefined { return this.rooms.get(room); }
  open(room: string, payer: string): RoomTranslator {
    const found = this.rooms.get(room);
    if (found) return found;
    if (this.rooms.size >= (this.options.maxRooms ?? 50)) throw new SpeechError("Live translation is busy. Try again shortly.", 429);
    const made = new RoomTranslator({ ...this.options, room, payer, onEmpty: () => { if (this.rooms.get(room) === made) this.rooms.delete(room); } });
    this.rooms.set(room, made);
    return made;
  }
}
