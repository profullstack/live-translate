/** Errors and WAV helpers shared by every server module. No Node built-ins: the browser half imports encodeWav too. */
export { encodeWav } from "./pcm-wav.ts";

export class SpeechError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface Wav {
  rate: number;
  channels: number;
  /** Mixed down to one channel, in [-1, 1]. */
  samples: Float32Array;
}

/** Whether these bytes are a RIFF/WAVE file, whatever the request called them. */
export function isWav(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const ascii = (at: number, length: number): string => String.fromCharCode(...bytes.subarray(at, at + length));
  return ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE";
}

export function decodeWav(bytes: Uint8Array): Wav {
  if (!isWav(bytes)) throw new SpeechError("send a WAV file", 415);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 12;
  let format = 0;
  let channels = 0;
  let rate = 0;
  let bits = 0;
  let dataAt = -1;
  let dataLength = 0;
  while (at + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(at, at + 4));
    const length = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt " && length >= 16) {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      rate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      // Extensible: the real format is the first two bytes of the sub-format GUID.
      if (format === 0xfffe && length >= 26) format = view.getUint16(body + 24, true);
    } else if (id === "data") {
      dataAt = body;
      // A streamed WAV says 0 or 0xFFFFFFFF for a length it did not know yet.
      dataLength = length === 0 || body + length > bytes.length ? bytes.length - body : length;
      break;
    }
    at = body + length + (length & 1);
  }
  if (dataAt < 0 || channels < 1 || rate < 8000 || rate > 192_000) throw new SpeechError("that WAV has no sound in it", 415);
  const pcm = format === 1 && (bits === 8 || bits === 16 || bits === 24 || bits === 32);
  const float = format === 3 && bits === 32;
  if (!pcm && !float) throw new SpeechError(`WAV format ${format} at ${bits} bits is not one this reads: send 16-bit PCM`, 415);
  const width = bits / 8;
  const frames = Math.floor(dataLength / (width * channels));
  const samples = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) {
      const offset = dataAt + (frame * channels + channel) * width;
      if (float) sum += view.getFloat32(offset, true);
      else if (bits === 8) sum += (bytes[offset] as number) / 128 - 1;
      else if (bits === 16) sum += view.getInt16(offset, true) / 32768;
      else if (bits === 24) sum += (((bytes[offset + 2] as number) << 24) | ((bytes[offset + 1] as number) << 16) | ((bytes[offset] as number) << 8)) / 2147483648;
      else sum += view.getInt32(offset, true) / 2147483648;
    }
    samples[frame] = sum / channels;
  }
  return { rate, channels, samples };
}

/** Reject decoding loops, without removing normal emphasis like “no, no, no”. */
export function reliableText(text: string, seconds: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length > Math.max(120, seconds * 55)) return "";
  const words = clean.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  for (let size = 1; size <= Math.min(20, Math.floor(words.length / 4)); size++) {
    for (let start = 0; start + size * 4 <= words.length; start++) {
      let repeated = true;
      for (let i = size; i < size * 4; i++) {
        if (words[start + i] !== words[start + i % size]) { repeated = false; break; }
      }
      if (repeated) return "";
    }
  }
  return clean;
}

export function quietSamples(pcm: Float32Array): boolean {
  let energy = 0;
  for (const sample of pcm) energy += sample * sample;
  return pcm.length === 0 || Math.sqrt(energy / pcm.length) < 0.004;
}
