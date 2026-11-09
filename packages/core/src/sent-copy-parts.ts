/**
 * A SENT COPY KEPT WITHOUT ITS FILES. A delivered letter whose files are all uploads still held in
 * object storage can be owed to Sent as its skeleton: the composed copy with each file's encoded
 * body cut out, and where each one went. Spliced back from the same uploads it is the delivered copy,
 * byte for byte. The encoding is the composer's: base64 in lines of 76, CRLF between, the body
 * between its part's blank line and the next boundary. A file not found that way is no cut (`null`),
 * and the copy is not kept.
 */

/** Where a cut file's encoded body sat in the skeleton, and how long it was. */
export interface SentCopyFilePart { at: number; len: number }

/** A file's body as the composer encodes an attachment: base64, wrapped at 76 with CRLF. */
function encodedBody(content: Uint8Array): Buffer {
  const b64 = Buffer.from(content.buffer, content.byteOffset, content.byteLength).toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return Buffer.from(lines.join("\r\n"), "latin1");
}

const BODY_START = Buffer.from("\r\n\r\n", "latin1");
const BODY_END = Buffer.from("\r\n--", "latin1");

/** Cut each file's body out of `raw`, in order; `null` when one is not found as a part's whole body. */
export function cutFileParts(
  raw: Buffer, contents: readonly Uint8Array[],
): { skeleton: Buffer; parts: SentCopyFilePart[] } | null {
  const pieces: Buffer[] = [];
  const parts: SentCopyFilePart[] = [];
  let from = 0;
  let kept = 0;
  for (const content of contents) {
    const body = encodedBody(content);
    const at = raw.indexOf(Buffer.concat([BODY_START, body, BODY_END]), from);
    if (at < 0) return null;
    const start = at + BODY_START.length;
    pieces.push(raw.subarray(from, start));
    kept += start - from;
    parts.push({ at: kept, len: body.length });
    from = start + body.length;
  }
  pieces.push(raw.subarray(from));
  return { skeleton: Buffer.concat(pieces), parts };
}

/** The copy again, each file's body back where it was cut; `null` when a file is not the one cut. */
export function spliceFileParts(
  skeleton: Buffer, parts: readonly SentCopyFilePart[], contents: readonly Uint8Array[],
): Buffer | null {
  if (parts.length !== contents.length) return null;
  const out: Buffer[] = [];
  let from = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    const body = encodedBody(contents[i]!);
    if (body.length !== part.len || part.at < from || part.at > skeleton.length) return null;
    out.push(skeleton.subarray(from, part.at), body);
    from = part.at;
  }
  out.push(skeleton.subarray(from));
  return Buffer.concat(out);
}
