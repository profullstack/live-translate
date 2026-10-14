import { test } from "node:test";
import assert from "node:assert/strict";
import { RoomTranslator, RoomTranslators, validChoices } from "../src/room.ts";
import type { LiveVoice } from "../src/live-voice.ts";
import type { SharedEvent } from "../src/shared-events.ts";
import type { TranslationMeter } from "../src/passes.ts";

const settle = (ms = 30): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const chunk = (): Uint8Array => { const bytes = new Uint8Array(64_000); for (let i = 0; i < bytes.length; i += 2) bytes[i + 1] = (i / 2) % 50; return bytes; };

function fakes(spoken = "fr", words = ["Bonjour", "tout", "le", "monde."]) {
  const heard: { by: string; language: string }[] = [], voiced: { text: string; language: string; by: string }[] = [], charged: string[] = [];
  const voice = {
    available: () => true,
    hear: async (_wav: Uint8Array, by: string, _signal?: AbortSignal, meter?: TranslationMeter, _room = "", language = "") => {
      heard.push({ by, language });
      await meter?.require(by);
      const id = await meter?.reserve(by, "transcription", 32_000);
      if (id) await meter!.commit(id);
      return { language: spoken, seconds: 2, turns: [{ start: 0.1, end: 1.5, text: words.join(" "), speaker: "s0", profile: "unknown" as const,
        words: words.map((text, i) => ({ text, start: 0.1 + i * 0.3, end: 0.35 + i * 0.3 })) }] };
    },
    stream: async (ask: { text: string; language: string }, by: string, _signal?: AbortSignal, meter?: TranslationMeter) => {
      voiced.push({ text: ask.text, language: ask.language, by });
      const id = await meter?.reserve(by, "voice", ask.text.length);
      if (id) await meter!.commit(id);
      return new Response(new Uint8Array(3200));
    },
  } as unknown as LiveVoice;
  const translator = { translate: async (texts: string[], from: string, to: string) => ({ texts: texts.map(text => `[${from}>${to}] ${text}`) }) };
  const billing: TranslationMeter = {
    require: async () => undefined,
    reserve: async by => { charged.push(by); return `r${charged.length}`; },
    commit: async () => undefined, refund: async () => undefined,
  };
  return { voice, translator, billing, heard, voiced, charged };
}
function listener(id: string, choices: ReturnType<typeof validChoices>) {
  const events: SharedEvent[] = [];
  return { id, choices, events, send: (event: SharedEvent) => { events.push(event); }, close: () => undefined };
}

test("each listener gets their own language; work is shared per target", async () => {
  const f = fakes();
  const room = new RoomTranslator({ room: "meet-1", payer: "host", voice: f.voice, translator: f.translator, billing: f.billing });
  const english = listener("a", validChoices([{ participant: "pierre", from: "", to: "en", audio: true, text: true }]));
  const english2 = listener("a2", validChoices([{ participant: "pierre", from: "", to: "en", audio: true, text: false }]));
  const vietnamese = listener("b", validChoices([{ participant: "pierre", from: "", to: "vi", audio: false, text: true }]));
  const french = listener("c", validChoices([{ participant: "pierre", from: "", to: "fr", audio: true, text: true }]));
  for (const one of [english, english2, vietnamese, french]) await room.listen(one);
  assert.deepEqual(room.feed("pierre", "client-1", chunk()), { feeder: true, wanted: true });
  await settle(80);

  assert.equal(f.heard.length, 1, "heard once for four listeners");
  assert.equal(f.voiced.length, 1, "voiced once for two English listeners; Vietnamese is text-only; French hears the original");
  assert.deepEqual(f.voiced[0], { text: "[fr>en] Bonjour tout le monde.", language: "en", by: "meet-1:pierre" });

  const lines = (events: SharedEvent[]) => events.filter(event => event.type === "line") as Extract<SharedEvent, { type: "line" }>[];
  assert.equal(lines(english.events)[0]!.line.text, "[fr>en] Bonjour tout le monde.");
  assert.equal(lines(english.events)[0]!.audio, true);
  assert.equal(lines(english.events)[0]!.participant, "pierre");
  assert.equal(lines(english2.events)[0]!.line.text, "", "audio-only listener gets no words");
  assert.ok(english.events.some(event => event.type === "audio") && english.events.some(event => event.type === "end"));
  assert.equal(lines(vietnamese.events)[0]!.line.text, "[fr>vi] Bonjour tout le monde.");
  assert.equal(lines(vietnamese.events)[0]!.audio, false);
  assert.ok(!vietnamese.events.some(event => event.type === "audio"));
  assert.equal(lines(french.events)[0]!.line.text, "Bonjour tout le monde.", "same language: original words");
  assert.ok(!french.events.some(event => event.type === "audio"), "same language: original voice, nothing synthesized");
  assert.ok(f.charged.length >= 2 && f.charged.every(by => by === "host"), "every charge lands on the payer");
});

test("a named source language is passed to the ear", async () => {
  const f = fakes("de", ["Guten", "Tag."]);
  const room = new RoomTranslator({ room: "meet-2", payer: "host", voice: f.voice, translator: f.translator });
  await room.listen(listener("a", validChoices([{ participant: "hans", from: "de", to: "fr", audio: false, text: true }])));
  room.feed("hans", "c1", chunk());
  await settle();
  assert.equal(f.heard[0]!.language, "de");
});

test("one feeder per participant; others back off until the lease lapses", async () => {
  let now = 1_000_000;
  const f = fakes();
  const room = new RoomTranslator({ room: "meet-3", payer: "host", voice: f.voice, translator: f.translator, now: () => now });
  assert.deepEqual(room.feed("pierre", "c1", chunk()), { feeder: false, wanted: false }, "nobody listening yet");
  await room.listen(listener("a", validChoices([{ participant: "pierre", from: "", to: "en", audio: false, text: true }])));
  assert.equal(room.feed("pierre", "c1", new Uint8Array(0)).feeder, true);
  assert.equal(room.feed("pierre", "c2", new Uint8Array(0)).feeder, false);
  now += 7000;
  assert.equal(room.feed("pierre", "c2", new Uint8Array(0)).feeder, true, "c1 went quiet, c2 takes over");
  assert.equal(room.feed("pierre", "c1", new Uint8Array(0)).feeder, false);
});

test("leaving stops the pipeline and empties the room", async () => {
  const f = fakes();
  let emptied = false;
  const rooms = new RoomTranslators({ voice: f.voice, translator: f.translator });
  const room = rooms.open("meet-4", "host");
  assert.equal(rooms.open("meet-4", "someone-else"), room, "one translator per meeting");
  const leave = await room.listen(listener("a", validChoices([{ participant: "pierre", from: "", to: "en", audio: true, text: true }])));
  assert.equal(room.wanted("pierre"), true);
  leave();
  assert.equal(room.wanted("pierre"), false);
  assert.equal(rooms.get("meet-4"), undefined);
  void emptied;
});

test("choices are validated and nobody translates themselves", () => {
  assert.deepEqual(validChoices([
    { participant: "me", from: "", to: "en", audio: true, text: true },
    { participant: "x", from: "", to: "en", audio: false, text: false },
    { participant: "y", from: "fr", to: "xx-bad", audio: true, text: true },
  ].slice(0, 2), "me"), []);
  assert.throws(() => validChoices([{ participant: "y", from: "fr", to: "EN!", audio: true, text: true }]));
  assert.deepEqual(validChoices([{ participant: "y", from: "", to: "", audio: true, text: true }]), [{ participant: "y", from: "", to: "", audio: false, text: true }], "no voice without a target");
});
