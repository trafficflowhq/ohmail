"use client";

/**
 * Compose attachments — pick files, hold their bytes in memory, send them with the message. Nothing
 * is filed against the account: not `drafts`, not `attachments`, not `localStorage` (the scratch
 * buffer strips them; see `compose.ts`) — a reload starts with none. The qualification is the
 * transport: on the hosted browser client a send whose files exceed one request body uploads them to
 * private object storage first and sends references; the bytes sit there unreadable without a
 * service credential and a retention sweep removes them within 24 hours whether the send happened or
 * not — "nowhere" would be a claim the product cannot keep, and the privacy page says this too.
 */

/**
 * The cap is a UX pre-check; the server is authoritative. This control states the number up front
 * and refuses to ADD a file that would cross it, so a person learns at pick time, not at a failed
 * send; the number is a PROP, not a constant ({@link composeAttachCap}). Pictures are shrunk FIRST
 * and the cap applies to the shrunk size — the common attachment is a six-megabyte phone photo
 * against a three-megabyte cap, and a compressor that runs only on files that already fit never
 * runs on the one that needed it. Decode → re-encode → measure → admit or refuse; the transform, the
 * level table and the keep-the-original guard live in `./image-quality`.
 */

/**
 * The dial, in the row it acts on — one value per account. It edits the account's own preference,
 * the SAME value Settings → General edits through the same two functions; the key is per account
 * (`imageQualityKeyFor`, `storageOwner`'s id) because the old account-less key silently rewrote the
 * preference for everyone who signs in on the machine. A move re-encodes the pictures already
 * attached — owner ruling — from the pristine SOURCE bytes ({@link ATTACHMENT_SOURCES}), never from
 * the previous encode: re-compressing an encode is generational loss, and a move back to Original
 * must recover the exact bytes. The pass is async; its commit is ONE atomic list replacement, so a
 * send mid-pass never sends a torn mix. Low → Medium → High → Original; Settings renders the same.
 */

/**
 * Pasted and dropped files are picks too: the body takes no images (the product's rule), so a pasted
 * picture used to do nothing and a dropped file navigated the browser away. Both land here through
 * the same admit pipeline (shrink → cap → duplicate check → notes); the caller hands this component
 * the surface to listen on (`dropZone`). The two strings that state the cap are catalogue keys
 * (`compose.attach*`) taking the rendered size as a parameter — they were inline literals holding a
 * hard-coded "3 MB", the exact drift this removes in the one place a user reads a promise.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Icon, formatFileSize } from "@ohmail/ui";
import {
  COMPOSE_ATTACH_MAX_TOTAL_BYTES,
  type ComposeAttachCapBinding,
  type ComposeAttachment,
} from "@ohmail/client-engine";
import {
  DEFAULT_IMAGE_QUALITY_LEVEL,
  IMAGE_QUALITY_LEVELS,
  type ImageQualityLevel,
  compressImage,
  isImageQualityLevel,
  readImageQualityLevel,
  writeImageQualityLevel,
} from "./image-quality";
import { activeFormatLocale } from "../shell/locale";
import { storageOwner } from "../shell/storage-owner";

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
 * THE BOUND LIVES IN `@ohmail/client-engine` (`attach-cap.ts`) so the phone composer reads the
 * SAME rule the web and desktop forms state (two surfaces once stated different caps). Re-exported
 * under the same names — every consumer and the `compose-attach-cap-parity` pin resolve unchanged.
 */
export {
  COMPOSE_ATTACH_MAX_TOTAL_BYTES,
  COMPOSE_ATTACH_MIME_ENVELOPE_BYTES,
  COMPOSE_ATTACH_STAGED_SURFACE_BYTES,
  composeAttachBudgetFor,
  composeAttachCap,
  composeAttachCapBinding,
  type ComposeAttachCapBinding,
} from "@ohmail/client-engine";

/**
 * The pristine source of every admitted attachment, keyed by the attachment object itself — at
 * MODULE scope, deliberately. A dial move re-encodes from the PICKED bytes (re-encoding the previous
 * encode compounds loss, and a move to Original must recover the exact file), and the map lives
 * outside the component because the list does: `AppShell` owns `fields.attachments` so the compose
 * survives navigation, and a map in component state died with the unmount — every lookup missed and
 * the dial silently did nothing while the note claimed otherwise (review finding). Keyed weakly, so
 * a removed row or closed compose releases its bytes; a list restored without bytes (a reload) has
 * no entries and is left untouched. `originalBase64` is computed at most once and reused.
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

/**
 * The shared formatter, in the reader's own language — see `@ohmail/ui`'s `formatFileSize`.
 *
 * This copy was 1024-based where the two reading surfaces are 1000-based, so the composer and the
 * attachment strip named different sizes for the same file, and the cap sentence stated a number
 * the reading pane would not have agreed with. One law now; the cap reads as the Finder reads it.
 */
function formatSize(bytes: number): string {
  return formatFileSize(bytes, activeFormatLocale());
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
  onAttaching,
  disabled,
  maxTotalBytes = COMPOSE_ATTACH_MAX_TOTAL_BYTES,
  capBinding,
  dropZone,
}: {
  attachments: ComposeAttachment[];
  onChange: (next: ComposeAttachment[]) => void;
  /**
   * WHICH FILES ARE STILL BECOMING ATTACHMENTS — the names, while a pick is converting, and an
   * empty list when nothing is. A pick decodes and re-encodes off the main path and commits in one
   * `onChange` at the end, so between the press and that commit the form holds a message the
   * person believes carries a file it does not: Send used to snapshot exactly that. The sending
   * surface joins this to its own lock and says which file it is waiting for.
   *
   * ABSENT where a harness mounts this component bare. A caller that takes it is refusing a send;
   * a caller that does not is where it always was, so the prop cannot silently disarm a lock.
   */
  onAttaching?: (files: readonly string[]) => void;
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
   * WHY THE STATED CAP IS THE NUMBER IT IS — {@link composeAttachCapBinding} of the SAME two
   * inputs the caller derived `maxTotalBytes` from. Only `"surface"` renders anything: it means
   * this window's transport is the smaller ceiling and the mail server would take more, which is
   * the one case a person cannot work out from the number. The paired desktop's Cloud door states
   * 3 MB where the hosted browser states 38 MB for the same account and both are right; without
   * the clause that reads as the product disagreeing with itself.
   *
   * ABSENT says nothing, so a caller that has not been taught it renders exactly what it did.
   */
  capBinding?: ComposeAttachCapBinding;
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
  const onAttachingRef = useRef(onAttaching);
  onAttachingRef.current = onAttaching;
  /**
   * THE PICKS IN FLIGHT, keyed by their own number: two picks can overlap (a drop while a paste
   * decodes), and a single boolean would have the first one to settle announce that nothing is
   * attaching while the other still is. The report is the union, in pick order.
   */
  const picksInFlight = useRef(new Map<number, readonly string[]>());
  const pickSeq = useRef(0);
  const reportAttaching = useRef((): void => {
    onAttachingRef.current?.([...picksInFlight.current.values()].flat());
  });
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
  /** Whose preference the dial edits — `storageOwner`'s id, `null` where there is none. */
  const owner = useRef<string | null>(null);
  useEffect(() => {
    owner.current = storageOwner();
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
   * Re-encode the pictures already attached at the level the dial just moved to — the other
   * half of the dial (owner ruling: the setting applies to what is on the message, not only the
   * next pick). Every candidate re-runs through {@link compressImage} over its retained
   * PRISTINE source (`sources`), never the current encode: encode-of-encode is generational
   * loss, and a move to Original must yield the exact picked bytes — `compressImage(source,
   * "original")` answers the source identically. A file with no retained source and a file
   * whose re-encode equals what it carries are left untouched, object identity included, so
   * non-images and incompressible files pass through a move as if it never happened.
   */

  /**
   * One atomic commit, reconciled, generation-guarded — the pass is async and the composer stays live under it, so
   * three races are closed by construction. A SEND mid-pass reads the caller's state, untouched by the pass — the
   * settled pre-move encodes; the commit is a single `onChange` carrying every replacement at once, so no observable
   * list mixes two levels for one source (pinned by test). A PICK or REMOVE mid-pass lands in `attachmentsRef` before
   * the commit reads it: the commit maps over the LATEST list, replacing only rows it re-encoded (a mid-pass pick was
   * already encoded at the new level — `onFiles` reads `levelRef` at pick time). A SECOND MOVE bumps `requalifyGen`;
   * the older pass yields and its superseded encodes are never committed.
   */

  /**
   * The cap still governs, over the whole list. A move UP can grow the total past the cap, and
   * admission is judged against the PROJECTED FINAL TOTAL — a prefix walk admitted a grow
   * before counting the untouched rows behind it, and the committed list exceeded the cap the
   * send enforces (review finding). Shrinks land first (they only make room), then grows in
   * list order while the projection holds; a row whose re-encode would cross the cap keeps its
   * previous bytes — the least destructive honest answer, since a dial move must not eject an
   * admitted file — and the refusal is said on screen with the same number the send enforces,
   * read at COMMIT time, because an inline reply's mailbox can change under the pass.
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

      // THE COMMIT — one pass over the LATEST list, one `onChange`, through the LATEST closure and against the LATEST
      // cap (see the refs above). Rows the user added or removed while the encodes ran are respected. The hand-off
      // outranks a ref the renderer has not caught up with: a kicked pass starts in the same tick as the intake's own
      // commit, so the ref can still hold the list that commit EXTENDED. Recognised EXPLICITLY — the intake marks its
      // committed list pending and the render that receives it clears the mark — never inferred from shapes: a user
      // clearing the list's tail mid-pass also leaves the ref a prefix of the hand-off, and a shape test read that
      // removal as an unflushed render and resurrected the removed file (review finding).
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

  /**
   * CONVERGE WHAT NAVIGATION LEFT BEHIND — once, on mount. The list outlives this control (the shell keeps the form
   * across views) while an unmount kills any in-flight re-encode pass — the discard guard, and deliberately so: a
   * component cannot tell a navigation from a discard from the inside, and a stale pass resurrecting a thrown-away
   * message is the worse failure. What navigation may therefore leave is rows encoded at a level the dial no longer
   * shows. The source records carry the level each row's encode was made at, so this asks only when a row is actually
   * behind, and the pass is the ordinary one — atomic, generation-guarded, identity-skipping rows already right.
   */

  /**
   * (A pick dropped mid-navigation is the accepted residue of the discard guard: the file never entered the list, the
   * user watches it not appear, and re-picking costs one gesture — a resurrected discard costs a message they meant
   * to destroy.)
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
      /* THE LOCK IS TAKEN BEFORE THE FIRST AWAIT, and given back in `finally` — a refused file, a
         discarded compose and an ordinary commit all end the same way, or a send stays blocked
         over a pick that is no longer happening. */
      const pick = ++pickSeq.current;
      picksInFlight.current.set(pick, Array.from(fileList).map((f) => f.name || "attachment"));
      reportAttaching.current();
      try {
        setError(null);
        setCompressed(null);
        setDuplicates([]);
        // THIS SURFACE'S DIAL, once per pick, off the ref — inside the handler because the level
        // must be the one on screen at the moment of the pick, not the one a stale closure holds.
        const level = levelRef.current;
        let refused = false;
        /**
         * THE STRICTEST CAP ANY REFUSAL WAS MADE UNDER — what the error line formats. The cap is
         * live, so a candidate stranded at a dipped cap and a commit refusal at the restored one
         * are refusals under DIFFERENT numbers; formatting the commit-time cap claimed a limit
         * the refused files actually fit (review finding). `refused` alone remains for failures
         * with no cap of their own (an unreadable file).
         */
        let refusedAtCap: number | null = null;
        const refuseAt = (c: number): void => {
          refusedAtCap = refusedAtCap === null ? c : Math.min(refusedAtCap, c);
        };
        const skippedEarly: string[] = [];
        const picked: Array<{
          attachment: ComposeAttachment;
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
            // REFUSE THE UNADMITTABLE BEFORE ENCODING IT. `readAsBase64` allocates ~4/3 of the file as a string, so
            // what can never be admitted must be turned away on its SIZE — known right here — rather than after the tab
            // has paid to encode it: a single file over the cap, and equally the tail of a batch whose accepted files
            // already fill it (ten near-cap files would otherwise stage hundreds of MB of strings for a commit that
            // admits one — review finding). The bound is REPROJECTED per file against the cap and the list AS THEY
            // STAND NOW, never a running reservation: a reservation treats tentative staging as final admission, so a
            // cap lowered (or a row removed) mid-batch kept charging for a staged file the commit was going to refuse
            // and turned away a later file that fit (review finding).

            // A staged candidate counts only while the current cap would still admit it; duplicates were skipped at
            // their encode and never stage. The COMMIT below remains the authority on admission.
            const capNow = maxTotalBytesRef.current;
            let projected = totalBytes(attachmentsRef.current);
            for (let i = 0; i < picked.length; ) {
              const p = picked[i]!;
              if (projected + p.bytes <= capNow) {
                projected += p.bytes;
                i += 1;
              } else {
                /* STRANDED ⇒ REFUSED NOW, AT PICK-TIME SEMANTICS — evicted for memory AND said on
                   screen, exactly as a file picked under this cap would have been refused. The
                   alternative — keeping the candidate for the commit to reconsider under a cap
                   that might restore — was built and reverted: it put awaits back inside the
                   settled commit, and every hazard the atomic commit exists to close (a discard
                   resurrected, a stale cap honored, an unbounded staging window, a re-encode
                   whose size diverges from its accounting) came back through that door. A cap
                   dip mid-batch is a From switch inside one pick's encode loop; its cost here is
                   one stated refusal and one re-pick, never a silent loss. */
                picked.splice(i, 1);
                refuseAt(capNow);
              }
            }
            if (picture.bytes > capNow || projected + picture.bytes > capNow) {
              refuseAt(capNow);
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
                (a) => a.filename === filename && a.contentBase64 === contentBase64,
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
          /* THE SAME FILE TWICE IS A SKIP, NOT A SECOND ROW. Same name and byte-identical
             content is the same attachment, and two indistinguishable rows invite deleting the
             wrong one — or mailing both. Compared on the ADMITTED bytes, against the list the
             commit will actually extend. */
          if (
            [...latest, ...admitted].some(
              (a) => a.filename === p.attachment.filename && a.contentBase64 === p.attachment.contentBase64,
            )
          ) {
            skipped.push(p.attachment.filename);
            continue;
          }
          if (running + p.bytes > cap) {
            refuseAt(cap);
            continue;
          }
          admitted.push(p.attachment);
          running += p.bytes;
          if (p.compressed) {
            savedFrom += p.originalBytes;
            savedTo += p.bytes;
          }
        }
        /*
         * EVERY FAILURE MODE THE PICK HAD IS SAID — both sentences on a mixed batch, never one
         * standing in for the other (review finding: an exclusive branch left an unreadable file
         * reading as a second size refusal).
         *  · The cap sentence is PAST-CONDITIONAL, deliberately: it describes the refusal
         *    DECISION under the cap in force when it was made — the cap is live, and a
         *    present-tense "must stay under X" beside a header announcing a restored limit
         *    asserted two active limits at once.
         *  · The read sentence carries no number, because a read failure is not a size story.
         */
        const failures: string[] = [];
        if (refusedAtCap !== null) failures.push(t("attachRefused", { size: formatSize(refusedAtCap) }));
        if (refused) failures.push(t("attachUnreadable"));
        if (failures.length > 0) setError(failures.join(" "));
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
      } finally {
        picksInFlight.current.delete(pick);
        reportAttaching.current();
      }
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
        {/* Only where this window's transport is the smaller ceiling — see `capBinding`. */}
        {capBinding === "surface"
          ? <span className="compose-attach-why">{t("attachCapSurface")}</span>
          : null}
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
