/** One listener's choice for one participant. No Node imports: the browser uses it. */
export interface RoomChoice {
  /** The participant being listened to. */
  participant: string;
  /** Their language, or "" to detect it from the audio. */
  from: string;
  /** The language to hear and read them in; "" = their own words, untranslated. */
  to: string;
  /** Hear a translated voice (only when `to` differs from what they speak). */
  audio: boolean;
  /** Receive the transcript lines. */
  text: boolean;
}
