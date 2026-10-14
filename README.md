# @profullstack/live-translate

Live speech translation for streams and meetings. A listener picks a language and hears the speaker
translated and re-voiced a few seconds behind, with an optional transcript. Extracted from
[nixamp](https://nixamp.com)'s paid "translated audio" and reused by [PairUX](https://pairux.com)
meetings, where every participant can hear every other participant in a language of their own.

- **Hear:** ElevenLabs Scribe v2 (word timestamps, speaker labels, language detection or a named language).
- **Translate:** pluggable `TextTranslator` (`translate(texts, from, to)`): a local model, an LLM, an API.
  Pairs are translated directly (French to German never goes through English unless your translator needs to).
- **Speak:** ElevenLabs Flash v2.5, streamed as 16 kHz PCM.
- **Sell:** prepaid CoinPay passes (Day $1, Month $5 by default) metered at 5x provider cost, plus a free
  daily allowance (10 sessions/account/day), on any Postgres `Queryable`.

The ElevenLabs key never leaves the server. Browsers get short grants or an event stream.

## Entry points

| Import | Runs in | What |
|---|---|---|
| `@profullstack/live-translate` | Node / Bun | `LiveVoice`, `Interpreter`, `TranslationPasses`, `UpgradeAllowances`, `SharedTranslations` (one source, many listeners), `RoomTranslator(s)` (meetings) |
| `@profullstack/live-translate/browser` | browser | `AudioCapture`, `LiveVoicePlayer`, `SharedAudio`, `RoomFeeder`, `RoomListener` |
| `@profullstack/live-translate/core` | anywhere | `SpeechError`, WAV helpers, the `Interpreter`, recovery rules, event types |

## Meetings: everyone in their own language

```ts
// server
import { LiveVoice, RoomTranslators, validChoices } from "@profullstack/live-translate";
const rooms = new RoomTranslators({ voice: new LiveVoice({ limits: { serverAudioPerMinute: 6000 } }), translator, billing });

// POST /listen (event stream): this listener's per-participant choices
const room = rooms.open(meetingId, hostAccountId);           // everything is billed to the payer
const leave = await room.listen({ id, choices: validChoices(body.choices, me), send, close });

// POST /feed?participant=&client= (2 s of 16 kHz s16le)
return room.feed(participant, client, pcm);                  // { feeder, wanted }
```

```ts
// browser
import { RoomFeeder, RoomListener } from "@profullstack/live-translate/browser";
const feeder = new RoomFeeder({ path: "/api/…/feed", context: () => audioContext });
feeder.add(participantId, remoteAudioTrack);                 // uploads only while wanted and elected

const listener = new RoomListener({ path: "/api/…/listen", line: ({ participant, line }) => show(participant, line.text),
  speaking: who => duck(who) });
await listener.set([{ participant: "pierre", from: "", to: "en", audio: true, text: true },
                    { participant: "hans",   from: "de", to: "en", audio: false, text: true }]);
```

Each participant's track is heard once per source-language choice, each phrase translated and voiced once per
target language, then fanned out. A listener who already speaks the speaker's language gets the original
words as text and keeps the original voice. One client per participant uploads that participant's audio
(a lease, re-elected when it goes quiet), so the speaker's own client needs nothing.

## Streams: one source, many listeners

`SharedTranslations.join(source, language, by, send, close)` runs one pipeline per (source, language) and
bills every listening account; `parse` narrows which sources are accepted. See nixamp's `/api/v1/speech/shared`.

## Limits

`new LiveVoice({ limits })` sets provider-protection budgets (concurrent hearings/voices, Scribe seconds and Flash
characters per minute per caller and per server). A listened-to meeting speaker costs about 180 s of Scribe a minute
(2 s steps over a 6 s window).

## License

MIT
