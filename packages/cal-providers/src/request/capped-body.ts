/**
 * A body read under a ceiling, counted as the bytes arrive. A ceiling applied after a full read
 * would bound what is returned and not what is held.
 */

/** What a body is read from: a Node response, or anything that hands out chunks and can be ended. */
export interface BodyStream extends AsyncIterable<Uint8Array> {
  destroy(): unknown;
}

/**
 * The whole body, or `null` when it is longer than `max`: by its own Content-Length before a byte is
 * read, or by the count while it arrives. Either way the stream is ended at once. A stream that
 * fails while it is read throws what it failed with.
 */
export async function readCapped(stream: BodyStream, contentLength: string | null, max: number): Promise<Uint8Array | null> {
  const declared = contentLength === null ? Number.NaN : Number(contentLength);
  if (Number.isFinite(declared) && declared > max) {
    stream.destroy();
    return null;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > max) {
      stream.destroy();
      return null;
    }
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
