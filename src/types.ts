/** What the server modules need from a database: node-postgres, Bun's pool or
 * anything with the same `query`. Postgres SQL (JSONB, ANY($1::text[])). */
export interface Queryable { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; }

/** Text translation is pluggable: a local model (nixamp's OPUS-MT), an LLM, or a
 * paid API. One call per batch of phrases, same order and length back. */
export interface TextTranslator {
  translate(texts: string[], from: string, to: string, options?: { by?: string; deadline?: number; signal?: AbortSignal }): Promise<{ texts: string[] }>;
}
