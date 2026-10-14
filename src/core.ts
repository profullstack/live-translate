/** @profullstack/live-translate/core: the parts with no Node or DOM imports,
 * safe for any bundle (errors, WAV, the interpreter, recovery rules, event shapes). */
export * from "./speech.ts";
export * from "./recovery.ts";
export * from "./interpreter.ts";
export type { SharedEvent } from "./shared-events.ts";
export type { RoomChoice } from "./room-choice.ts";
export type { TextTranslator, Queryable } from "./types.ts";
