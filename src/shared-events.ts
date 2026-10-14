import type { Caption } from "./interpreter.ts";
/** What a shared or room feed sends down its event stream. `participant` names
 * whose speech a room line belongs to; channel feeds leave it out. */
export type SharedEvent =
  | { type: "status"; listeners: number }
  | { type: "line"; id: string; line: Caption; participant?: string; audio?: boolean }
  | { type: "audio"; id: string; data: string }
  | { type: "end"; id: string }
  | { type: "error"; error: string; retryable?: boolean; participant?: string };
