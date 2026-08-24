"use client";

/**
 * COMPOSE ATTACHMENTS — pick files, hold their bytes in memory, send them with the message.
 *
 * ── NOTHING IS FILED AGAINST THE ACCOUNT — AND ONE EXACT QUALIFICATION ───────────────────
 *
 * The bytes a user picks here are stored against nothing that outlives the send: not the account's
 * `drafts` row, not `attachments`, not this browser's `localStorage` (the compose scratch buffer
 * strips them; see `compose.ts`). This control keeps the decoded files in React state handed up
 * through `ComposeFields.attachments`, and a reload starts with none.
 *
 * THE QUALIFICATION IS THE TRANSPORT, and it is stated here because the sentence above used to
 * read "ride the SEND request and are stored nowhere", which stopped being the whole truth. On the
 * hosted browser client a send whose files exceed what one request body can carry uploads them to
 * private object storage first and sends REFERENCES; the bytes sit there, unreadable without a
 * service credential, until the send reads them, and a retention sweep removes them within 24
 * hours whether the send happened or not. Still nothing on the account, still no row that names
 * them after the window closes — but "nowhere" would be a claim the product cannot keep, so the
 * privacy page says this too.
 *
 * ── THE CAP IS A UX PRE-CHECK; THE SERVER IS AUTHORITATIVE ───────────────────────────────
 *
 * The server refuses a total over its own ceiling; this control states that number up front and
 * refuses to ADD a file that would cross it, so a user learns at pick time instead of at a failed
 * send. **The number is a PROP, not a constant** — see {@link composeAttachCap} for what goes into
 * it and why this component no longer knows.
 *
 * ── PICTURES ARE SHRUNK FIRST, AND THE ORDER IS THE POINT ────────────────────────────────
 *
 * Every picked file goes through {@link compressImage} BEFORE the cap above is applied to it, and the
 * cap is then applied to the SHRUNK size. Written the other way round the feature would be nearly
 * pointless: the common attachment is a phone photo of six megabytes, the cap is three, and a
 * compressor that only runs on files which already fit never runs on the file that needed it. So
 * the sequence is decode → re-encode → measure → admit or refuse, and a photo that fits only
 * because it was shrunk attaches.
 *
 * The transform is in `./image-quality`, which is where the level table, the format rules and the
 * keep-the-original guard are documented. This file's only job is to run it in the right place and
 * to say what happened.
 *
 * ── THE DIAL, IN THE ROW IT ACTS ON — ONE VALUE PER ACCOUNT ──────────────────────────────
 *
 * The quality level is offered beside the attach button because the moment the level matters is
 * the pick: a person about to send a photo at full size should not have to know that a dial
 * lives two views away.
 *
 * IT EDITS THE ACCOUNT'S OWN PREFERENCE, DELIBERATELY AND SCOPED. Moving it here is remembered
 * — the next compose on this account opens at the level chosen — and it is the SAME value the
 * Settings → General row edits, through the same two functions, so the two surfaces cannot
 * disagree. What changed from the first shipping of this dial is the KEY: the value is stored
 * per account (`imageQualityKeyFor`; the id is `readOwner`'s, the one the mail mirror is named
 * for), because the old account-less key meant a control that looks personal silently rewrote
 * the preference for EVERYONE who signs in on the machine. A surface with no account — the
 * standalone desktop, the demo — uses the account-less key, where every pre-scoping choice
 * already lives.
 *
 * AND A MOVE RE-ENCODES THE PICTURES ALREADY ATTACHED — owner ruling, replacing the old
 * "new picks only" scope. The pristine SOURCE bytes of every admitted file are retained (in
 * memory, per attachment, for as long as the list holds it — {@link ATTACHMENT_SOURCES}),
 * and a dial move re-runs the compression over each already-attached compressible picture FROM
 * THAT SOURCE, never from the previous encode: re-compressing an encode is generational quality
 * loss, and a move back to Original must recover the exact original bytes. Non-image and
 * incompressible files are untouched, byte for byte and object for object. The pass is async and
 * the composer stays responsive; its commit is ONE atomic list replacement, so a send that lands
 * mid-pass sends the settled pre-move encodes and a send after it sends the settled new ones —
 * never a torn mix. The visible note states this scope (it used to state the opposite).
 *
 * The options run Low → Medium → High → Original, ascending, with the default in the middle and
 * "Original" at the end anchoring what the scale is FOR (everything below it trades fidelity for
 * bytes). The Settings segment renders the SAME array in the SAME order — one table, one catalog
 * entry for the labels — so neither surface can grow a level or a word the other lacks.
 *
 * ── PASTED AND DROPPED FILES ARE PICKS TOO ───────────────────────────────────────────────
 *
 * The message body takes no images (no-images is the product's rule), so pasting a picture into
 * the editor used to do NOTHING — no attachment, no notice — and a file dropped on the surface
 * was left to the browser, which navigates away to the file. Both now land HERE, through the
 * same admit pipeline as the picker (shrink → cap → duplicate check → notes): the caller hands
 * this component the surface to listen on (`dropZone`), because the files belong to the send
 * exactly as a picked file does.
 *
 * ── COPY ─────────────────────────────────────────────────────────────────────────────────
 *
 * The two strings that state the cap are catalog keys (`compose.attach*`) taking the rendered size
 * as a parameter, so the sentence on screen and the number the send will enforce come from one
 * value. They were inline literals holding a hard-coded "3 MB" — which was exactly the drift this
 * slice removes, in the one place a user reads a promise.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Icon } from "@ohmail/ui";
import type { ComposeAttachment } from "@ohmail/client-engine";
import {
  DEFAULT_IMAGE_QUALITY_LEVEL,
  IMAGE_QUALITY_LEVELS,
  type ImageQualityLevel,
  compressImage,
  isImageQualityLevel,
  readImageQualityLevel,
  writeImageQualityLevel,
} from "./image-quality";
import { readOwner } from "../shell/owner-cookie";

/**
 * The dial's own order — the table's, unreversed.
 *
 * It used to reverse the array, because the levels ascended by EFFORT and this menu had to lead
 * with the strongest squeeze. On a quality axis the table already reads Low → Medium → High →
 * Original, which is the order this menu wants and the order the Settings segment wants, so both
 * surfaces now render one array as it stands and neither can drift from the other.
 */
const LEVEL_CHOICES: readonly ImageQualityLevel[] = IMAGE_QUALITY_LEVELS;

/**
 * THE INLINE TRANSPORT'S OWN CEILING on total attachment bytes — the mirror of the constant the
 * hosted send handler enforces, kept as a literal rather than imported so this bundle pulls in no
 * server module.
 *
 * It is a fact about the REQUEST PIPELINE and not about mail: attachment bytes travelling base64 on
 * one JSON request have to clear the hosted API's serverless body limit (~4.5 MB) with room for the
 * envelope and the ~1.33× base64 inflation. 3 MB of raw bytes encodes to about 4 MB.
 *
 * IT IS NO LONGER WHAT THE HOSTED FORM PROMISES, and that is the point of the paragraph above:
 * a window whose client can stage declares an uncapped SURFACE, so this number stops being the
 * binding term and the mailbox's own announcement governs. It remains the strict fallback for
 * every caller that has not declared a surface, and the client-engine's own
 * `SEND_INLINE_MAX_TOTAL_BYTES` is the same value deciding the same boundary from the transport
 * side — all three are pinned together by the repository's `compose-attach-cap-parity` suite.
 */
export const COMPOSE_ATTACH_MAX_TOTAL_BYTES = 3 * 1024 * 1024;

/**
 * THE ENVELOPE ALLOWANCE and THE ENCODING EXPANSION — the mirror of the send's, kept as literals
 * for the same reason the constant above is.
 *
 * A server's announced `SIZE` bounds the ENCODED MESSAGE: headers, MIME boundaries, the body, and
 * every attachment base64-encoded at four characters per three bytes, wrapped at 76 characters
 * with a CRLF. The expansion is therefore (4/3)·(78/76) and its inverse is exactly 19/26, so 25 MB
 * of files is about 34 MB of message.
 *
 * Stating the face value would be a promise the sending server breaks: somebody attaches 25 MB to
 * a provider that announced 25 MB, waits for the send, and has it bounced. Pinned value for value
 * against `attachmentBudgetFor` in the services package by the repository's parity suite.
 */
export const COMPOSE_ATTACH_MIME_ENVELOPE_BYTES = 64 * 1024;

/**
 * WHAT THE HOSTED WINDOW'S TRANSPORT CAN CARRY — the staging bucket's per-object ceiling.
 *
 * Uploading straight to object storage removes the request-body limit; it does not remove every
 * limit. An object over the bucket's configured size is refused by the browser's own PUT, after
 * the upload grant was minted and after the person waited, and there is nothing useful the client
 * can say about it. So the window declares this as its surface instead of `null`, and the mint
 * applies the same bound server-side.
 *
 * A per-OBJECT limit used as a per-TOTAL bound, deliberately: it is always correct in the safe
 * direction, because if the total fits then every individual file fits.
 */
export const COMPOSE_ATTACH_STAGED_SURFACE_BYTES = 40 * 1024 * 1024;

/** An announced `SIZE` converted to a budget for RAW attachment bytes. See the constants above. */
export function composeAttachBudgetFor(announcedMessageBytes: number): number {
  const forAttachments = announcedMessageBytes - COMPOSE_ATTACH_MIME_ENVELOPE_BYTES;
  if (forAttachments <= 0) return 1;
  return Math.max(1, Math.floor((forAttachments * 19) / 26));
}

/**
 * THE CEILING THIS FORM MAY PROMISE — the smaller of what the sending surface can carry and what
 * the sending mailbox's own server said it will accept.
 *
 * It is a MIRROR of the rule the send itself applies — `effectiveAttachmentCap` in the services
 * package's send-service — and it has to be: a number stated here that the send
 * would refuse is a claim the product cannot keep, and a refusal below the promise wastes a
 * message somebody composed. A mirror rather than an import because this bundle may pull in no
 * server module (the same rule the constant above states); the two implementations are pinned to
 * each other VALUE FOR VALUE by the repository's parity suite (`compose-attach-cap-parity`).
 *
 * `mailboxMax` is the submission server's own RFC 1870 `SIZE` announcement, forwarded from
 * `GET /mailboxes` through the resolved From. The interesting case is the STINGY provider, not the
 * generous one: a server that caps at 2 MB binds this form to 2 MB even though the request pipeline
 * would have carried 3 — without the `min` the user picks a file, waits for a send, and has it
 * bounced by their own provider.
 *
 * `surfaceMax` is the HOST's declaration about the pipeline a send from this window rides — the
 * form-side twin of the `sendSurfaceMaxTotalBytes` the send handler's service bag declares, with
 * the same three states:
 *
 *  · ABSENT (`undefined` — every one-argument call): the surface has not declared itself, and it
 *    resolves to the strict constant rather than to "unbounded". A caller that has not been
 *    taught the surface dimension must not acquire a bigger allowance by not passing it.
 *  · `null`: EXPLICITLY UNCAPPED — the desktop's standalone door, where this form, the send
 *    handler and the SMTP dial are one process and no request body exists between them (the
 *    mail engine's service bag makes the same declaration to `SendService`). The mailbox's
 *    own announcement then governs; while none has been measured the answer is again the
 *    constant, because an unknown limit read as no limit costs the user a composed message.
 *  · a number: that surface's own ceiling, bounded exactly as the constant is.
 *
 * The parameter order is the reverse of `effectiveAttachmentCap`'s, deliberately: every caller
 * here has a mailbox in hand, and only a HOST declares a surface, so the surface rides the
 * optional seat. `0` and anything non-finite never become a ceiling on either side — a server
 * advertising `SIZE 0` means "no fixed maximum" (RFC 1870 §6), so reading it as a ceiling of
 * nothing would refuse every file.
 */
export function composeAttachCap(
  mailboxMax: number | null | undefined,
  surfaceMax?: number | null,
): number {
  const usable = (n: number | null | undefined): n is number =>
    typeof n === "number" && Number.isFinite(n) && n > 0;
  const surface = surfaceMax === undefined ? COMPOSE_ATTACH_MAX_TOTAL_BYTES : surfaceMax;
  const bounds: number[] = [];
  if (usable(surface)) bounds.push(surface);
  if (mailboxMax === null || mailboxMax === undefined) {
    // UNPROBED. The strict constant, NOT converted — it already describes raw attachment bytes.
    bounds.push(COMPOSE_ATTACH_MAX_TOTAL_BYTES);
  } else if (usable(mailboxMax)) {
    // A REAL ANNOUNCEMENT, which is about the encoded message. See `composeAttachBudgetFor`.
    bounds.push(composeAttachBudgetFor(mailboxMax));
  }
  return bounds.length > 0 ? Math.min(...bounds) : COMPOSE_ATTACH_MAX_TOTAL_BYTES;
}

/**
 * THE PRISTINE SOURCE of every admitted attachment, keyed by the attachment object itself —
 * AT MODULE SCOPE, deliberately.
 *
 * A dial move re-encodes the pictures already attached, and it must do so FROM THE PICKED BYTES:
 * re-encoding the previous encode compounds the loss (each pass throws away fidelity the next
 * pass cannot get back), and a move to Original must recover the exact file. The map lives
 * outside the component because the LIST does: `AppShell` owns `fields.attachments` precisely so
 * the compose survives navigating away, and a map held in component state died with the unmount —
 * after visiting another view and coming back, every source lookup missed and the dial silently
 * did nothing while the note claimed otherwise (review finding). Keyed weakly on the attachment's
 * identity, so a removed row, a discarded form, or a closed compose releases its bytes with no
 * bookkeeping; a list restored WITHOUT bytes (a reload — the scratch buffer strips them) simply
 * has no entries and is left untouched by a move, which is the honest answer.
 *
 * `originalBase64` is the source's own encoding, computed at most once — a move to Original and
 * every "this file cannot shrink" outcome reuse it instead of re-reading megabytes.
 */
const ATTACHMENT_SOURCES = new WeakMap<ComposeAttachment, {
  blob: Blob;
  originalBase64?: string;
  /** The level the row's CURRENT encode was made at — what the mount-time convergence reads to
      decide whether a pass is owed at all, without re-encoding anything to find out. */
  encodedLevel: ImageQualityLevel;
}>();

/** Decoded byte length of a base64 string, without decoding it. */
function base64Bytes(b64: string): number {
  const len = b64.length;
  if (len === 0) return 0;
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

function totalBytes(items: readonly ComposeAttachment[]): number {
  return items.reduce((n, a) => n + base64Bytes(a.contentBase64), 0);
}

/** "2.3 MB" / "748 KB" / "512 B" — never a trailing ".0". */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let n = bytes / 1024;
  for (const unit of ["KB", "MB", "GB"]) {
    if (n < 1024 || unit === "GB") {
      const s = n < 10 ? n.toFixed(1).replace(/\.0$/, "") : String(Math.round(n));
      return `${s} ${unit}`;
    }
    n /= 1024;
  }
  return `${bytes} B`;
}

/**
 * Read bytes to base64 (no `data:` prefix). Rejects on a read error.
 *
 * Takes a `Blob` rather than a `File` because what gets read is often no longer the picked file —
 * a shrunk picture is a fresh blob off a canvas, with no name and no `lastModified`. The filename
 * comes from the original in every case, which is safe precisely because the shrink keeps formats.
 */
function readAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : "");
    };
    reader.readAsDataURL(file);
  });
}

export function ComposeAttach({
  attachments,
  onChange,
  disabled,
  maxTotalBytes = COMPOSE_ATTACH_MAX_TOTAL_BYTES,
  dropZone,
}: {
  attachments: ComposeAttachment[];
  onChange: (next: ComposeAttachment[]) => void;
  disabled?: boolean;
  /**
   * The ceiling this form enforces and states, in raw bytes. Callers pass
   * {@link composeAttachCap} of the sending mailbox's announced `SIZE`.
   *
   * DEFAULTED rather than required, and to the STRICT value: a surface that has not been taught to
   * resolve a mailbox must not thereby acquire a bigger allowance than the hosted request pipeline
   * can carry. The default is what this component hard-coded before it took a prop, so an
   * un-updated caller behaves exactly as it did.
   */
  maxTotalBytes?: number;
  /**
   * THE SURFACE WHOSE PASTES AND DROPS BELONG TO THIS SEND — the compose form, the reply panel.
   * A picture pasted into the editor and a file dropped on the surface both land in the
   * attachment list through the same admit pipeline as the picker; without a handler the paste
   * is a silent nothing and the drop is the browser navigating away to the file. Optional
   * because this component is mounted bare in harnesses with no surface to listen on.
   */
  dropZone?: React.RefObject<HTMLElement | null>;
}) {
  const t = useTranslations("compose");
  // The LEVEL labels come from the Settings catalog, deliberately: one word per level in the
  // whole product, so "Original" here and "Original" there can never drift into synonyms.
  const ts = useTranslations("settings");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const levelId = useId();
  const [error, setError] = useState<string | null>(null);
  /**
   * The list as of the CURRENT render — what a re-encode pass reconciles its commit against, so
   * files picked or removed while the pass ran are respected rather than clobbered by a commit
   * computed from a stale snapshot.
   */
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  /**
   * THE INTAKE'S UN-FLUSHED HAND-OFF — the exact list the intake just committed, until the render
   * that receives it clears the mark. A pass kicked in the intake's own tick reads THIS to know
   * the ref is one commit behind; it is an explicit marker, never a shape test, because a user
   * clearing the list's tail mid-pass leaves the ref a prefix of the hand-off too, and reading
   * that shape as "un-flushed" resurrected the removed file.
   */
  const pendingFlush = useRef<readonly ComposeAttachment[] | null>(null);
  {
    // Cleared on ELEMENTWISE identity, not array identity: a caller may clone the array prop
    // every render (the reply panel does), and a marker that waited for the exact array object
    // would never clear — leaving a later removal to be read as un-flushed and resurrected.
    // The ROWS keep identity through a clone, so the elementwise test is the flush signal.
    const pf = pendingFlush.current;
    if (
      pf !== null &&
      (pf === attachments ||
        (pf.length === attachments.length && pf.every((a, i) => a === attachments[i])))
    ) {
      pendingFlush.current = null;
    }
  }
  /**
   * THE CALLER'S HANDLER AND CAP, AS OF THE CURRENT RENDER — what every ASYNC commit goes
   * through, and the review finding that put them here: an async pass that called the `onChange`
   * captured when it STARTED invoked a caller closure holding that render's whole form
   * (`ComposeView` spreads `...fields` around the new list), so a subject or recipient edited
   * while encodes ran was silently written back to its pre-edit text. The ref hands the commit
   * to the LATEST render's closure, whose spread carries the fields as they now stand. The cap
   * moves for the same reason: an inline reply's From can switch to a stingier mailbox mid-pass,
   * and bytes admitted against the old ceiling would be refused by the send.
   */
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const maxTotalBytesRef = useRef(maxTotalBytes);
  maxTotalBytesRef.current = maxTotalBytes;
  /**
   * Which dial move owns the commit. A pass checks it after every await and yields to a newer
   * move: the newer pass re-encodes from the same sources, so the stale pass's work is simply
   * superseded — committing it late would overwrite the level the user chose last.
   */
  const requalifyGen = useRef(0);
  /**
   * A DISCARDED FORM STAYS DISCARDED: unmounting bumps the generation, so a pass still encoding
   * when the compose was cancelled (or the reply settled) can never commit into the caller's
   * cleared state and repopulate a message the user threw away.
   */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true; // re-armed on every mount — StrictMode replays the cleanup once
    return () => {
      mounted.current = false;
      requalifyGen.current += 1;
    };
  }, []);
  /**
   * THE ACCOUNT'S LEVEL — the dial's value, and what the next pick applies. Seeded with the
   * default and corrected to the STORED per-account preference post-mount, never read during
   * the first render: there is no `localStorage` on the server (and no cookie to read the
   * account from), and a mismatch would make React keep the server's value. The ref is the
   * same value readable from inside async handlers without re-binding them per change.
   */
  const [level, setLevel] = useState<ImageQualityLevel>(DEFAULT_IMAGE_QUALITY_LEVEL);
  const levelRef = useRef<ImageQualityLevel>(DEFAULT_IMAGE_QUALITY_LEVEL);
  /** Whose preference the dial edits — `readOwner`'s account id, `null` where there is none. */
  const owner = useRef<string | null>(null);
  useEffect(() => {
    owner.current = readOwner();
    const stored = readImageQualityLevel(owner.current);
    setLevel(stored);
    levelRef.current = stored;
  }, []);
  /**
   * WHAT THE COMPRESSION SAVED on the most recent pick — `null` when nothing was re-encoded, which
   * is every pick containing no picture and every pick at quality Original. Held as the two totals
   * rather than as a rendered sentence so the copy stays in the catalog.
   */
  const [compressed, setCompressed] = useState<{ from: number; to: number } | null>(null);
  /** Files a pick skipped because identical bytes under the same name are already in the list. */
  const [duplicates, setDuplicates] = useState<string[]>([]);
  /** The dial moved while files were attached — say what the change does NOT touch. */
  const [scopeNote, setScopeNote] = useState(false);

  const pick = useCallback(() => {
    setError(null);
    setCompressed(null);
    setDuplicates([]);
    inputRef.current?.click();
  }, []);

  /**
   * RE-ENCODE THE PICTURES ALREADY ATTACHED at the level the dial just moved to — the other half
   * of the dial, and the half it long disclaimed ("files already attached keep their size").
   * Owner ruling: the setting applies to what is on the message, not only to the next pick.
   *
   * ── FROM THE SOURCE, ALWAYS ────────────────────────────────────────────────────────────────
   * Every candidate is re-run through {@link compressImage} over its retained PRISTINE source
   * (see `sources`), never over the current encode: encode-of-encode is generational loss, and
   * a move to Original must yield the exact picked bytes — which it does here, because
   * `compressImage(source, "original")` answers the source identically. A file with no retained
   * source (a list restored without bytes) and a file whose re-encode equals what it already
   * carries are left untouched, OBJECT IDENTITY INCLUDED, so non-images and incompressible
   * files pass through a move as if it never happened.
   *
   * ── ONE ATOMIC COMMIT, RECONCILED, GENERATION-GUARDED ──────────────────────────────────────
   * The pass is async and the composer stays live under it, so three races are closed by
   * construction rather than by luck:
   *   · A SEND mid-pass reads the caller's state, which this pass has not touched yet — the
   *     settled pre-move encodes. The commit is a single `onChange` carrying every replacement
   *     at once, so no observable list ever mixes two levels for one source. Pinned by test.
   *   · A PICK or REMOVE mid-pass lands in `attachmentsRef` before the commit reads it: the
   *     commit maps over the LATEST list, replacing only rows it re-encoded and keeping
   *     everything else — including rows added mid-pass, which the pick already encoded at the
   *     new level (`onFiles` reads `levelRef` at pick time).
   *   · A SECOND MOVE mid-pass bumps `requalifyGen`; the older pass notices and yields — its
   *     superseded encodes are discarded, never committed over the newer level.
   *
   * ── THE CAP STILL GOVERNS, OVER THE WHOLE LIST ─────────────────────────────────────────────
   * A move UP (toward Original) can grow the total past the cap. Admission is judged against the
   * PROJECTED FINAL TOTAL of the whole list — a prefix walk admitted a grow before it had counted
   * the untouched rows behind it, and the committed list then exceeded the cap the send enforces
   * (review finding). Shrinks land first (they only make room), then grows in list order while
   * the projection holds; a row whose re-encode would cross the cap keeps its previous bytes —
   * the least destructive honest answer (the file was admitted; a dial move must not eject it) —
   * and the refusal is said on screen with the same number the send enforces, read at COMMIT
   * time, because an inline reply's mailbox can change under the pass.
   */
  const requalify = useCallback(
    async (nextLevel: ImageQualityLevel, over?: readonly ComposeAttachment[]) => {
      const gen = ++requalifyGen.current;
      // `over` is the intake's hand-off: its commit is a setState the renderer has not flushed
      // yet, so a pass kicked in the same tick would enumerate a ref one commit behind and skip
      // the rows the kick exists to re-encode. The COMMIT below still reconciles against the
      // ref, which has caught up by then (the encodes cross real tasks).
      const snapshot = over ?? attachmentsRef.current;
      /** att → its re-encode and the numbers the notes render. */
      const replacements = new Map<
        ComposeAttachment,
        { next: ComposeAttachment; bytes: number; originalBytes: number; compressed: boolean }
      >();
      for (const att of snapshot) {
        const source = ATTACHMENT_SOURCES.get(att);
        if (!source) continue;
        const picture = await compressImage(source.blob, nextLevel);
        if (gen !== requalifyGen.current) return; // superseded — the newer move owns the list
        let contentBase64: string;
        if (picture.blob === source.blob) {
          // The source itself (Original, or "would not get smaller"): its encoding is cached
          // once and reused, so toggling the dial never re-reads megabytes it already read.
          source.originalBase64 ??= await readAsBase64(source.blob);
          contentBase64 = source.originalBase64;
        } else {
          contentBase64 = await readAsBase64(picture.blob);
        }
        if (gen !== requalifyGen.current) return; // superseded — the newer move owns the list
        if (contentBase64 === att.contentBase64) {
          source.encodedLevel = nextLevel; // the bytes already ARE this level's — stamp and keep
          continue;
        }
        const next: ComposeAttachment = {
          filename: att.filename,
          contentType: picture.contentType,
          contentBase64,
        };
        // The replacement inherits the SAME source record — the next move re-encodes from the
        // same pristine bytes, the cached original encoding rides along — re-stamped with the
        // level this encode was made at, which is what the mount-time convergence reads.
        ATTACHMENT_SOURCES.set(next, { ...source, encodedLevel: nextLevel });
        replacements.set(att, {
          next,
          bytes: picture.bytes,
          originalBytes: picture.originalBytes,
          compressed: picture.compressed,
        });
      }
      if (gen !== requalifyGen.current) return; // superseded — the newer move owns the list
      if (replacements.size === 0) return; // nothing compressible moved — the list stands

      // THE COMMIT — one pass over the LATEST list, one `onChange`, through the LATEST closure
      // and against the LATEST cap (see the refs above). Rows the user added or removed while
      // the encodes ran are respected.
      //
      // The hand-off outranks a ref the renderer has not caught up with: a kicked pass starts in
      // the same tick as the intake's own commit, so the ref can still hold the list that commit
      // EXTENDED. Recognised EXPLICITLY — the intake marks its committed list pending and the
      // render that receives it clears the mark — never inferred from shapes: a user clearing
      // the list's tail mid-pass also leaves the ref a prefix of the hand-off, and a shape test
      // read that removal as an unflushed render and resurrected the removed file (review
      // finding).
      const refList = attachmentsRef.current;
      const latest = over !== undefined && pendingFlush.current === over ? over : refList;

      // CONVERGENCE COLLAPSES DUPLICATES FIRST, on the TARGET encodes, before the cap projects:
      // rows whose targets are byte-identical twins under one name exist only through a race
      // this pass settles (a re-pick mid-move beside the row the move re-encoded — the admit
      // path forbids the pair up front). Collapsing AFTER admission was incomplete: a
      // cap-refused grow keeps its old bytes, the keys then differ, and the same file rides the
      // send twice (review finding). First occurrence stands; the cap projects over what will
      // be kept.
      const targetOf = (att: ComposeAttachment): ComposeAttachment =>
        replacements.get(att)?.next ?? att;
      const seenTargets = new Set<string>();
      const rows: ComposeAttachment[] = [];
      for (const att of latest) {
        const target = targetOf(att);
        const key = `${target.filename}\u0000${target.contentBase64}`;
        if (seenTargets.has(key)) continue; // the race's twin — dropped before it can diverge
        seenTargets.add(key);
        rows.push(att);
      }

      // Admission projects the WHOLE-LIST total: shrinks first (they only make room), grows in
      // list order while the projection stays under the cap — see the header note.
      const cap = maxTotalBytesRef.current;
      const deltaOf = (att: ComposeAttachment, bytes: number): number =>
        bytes - base64Bytes(att.contentBase64);
      let total = totalBytes(rows);
      const landed = new Set<ComposeAttachment>();
      for (const att of rows) {
        const r = replacements.get(att);
        if (r && deltaOf(att, r.bytes) <= 0) {
          landed.add(att);
          total += deltaOf(att, r.bytes);
        }
      }
      let capKept = false;
      for (const att of rows) {
        const r = replacements.get(att);
        if (!r || landed.has(att)) continue;
        const delta = deltaOf(att, r.bytes);
        if (total + delta <= cap) {
          landed.add(att);
          total += delta;
        } else {
          capKept = true; // the re-encode would cross the cap — the admitted bytes stay
        }
      }
      let savedFrom = 0;
      let savedTo = 0;
      const committed = rows.map((att) => {
        const r = replacements.get(att);
        if (!r || !landed.has(att)) return att;
        if (r.compressed) {
          savedFrom += r.originalBytes;
          savedTo += r.bytes;
        }
        return r.next;
      });
      setError(capKept ? t("attachQualityCap", { size: formatSize(cap) }) : null);
      setCompressed(savedFrom > 0 ? { from: savedFrom, to: savedTo } : null);
      if (committed.length !== latest.length || committed.some((a, i) => a !== latest[i])) {
        onChangeRef.current(committed);
      }
    },
    [t],
  );

  /*
   * CONVERGE WHAT NAVIGATION LEFT BEHIND — once, on mount. The list outlives this control (the
   * shell keeps the form across views) while an unmount kills any in-flight re-encode pass — the
   * discard guard, and deliberately so: a component cannot tell a navigation from a discard from
   * the inside, and a stale pass resurrecting a thrown-away message is the worse failure. What
   * navigation may therefore leave is rows encoded at a level the dial no longer shows. The
   * source records carry the level each row's encode was made at, so this asks only when a row
   * is actually behind, and the pass is the ordinary one — atomic, generation-guarded,
   * identity-skipping rows already right. (A pick dropped mid-navigation is the accepted residue
   * of the discard guard: the file never entered the list, the user watches it not appear, and
   * re-picking costs one gesture — a resurrected discard costs a message they meant to destroy.)
   */
  useEffect(() => {
    const stored = levelRef.current;
    const behind = attachmentsRef.current.some((a) => {
      const s = ATTACHMENT_SOURCES.get(a);
      return s !== undefined && s.encodedLevel !== stored;
    });
    if (behind) void requalify(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount, after the stored level lands above
  }, []);

  const onFiles = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      setError(null);
      setCompressed(null);
      setDuplicates([]);
      // THIS SURFACE'S DIAL, once per pick, off the ref — inside the handler because the level
      // must be the one on screen at the moment of the pick, not the one a stale closure holds.
      const level = levelRef.current;
      let refused = false;
      const skippedEarly: string[] = [];
      const picked: Array<{
        /** Absent on a DEMOTED candidate: the cap dipped below it mid-batch, its base64 was
            evicted for memory, and the COMMIT reconsiders it against the final cap — a dip that
            restored must not cost a file it would admit. The source and its measured numbers
            stay so the reconsideration can re-encode without guessing. */
        attachment?: ComposeAttachment;
        file: File;
        filename: string;
        bytes: number;
        originalBytes: number;
        compressed: boolean;
      }> = [];
      for (const file of Array.from(fileList)) {
        try {
          // BEFORE THE CAP CHECK. The whole value of compressing on the client is that it changes
          // which files are admissible, and it cannot do that from behind the check that refuses
          // them. See the header note. Admission itself is deferred to the COMMIT below, against
          // the list as it stands then — a dial move can re-encode rows while these files decode,
          // and a cap judged against the list as it stood at pick time would admit or refuse
          // against sizes that no longer exist.
          const picture = await compressImage(file, level);
          // REFUSE THE UNADMITTABLE BEFORE ENCODING IT. `readAsBase64` allocates ~4/3 of the
          // file as a string, so what can never be admitted must be turned away on its SIZE —
          // known right here — rather than after the tab has paid to encode it: a single file
          // over the cap, and equally the tail of a batch whose accepted files already fill it
          // (ten near-cap files would otherwise stage hundreds of MB of strings for a commit
          // that admits one — review finding). The bound is REPROJECTED per file against the
          // cap and the list AS THEY STAND NOW, never a running reservation: a reservation
          // treats tentative staging as final admission, so a cap lowered (or a row removed)
          // mid-batch kept charging for a staged file the commit was going to refuse and turned
          // away a later file that fit (review finding). A staged candidate counts only while
          // the current cap would still admit it; duplicates were skipped at their encode and
          // never stage. The COMMIT below remains the authority on admission.
          const capNow = maxTotalBytesRef.current;
          let projected = totalBytes(attachmentsRef.current);
          for (const p of picked) {
            if (p.attachment !== undefined && projected + p.bytes <= capNow) {
              projected += p.bytes;
            } else if (p.attachment !== undefined) {
              // DEMOTED, NOT DISCARDED. A stranded candidate's base64 held in `picked` is
              // exactly the allocation this guard exists to bound — leaving it resident while
              // later files stage another cap's worth re-opens the OOM this closes (review
              // finding). But the CAP IS LIVE and may restore before the commit, so the bytes
              // are dropped while the candidate stands: the commit reconsiders it against the
              // final cap and re-encodes from its retained source if it fits (review finding —
              // a permanent discard here made a transient dip cost an admissible file).
              p.attachment = undefined;
            }
          }
          if (picture.bytes > capNow || projected + picture.bytes > capNow) {
            refused = true;
            continue;
          }
          const contentBase64 = await readAsBase64(picture.blob);
          const filename = file.name || "attachment";
          const attachment: ComposeAttachment = {
            filename,
            contentType: picture.contentType,
            contentBase64,
          };
          /* THE SAME FILE TWICE IS A SKIP, NOT A SECOND ROW — detected the moment its bytes are
             known, so a duplicate neither spends the memory bound above nor a slot below. The
             commit re-checks against the list as it stands then; this early skip is what keeps
             the bound honest. */
          if (
            [...attachmentsRef.current, ...picked.map((p) => p.attachment)].some(
              (a) => a !== undefined && a.filename === filename && a.contentBase64 === contentBase64,
            )
          ) {
            skippedEarly.push(filename);
            continue;
          }
          // The pristine source, retained for the dial (see ATTACHMENT_SOURCES). When the
          // admitted bytes ARE the source (Original, or a file the shrink could not help), the
          // base64 in hand is the source's own encoding — cache it so a move never re-reads it.
          ATTACHMENT_SOURCES.set(attachment, {
            blob: file,
            encodedLevel: level,
            ...(picture.blob === file ? { originalBase64: contentBase64 } : {}),
          });
          picked.push({
            attachment,
            file,
            filename,
            bytes: picture.bytes,
            originalBytes: picture.originalBytes,
            compressed: picture.compressed,
          });
        } catch {
          refused = true;
        }
      }

      // A pick landing after the compose was discarded must not repopulate it — see `mounted`.
      if (!mounted.current) return;

      // THE COMMIT — against the list as it stands NOW, in one `onChange` through the latest
      // closure. `attachments` (the closure copy) may be a level behind: a re-encode pass can
      // have replaced rows while these files decoded, and a commit built on the snapshot would
      // silently revert them (review finding).
      const latest = attachmentsRef.current;
      const cap = maxTotalBytesRef.current;
      let running = totalBytes(latest);
      const admitted: ComposeAttachment[] = [];
      const skipped: string[] = [...skippedEarly];
      let savedFrom = 0;
      let savedTo = 0;
      for (const p of picked) {
        let attachment = p.attachment;
        if (attachment === undefined) {
          /* DEMOTED mid-batch: the cap dipped below it and its bytes were evicted. The FINAL
             live cap decides — a dip that restored re-admits the file, re-encoded from its
             retained source at the level of its pick; a dip that held refuses it, which is the
             answer the commit would have given anyway. */
          if (running + p.bytes > cap) {
            refused = true;
            continue;
          }
          const picture = await compressImage(p.file, level);
          const contentBase64 = await readAsBase64(picture.blob);
          attachment = {
            filename: p.filename,
            contentType: picture.contentType,
            contentBase64,
          };
          ATTACHMENT_SOURCES.set(attachment, {
            blob: p.file,
            encodedLevel: level,
            ...(picture.blob === p.file ? { originalBase64: contentBase64 } : {}),
          });
        }
        /* THE SAME FILE TWICE IS A SKIP, NOT A SECOND ROW. Same name and byte-identical
           content is the same attachment, and two indistinguishable rows invite deleting the
           wrong one — or mailing both. Compared on the ADMITTED bytes, against the list the
           commit will actually extend. */
        if (
          [...latest, ...admitted].some(
            (a) => a.filename === attachment!.filename && a.contentBase64 === attachment!.contentBase64,
          )
        ) {
          skipped.push(attachment.filename);
          continue;
        }
        if (running + p.bytes > cap) {
          refused = true;
          continue;
        }
        admitted.push(attachment);
        running += p.bytes;
        if (p.compressed) {
          savedFrom += p.originalBytes;
          savedTo += p.bytes;
        }
      }
      if (refused) {
        setError(t("attachRefused", { size: formatSize(cap) }));
      }
      // The totals of this pick, not of the list: the sentence explains what just happened to the
      // files being added, and for the single-picture case — which is nearly all of them — the two
      // numbers are that picture's own.
      if (savedFrom > 0) setCompressed({ from: savedFrom, to: savedTo });
      if (skipped.length > 0) setDuplicates(skipped);
      if (admitted.length > 0) {
        const committed = [...latest, ...admitted];
        pendingFlush.current = committed; // cleared by the render that receives it — see the ref
        onChangeRef.current(committed);
        // The dial may have moved while these files decoded — they were encoded at the level of
        // their PICK, which is the level the user has since moved off. Land the whole list at
        // the level chosen last: sources are retained, and the pass commits atomically like any
        // other, so no observable list mixes levels longer than one pass. The just-committed
        // list rides along because the renderer has not flushed it into the ref yet.
        if (levelRef.current !== level) void requalify(levelRef.current, committed);
      }
      // Clear the native input so re-picking the same file fires `change` again.
      if (inputRef.current) inputRef.current.value = "";
    },
    [t, requalify],
  );


  /**
   * PASTE AND DROP, ON THE CALLER'S SURFACE. Native listeners rather than React props because
   * the surface is the caller's element (the compose wrap, the reply panel), not something this
   * component renders. `dragover` must prevent default or the browser never allows the drop and
   * — for a file dropped anywhere else — navigates away to it. The recipient rows' own chip
   * drags carry no `Files` entry, so they pass through untouched.
   */
  useEffect(() => {
    const zone = dropZone?.current;
    if (!zone || disabled) return;
    const hasFiles = (dt: DataTransfer | null): boolean =>
      Array.from(dt?.types ?? []).includes("Files");
    const onPaste = (e: ClipboardEvent): void => {
      const files = e.clipboardData?.files;
      if (!files || files.length === 0) return;
      e.preventDefault(); // the editor takes no images; the paste is an attach
      void onFiles(files);
    };
    const onDragOver = (e: DragEvent): void => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
    };
    const onDrop = (e: DragEvent): void => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      void onFiles(e.dataTransfer?.files ?? null);
    };
    zone.addEventListener("paste", onPaste);
    zone.addEventListener("dragover", onDragOver);
    zone.addEventListener("drop", onDrop);
    return () => {
      zone.removeEventListener("paste", onPaste);
      zone.removeEventListener("dragover", onDragOver);
      zone.removeEventListener("drop", onDrop);
    };
  }, [dropZone, disabled, onFiles]);

  const remove = useCallback(
    (index: number) => {
      setError(null);
      // The note described a pick that no longer stands once one of its files is gone. Dropping it
      // is the honest move; recomputing it would mean claiming a saving for bytes still in the list.
      setCompressed(null);
      setDuplicates([]);
      const next = attachments.filter((_, i) => i !== index);
      // Nothing "already attached" is left for the scope note to be about.
      if (next.length === 0) setScopeNote(false);
      onChange(next);
    },
    [attachments, onChange],
  );

  const used = totalBytes(attachments);

  return (
    <div className="compose-attach">
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        disabled={disabled}
        onChange={(e) => void onFiles(e.target.files)}
      />
      <div className="compose-attach-row">
        <Button variant="ghost" onClick={pick} disabled={disabled}>
          <Icon name="clip" size={14} /> {t("attach")}
        </Button>
        {/* THE CLAIM, RENDERED FROM THE NUMBER THAT WILL BE ENFORCED. Both branches take
            `maxTotalBytes` — the same value `onFiles` refuses against — so the sentence and the
            rule cannot drift. It used to read a hard-coded 3 MB while the server's answer depended
            on the mailbox. */}
        <span className="compose-attach-cap">
          {attachments.length > 0
            ? t("attachUsed", { used: formatSize(used), total: formatSize(maxTotalBytes) })
            : t("attachCap", { size: formatSize(maxTotalBytes) })}
        </span>
        {/* THE DIAL — the account's, remembered: a move here is what the next compose on this
            account opens at, and it is the same per-account value the Settings row edits (see
            the header). It applies to the NEXT pick AND to the pictures already attached, which
            are re-encoded from their retained sources (`requalify`); moving it while any are
            attached says so in the note below. */}
        <label className="compose-attach-level" htmlFor={levelId}>
          {t("attachQualityLabel")}
          <select
            id={levelId}
            value={level}
            disabled={disabled}
            onChange={(e) => {
              const next = e.target.value;
              if (!isImageQualityLevel(next) || next === level) return;
              // Storage first, then the control — the Settings row's own pairing, so the next
              // pick (which reads the ref) and the next mount (which reads the store) agree.
              writeImageQualityLevel(next, owner.current);
              levelRef.current = next;
              setLevel(next);
              if (attachments.length > 0) {
                setScopeNote(true);
                void requalify(next);
              }
            }}
          >
            {LEVEL_CHOICES.map((id) => (
              <option key={id} value={id}>
                {ts(`imageQualityLevel.${id}`)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* THE SCOPE, SAID WHERE THE DIAL MOVED: the new level takes the pictures already attached
          with it — re-encoded from their originals, sizes updating in the rows above — and other
          files stay as they are. `role="status"` because the change happens with focus on the
          select — a visible-only sentence would be silent for exactly the person it informs. */}
      {scopeNote ? (
        <p className="compose-attach-scope" role="status">{t("attachQualityScope")}</p>
      ) : null}

      {attachments.length > 0 ? (
        <ul className="compose-attach-list">
          {attachments.map((a, i) => (
            <li key={`${a.filename}-${i}`} className="compose-attach-item">
              <Icon name="clip" size={12} />
              <span className="compose-attach-name">{a.filename}</span>
              <span className="compose-attach-size">{formatSize(base64Bytes(a.contentBase64))}</span>
              <button
                type="button"
                className="compose-attach-remove"
                aria-label={t("attachRemove", { filename: a.filename })}
                disabled={disabled}
                onClick={() => remove(i)}
              >
                <Icon name="x" size={12} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {/* WHAT WAS DONE TO THE FILES, said quietly and only when it happened. Plain muted text and
          not the refusal's tinted panel: nothing went wrong, and a picture that got smaller is not
          news the way a file that was turned away is. No `role="alert"` for the same reason — this
          must not interrupt a screen reader mid-sentence; it is read when the region is reached. */}
      {compressed ? (
        <p className="compose-attach-saved">
          {t("attachCompressed", { from: formatSize(compressed.from), to: formatSize(compressed.to) })}
        </p>
      ) : null}

      {/* A SKIP IS SAID, NOT SWALLOWED: a pick that silently added nothing reads as a broken
          picker. The muted register, not the error's — nothing went wrong; the file is already
          on the message. */}
      {duplicates.length > 0 ? (
        <p className="compose-attach-duplicate" role="status">
          {t("attachDuplicate", { filenames: duplicates.join(", ") })}
        </p>
      ) : null}

      {error ? <p className="compose-attach-error" role="alert">{error}</p> : null}
    </div>
  );
}
