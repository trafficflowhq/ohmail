import { createHash } from "node:crypto";
import type { AttachmentMeta, MimeStructure } from "./types.js";

/**
 * THE SERVER'S SECTION FOR EACH ATTACHMENT, derived from the server's own tree.
 *
 * `attachments.part_id` is a cache of the mailbox's section numbering: it is written only to a
 * section whose decoded bytes were in hand and sha256-equal to the row's `content_sha256`. The
 * numbers come from the server's BODYSTRUCTURE by RFC 3501 §6.4.5 ({@link enumerateSections});
 * the raw source is only CUT along that tree ({@link locateSections}) to hash each section, and
 * a shape where a cut could differ from the server's refuses rather than guesses. Pure: no I/O.
 */

/** Past this many sections the tree is refused whole; mailsplit stops at 1 000 child nodes too. */
export const MAX_SECTIONS = 1000;

export type SectionKind = "multipart" | "rfc822" | "leaf";

/** One addressable section of the server's tree, in document order. */
export interface Section {
  section: string;
  node: MimeStructure;
  kind: SectionKind;
}

const isMultipart = (n: MimeStructure): boolean => n.type.toLowerCase().startsWith("multipart/");
const isRfc822 = (n: MimeStructure): boolean => n.type.toLowerCase() === "message/rfc822";

/**
 * RFC 3501 §6.4.5 over the server's tree: a multipart's parts are `p.1 … p.k` (the root's are
 * `1 … k`); a non-multipart root is `1`; a `message/rfc822` at `n` numbers its encapsulated body's
 * parts `n.1 … n.k` when that body is a multipart (which is `n.TEXT`, unnumbered) and `n.1` when
 * it is a single part. Iterative, so a deep tree cannot exhaust the stack; `null` past MAX_SECTIONS.
 */
export function enumerateSections(root: MimeStructure): Section[] | null {
  const out: Section[] = [];
  const stack: Array<{ node: MimeStructure; section: string }> = [];
  const pushParts = (parts: readonly MimeStructure[], prefix: string): void => {
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      stack.push({ node: parts[i]!, section: prefix === "" ? `${i + 1}` : `${prefix}.${i + 1}` });
    }
  };
  if (isMultipart(root)) pushParts(root.children, "");
  else stack.push({ node: root, section: "1" });
  while (stack.length > 0) {
    if (out.length >= MAX_SECTIONS) return null;
    const { node, section } = stack.pop()!;
    if (isMultipart(node)) {
      out.push({ section, node, kind: "multipart" });
      pushParts(node.children, section);
    } else if (isRfc822(node)) {
      out.push({ section, node, kind: "rfc822" });
      const body = node.children[0];
      if (body !== undefined) {
        if (isMultipart(body)) pushParts(body.children, section);
        else stack.push({ node: body, section: `${section}.1` });
      }
    } else {
      out.push({ section, node, kind: "leaf" });
    }
  }
  return out;
}

/** A section with its undecoded content as a byte range of the raw source — `BODY[section]`. */
export interface LocatedSection extends Section {
  start: number;
  end: number;
}

/** Why the source could not be cut along the server's tree. Each is a shape, never a guess. */
export type LocatorRefusal =
  | "too_many_sections" | "no_header_end" | "no_boundary" | "boundary_overlap" | "ambiguous_line"
  | "part_count" | "no_close" | "header_only_part" | "encoded_rfc822" | "unlocated";

export type Location = { ok: true; sections: LocatedSection[] } | { ok: false; why: LocatorRefusal };

const LF = 0x0a;
const CR = 0x0d;
const DASH = 0x2d;

class Refused extends Error {
  constructor(readonly why: LocatorRefusal) { super(why); }
}

const asBuffer = (raw: Uint8Array): Buffer =>
  Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);

/** Where the body starts after the header block in `[from, to)`: past the first empty line. */
function bodyStartAfterHeader(b: Uint8Array, from: number, to: number): number {
  let p = from;
  while (p < to) {
    if (b[p] === LF) return p + 1;
    if (b[p] === CR && p + 1 < to && b[p + 1] === LF) return p + 2;
    const nl = b.indexOf(LF, p);
    if (nl === -1 || nl >= to) return -1;
    p = nl + 1;
  }
  return -1;
}

/** Does `b` hold `pattern` at `at` (bounded by `to`)? */
function bytesAt(b: Uint8Array, at: number, to: number, pattern: Uint8Array): boolean {
  if (at + pattern.length > to) return false;
  for (let i = 0; i < pattern.length; i += 1) if (b[at + i] !== pattern[i]) return false;
  return true;
}

/** A boundary the locator can compare byte for byte: printable ASCII, 1-70 chars (RFC 2046). */
function boundaryBytes(node: MimeStructure): Uint8Array {
  const b = node.params.boundary;
  if (typeof b !== "string" || b.length === 0 || b.length > 70 || !/^[\x20-\x7e]+$/.test(b)) {
    throw new Refused("no_boundary");
  }
  return Buffer.from(`--${b}`, "latin1");
}

/**
 * Cut one multipart's body `[start, end)` into its parts' ranges. Only an EXACT delimiter line
 * counts (`--B` or `--B--`, then a line end): mailsplit matches exactly, Dovecot matches a prefix
 * of any active boundary, so any other line starting with an active `--boundary` is a place the
 * two could cut differently and refuses. The line ending before a delimiter belongs to it (RFC
 * 2046 §5.1.1). The part count must equal the server's, and a close delimiter must be present.
 * `dash` is every line start beginning `--`, found once for the whole source.
 */
function cutMultipart(
  b: Uint8Array, dash: readonly number[], start: number, end: number,
  own: Uint8Array, active: readonly Uint8Array[], parts: number,
): Array<{ start: number; end: number }> {
  const opens: Array<{ line: number; next: number }> = [];
  let closeAt = -1;
  let lo = 0;
  let hi = dash.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (dash[mid]! < start) lo = mid + 1; else hi = mid; }
  for (let k = lo; k < dash.length && dash[k]! < end; k += 1) {
    const p = dash[k]!;
    const nl = b.indexOf(LF, p);
    const next = nl === -1 || nl >= end ? end : nl + 1;
    const contentEnd = nl === -1 || nl >= end ? end : (nl > p && b[nl - 1] === CR ? nl - 1 : nl);
    for (const x of active) {
      if (!bytesAt(b, p, contentEnd, x)) continue;
      const rest = contentEnd - (p + x.length);
      if (x !== own || closeAt >= 0) throw new Refused("ambiguous_line");
      if (rest === 0) opens.push({ line: p, next });
      else if (rest === 2 && b[p + x.length] === DASH && b[p + x.length + 1] === DASH) {
        if (opens.length === 0) throw new Refused("ambiguous_line");
        closeAt = p;
      } else throw new Refused("ambiguous_line");
    }
  }
  if (closeAt < 0) throw new Refused("no_close");
  if (opens.length !== parts) throw new Refused("part_count");
  const lineEndBefore = (line: number): number => {
    if (line > 0 && b[line - 1] === LF) return line - 1 > 0 && b[line - 2] === CR ? line - 2 : line - 1;
    return line;
  };
  return opens.map((o, i) => {
    const nextLine = i + 1 < opens.length ? opens[i + 1]!.line : closeAt;
    return { start: o.next, end: Math.max(o.next, lineEndBefore(nextLine)) };
  });
}

/**
 * Cut the raw source along the server's tree and give every section its byte range: one linear
 * pass over the source for the `--` lines, then each multipart reads only its own. A refusal
 * names the shape (see {@link LocatorRefusal}); ingest keeps mailparser's id for that message.
 */
export function locateSections(raw: Uint8Array, structure: MimeStructure): Location {
  const sections = enumerateSections(structure);
  if (sections === null) return { ok: false, why: "too_many_sections" };
  const b = raw;
  const ranges = new Map<MimeStructure, { start: number; end: number }>();
  const dash: number[] = [];
  for (let p = 0; p < b.length;) {
    if (b[p] === DASH && p + 1 < b.length && b[p + 1] === DASH) dash.push(p);
    const nl = b.indexOf(LF, p);
    if (nl === -1) break;
    p = nl + 1;
  }
  try {
    const rootBody = bodyStartAfterHeader(b, 0, b.length);
    if (rootBody < 0) throw new Refused("no_header_end");
    const work: Array<{ node: MimeStructure; start: number; end: number; active: readonly Uint8Array[] }> = [
      { node: structure, start: rootBody, end: b.length, active: [] },
    ];
    while (work.length > 0) {
      const { node, start, end, active } = work.pop()!;
      ranges.set(node, { start, end });
      if (isMultipart(node)) {
        const own = boundaryBytes(node);
        for (const a of active) {
          const [short, long] = a.length <= own.length ? [a, own] : [own, a];
          if (bytesAt(long, 0, long.length, short)) throw new Refused("boundary_overlap");
        }
        const inner = [own, ...active];
        const cut = cutMultipart(b, dash, start, end, own, inner, node.children.length);
        cut.forEach((r, i) => {
          const bodyStart = bodyStartAfterHeader(b, r.start, r.end);
          if (bodyStart < 0) throw new Refused("header_only_part");
          work.push({ node: node.children[i]!, start: bodyStart, end: r.end, active: inner });
        });
      } else if (isRfc822(node) && node.children[0] !== undefined) {
        const enc = (node.encoding ?? "").toLowerCase();
        if (enc !== "" && enc !== "7bit" && enc !== "8bit" && enc !== "binary") throw new Refused("encoded_rfc822");
        const innerBody = bodyStartAfterHeader(b, start, end);
        if (innerBody < 0) throw new Refused("no_header_end");
        work.push({ node: node.children[0], start: innerBody, end, active });
      }
    }
  } catch (err) {
    if (err instanceof Refused) return { ok: false, why: err.why };
    throw err;
  }
  const located: LocatedSection[] = [];
  for (const s of sections) {
    const r = ranges.get(s.node);
    if (r === undefined) return { ok: false, why: "unlocated" };
    located.push({ ...s, start: r.start, end: r.end });
  }
  return { ok: true, sections: located };
}

/** The section's bytes exactly as the source holds them (the server's undecoded `BODY[n]`). */
export function sectionBytes(raw: Uint8Array, s: LocatedSection): Uint8Array {
  return raw.subarray(s.start, s.end);
}

/**
 * libbase64 1.3.1's `decode`, verbatim: `Buffer.from` stops at the first `=`, so a run of padded
 * segments (every line padded on its own) is decoded segment by segment. Exact because mailparser
 * 3.9.32 decodes with that copy (through @zone-eu/mailsplit 5.4.19), and a section is matched by
 * the sha of these bytes against mailparser's own.
 */
function base64Decode(str: string): Buffer {
  const padPos = str.indexOf("=");
  if (padPos >= 0 && /[a-zA-Z0-9+/\-_]/.test(str.substr(padPos))) {
    const parts: Buffer[] = [];
    for (const segment of str.split(/[=]+/)) if (segment) parts.push(Buffer.from(segment, "base64"));
    return Buffer.concat(parts);
  }
  return Buffer.from(str, "base64");
}

/** libbase64 1.3.1's streaming `Decoder` over the chunks mailsplit hands it, verbatim. */
function base64DecodeChunks(chunks: readonly Buffer[]): Buffer {
  const out: Buffer[] = [];
  let curLine = "";
  for (const chunk of chunks) {
    if (chunk.length === 0) continue;
    let b64 = curLine + chunk.toString("ascii");
    curLine = "";
    if (/[^a-zA-Z0-9+/=]/.test(b64)) b64 = b64.replace(/[^a-zA-Z0-9+/=]/g, "");
    let padded = "";
    const lastPad = b64.lastIndexOf("=");
    if (lastPad >= 0) {
      padded = b64.substr(0, lastPad + 1);
      b64 = b64.substr(lastPad + 1);
    }
    if (b64.length < 4) {
      curLine = b64;
      b64 = "";
    } else if (b64.length % 4) {
      curLine = b64.substr(-b64.length % 4);
      b64 = b64.substr(0, b64.length - curLine.length);
    }
    b64 = padded + b64;
    if (b64) out.push(base64Decode(b64));
  }
  if (curLine) out.push(base64Decode(curLine));
  return Buffer.concat(out);
}

/** libqp 2.1.2's `decode`, verbatim — its `Decoder` concatenates every chunk and decodes once. */
function quotedPrintableDecode(input: Buffer): Buffer {
  const str = input.toString("binary")
    .replace(/[\t ]+$/gm, "")
    .replace(/=(?:\r?\n|$)/g, "");
  const encodedBytesCount = (str.match(/=[\da-fA-F]{2}/g) || []).length;
  const buffer = Buffer.alloc(str.length - encodedBytesCount * 2);
  let bufferPos = 0;
  for (let i = 0, len = str.length; i < len; i += 1) {
    const chr = str.charAt(i);
    const hex = str.substr(i + 1, 2);
    if (chr === "=" && hex && /[\da-fA-F]{2}/.test(hex)) {
      buffer[bufferPos++] = parseInt(hex, 16);
      i += 2;
      continue;
    }
    buffer[bufferPos++] = chr.charCodeAt(0);
  }
  return buffer;
}

/**
 * The section's content decoded by the encoding the SERVER declared — the bytes mailparser's
 * attachment holds and the door's download returns. base64 and quoted-printable decode; every
 * other encoding passes through, as mailsplit's and imapflow's decoders do. A section running to
 * the end of an unterminated source reaches mailsplit as two chunks (its complete lines, then
 * the last line at flush), and libbase64's carry is fed the same two.
 */
export function decodedSectionBytes(raw: Uint8Array, s: LocatedSection): Uint8Array {
  const body = asBuffer(sectionBytes(raw, s));
  const enc = (s.node.encoding ?? "").toLowerCase().trim();
  if (enc === "quoted-printable") return quotedPrintableDecode(body);
  if (enc !== "base64") return body;
  if (s.end === raw.length && body.length > 0 && body[body.length - 1] !== LF) {
    const lastNl = body.lastIndexOf(LF);
    if (lastNl >= 0) return base64DecodeChunks([body.subarray(0, lastNl + 1), body.subarray(lastNl + 1)]);
  }
  return base64DecodeChunks([body]);
}

const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/** Why an attachment kept mailparser's id at ingest. Logged as `attachment_section_unmatched`. */
export type UnmatchedReason = "no_structure" | "locator_failed" | "no_equal_sha" | "no_sha";

export type SectionMatch = { matched: true; section: string } | { matched: false; reason: UnmatchedReason };

/**
 * Each attachment's section: the one whose decoded bytes hash to its `contentSha256`. mailparser's
 * `partId` is asked first and is the tie-break between sha-equal sections (the same logo twice);
 * the rest go to the first unused sha-equal section in document order. A file nothing hashes equal
 * to is UNMATCHED and keeps its hint — never null, which `fetchPart` would read as section 1.
 * Shas are computed lazily and cached; most files are settled by their own hinted section.
 */
export function attachmentSections(
  raw: Uint8Array, structure: MimeStructure | undefined, attachments: readonly AttachmentMeta[],
): SectionMatch[] {
  if (attachments.length === 0) return [];
  if (structure === undefined) return attachments.map(() => ({ matched: false, reason: "no_structure" }));
  const loc = locateSections(raw, structure);
  if (!loc.ok) return attachments.map(() => ({ matched: false, reason: "locator_failed" }));
  const files = loc.sections.filter((s) => s.kind !== "multipart");
  const bySection = new Map(files.map((s) => [s.section, s]));
  const shas = new Map<string, string>();
  const shaOf = (s: LocatedSection): string => {
    let h = shas.get(s.section);
    if (h === undefined) { h = sha256Hex(decodedSectionBytes(raw, s)); shas.set(s.section, h); }
    return h;
  };
  const used = new Set<string>();
  const out: Array<SectionMatch | undefined> = attachments.map((a) => {
    if (a.contentSha256 === null) return { matched: false, reason: "no_sha" };
    const hinted = a.partId === null ? undefined : bySection.get(a.partId);
    if (hinted === undefined || used.has(hinted.section) || shaOf(hinted) !== a.contentSha256) return undefined;
    used.add(hinted.section);
    return { matched: true, section: hinted.section };
  });
  return out.map((m, i) => {
    if (m !== undefined) return m;
    const want = attachments[i]!.contentSha256!;
    const hit = files.find((s) => !used.has(s.section) && shaOf(s) === want);
    if (hit === undefined) return { matched: false, reason: "no_equal_sha" };
    used.add(hit.section);
    return { matched: true, section: hit.section };
  });
}

/**
 * mailparser 3.9.18's numbering replayed over the server's tree, measured equal to what that
 * version stored on generated trees: one counter per multipart, in first-seen order, never popped, so
 * a part after a sibling multipart is numbered one level too deep; an inline 7bit/8bit/binary
 * rfc822 is descended and its embedded root counts once more on the CONTAINER. A prediction is
 * only ever an ORDER for the door's downloads — nothing is written from it.
 */
export function legacyPrediction(root: MimeStructure): Map<MimeStructure, string> {
  const lists: Array<{ owner: MimeStructure; count: number }> = [];
  const ids = new Map<MimeStructure, string>();
  const partIdOf = (owner: MimeStructure): string => {
    let i = lists.findIndex((x) => x.owner === owner);
    if (i === -1) { lists.push({ owner, count: 1 }); i = lists.length - 1; } else lists[i]!.count += 1;
    return lists.slice(0, i + 1).map((x) => x.count).join(".");
  };
  const descends = (n: MimeStructure): boolean => isRfc822(n)
    && ["", "7bit", "8bit", "binary"].includes((n.encoding ?? "").toLowerCase())
    && (n.disposition?.type ?? "").toLowerCase() === "inline";
  const stack: Array<{ node: MimeStructure; owner: MimeStructure | null }> = [{ node: root, owner: null }];
  while (stack.length > 0) {
    const { node, owner } = stack.pop()!;
    if (owner !== null) ids.set(node, partIdOf(owner));
    if (isMultipart(node)) {
      for (let i = node.children.length - 1; i >= 0; i -= 1) stack.push({ node: node.children[i]!, owner: node });
    } else if (descends(node) && node.children[0] !== undefined) {
      stack.push({ node: node.children[0], owner });
    }
  }
  return ids;
}

/** What the door's candidate order reads off a stored row. */
export interface CandidateRow { partId: string | null; contentType: string; filename: string | null }

const baseTypeOf = (t: string): string => t.split(";")[0]!.trim().toLowerCase();
const nameOf = (n: MimeStructure): string | null =>
  (n.disposition?.params.filename ?? n.params.name ?? "").trim() || null;

/**
 * Where an older row's file most likely is, in the order the door downloads them: (i) the stored
 * id names an rfc822 whose body is one part — `<id>.1`, the 3.9.32 class, exact; (ii) the section
 * mailparser 3.9.18 would have numbered with the stored id, the 3.9.18 class, exact; (iii) the
 * other files with the row's name and base type (or a server type of octet-stream), document
 * order. The stored id itself is never a candidate: it was the download that failed.
 */
export function candidateSections(structure: MimeStructure, row: CandidateRow): string[] {
  const sections = enumerateSections(structure);
  if (sections === null) return [];
  const out: string[] = [];
  const add = (section: string): void => {
    if (section !== row.partId && !out.includes(section)) out.push(section);
  };
  if (row.partId !== null) {
    const stored = sections.find((s) => s.section === row.partId);
    const body = stored?.kind === "rfc822" ? stored.node.children[0] : undefined;
    if (body !== undefined && !isMultipart(body)) add(`${row.partId}.1`);
    const predicted = legacyPrediction(structure);
    for (const s of sections) if (s.kind !== "multipart" && predicted.get(s.node) === row.partId) add(s.section);
  }
  const name = row.filename?.trim() || null;
  if (name !== null) {
    const base = baseTypeOf(row.contentType);
    for (const s of sections) {
      if (s.kind === "multipart" || nameOf(s.node) !== name) continue;
      const t = baseTypeOf(s.node.type);
      if (t === base || t === "application/octet-stream") add(s.section);
    }
  }
  return out;
}
