/**
 * The phone composer's attachments — every decision, away from the markup and the pickers.
 * The admit pipeline mirrors the webapp's `ComposeAttach` (cap → duplicate → notes), the cap is
 * the ONE shared bound (`composeAttachCap`, `@ohmail/client-engine` — the same rule the web and
 * desktop forms state), and the send lock's predicate mirrors the webapp's
 * `sendNeedsContent` (`apps/webapp/app/shell/mail-send.ts`) until the two live in one module —
 * filed as a gap row. The expo pickers live in `attach-native.ts`, the twin the suite never
 * imports; this module imports no react-native and no expo.
 */
import {
  COMPOSE_FORWARD_MAX_TOTAL_BYTES, IMAGE_QUALITY_RULES, composeAttachCap, encodableImageType, fitWithin, zonedFields,
  type ComposeAttachment, type ImageQualityLevel, type ImageQualityRule,
} from "@ohmail/client-engine";
import { Copy } from "../copy";
import type { PhoneMailbox } from "../net/mailboxes";

/* The level vocabulary, for the setting and the sheet — this module is the phone's door to it. */
export {
  DEFAULT_IMAGE_QUALITY_LEVEL, IMAGE_QUALITY_LEVELS, isImageQualityLevel, type ImageQualityLevel,
} from "@ohmail/client-engine";

/** One picked file — the mutation's `ComposeAttachment` plus the size the admit rule weighs. */
export interface PhoneComposeAttachment extends ComposeAttachment {
  sizeBytes: number;
  /** Where the picker left the file — what a picture is shrunk from. Never sent. */
  uri?: string;
  /** Its record on the phone's disk, once written (`letter-store.ts`). Never sent. */
  fileId?: string;
  /**
   * The name was made at the pick ({@link photoName}), not handed by the picker: a re-pick of the
   * same picture is named anew, so the duplicate check reads its bytes alone. Never sent.
   */
  nameFromPick?: true;
}

/**
 * RE-ENCODE ONE PICTURE — fitted inside `rule.maxEdge`, JPEG at `rule.quality`, a PNG in its own
 * format — and answer its base64, or `null` where it could not. The native twin implements it
 * over expo-image-manipulator; the node suite hands in a fake.
 */
export type ImageShrink = (
  uri: string, type: "image/jpeg" | "image/png", rule: ImageQualityRule,
) => Promise<string | null>;

/** The box a picture is fitted to — the web's `fitWithin`, for the native twin's use. */
export function shrinkBox(width: number, height: number, rule: ImageQualityRule): { width: number; height: number } {
  return fitWithin(width, height, rule.maxEdge);
}

/**
 * SHRINK PICKED PICTURES BEFORE THE CAP — the web's `compressImage` rule on this phone, the same
 * level table (`@ohmail/client-engine`). Only JPEG and PNG; `original` and every other type pass
 * untouched; a re-encode that is not SMALLER is dropped and the picked bytes attach (a bigger,
 * worse file is worse than not running). Never throws: a picture that cannot be shrunk attaches
 * as it was, and the cap decides.
 */
export async function shrinkPicked(
  files: readonly PhoneComposeAttachment[],
  level: ImageQualityLevel,
  shrink: ImageShrink,
): Promise<PhoneComposeAttachment[]> {
  const rule = IMAGE_QUALITY_RULES[level];
  const out: PhoneComposeAttachment[] = [];
  for (const file of files) {
    const type = encodableImageType(file.contentType);
    if (rule === null || type === null || !file.uri) {
      out.push(file);
      continue;
    }
    let smaller: string | null = null;
    try {
      smaller = await shrink(file.uri, type, rule);
    } catch {
      smaller = null;
    }
    const bytes = smaller === null ? 0 : base64SizeBytes(smaller);
    out.push(smaller !== null && bytes > 0 && bytes < file.sizeBytes
      ? { ...file, contentType: type, contentBase64: smaller, sizeBytes: bytes }
      : file);
  }
  return out;
}

/**
 * What a picker press produced. `cancelled` renders nothing (the person changed their mind);
 * `unavailable` is the platform refusing the picker itself and is SAID, never a silent no-op —
 * the ydotool rule: every fallback refuses by name. `unreadable` counts files whose bytes could
 * not be read; the picked ones beside them still arrive.
 */
export type AttachPickOutcome =
  | { kind: "picked"; files: PhoneComposeAttachment[]; unreadable: number }
  | { kind: "cancelled" }
  | { kind: "unavailable" };

/** The two pickers, behind a seam so the node suite drives every decision without expo. */
export interface AttachPicker {
  /** The document picker — any file type, multiple selection. */
  pickFiles(): Promise<AttachPickOutcome>;
  /** The photo library — images, multiple selection, bytes in hand; `zone` dates a nameless photo. */
  pickPhotos(zone: string): Promise<AttachPickOutcome>;
}

/**
 * THE CAP THIS COMPOSER STATES AND REFUSES AGAINST — `composeAttachCap` of the sending
 * mailbox's announced `SIZE`, surface ABSENT: the phone's send rides one JSON request (the
 * hosted API's serverless body limit is real there), so it earns no allowance beyond the strict
 * constant until it stages — filed. The mailbox is the message's own `mailboxId`, the same
 * resolution the send makes; an unknown mailbox reads as unprobed, never as unbounded.
 */
export function phoneAttachCap(
  mailboxes: readonly PhoneMailbox[],
  mailboxId: string | null | undefined,
): number {
  const row = mailboxId ? mailboxes.find((b) => b.id === mailboxId) : undefined;
  return composeAttachCap(row?.smtpMaxSizeBytes ?? null);
}

/**
 * A FORWARD'S THREE BOUNDS: files added on this phone stay under the phone's cap (they ride its one
 * request), the original's kept files under the send's forwarded ceiling (the server streams them),
 * and both together under what the sending mailbox takes — `composeAttachCap` with no surface term.
 */
export function forwardCaps(
  mailboxes: readonly PhoneMailbox[],
  mailboxId: string | null | undefined,
): { phone: number; forwarded: number; message: number } {
  const row = mailboxId ? mailboxes.find((b) => b.id === mailboxId) : undefined;
  return {
    phone: phoneAttachCap(mailboxes, mailboxId),
    forwarded: COMPOSE_FORWARD_MAX_TOTAL_BYTES,
    message: composeAttachCap(row?.smtpMaxSizeBytes ?? null, null),
  };
}

/** What one admit pass decided — the list as it stands, and the notes the sheet renders. */
export interface AttachAdmit {
  next: PhoneComposeAttachment[];
  /** Files refused because they would have put the total over the cap — the web's sentence. */
  overCap: number;
  /** Re-picked files skipped rather than listed twice, named — the web's `attachDuplicate`. */
  duplicates: string[];
  /**
   * Files whose BYTES are absent (empty `contentBase64`) — refused the row here, whatever the
   * picker said: a row with a name and no bytes is a message that quietly leaves without
   * something the sender attached. The native twin already screens these; this is the belt for
   * any picker, counted into the same `attachUnreadable` sentence.
   */
  unreadable: number;
}

/**
 * ADMIT PICKED FILES AGAINST THE LIST AS IT STANDS — the webapp pipeline's order: a duplicate
 * (same filename AND same bytes, the web's identity; the same bytes alone where either name was
 * made at the pick, `nameFromPick`) is skipped and named as listed; a file that would put
 * the running total over the cap is refused and counted; the rest append in pick order. The cap
 * binds DURING the walk, not after it — an over-cap file never occupies memory or a row.
 */
export function admitPicked(
  existing: readonly PhoneComposeAttachment[],
  picked: readonly PhoneComposeAttachment[],
  capBytes: number,
): AttachAdmit {
  const next = [...existing];
  let total = next.reduce((n, a) => n + a.sizeBytes, 0);
  let overCap = 0;
  let unreadable = 0;
  const duplicates: string[] = [];
  for (const file of picked) {
    if (file.contentBase64.length === 0) {
      unreadable += 1;
      continue;
    }
    const same = next.find((a) => a.contentBase64 === file.contentBase64
      && (a.filename === file.filename || a.nameFromPick === true || file.nameFromPick === true));
    if (same !== undefined) {
      duplicates.push(same.filename);
      continue;
    }
    if (file.sizeBytes > capBytes || total + file.sizeBytes > capBytes) {
      overCap += 1;
      continue;
    }
    next.push(file);
    total += file.sizeBytes;
  }
  return { next, overCap, duplicates, unreadable };
}

/**
 * NOTHING TO SEND — the webapp's `sendNeedsContent`, mirrored (a forward's content is the
 * forwarded message itself; an attachment IS content — the server composes a blank body beside
 * files). One rule, two consumers on this phone: the Send button's face and the press's told
 * refusal. Unification with the webapp module is filed.
 */
export function phoneSendNeedsContent(o: {
  forward: boolean;
  body: string;
  attachmentCount: number;
}): boolean {
  return !o.forward && o.body.trim().length === 0 && o.attachmentCount === 0;
}

/** The mutation's shape: the admit list without the weight it was admitted under. */
export function toComposeAttachments(
  list: readonly PhoneComposeAttachment[],
): ComposeAttachment[] | undefined {
  if (list.length === 0) return undefined;
  return list.map(({ filename, contentType, contentBase64 }) => ({
    filename,
    contentType,
    contentBase64,
  }));
}

const PHOTO_EXT: Record<string, string> = {
  "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/heic": "heic",
  "image/heif": "heif", "image/gif": "gif", "image/webp": "webp",
};
/* Android's photo picker hands the media number ("19.jpg"); iOS and the cache hand a UUID. */
const MEDIA_NUMBER = /^\d+(\.\w+)?$/;
const CACHE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.\w+)?$/i;

/** The picker handed no name of the photo's own: none, a media number or a cache UUID. */
export function pickerGaveNoName(picked: string | null | undefined): boolean {
  const given = typeof picked === "string" ? picked.trim() : "";
  return given === "" || MEDIA_NUMBER.test(given) || CACHE_UUID.test(given);
}

/**
 * THE NAME A PICKED PHOTO IS LISTED AND SENT UNDER. A real name is kept; a missing one, a media
 * number or a cache UUID becomes "Photo YYYY-MM-DD HH.MM.SS.<ext>" at the pick, in the reader's
 * zone, the extension from the file's type. A name already in `taken` (this pick) gets " (2)".
 */
export function photoName(
  picked: string | null | undefined,
  mime: string | null | undefined,
  at: Date,
  zone: string,
  taken: ReadonlySet<string>,
): string {
  const given = typeof picked === "string" ? picked.trim() : "";
  let name = given;
  if (pickerGaveNoName(given)) {
    const ext = PHOTO_EXT[(mime ?? "").toLowerCase()] ?? /\.(\w+)$/.exec(given)?.[1]?.toLowerCase() ?? "jpg";
    const f = zonedFields(at, zone);
    const p2 = (n: number) => String(n).padStart(2, "0");
    name = Copy.photoNamed(`${f.year}-${p2(f.month)}-${p2(f.day)} ${p2(f.hour)}.${p2(f.minute)}.${p2(f.second)}.${ext}`);
  }
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const [stem, tail] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 2; ; n += 1) {
    const next = `${stem} (${n})${tail}`;
    if (!taken.has(next)) return next;
  }
}

/** Decoded byte length of a base64 string, without decoding it — the adapter's own accounting. */
export function base64SizeBytes(b64: string): number {
  const len = b64.length;
  if (len === 0) return 0;
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}
