/**
 * A LETTER'S FILES, THE RULES: the ceiling a letter states, and the two commits (a pick, a quality move), each over
 * the list as it stands. The hook that drives them is `files.ts`.
 */
import type { ComposeAttachment } from "@ohmail/wire";
import {
  composeAttachCap,
  composeAttachCapBinding,
  type ComposeAttachCapBinding,
  type ImageQualityLevel,
} from "@ohmail/client-engine";

export { IMAGE_QUALITY_LEVELS, type ImageQualityLevel } from "@ohmail/client-engine";

/** How pictures go. `none`: as picked, and no quality is offered. */
export interface PicturesPort {
  level(): ImageQualityLevel;
  setLevel(level: ImageQualityLevel): void;
  /** The bytes to attach at `level`: the input itself when nothing was gained. */
  compress(file: Blob, level: ImageQualityLevel): Promise<{ blob: Blob; contentType: string }>;
}
export type Pictures = PicturesPort | "none";

/** A host-held file. Its metadata is available before the letter asks for bytes. */
export interface DroppedFile {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  readonly state: "ok" | "too_large" | "unreadable";
  /** The reader checks the receiving letter before asking for each chunk. */
  read(signal?: AbortSignal, stillHere?: () => boolean): Promise<File>;
}

/**
 * What the window can carry in one send: `strict`, the hosted request's own bound; `mailbox`, no bound of its own
 * (the mailbox's announcement governs); a number, that window's bound.
 */
export type SendSurface = "strict" | "mailbox" | number;

export interface LetterCap {
  readonly bytes: number;
  readonly binding: ComposeAttachCapBinding;
}

/** The ceiling a letter states and enforces: the smaller of the window's and the sending mailbox's. */
export function letterCap(mailboxMax: number | null, surface: SendSurface): LetterCap {
  const s = surface === "strict" ? undefined : surface === "mailbox" ? null : surface;
  return { bytes: composeAttachCap(mailboxMax, s), binding: composeAttachCapBinding(mailboxMax, s) };
}

/** Decoded byte length of a base64 string, without decoding it. */
export function base64Bytes(b64: string): number {
  if (b64.length === 0) return 0;
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

export function totalBytes(items: readonly ComposeAttachment[]): number {
  return items.reduce((n, a) => n + base64Bytes(a.contentBase64), 0);
}

export const same = (a: ComposeAttachment, b: ComposeAttachment): boolean =>
  a.filename === b.filename && a.contentBase64 === b.contentBase64;

export interface Picked {
  readonly attachment: ComposeAttachment;
  readonly bytes: number;
  readonly originalBytes: number;
  readonly compressed: boolean;
}

/** Reproject the pick against the current list and ceiling, refusing staged files that no longer fit. */
export function remainingRoom(
  list: readonly ComposeAttachment[],
  cap: number,
  picked: Picked[],
  refuse: (cap: number) => void,
): number {
  let remaining = cap - totalBytes(list);
  for (let i = 0; i < picked.length;) {
    if (picked[i]!.bytes <= remaining) {
      remaining -= picked[i]!.bytes;
      i += 1;
    } else {
      picked.splice(i, 1);
      refuse(cap);
    }
  }
  return remaining;
}

export interface Admitted {
  /** The list to commit; the same array as `latest` when nothing was added. */
  readonly list: readonly ComposeAttachment[];
  /** The ceiling a file was refused under, or null. */
  readonly refusedAt: number | null;
  /** The names skipped as already on the letter. */
  readonly twice: readonly string[];
  /** What the shrink saved on the files added: the two totals, or null. */
  readonly saved: { readonly from: number; readonly to: number } | null;
}

/** THE COMMIT of a pick, against the list as it stands now: twins skipped, the ceiling held, in pick order. */
export function admit(
  latest: readonly ComposeAttachment[],
  picked: readonly Picked[],
  cap: number,
): Admitted {
  let running = totalBytes(latest);
  const added: ComposeAttachment[] = [];
  const twice: string[] = [];
  let refusedAt: number | null = null;
  let from = 0;
  let to = 0;
  for (const p of picked) {
    if ([...latest, ...added].some((a) => same(a, p.attachment))) {
      twice.push(p.attachment.filename);
      continue;
    }
    if (running + p.bytes > cap) {
      refusedAt = cap;
      continue;
    }
    added.push(p.attachment);
    running += p.bytes;
    if (p.compressed) {
      from += p.originalBytes;
      to += p.bytes;
    }
  }
  return {
    list: added.length > 0 ? [...latest, ...added] : latest,
    refusedAt,
    twice,
    saved: from > 0 ? { from, to } : null,
  };
}

export interface Requalified {
  readonly list: readonly ComposeAttachment[];
  /** A re-encode would have crossed the ceiling, so that file kept its bytes. */
  readonly kept: boolean;
  readonly saved: { readonly from: number; readonly to: number } | null;
}

/**
 * THE COMMIT of a quality move over the list as it stands now: twins of the targets collapse first, then shrinks
 * land (they only make room), then grows in list order while the whole list stays under the ceiling.
 */
export function requalified(
  latest: readonly ComposeAttachment[],
  replacements: ReadonlyMap<ComposeAttachment, Picked>,
  cap: number,
): Requalified {
  const targetOf = (a: ComposeAttachment): ComposeAttachment => replacements.get(a)?.attachment ?? a;
  const seen = new Set<string>();
  const rows: ComposeAttachment[] = [];
  for (const a of latest) {
    const t = targetOf(a);
    const key = `${t.filename}\u0000${t.contentBase64}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(a);
  }
  const delta = (a: ComposeAttachment, bytes: number): number => bytes - base64Bytes(a.contentBase64);
  let total = totalBytes(rows);
  const landed = new Set<ComposeAttachment>();
  for (const a of rows) {
    const r = replacements.get(a);
    if (r && delta(a, r.bytes) <= 0) {
      landed.add(a);
      total += delta(a, r.bytes);
    }
  }
  let kept = false;
  for (const a of rows) {
    const r = replacements.get(a);
    if (!r || landed.has(a)) continue;
    if (total + delta(a, r.bytes) <= cap) {
      landed.add(a);
      total += delta(a, r.bytes);
    } else kept = true;
  }
  let from = 0;
  let to = 0;
  const list = rows.map((a) => {
    const r = replacements.get(a);
    if (!r || !landed.has(a)) return a;
    if (r.compressed) {
      from += r.originalBytes;
      to += r.bytes;
    }
    return r.attachment;
  });
  const unchanged = list.length === latest.length && list.every((a, i) => a === latest[i]);
  return { list: unchanged ? latest : list, kept, saved: from > 0 ? { from, to } : null };
}

/** Bytes to base64, with no `data:` prefix. */
export function readAsBase64(file: Blob, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const reader = new FileReader();
    const retire = (): void => signal?.removeEventListener("abort", abort);
    const abort = (): void => {
      retire();
      reject(signal?.reason);
      reader.abort();
    };
    reader.onerror = () => {
      retire();
      reject(reader.error ?? new Error("read failed"));
    };
    reader.onload = () => {
      retire();
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : "");
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      reader.readAsDataURL(file);
    } catch (error) {
      retire();
      reject(error);
    }
  });
}
