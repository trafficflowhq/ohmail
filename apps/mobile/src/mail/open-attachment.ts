/**
 * The tile press's PURE half: the cache filename an attachment's bytes are written under.
 * The native half (`open-attachment-native.ts`) writes the file and raises the share sheet;
 * this half is what the suite drives. A filename out of a mail message is sender-authored
 * text: path separators, control bytes and a leading dot are stripped so the write can only
 * ever land inside the cache directory, and the engine's nameless-part fallback has already
 * guaranteed the name is non-empty upstream — the fallback here is for this rule's own strip.
 */

export function shareFilename(filename: string): string {
  const cleaned = filename
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  const bounded = cleaned.length > 128 ? cleaned.slice(-128) : cleaned;
  return bounded === "" ? "attachment" : bounded;
}
