/** The browser half of meeting translation (see ../room.ts).
 *
 * RoomFeeder taps the remote tracks this client already receives and uploads
 * 2-second PCM chunks only while the server says the participant is wanted and
 * this client holds the feeder lease; otherwise it probes every few seconds.
 * RoomListener holds one event stream carrying this listener's choices, plays
 * translated voices, and hands transcript lines to the page. */
import type { Caption } from "../interpreter.ts";
import type { RoomChoice } from "../room-choice.ts";
import { AudioCapture } from "./capture.ts";
import { LiveVoicePlayer } from "./player.ts";
import { SharedAudio } from "./shared-audio.ts";

export type { RoomChoice } from "../room-choice.ts";
const PROBE_MS = 5000;

function pcm16(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2), view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i] as number));
    view.setInt16(i * 2, value < 0 ? value * 32768 : value * 32767, true);
  }
  return bytes;
}

interface Fed { capture: AudioCapture; source: MediaStreamAudioSourceNode; feeder: boolean; wanted: boolean; probeAt: number; busy: boolean; }

export class RoomFeeder {
  private readonly fed = new Map<string, Fed>();
  readonly client = crypto.randomUUID();
  constructor(private readonly options: {
    /** POST target; the participant and client ids are added as query parameters. */
    path: string; context: () => AudioContext;
    fetcher?: typeof fetch; headers?: () => HeadersInit | Promise<HeadersInit>;
    /** A served copy of the tap (see TAP_SOURCE) for a CSP without blob: scripts. */
    workletUrl?: string; processor?: string; now?: () => number;
  }) {}

  has(participant: string): boolean { return this.fed.has(participant); }

  /** Start or replace the tap on one participant's audio track. */
  async add(participant: string, track: MediaStreamTrack): Promise<void> {
    this.remove(participant);
    const context = this.options.context();
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const fed: Fed = { capture: null as unknown as AudioCapture, source, feeder: false, wanted: true, probeAt: 0, busy: false };
    fed.capture = new AudioCapture(window => void this.chunk(participant, fed, window.samples.slice(-32_000)), { workletUrl: this.options.workletUrl, processor: this.options.processor });
    this.fed.set(participant, fed);
    await fed.capture.start(context, source, 2);
  }
  remove(participant: string): void {
    const fed = this.fed.get(participant);
    if (!fed) return;
    fed.capture.stop(); fed.source.disconnect(); this.fed.delete(participant);
  }
  stop(): void { for (const participant of [...this.fed.keys()]) this.remove(participant); }

  private async chunk(participant: string, fed: Fed, samples: Float32Array): Promise<void> {
    const now = this.options.now?.() ?? Date.now();
    if (fed.busy || (!(fed.feeder && fed.wanted) && now < fed.probeAt)) return;
    fed.busy = true;
    try {
      const url = `${this.options.path}${this.options.path.includes("?") ? "&" : "?"}participant=${encodeURIComponent(participant)}&client=${this.client}`;
      const response = await (this.options.fetcher ?? fetch)(url, {
        method: "POST", headers: { "content-type": "audio/pcm", ...await this.options.headers?.() }, body: new Blob([pcm16(samples).buffer as ArrayBuffer]),
        signal: AbortSignal.timeout(8000),
      });
      const answer = response.ok ? await response.json() as { feeder?: boolean; wanted?: boolean } : {};
      fed.feeder = answer.feeder === true; fed.wanted = answer.wanted === true;
    } catch { fed.feeder = false; }
    finally {
      fed.busy = false;
      if (!(fed.feeder && fed.wanted)) fed.probeAt = (this.options.now?.() ?? Date.now()) + PROBE_MS;
    }
  }
}

export interface RoomLine { participant: string; line: Caption; audio: boolean; }

export class RoomListener {
  private readonly shared: SharedAudio;
  private readonly player: LiveVoicePlayer;
  private choices: RoomChoice[] = [];
  private speaking: string | null = null;
  constructor(private readonly options: {
    /** POST target answering an event stream (see RoomTranslator.listen). */
    path: string;
    line: (line: RoomLine) => void;
    status?: (text: string) => void;
    /** One participant's translation stopped; the others continue. */
    failed?: (participant: string, error: string) => void;
    /** The whole stream stopped. */
    stopped?: (error: string) => void;
    volume?: () => number;
    /** Which participant's translated voice is playing, for ducking their original. */
    speaking?: (participant: string | null) => void;
    fetcher?: typeof fetch;
    audioContext?: () => AudioContext;
  }) {
    const voices = new Map<string, string>();
    this.shared = new SharedAudio({
      path: options.path, scheme: "room-translation", fetcher: options.fetcher,
      status: text => options.status?.(text),
      failed: error => { this.player.disable(); options.stopped?.(error); },
      error: event => {
        if (!event.participant) return false;
        this.choices = this.choices.filter(choice => choice.participant !== event.participant);
        options.failed?.(event.participant, event.error);
        return true;
      },
      line: (line, url, event) => {
        const participant = event.participant ?? "";
        if (line.text) options.line({ participant, line, audio: event.audio === true });
        if (event.audio) { voices.set(url, participant); this.player.push(line, url, 0); }
      },
    });
    this.player = new LiveVoicePlayer({
      active: () => undefined,
      status: text => options.status?.(text),
      playing: () => this.choices.some(choice => choice.audio),
      volume: () => options.volume?.() ?? 1,
      failed: () => options.speaking?.(null),
      audioContext: options.audioContext,
      fetcher: (async (url: string) => {
        const participant = voices.get(url) ?? null; voices.delete(url);
        if (participant !== this.speaking) { this.speaking = participant; options.speaking?.(participant); }
        return this.shared.audio(url);
      }) as typeof fetch,
    });
  }

  /** (Re)connect with this listener's choices; an empty list disconnects. */
  async set(choices: RoomChoice[]): Promise<void> {
    this.choices = choices;
    if (!choices.length) { this.stop(); return; }
    if (choices.some(choice => choice.audio)) await this.player.enable(); else this.player.disable();
    await this.shared.start("", "", { choices });
  }
  setVolume(): void { this.player.setVolume(); }
  stop(): void {
    this.shared.stop(); this.player.disable();
    if (this.speaking !== null) { this.speaking = null; this.options.speaking?.(null); }
  }
}
