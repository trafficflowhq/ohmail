/**
 * Composing a new message — the three fields, and the address parser. A reply inherits recipient,
 * subject, mailbox and thread from the message being answered; a compose has none of that, so this
 * module owns turning a line of typed text into recipients, and refusing to guess. It deliberately
 * knows nothing about React and nothing about send phases — `mail-send.ts` owns the state machine
 * and `canSend` — so the parsing is testable one row at a time and cannot drift into a second copy
 * of the send rule.
 */
import type { ComposeAttachment, EmailAddress, EngineDraft, EngineMutation } from "@ohmail/wire";
import type { SignatureState } from "@ohmail/client-engine";
import { fnv1a, sendFingerprint } from "@ohmail/client-engine/send-fingerprint";
import { sha256Hex } from "@trafficflow/core/diagnostics";
import { draftForwardSourceTuples, draftRevisionInput } from "@trafficflow/core/outbound-text";
import { durableRemove, durableSessionRemove, durableSessionSet, durableSet, localStorageDoor, onLocalStorageChanged } from "../storage/durable.js";
import { isDemoOwned, retiredSignOutStorageHeld } from "../storage/storage-owner.js";
import { scopeSuffix, type StorageScope } from "../storage/scope.js";
import { forwardSourceOf, forwardSourcesForSave, sourcesFromDraft, type ForwardSource } from "./forward-selection.js";
import type { DraftVersions } from "./draft-reply-control.js";
import type { RichValue } from "./rich-text.js";

/** The compose form, verbatim as typed. `to` is TEXT; `plan()` is what turns it into addresses. */
export interface ComposeFields {
  to: string;
  /**
   * Carbon and blind-carbon recipients, each ONE comma-separated string exactly like {@link to}.
   *
   * They are the same shape as `to` on purpose: the same `RecipientField` combobox drives all
   * three, the same `parseRecipients` splits them, and the same "a typo blocks the whole send"
   * rule applies (`composePlan`). A `Cc` recipient is a visible header on the delivered mail; a
   * `Bcc` recipient is delivered on the SMTP envelope and NEVER written into the headers — the
   * asymmetry is enforced at the MIME builder (`imap.ts#send`), not here, so this form only has to
   * carry two more lines of text.
   */
  cc: string;
  bcc: string;
  subject: string;
  /**
   * The message as PLAIN TEXT — the editor's own rendering when {@link html} is set.
   *
   * It stays the field every local check reads: `canSend` refuses an empty one, the optimistic
   * draft row shows it, and `writeComposeDraft` decides on it whether there is a draft to keep
   * at all. It is deliberately NOT what a plaintext recipient reads — the server derives that
   * from the sanitized markup so the two halves of a `multipart/alternative` cannot be made to
   * disagree by a client (`outbound-html.ts`).
   */
  body: string;
  /**
   * The markup, or `""` for a message with no formatting in it.
   *
   * A SECOND FIELD rather than a `RichValue` in `body`, and rather than the envelope
   * `rich-text.ts` writes: this buffer is already a JSON object, so an envelope inside it would
   * be a second encoding to keep true for nothing. The reply key needs one because it holds a
   * bare string; this one does not. It is read field-wise below, exactly like `fromMailboxId`,
   * so a buffer written before this field existed still restores as a plain draft.
   */
  html: string;
  /** Whether the body came from the drafter. Absent in older buffers. */
  aiDraft?: boolean;
  /** The letter's AI draft and original text, kept in its local recovery buffer. */
  draftVersions?: DraftVersions;
  /**
   * The sender the user picked, as a mailbox id; `null` = they did not pick one. A field on the
   * FORM rather than a derivation, because a default re-derived on every render would silently
   * revert a deliberate choice — `drafts.mailboxId` is NOT NULL and immutable after create, so the
   * pick must survive as long as the text it belongs to; it lives beside the body so leaving the
   * view throws away neither. `null` is not "no mailbox": the derived default applies. A stored id
   * is revalidated against the account's mailboxes on the way out (`resolveComposeFrom`), never
   * trusted. Never an address string — see `compose-from.ts`.
   */
  fromMailboxId: string | null;
  /**
   * Files to send with this message — held in memory only, never written to `localStorage`.
   * Attachments carry base64 bytes and a photo would blow past a quota Safari private mode refuses
   * outright, so `writeComposeDraft` keeps only the names of picked files for the recovery warning.
   * Not part of the autosaved `drafts` row either — nothing on the account stores attachment bytes
   * (§13.2/§14) — so `signatureOf`/`worthSaving` ignore it. Optional, so an old buffer reads back
   * as a draft with no files.
   */
  attachments?: ComposeAttachment[];
  /** Picked files whose bytes were lost when the draft was restored. */
  missingAttachmentNames?: readonly string[];
  /** The forwarded originals still on this draft, in message-date order. Their bytes stay in memory. */
  forwardSources?: ForwardSource[];
  /**
   * The message this compose is forwarding — an id, and nothing else. A forward is written on the ordinary compose
   * form; this one field turns it into a forward on the wire, and it deliberately carries no copy of the original —
   * not body, attachments or quote. The SERVER reads the original from the account, refuses a `no_forward` one,
   * builds the quote and streams the attachments from IMAP at send (`send-service.ts`); a client-assembled quote is
   * exactly the seam a redacted sensitive body would escape through. PERSISTED in the scratch buffer, unlike {@link
   * attachments}: one short string, and a reload that silently turned the message back into a plain compose would
   * send an empty mail with "Fwd:" on it. Guarded field-wise on read, like {@link fromMailboxId}. `null` is the
   * ordinary case; the exclusive peer of `inReplyTo` — a forward threads onto no conversation (`types.ts`).
   */
  forwardOf?: string | null;
  /**
   * The original's files kept once one was removed, beside {@link forwardOf}; `null` or absent: nothing
   * removed, every file goes. Persisted in the scratch buffer (ids only) and on the row (`draft_save`).
   */
  forwardParts?: string[] | null;
  /**
   * THE SIGNATURE BLOCK'S STATE for this message — follows the From selector until the user
   * removes or edits it, and then their choice wins (`signature.ts` owns the model and the
   * serialization). Absent means `following`, which is what every buffer written before the
   * field existed restores as. It lives on the FORM because a removal belongs to the message
   * being written: leaving the view and coming back must not resurrect a struck block, and a
   * reload restores it with the text it belongs to.
   */
  sig?: SignatureState;
  /**
   * The diagnostics block Settings › Help & contact put in {@link body}, so the composer can offer
   * to remove it or put it back (`SupportDiagnostics`). The block itself is body text.
   */
  diag?: string;
  /**
   * The person edited a recipient line in the composer (a door's prefill never sets it), so a
   * recipient alone counts as typed text worth a draft. Kept in the buffer; never on the row.
   */
  recipientsTyped?: true;
}

export const EMPTY_COMPOSE: ComposeFields = {
  to: "", cc: "", bcc: "", subject: "", body: "", html: "", fromMailboxId: null, attachments: [],
  forwardOf: null,
};

/**
 * A compose handed to the shell from OUTSIDE — the shape a host passes when the operating
 * system delivered it a `mailto:` click (`AppShell`'s `mailtoDraft` prop; the desktop's
 * `mailto.ts` is the one parser that produces it).
 *
 * Recipients are ARRAYS of plain addresses here, unlike {@link ComposeFields}' comma-separated
 * text, because the producer has already split them and the seeder formats them into chips —
 * handing a pre-joined string across the seam would mean two places knowing the separator
 * convention. The body is PLAIN text; the seeder sets `html: ""`, `openDraft`'s rule.
 */
export interface ComposePrefill {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

/**
 * `localStorage` key for the compose scratch buffer — one per ACCOUNT, not one per browser. The bare constant
 * was true about the surface and wrong about the storage: nothing cleared the key on sign-out
 * (`clearBootCaches()` removes only `ohmail.boot.`, `clearAllMirrors()` is IndexedDB), so one account's
 * unfinished message survived into the next account on the same browser, where autosave could persist it as
 * THEIR server draft. The suffix is `searchSortKey`'s shape, with the same `"local"` fallback. The storage owner is
 * the scope the mount hands in, not the cookie's alone: the standalone desktop has no cookie, so this key used to resolve to
 * `"local"` for every mailbox on the install at once — and the desktop mounts an engine per mailbox. The legacy
 * key is drained, never read "to migrate": the migrating reader has no way to know whose draft it is.
 */
/** Every owner's scratch key starts here. Exported so sign-out can sweep them. */
export const COMPOSE_DRAFT_PREFIX = "ohmail.ui.compose.";

export function composeDraftKey(owner: StorageScope): string {
  return `${COMPOSE_DRAFT_PREFIX}${scopeSuffix(owner)}.${composerId()}`;
}

/**
 * WHICH COMPOSER THIS IS — one per tab. The scratch buffer, the session and the row were keyed per
 * ACCOUNT, so every tab on the origin shared one message-in-progress, and a tab that delivered or
 * replaced its message cleared the identity another tab was still holding. The id lives in
 * `sessionStorage`, per tab and surviving a reload; a browser refusing it gets one per page.
 */
export const COMPOSER_KEY = "ohmail.compose.composer";
let composerInMemory: string | null = null;
let hostComposer: string | null = null;

/**
 * A COMPOSER THE HOST NAMES. The desktop is one window whose `sessionStorage` does not outlive the
 * app, and a quit need not fire `pagehide`, so its window names itself the composer during render,
 * as it names whose storage this is. Not id-shaped is treated as absent.
 */
export function setComposerScope(scope: string | null): void {
  hostComposer = scope !== null && /^[A-Za-z0-9_-]{1,64}$/.test(scope) ? scope : null;
}

export function composerId(): string {
  if (hostComposer !== null) return hostComposer;
  if (reminted !== null) return reminted;
  try {
    const held = window.sessionStorage.getItem(COMPOSER_KEY);
    if (held !== null && held.length > 0) return held;
    if (composerInMemory !== null) return composerInMemory;
    const minted = crypto.randomUUID();
    if (durableSessionSet(COMPOSER_KEY, minted, "compose.composer") === "stored") return minted;
    composerInMemory = minted;
    return minted;
  } catch {
    composerInMemory ??= crypto.randomUUID();
    return composerInMemory;
  }
}

/**
 * Each closed composer leaves one record per account for the next empty composer. The record
 * carries the text and its identity together, so a refused close-time write leaves the original
 * keys intact. The old account-wide slot can still be read after an upgrade.
 */
const unitPrefixes = (): readonly string[] => [COMPOSE_SESSION_PREFIX, COMPOSE_ROW_PREFIX, COMPOSE_DRAFT_PREFIX];
const UNIT_STORES = ["compose.session", "compose.row", "compose.draft"] as const;
const unitKeys = (suffix: string): string[] => unitPrefixes().map((prefix) => prefix + suffix);
const handoffPrefix = (owner: string): string => `${COMPOSE_DRAFT_PREFIX}${owner}:handoff:`;
const handoffs = localStorageDoor("compose.draft");
const detachedUnits = new Map<string, string>();
const adoptedOwners = new Set<string>();
const composeRemovals = new EventTarget();
let handoffArmed = false;

export function onComposeStorageChanged(owner: StorageScope, check: () => void): () => void {
  const scope = scopeSuffix(owner);
  const base = COMPOSE_DRAFT_PREFIX + scope;
  const stop = onLocalStorageChanged((key) => {
    if (key === null || key === base || key.startsWith(`${base}.`) || key.startsWith(handoffPrefix(scope))) check();
  });
  composeRemovals.addEventListener(scope, check);
  return () => {
    stop();
    composeRemovals.removeEventListener(scope, check);
  };
}

function removeComposeBuffer(owner: StorageScope): void {
  if (durableRemove(composeDraftKey(owner), "compose.draft") === "stored") {
    // The browser's storage event only reaches other windows.
    composeRemovals.dispatchEvent(new Event(scopeSuffix(owner)));
  }
}

function readUnit(keys: readonly string[]): (string | null)[] {
  return keys.map((key) => window.localStorage.getItem(key));
}

/** A session alone names no draft: opening the composer mints one. */
function holdsMessage(unit: readonly (string | null)[]): boolean {
  return unit[1] !== null || unit[2] !== null;
}

/** Recipients, subject, either version of the body or forwarded originals make a compose worth keeping. */
export function worthSaving(f: ComposeFields): boolean {
  return (
    f.to.trim() !== "" ||
    (f.cc ?? "").trim() !== "" ||
    (f.bcc ?? "").trim() !== "" ||
    f.subject.trim() !== "" ||
    f.body.trim() !== "" ||
    hasDraftVersionWords(f.draftVersions) ||
    (f.forwardSources?.length ?? 0) > 0
  );
}

function hasDraftVersionWords(versions: DraftVersions | undefined): boolean {
  return versions !== undefined && (versions.yours.text.trim() !== "" || versions.draft.text.trim() !== "");
}

function hasRecoveryContent(raw: string | null | undefined): boolean {
  try { return worthSaving(decodeComposeDraft(raw)); }
  catch { return false; }
}

function decodeUnit(raw: string | null): (string | null)[] | null {
  if (raw === null) return null;
  try {
    const unit: unknown = JSON.parse(raw);
    return Array.isArray(unit) && unit.length === UNIT_STORES.length
      && unit.every((value) => value === null || typeof value === "string") ? unit : null;
  } catch { return null; }
}

function detachedUnit(owner: StorageScope): (string | null)[] | null {
  const key = detachedUnits.get(scopeSuffix(owner));
  return key === undefined ? null : decodeUnit(handoffs.get(key));
}

/** A save may answer after pagehide. Keep its row and markers beside the words that moved. */
function updateDetachedUnit(owner: StorageScope, update: (unit: (string | null)[]) => void): boolean {
  const key = detachedUnits.get(scopeSuffix(owner));
  if (key === undefined) return false;
  const unit = decodeUnit(handoffs.get(key));
  if (unit !== null) {
    update(unit);
    handoffs.set(key, JSON.stringify(unit));
  }
  return true;
}

/** A leaving editor can still finish a save while its recovery copy is on disk. */
export function storedComposeDraft(owner: StorageScope): boolean {
  if (detachedUnits.has(scopeSuffix(owner))) return detachedUnit(owner)?.[2] != null;
  return handoffs.get(composeDraftKey(owner)) !== null;
}

function updateComposeBuffer(owner: StorageScope, update: (raw: string) => string): void {
  try {
    if (updateDetachedUnit(owner, (unit) => { if (unit[2] != null) unit[2] = update(unit[2]); })) return;
    const key = composeDraftKey(owner);
    const raw = window.localStorage.getItem(key);
    if (raw) durableSet(key, update(raw), "compose.draft");
  } catch { /* the marker stays in this page's memory */ }
}

function storeUnitPart(key: string, value: string | null, index: number): boolean {
  const store = UNIT_STORES[index]!;
  return (value === null ? durableRemove(key, store) : durableSet(key, value, store)) === "stored";
}

/** Write the identity before the text, and put back any parts we changed on a refusal. */
function acceptUnit(to: readonly string[], unit: readonly (string | null)[], consume: () => boolean): boolean {
  const previous = readUnit(to);
  const written: number[] = [];
  for (let i = 0; i < to.length; i += 1) {
    if (unit[i] === previous[i]) continue;
    if (!storeUnitPart(to[i]!, unit[i]!, i)) {
      for (const index of written.reverse()) storeUnitPart(to[index]!, previous[index]!, index);
      return false;
    }
    written.push(i);
  }
  if (consume()) {
    rowHolds.delete(to[2]!);
    createsMem.delete(to[2]!);
    return true;
  }
  for (const index of written.reverse()) storeUnitPart(to[index]!, previous[index]!, index);
  return false;
}

function moveUnit(from: readonly string[], to: readonly string[], unit = readUnit(from)): boolean {
  return acceptUnit(to, unit, () => removeUnit(from, unit));
}

function removeUnit(keys: readonly string[], unit: readonly (string | null)[]): boolean {
  const removed: number[] = [];
  for (let index = 0; index < keys.length; index += 1) {
    if (unit[index] === null) continue;
    if (!storeUnitPart(keys[index]!, null, index)) {
      for (const prior of removed) storeUnitPart(keys[prior]!, unit[prior]!, prior);
      return false;
    }
    removed.push(index);
  }
  rowHolds.delete(keys[2]!);
  createsMem.delete(keys[2]!);
  return true;
}

type OfferComposer = (restore: () => boolean, available: () => boolean) => void;
type RestoreOffer = { restore: () => Promise<boolean>; available: () => boolean };

type ClosedCompose = { key: string; raw: string; unit: (string | null)[]; ownTab: boolean };

function closedVersion({ unit }: ClosedCompose) {
  const [, row, raw] = unit;
  if (!row || !raw) return null;
  const { holds } = JSON.parse(raw) as { holds?: Partial<ComposeRowHolds> };
  if (holds?.row !== row || typeof holds.rev !== "string" || !holds.rev
    || typeof holds.sig !== "string" || holds.gone) return null;
  const fields = decodeComposeDraft(raw);
  const edited = holds.sig !== holdsSig(fields) || holds.pending !== undefined || fields.sig?.kind === "edited"
    || (holds.fromMailboxId !== undefined && holds.fromMailboxId !== fields.fromMailboxId);
  // Older markers lack the From choice. Their matching text can rank the copies,
  // but only the full saved proof lets recovery remove a duplicate.
  const saved = !edited && matchesSavedMarker(fields, holds, { id: row, contentRevision: holds.rev });
  return { row, revision: holds.rev, edited, saved };
}

function adoptClosedComposer(
  owner: string, own: readonly string[], live?: ReadonlySet<string>, offer?: OfferComposer,
): boolean {
  const prefix = handoffPrefix(owner);
  const mine = prefix + composerId();
  const keys = [mine, ...Object.keys(window.localStorage).filter((key) => key !== mine && key.startsWith(prefix))];
  const candidates: ClosedCompose[] = [];
  for (const key of keys) {
    const source = key.slice(prefix.length).split(":", 1)[0]!;
    const ownTab = source === composerId();
    if (!ownTab && live?.has(composerLockName(source))) continue;
    const raw = window.localStorage.getItem(key);
    if (raw === null) continue;
    const unit = decodeUnit(raw);
    if (unit === null) continue;
    if (!hasRecoveryContent(unit[2])) {
      if (handoffs.get(key) === raw) handoffs.remove(key);
      continue;
    }
    candidates.push({ key, raw, unit, ownTab });
  }
  const first = candidates[0];
  if (first) {
    // A fresh tab should recover edits made against the same saved revision before an
    // untouched copy of it. A reload still takes its own tab's work first.
    const version = closedVersion(first);
    const siblings = version === null ? [] : candidates.filter((candidate) => candidate.unit[1] === version.row)
      .map((candidate) => ({ candidate, version: closedVersion(candidate) }))
      .filter((copy) => copy.version?.revision === version.revision);
    const changed = !first.ownTab && version?.edited === false
      ? siblings.find((copy) => copy.version?.edited === true)
      : undefined;
    const selected = changed?.candidate ?? first;
    const recoveringEdits = changed !== undefined || version?.edited === true;
    const take = (unit: (string | null)[], raw: string): boolean => {
      const accepted = acceptUnit(own, unit, () =>
        handoffs.get(selected.key) === raw && handoffs.remove(selected.key) === "stored");
      if (accepted && recoveringEdits && selected.raw === raw) {
        // These copies hold only the base revision of the edits just recovered.
        for (const copy of siblings) {
          if (copy.version?.saved && handoffs.get(copy.candidate.key) === copy.candidate.raw) {
            handoffs.remove(copy.candidate.key);
          }
        }
      }
      return accepted;
    };
    if (offer && !selected.ownTab) {
      offer(() => {
        const current = handoffs.get(selected.key);
        const left = decodeUnit(current);
        if (current === null || holdsMessage(readUnit(own)) || left === null || left[0] !== selected.unit[0]
          || !hasRecoveryContent(left[2])) return false;
        return take(left, current);
      }, () => {
        const left = decodeUnit(handoffs.get(selected.key));
        return left !== null && left[0] === selected.unit[0] && hasRecoveryContent(left[2]);
      });
      return true;
    }
    const accepted = take(selected.unit, selected.raw);
    if (accepted && !selected.ownTab) unannounced.add(owner);
    return accepted;
  }
  const legacy = unitKeys(owner);
  const unit = readUnit(legacy);
  if (hasRecoveryContent(unit[2])) return moveUnit(legacy, own, unit);
  if (holdsMessage(unit)) removeUnit(legacy, unit);
  return false;
}

function adoptHandoff(owner: StorageScope): void {
  const o = scopeSuffix(owner);
  if (detachedUnits.has(o)) return;
  // Wait for the page's identity before taking anything from another composer.
  const locks = claimSettled ? null : composerLocks();
  if (locks !== null) {
    void claimComposer(locks);
    return;
  }
  if (adoptedOwners.has(o) || recoveries.has(o)) return;
  adoptedOwners.add(o);
  armHandoff();
  try {
    const own = unitKeys(`${o}.${composerId()}`);
    if (!holdsMessage(readUnit(own))) adoptClosedComposer(o, own);
  } catch { /* the browser can refuse storage reads */ }
}

/** A closing tab leaves its message for the next composer; a page kept for back/forward does not. */
export function handOffComposer(): void {
  try {
    const id = composerId();
    const suffix = `.${id}`;
    const owners = new Set<string>();
    for (const key of Object.keys(window.localStorage)) {
      const prefix = unitPrefixes().find((part) => key.startsWith(part));
      if (prefix !== undefined && key.endsWith(suffix)) owners.add(key.slice(prefix.length, -suffix.length));
    }
    for (const owner of owners) {
      const keys = unitKeys(owner + suffix);
      const unit = readUnit(keys);
      if (!holdsMessage(unit)) continue;
      const raw = JSON.stringify(unit);
      const slot = handoffPrefix(owner) + id;
      const previous = window.localStorage.getItem(slot);
      // If an earlier handoff is still waiting, keep both versions.
      const key = previous === null || previous === raw ? slot : `${slot}:${crypto.randomUUID()}`;
      if (previous !== raw && handoffs.set(key, raw) !== "stored") continue;
      detachedUnits.set(owner, key);
      keys.forEach((part, index) => storeUnitPart(part, null, index));
    }
  } catch { /* the browser can refuse storage reads */ }
}

function armHandoff(): void {
  if (handoffArmed || typeof window === "undefined") return;
  handoffArmed = true;
  window.addEventListener("pagehide", (e) => {
    if ((e as PageTransitionEvent).persisted) return;
    handOffComposer();
    // A reload keeps this tab's sessionStorage, so the next page knows this lock is about to go.
    durableSessionSet(COMPOSER_LEFT_KEY, composerId(), "compose.composer");
  });
}

/**
 * THIS PAGE'S HOLD ON ITS COMPOSER — a Web Lock named for the id, held for the page's life and let
 * go by the browser when the page goes, a crash included. "Duplicate tab" copies `sessionStorage`,
 * so a copy starts under a live page's id: that lock is taken, and the copy mints its own. A unit
 * whose composer nobody holds belongs to a tab that died without `pagehide`; a composer holding no
 * message adopts it. Only a unit written under a lock (`locked` in the buffer) is taken, because a
 * tab of an older bundle holds none and may still be open. No lock manager: nothing is asked.
 */
interface ComposerLocks {
  request(
    name: string, opts: { ifAvailable?: boolean; signal?: AbortSignal }, cb: (lock: unknown) => unknown,
  ): Promise<unknown>;
  query(): Promise<{ held?: ReadonlyArray<{ name?: string }>; pending?: ReadonlyArray<{ name?: string }> }>;
}
let reminted: string | null = null;
let composerLocked = false;
let claim: Promise<void> | null = null;
let claimSettled = false;
const recoveries = new Map<string, Promise<boolean>>();
const recoveryOffers = new Map<string, RestoreOffer>();
const unannounced = new Set<string>();
const composerLockName = (id: string): string => `${COMPOSER_KEY}.${id}`;
const RECOVERY_LOCK = `${COMPOSER_KEY}:recover`;

export function composeOrigin(): string {
  return composerId();
}

/** Resume a press only after its original page lets go, and in just one window. */
export async function recoverComposePress(source: string, take: () => Promise<void>): Promise<void> {
  const locks = composerLocks();
  const same = source === composerId();
  if (locks === null) {
    if (same) await take();
    return;
  }
  await locks.request(same ? RECOVERY_LOCK : composerLockName(source), { ifAvailable: true }, (lock) => {
    if (lock) return take();
  });
}
/** The id a page of this tab let go of at `pagehide`; a duplicate's copied storage never has it. */
const COMPOSER_LEFT_KEY = `${COMPOSER_KEY}:left`;
/** How long a reload waits for its previous page's lock before it takes an id of its own. */
const LEFT_LOCK_WAIT_MS = 2_000;
/** A lock manager that has not answered by then is read as none: the composer is never held up. */
const LOCK_ANSWER_MS = 3_000;

function composerLocks(): ComposerLocks | null {
  if (hostComposer !== null || typeof navigator === "undefined") return null;
  try {
    const l = (navigator as { locks?: Partial<ComposerLocks> }).locks;
    return typeof l?.request === "function" && typeof l.query === "function" ? l as ComposerLocks : null;
  } catch { return null; }
}

/** Take the id's lock at once, or (`waitMs`) wait that long for a leaving page to let it go. */
function holdComposer(locks: ComposerLocks, id: string, waitMs = 0): Promise<"held" | "taken" | "unknown"> {
  return new Promise((resolve) => {
    let done = false;
    const abort = waitMs > 0 ? new AbortController() : null;
    const settle = (v: "held" | "taken" | "unknown"): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      abort?.abort();
      settle(abort === null ? "unknown" : "taken");
    }, abort === null ? LOCK_ANSWER_MS : waitMs);
    try {
      locks.request(composerLockName(id), abort === null ? { ifAvailable: true } : { signal: abort.signal }, (lock) => {
        // A grant arriving after the answer was given is let go at once: this page took another id.
        if (done || lock === null) {
          settle("taken");
          return undefined;
        }
        settle("held");
        return new Promise<never>(() => {});
      }).catch((err: unknown) => {
        settle((err as { name?: unknown } | null)?.name === "AbortError" ? "taken" : "unknown");
      });
    } catch { settle("unknown"); }
  });
}

function claimComposer(locks: ComposerLocks): Promise<void> {
  claim ??= (async () => {
    try {
      const id = composerId();
      let left: string | null = null;
      try { left = window.sessionStorage.getItem(COMPOSER_LEFT_KEY); } catch { /* no jar, no reload */ }
      let got = await holdComposer(locks, id, left === id ? LEFT_LOCK_WAIT_MS : 0);
      if (got === "taken") {
        // A live page holds this id: this page is its duplicate, and takes its own.
        reminted = crypto.randomUUID();
        durableSessionSet(COMPOSER_KEY, reminted, "compose.composer");
        got = await holdComposer(locks, reminted);
      }
      if (left !== null) durableSessionRemove(COMPOSER_LEFT_KEY, "compose.composer");
      composerLocked = got === "held";
    } finally {
      claimSettled = true;
    }
  })();
  return claim;
}

const writtenUnderLock = (raw: string | null): boolean => {
  try { return (JSON.parse(raw ?? "null") as { locked?: unknown } | null)?.locked === true; }
  catch { return false; }
};

/** ONE dead tab's unit for this owner, into this composer — serialized across tabs by a lock. */
function recoverOrphan(locks: ComposerLocks, owner: string, offer?: OfferComposer): Promise<boolean> {
  let late = false;
  const run = async (): Promise<boolean> => {
    try {
      const q = await locks.query();
      // Past the bound the restore has already run, and a unit moved now would be written over.
      if (late) return false;
      const live = new Set([...(q.held ?? []), ...(q.pending ?? [])].map((l) => l.name ?? ""));
      const mine = composerId();
      const own = unitKeys(`${owner}.${mine}`);
      adoptedOwners.add(owner);
      armHandoff();
      if (holdsMessage(readUnit(own))) return false;
      if (adoptClosedComposer(owner, own, live, offer)) return false;
      const base = `${COMPOSE_DRAFT_PREFIX}${owner}.`;
      for (const k of Object.keys(window.localStorage)) {
        const id = k.startsWith(base) ? k.slice(base.length) : "";
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || id === mine || live.has(composerLockName(id))) continue;
        if (!writtenUnderLock(window.localStorage.getItem(k))) continue;
        const from = unitKeys(`${owner}.${id}`);
        const unit = readUnit(from);
        if (!hasRecoveryContent(unit[2])) {
          removeUnit(from, unit);
          continue;
        }
        if (offer) {
          const [session] = unit;
          offer(() => {
            const left = readUnit(from);
            return !holdsMessage(readUnit(own)) && left[0] === session && hasRecoveryContent(left[2]) && moveUnit(from, own, left);
          }, () => {
            const left = readUnit(from);
            return left[0] === session && hasRecoveryContent(left[2]);
          });
          return false;
        }
        return moveUnit(from, own, unit);
      }
    } catch { /* a refused jar or manager: nothing is recovered */ }
    return false;
  };
  const asked = (locks.request(RECOVERY_LOCK, {}, run) as Promise<boolean>).catch(() => false);
  const bound = new Promise<boolean>((r) => { setTimeout(() => { late = true; r(false); }, LOCK_ANSWER_MS); });
  return Promise.race([asked, bound]);
}

/**
 * Run `ready` once this page knows which composer it is. At once where nothing is asked, so a
 * window the host names and a browser without Web Locks read their unit exactly as before; every
 * read of the unit at mount waits here — the restore, and the autosave's adoption of its row.
 * A new page opening Compose can offer a different tab's unit without adopting it. That unit
 * stays where it was until the action takes it, under the same lock as automatic recovery.
 */
export function whenComposerReady(
  ready: () => void, owner: StorageScope, offer?: (restore: RestoreOffer) => void,
): () => void {
  const locks = composerLocks();
  if (locks === null) {
    ready();
    return () => {};
  }
  const o = scopeSuffix(owner);
  let r = recoveries.get(o);
  if (r === undefined) {
    const defer = offer && ((restore: () => boolean, available: () => boolean) => {
      recoveryOffers.set(o, {
        available: () => { try { return available(); } catch { return false; } },
        restore: async () => {
          try {
            const restored = await locks.request(RECOVERY_LOCK, {}, restore) === true;
            if (restored) recoveryOffers.delete(o);
            return restored;
          } catch { return false; }
        },
      });
    });
    r = claimComposer(locks).then(() => recoverOrphan(locks, o, defer)).then((got) => {
      if (got) unannounced.add(o);
      return got;
    });
    recoveries.set(o, r);
  }
  let live = true;
  void r.then(() => {
    if (live) {
      if (!adoptedOwners.has(o)) recoveries.delete(o);
      ready();
      const restore = recoveryOffers.get(o);
      if (restore?.available()) offer?.(restore);
    }
  });
  return () => { live = false; };
}

/** Did this composer take a dead tab's message? `true` once, for the one sentence that says so. */
export function takeRecoveredComposer(owner: StorageScope): boolean {
  return unannounced.delete(scopeSuffix(owner));
}

/** A fresh page, for a test: nothing adopted yet. The tab's id is the test's own sessionStorage. */
export function resetComposerForTest(): void {
  adoptedOwners.clear();
  detachedUnits.clear();
  composerInMemory = null;
  hostComposer = null;
  reminted = null;
  composerLocked = false;
  claim = null;
  claimSettled = false;
  recoveries.clear();
  recoveryOffers.clear();
  unannounced.clear();
  rowHolds.clear();
  createsMem.clear();
}

/** The un-owned key this browser may still hold. Removed on clear, never read. */
export const LEGACY_COMPOSE_DRAFT_KEY = "ohmail.ui.compose";

/**
 * The scratch buffer, and what it is NOT. This is the client's own draft, in this browser, exactly like the
 * per-message reply buffer. It is not an IMAP draft and it is not a `drafts` row on the server: nothing is written to
 * the account until Send is pressed, because a draft-per-keystroke is a write storm and an orphan-row factory (`POST
 * /drafts` has no delete-on-abandon path the client drives). Server drafts on the mailbox are a later phase, and when
 * they arrive they belong on the mailbox itself; the compose surface therefore says "kept in this browser" and
 * nothing stronger. Storage can refuse — Safari private mode throws on write — and a refusal must never break
 * composing, so every access is wrapped and a failure simply means the draft lives for as long as the tab does.
 */
export function readComposeDraft(scope: StorageScope): ComposeFields {
  adoptHandoff(scope);
  const key = composeDraftKey(scope);
  try {
    const raw = detachedUnits.has(scopeSuffix(scope)) ? detachedUnit(scope)?.[2] : window.localStorage.getItem(key);
    return decodeComposeDraft(raw);
  } catch {
    // Blocked storage, or a value some earlier version wrote in another shape. Either way an
    // empty form beats throwing inside a render.
    return EMPTY_COMPOSE;
  }
}

function readDraftVersion(value: Partial<RichValue> | undefined): RichValue | undefined {
  if (typeof value?.text !== "string" || typeof value.html !== "string") return undefined;
  return { text: value.text, html: value.html, ...(typeof value.aiDraft === "boolean" ? { aiDraft: value.aiDraft } : {}) };
}

function readDraftVersions(value: Partial<DraftVersions> | undefined): DraftVersions | undefined {
  if (value?.shown !== "yours" && value?.shown !== "draft") return undefined;
  const yours = readDraftVersion(value.yours);
  const draft = readDraftVersion(value.draft);
  return yours && draft ? { yours, draft, shown: value.shown } : undefined;
}

export type ComposeDraftRecovery = Pick<ComposeFields, "draftVersions" | "missingAttachmentNames" | "aiDraft">;

export function readComposeDraftRecovery(value: ComposeDraftRecovery | undefined): ComposeDraftRecovery | undefined {
  const draftVersions = readDraftVersions(value?.draftVersions);
  const names = Array.isArray(value?.missingAttachmentNames)
    ? value.missingAttachmentNames.filter((name) => typeof name === "string" && name !== "")
    : [];
  if (!draftVersions && names.length === 0) return undefined;
  return {
    ...(draftVersions ? { draftVersions, aiDraft: typeof value?.aiDraft === "boolean" ? value.aiDraft : undefined } : {}),
    ...(names.length ? { missingAttachmentNames: names } : {}),
  };
}

/** Picked file bytes stay in memory. Forwarded originals can be read again from their references. */
export function missingComposeFiles(fields: ComposeFields): string[] {
  const picked = fields.attachments?.filter((file) => forwardSourceOf(file) === undefined) ?? [];
  return [...(fields.missingAttachmentNames ?? []), ...picked.map((file) => file.filename)];
}

function decodeComposeDraft(raw: string | null | undefined): ComposeFields {
  if (!raw) return EMPTY_COMPOSE;
  const parsed = JSON.parse(raw) as Partial<ComposeFields>;
  const forwardSources = sourcesFromDraft(parsed.forwardSources);
  return {
    to: typeof parsed.to === "string" ? parsed.to : "",
    // Guarded field-wise like every other line here, so a buffer written before Cc/Bcc existed
    // restores as a draft with empty Cc/Bcc rather than throwing or dropping the whole draft.
    cc: typeof parsed.cc === "string" ? parsed.cc : "",
    bcc: typeof parsed.bcc === "string" ? parsed.bcc : "",
    subject: typeof parsed.subject === "string" ? parsed.subject : "",
    body: typeof parsed.body === "string" ? parsed.body : "",
    // Same field-wise guard as `fromMailboxId` below, and it is what makes a draft written
    // by the plain textarea restore as a plain draft rather than as an empty one.
    html: typeof parsed.html === "string" ? parsed.html : "",
    ...(typeof parsed.aiDraft === "boolean" ? { aiDraft: parsed.aiDraft } : {}),
    ...readComposeDraftRecovery(parsed),
    // Guarded field-wise, so a buffer written before this field existed reads back as "no
    // pick" and one
    // written after it is still readable by a bundle that predates the field. Nothing here
    // versions the shape, and nothing needs to.
    fromMailboxId: typeof parsed.fromMailboxId === "string" && parsed.fromMailboxId.length > 0
      ? parsed.fromMailboxId
      : null,
    attachments: [],
    ...(forwardSources ? { forwardSources } : {}),
    // RESTORED, because it is an id rather than bytes and losing it would turn a half-written
    // forward back into an empty message titled "Fwd: …". Guarded field-wise like
    // `fromMailboxId`: a buffer written before this field existed reads back as a plain compose.
    forwardOf: typeof parsed.forwardOf === "string" && parsed.forwardOf.length > 0
      ? parsed.forwardOf
      : null,
    // The kept files: a list of at most 100 ids, else nothing removed.
    forwardParts: Array.isArray(parsed.forwardParts) && parsed.forwardParts.length <= 100
      && parsed.forwardParts.every((id) => typeof id === "string")
      ? [...parsed.forwardParts]
      : null,
    // Guarded field-wise like its neighbours: only the three shapes the model names restore,
    // and anything else — a buffer from before the field, or a value some other version wrote
    // — reads back as `following`, which is the resting state.
    ...(parsed.sig?.kind === "removed" ? { sig: { kind: "removed" as const } }
      : parsed.sig?.kind === "edited" && typeof parsed.sig.text === "string"
        ? { sig: { kind: "edited" as const, text: parsed.sig.text } }
        : {}),
    ...(typeof parsed.diag === "string" && parsed.diag !== "" ? { diag: parsed.diag } : {}),
    ...(parsed.recipientsTyped === true ? { recipientsTyped: true as const } : {}),
  };
}

/**
 * THE SCRATCH BUFFER, THROUGH THE CHECKED WRITE — `durable.ts`.
 *
 * A refused jar loses what somebody has written, which is the same fact about the browser as a
 * lost decision, so it raises the same notice. Nothing else changes here: there is no undo window
 * over a compose to degrade, and the draft still lives in React state for the length of the tab.
 */
export function writeComposeDraft(f: ComposeFields, scope: StorageScope): void {
  /**
   * "EMPTY" IS ABOUT THE TEXT, and `fromMailboxId` deliberately does not count. A sender pick on a form with nothing
   * written in it is not a draft — persisting it would turn every visit to Compose into a stored buffer, and it would
   * make the pick sticky in a way ruling 2 rules out: the default is derived on every fresh compose, and the only
   * thing worth remembering is a pick attached to a message somebody is actually writing. `html` does not count
   * either, and for a sharper reason: an empty ProseMirror document serialises to `<p></p>`, so testing it would make
   * every visit to Compose leave a stored buffer behind. `body` is the editor's plain rendering and is `""` for that
   * document, which is why it is the field that decides. Same rule as `isRichEmpty`.
   */
  if (f.to === "" && f.cc === "" && f.bcc === "" && f.subject === "" && f.body === ""
    && !hasDraftVersionWords(f.draftVersions) && f.forwardSources === undefined) {
    removeComposeBuffer(scope);
    return;
  }
  // Original forwarded files can be read again from their saved references. Picked files need a warning.
  const { attachments: _drop, missingAttachmentNames: _names, ...words } = f;
  const names = missingComposeFiles(f);
  const persisted = names.length > 0 ? { ...words, missingAttachmentNames: names } : words;
  // `locked`: written while this page holds its composer, so a crash leaves a unit it may adopt.
  const locked = composerLocked ? { ...persisted, locked: true } : persisted;
  const holds = rowHoldsOf(composeDraftKey(scope));
  const creates = createsOf(composeDraftKey(scope));
  const stored = { ...locked, ...(holds !== null ? { holds } : {}), ...(creates.length > 0 ? { creates } : {}) };
  durableSet(composeDraftKey(scope), JSON.stringify(stored), "compose.draft");
}

/* THE KEYS OF THE CREATES THE COMPOSER CLAIMS for the message in the buffer, kept inside it like the
   marker below: keys only, never words, moved with the unit and gone with it. */
const createsMem = new Map<string, string[]>();

function createsOf(key: string): string[] {
  const known = createsMem.get(key);
  if (known !== undefined) return known;
  let found: string[] = [];
  try {
    const raw = window.localStorage.getItem(key);
    const c = raw ? (JSON.parse(raw) as { creates?: unknown }).creates : undefined;
    if (Array.isArray(c)) found = c.filter((k): k is string => typeof k === "string" && k !== "");
  } catch { /* a refused jar or a foreign shape knows nothing */ }
  createsMem.set(key, found);
  return found;
}

export function readComposeCreates(owner: StorageScope): string[] {
  adoptHandoff(owner);
  return createsOf(composeDraftKey(owner));
}

export function writeComposeCreates(keys: readonly string[], owner: StorageScope): void {
  const key = composeDraftKey(owner);
  createsMem.set(key, [...keys]);
  updateComposeBuffer(owner, (raw) => {
    const { creates: _was, ...rest } = JSON.parse(raw) as Record<string, unknown>;
    return JSON.stringify(keys.length > 0 ? { ...rest, creates: keys } : rest);
  });
}

/**
 * WHAT THE ACCOUNT'S ROW HELD at this browser's last confirmed write: the row and a hash of the
 * form as written. Kept INSIDE the buffer, so it moves with the unit at a handoff and goes with it.
 * A reload that finds the row sent elsewhere compares it with the buffer, and keeps what the row
 * never held. Read only against the row the composer holds, so one left over names nothing.
 */
export interface ComposeRowHolds {
  row: string;
  sig: string;
  /** The form's From choice when this revision was opened or saved, including the default choice. */
  fromMailboxId?: string | null;
  /** A later save the outbox took for the row, not yet seen to land. */
  pending?: string;
  /** The row was deleted elsewhere while `pending` was unknown: those words are not saved again. */
  gone?: boolean;
  /** The row's version at that write (`contentRevision`), when the server said. */
  rev?: string;
}
/* Read once per key per page. A unit moves INTO a composer's keys only before its composer is ready
   (the handoff, a dead tab's recovery), and the marker is read after; a stale miss reads as unknown. */
const rowHolds = new Map<string, ComposeRowHolds | null>();

function rowHoldsOf(key: string): ComposeRowHolds | null {
  const known = rowHolds.get(key);
  if (known !== undefined) return known;
  let found: ComposeRowHolds | null = null;
  try {
    const raw = window.localStorage.getItem(key);
    const h = raw ? (JSON.parse(raw) as { holds?: Partial<ComposeRowHolds> }).holds : undefined;
    if (typeof h?.row === "string" && h.row !== "" && typeof h.sig === "string") {
      found = {
        row: h.row, sig: h.sig,
        ...(h.fromMailboxId === null || typeof h.fromMailboxId === "string" ? { fromMailboxId: h.fromMailboxId } : {}),
        ...(typeof h.pending === "string" ? { pending: h.pending } : {}),
        ...(h.gone === true ? { gone: true } : {}),
        ...(typeof h.rev === "string" && h.rev !== "" ? { rev: h.rev } : {}),
      };
    }
  } catch { /* a refused jar or a foreign shape knows nothing */ }
  rowHolds.set(key, found);
  return found;
}

export function readComposeRowHolds(owner: StorageScope): ComposeRowHolds | null {
  adoptHandoff(owner);
  return rowHoldsOf(composeDraftKey(owner));
}

/** A queued edit may have reached the deleted row. Its local copy can still be reopened. */
export function hasLocalDeletedDraftEdits(owner: StorageScope): boolean {
  const marker = readComposeRowHolds(owner);
  return marker?.gone === true && marker.pending !== undefined && marker.pending !== marker.sig
    && readComposeRow(owner) === null;
}

/** Record what the row holds, and write it into the stored buffer now. */
export function markComposeRowHolds(holds: ComposeRowHolds, owner: StorageScope): void {
  const key = composeDraftKey(owner);
  rowHolds.set(key, holds);
  updateComposeBuffer(owner, (raw) => JSON.stringify({ ...(JSON.parse(raw) as Record<string, unknown>), holds }));
}

/**
 * Which message-in-progress this compose surface is holding. There is one compose lane for
 * every message this browser will ever write, so a lane is not an identity; a DRAFT ROW is,
 * once one exists — and a new message has no row until autosave gives it one, which is exactly
 * the window `send-lock.ts` needs an identity in: a send whose outcome the server could not
 * confirm has to keep blocking THAT message and nothing else. The fingerprint cannot be it (the
 * person may edit and it is still the same message), so the identity is a session id minted
 * beside the scratch draft and cleared with it — surviving typing and reload, gone when the
 * compose is delivered or abandoned.
 */

/**
 * One session is one message, which means every door re-mints it. "Delivered or abandoned" was not the whole list: a
 * door that REPLACES the form with a different message — opening a draft, the contact popover's Write, an OS
 * `mailto:` — left the id alone, so one session spanned several messages and a record parking the first parked
 * whatever replaced it: "We couldn't confirm this send" over a message never sent, with Send refused. So {@link
 * clearComposeDraft} runs at every such door, immediately before the new form is persisted: it drops buffer and id
 * together, and the next read of {@link composeSessionId} mints fresh — the lazy read is what makes "one door, one
 * line" enough. The account's row for the replaced message goes with it ({@link composeRowKey}), the other half of
 * the same identity.
 */

/**
 * Owner-keyed and wrapped like every door in this file: a blocked jar answers `null`, which callers must read as
 * "this browser cannot name the message", never as "a new one".
 */
export const COMPOSE_SESSION_PREFIX = "ohmail.compose.session.";

export function composeSessionKey(owner: StorageScope): string {
  return `${COMPOSE_SESSION_PREFIX}${scopeSuffix(owner)}.${composerId()}`;
}

export function composeSessionId(owner: StorageScope): string | null {
  adoptHandoff(owner);
  if (detachedUnits.has(scopeSuffix(owner))) return detachedUnit(owner)?.[0] ?? null;
  try {
    const held = window.localStorage.getItem(composeSessionKey(owner));
    if (held !== null && held.length > 0) return held;
    const minted = crypto.randomUUID();
    // A MINT NOBODY COULD STORE IS NOT AN IDENTITY. `null` here is the same answer a refused READ
    // gives — "this browser cannot name the message" — because a session id held only in this
    // call frame names nothing on the next reload. The refusal now also reaches the shell.
    return durableSet(composeSessionKey(owner), minted, "compose.session") === "stored"
      ? minted
      : null;
  } catch {
    return null; // private mode, or a full quota — see the header on what `null` means
  }
}

/**
 * THE SESSION AS IT STANDS, NEVER MINTED: the stored id, or `null` where none is stored or the jar cannot be read.
 * For a reader that may write no key of the account: a render, and a composer whose mount is gone. A `null`
 * session names no record, the same answer a fresh session gives.
 */
export function readComposeSession(owner: StorageScope): string | null {
  adoptHandoff(owner);
  if (detachedUnits.has(scopeSuffix(owner))) return detachedUnit(owner)?.[0] ?? null;
  // The jar's own door: a read it refuses answers `null`.
  const held = localStorageDoor("compose.session").get(composeSessionKey(owner));
  return held !== null && held.length > 0 ? held : null;
}

/**
 * PUT A MESSAGE'S OWN SESSION BACK — the one writer, and it exists for exactly one caller. Every other door MINTS
 * (lazily, by reading) or CLEARS. Reopening a message this browser holds an unresolved send record for does neither:
 * that message already HAS a session — the one the record was written under — and the surface may have minted a
 * different one since, because any door in between (writing to a contact, an operating-system mail link) legitimately
 * starts a new message. Coming back to the unconfirmed one has to come back to its identity, or the record names
 * neither of the things the message is now called and the hold silently lifts. `null` is not accepted: clearing is
 * {@link clearComposeDraft}'s job, which drops the buffer and the row with it. This only ever restores a session that
 * a record still names.
 */
export function writeComposeSession(session: string, owner: StorageScope): void {
  // The same failure `composeSessionId` answers `null` for, and it is announced the same way.
  durableSet(composeSessionKey(owner), session, "compose.session");
}

/**
 * THE DRAFT ROW THE COMPOSE SURFACE IS HOLDING, ACROSS A RELOAD: `useComposeAutosave` keeps the row in React state,
 * and React state does not survive a reload — while the scratch buffer, which holds the TEXT of the same message,
 * does. So a reload restored the message and lost its row: the next pause created a SECOND row for it, and the
 * durable send record still named the first. One message under two rows is how a send whose outcome nobody could
 * confirm read as two messages and unlocked Send for the one that may already have gone. The row is written here
 * rather than into the buffer because it is not part of the form: it is a fact about which message the surface is
 * holding, with the same lifetime as {@link composeSessionId} — and it is cleared by the same call, at the same
 * doors, for the same reason. `null` clears it.
 */

/**
 * A blocked jar answers `null` on read, which the hook reads as "no row to adopt", never as "there is no row".
 */
export const COMPOSE_ROW_PREFIX = "ohmail.compose.row.";

export function composeRowKey(owner: StorageScope): string {
  return `${COMPOSE_ROW_PREFIX}${scopeSuffix(owner)}.${composerId()}`;
}

/**
 * THE TAB'S OWN MEMORY OF THE ROW, for a browser that refuses this app its storage. There nothing can be written, so
 * `readComposeRow` answered `null` BY CONSTRUCTION: `holdOf` said `unknown`, the adoption waited, and the timer
 * created a SECOND row for the one just opened. Keyed by the same storage key, so it is account-scoped as the jar is,
 * and swept by {@link forgetComposeRows} at sign-out — an id on the departed account must not reach the next sign-in.
 * It answers ONLY when the jar throws: a jar that works and says `null` is another tab having cleared the row, and a
 * remembered value would resurrect it.
 */
const composeRowInMemory = new Map<string, string>();

/** Forget every remembered row — the sign-out sweep's half of {@link COMPOSE_ROW_PREFIX}. */
export function forgetComposeRows(): void {
  composeRowInMemory.clear();
}

export function readComposeRow(owner: StorageScope): string | null {
  adoptHandoff(owner);
  if (detachedUnits.has(scopeSuffix(owner))) return detachedUnit(owner)?.[1] ?? null;
  try {
    const held = window.localStorage.getItem(composeRowKey(owner));
    return held !== null && held.length > 0 ? held : null;
  } catch {
    return composeRowInMemory.get(composeRowKey(owner)) ?? null;
  }
}

export function writeComposeRow(id: string | null, owner: StorageScope): void {
  const key = composeRowKey(owner);
  if (id === null) composeRowInMemory.delete(key);
  else composeRowInMemory.set(key, id);
  if (updateDetachedUnit(owner, (unit) => { unit[1] = id; })) return;
  // The row stays as durable as the tab through `composeRowInMemory` above, which is why a
  // refusal is survivable here at all; it is no longer silent about being a tab's memory.
  if (id === null) durableRemove(key, "compose.row");
  else durableSet(key, id, "compose.row");
}

export function clearComposeDraft(owner: StorageScope): void {
  // FIRST, because the remembered row must not survive a clear of the message it names.
  composeRowInMemory.delete(composeRowKey(owner));
  createsMem.delete(composeDraftKey(owner));
  rowHolds.delete(composeDraftKey(owner));
  /*
   * FOUR INDEPENDENT REMOVALS, not one try block. Under a shared `try` the first refusal skipped
   * every line below it, so a quota that rejected the buffer's removal left the session id and
   * the row behind — the identity of a message this call has just declared over. Each door
   * answers for itself now, exactly as the sign-out sweep's per-key catch does.
   */
  removeComposeBuffer(owner);
  // The session id goes with the buffer it names: the message-in-progress is over, so the next
  // press is a new message and must not inherit this one's identity.
  durableRemove(composeSessionKey(owner), "compose.session");
  // AND the row that message had on the account — the other half of the identity, and the half
  // a reload used to lose on its own. See `composeRowKey`.
  durableRemove(composeRowKey(owner), "compose.row");
  // AND the un-owned key a browser upgraded from an earlier bundle may still hold. This is
  // the only line that touches it: it is drained on the next clear and never read back.
  // NEVER FROM THE DEMO. This key carries no owner, so the demo's own partition does not reach
  // it — and the demo clears at every door that replaces the form. A shop window draining the one
  // buffer an upgraded browser still holds is the same lost message by a different route.
  if (!isDemoOwned(owner) && !retiredSignOutStorageHeld()) durableRemove(LEGACY_COMPOSE_DRAFT_KEY, "compose.draft");
}

/**
 * WHICH MESSAGE A COMPOSE OPERATION IS FOR — the two names a compose surface answers to, taken at
 * the moment the operation began rather than read back when it ends. The row is the durable name;
 * the session is the only name a message has before autosave gives it one.
 */
export interface ComposeHeld {
  /** The row the operation was for; `null` = it carried none (a press before the first save). */
  draftId: string | null;
  /**
   * The compose session it was minted under. `null` is NOT "a different message": it is an
   * operation that cannot name a session at all — a lane that never had one, a build that did
   * not write one, a browser that refuses this app its storage. Absent and different are
   * separate statements and the predicate below keeps them apart, because collapsing them makes
   * every unnameable settlement refuse and leaves delivered text sitting in the composer.
   */
  session: string | null;
}

/**
 * The saved shape, as one string, so "has anything changed" is one comparison rather than five
 * that can be forgotten one at a time. It covers the TEXT the mutation carries; the sending
 * mailbox is tracked beside it (`savedMailbox` in the hook) rather than in here, because the
 * two have different sources — the text is the form's, the mailbox is the RESOLUTION's
 * (`resolveComposeFrom`), and folding the resolution into a signature of the form would make
 * "has the form changed" depend on an argument the form does not hold.
 */
export function signatureOf(f: ComposeFields): string {
  return JSON.stringify([
    f.to, f.cc ?? "", f.bcc ?? "", f.subject, f.body, f.html ?? "", f.forwardOf ?? "",
    // The kept files only when there is a list, so every older buffer keeps its signature.
    ...(f.forwardOf && f.forwardParts ? [[...f.forwardParts].sort()] : []),
    ...(f.forwardSources !== undefined ? [forwardSourceShape(f.forwardSources)] : []),
  ]);
}

/** The forwarding fields covered by existing compose storage markers. */
export function forwardSourceShape(sources: readonly ForwardSource[] | undefined): string[][] | undefined {
  return sources?.map(({ id, filename, sha256 }) => [id, filename, sha256 ?? ""]);
}

/** {@link signatureOf} hashed, for the marker the buffer carries — the body is not stored twice. */
export function holdsSig(f: ComposeFields): string {
  return sigOf(signatureOf(f));
}

/** A string hashed (cyrb53). */
export function sigOf(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function sameRecipientList(before: readonly EmailAddress[], after: readonly EmailAddress[]): boolean {
  return before.length === after.length && before.every((entry, i) =>
    entry.address === after[i]?.address && (entry.name ?? null) === (after[i]?.name ?? null));
}

export type ComposeSavedRevision = Pick<EngineDraft, "id" | "contentRevision" | "mailboxId">;

/** Recover the From proof of a saved copy when only its revision survived. */
function matchesDraftRevision(fields: ComposeFields, mailboxId: string, revision: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(revision)) return false;
  const to = parseRecipients(fields.to);
  const cc = parseRecipients(fields.cc);
  const bcc = parseRecipients(fields.bcc);
  if (to.invalid.length || cc.invalid.length || bcc.invalid.length) return false;
  return sha256Hex(draftRevisionInput({
    mailboxId, inReplyToMessageId: null, subject: fields.subject, body: fields.body, html: fields.html || null,
    to: to.addresses, cc: cc.addresses, bcc: bcc.addresses,
    forwardOfMessageId: fields.forwardOf, forwardParts: fields.forwardParts,
    forwardSources: forwardSourcesForSave(fields.forwardSources),
  })) === revision;
}

function matchesSavedMarker(
  fields: ComposeFields, marker: Partial<ComposeRowHolds> | null | undefined,
  row: Pick<ComposeSavedRevision, "id" | "contentRevision"> & { mailboxId?: string },
): boolean {
  return !!row.contentRevision && marker?.row === row.id && marker.rev === row.contentRevision
    && marker.pending === undefined && marker.gone !== true && marker.sig === holdsSig(fields)
    && fields.sig?.kind !== "edited"
    && (marker.fromMailboxId !== undefined ? marker.fromMailboxId === fields.fromMailboxId
      : fields.fromMailboxId === null || fields.fromMailboxId === row.mailboxId
        || matchesDraftRevision(fields, fields.fromMailboxId, row.contentRevision));
}

export function composeWordsFingerprint(fields: ComposeFields): string | null {
  if (!fields.forwardSources?.length && [fields.to, fields.subject, fields.body].every((text) => text.trim() === "")) return null;
  const fingerprint = sendFingerprint(composePlan(fields, fields.fromMailboxId).mutation as unknown as MailSend);
  return fields.forwardSources?.length
    ? fnv1a(JSON.stringify([fingerprint, draftForwardSourceTuples(fields.forwardSources)]))
    : fingerprint;
}

/** Check both the recorded revision and the words still present in this recovery copy. */
export function composeBufferMatchesRevision(
  fields: ComposeFields, marker: Partial<ComposeRowHolds> | null | undefined, row: EngineDraft,
): boolean {
  if (!matchesSavedMarker(fields, marker, row)) return false;
  if (fields.subject !== row.subject || fields.body !== row.body || (fields.html || null) !== (row.html ?? null)
    || (fields.fromMailboxId !== null && fields.fromMailboxId !== row.mailboxId)
    || (fields.forwardOf ?? null) !== (row.forwardOfMessageId ?? null)
    || JSON.stringify(fields.forwardParts ?? null) !== JSON.stringify(row.forwardParts ?? null)
    || JSON.stringify(draftForwardSourceTuples(fields.forwardSources ?? []))
      !== JSON.stringify(draftForwardSourceTuples(row.forwardSources ?? []))) return false;
  return (["to", "cc", "bcc"] as const).every((line) => {
    const parsed = parseRecipients(fields[line]);
    return parsed.invalid.length === 0 && sameRecipientList(parsed.addresses, row[line]);
  });
}

/** A completed send or discard spends the recovery units named by its durable identity. */
export function clearEndedComposeCopies(held: ComposeHeld, owner: StorageScope, saved?: ComposeSavedRevision | EngineDraft): void {
  if (held.session === null && saved === undefined) return;
  reconcileComposeCopies(owner, () => ({ session: held.session, saved }));
}

/** A confirmed ending can spend the saved revision even when a different composer made the copy. */
export function clearSavedComposeCopies(row: ComposeSavedRevision | EngineDraft | undefined, owner: StorageScope): void {
  if (row?.contentRevision) clearEndedComposeCopies({ draftId: null, session: null }, owner, row);
}

type ObservedDraftEnd = { mailboxId?: string; fingerprint?: string };
type ComposeEnd = { session?: string | null; saved?: ComposeSavedRevision | EngineDraft; observed?: ObservedDraftEnd };

/** An authoritative row ending spends its confirmed saved versions and the exact words pressed Send on. */
export function clearKnownComposeCopies(
  owner: StorageScope,
  ended: (row: string, session: string | null) => ObservedDraftEnd | undefined,
  includeCurrent = false,
): void {
  reconcileComposeCopies(owner, (held) => {
    const observed = held.draftId === null ? undefined : ended(held.draftId, held.session);
    return observed === undefined ? undefined : { observed };
  }, includeCurrent);
}

function reconcileComposeCopies(owner: StorageScope, ended: (held: ComposeHeld) => ComposeEnd | undefined, includeCurrent = false): void {
  clearComposeCopies(owner, ([session, draftId, raw]) => {
    const ending = ended({ session: session ?? null, draftId: draftId ?? null });
    if (ending === undefined) return false;
    if (ending.session && session === ending.session) return true;
    if (!draftId || (ending.observed === undefined && ending.saved?.id !== draftId)) return false;
    if (!raw) return ending.observed !== undefined;
    try {
      const marker = (JSON.parse(raw) as { holds?: Partial<ComposeRowHolds> }).holds;
      const fields = decodeComposeDraft(raw);
      const observed = ending.observed;
      if (observed !== undefined && !worthSaving(fields)) return true;
      if (observed?.fingerprint !== undefined && observed.fingerprint === composeWordsFingerprint(fields)) return true;
      const saved = ending.saved;
      if (saved && "body" in saved) return composeBufferMatchesRevision(fields, marker, saved);
      return matchesSavedMarker(fields, marker, saved ?? { id: draftId, mailboxId: observed?.mailboxId, contentRevision: marker?.rev });
    } catch { return false; }
  }, includeCurrent);
}

function clearComposeCopies(owner: StorageScope, matches: (unit: readonly (string | null)[]) => boolean, includeCurrent = false): void {
  const scope = scopeSuffix(owner);
  const prefix = handoffPrefix(scope);
  const own = composerId();
  const scratch = `${COMPOSE_DRAFT_PREFIX}${scope}.`;
  const rows = `${COMPOSE_ROW_PREFIX}${scope}.`;
  try {
    const sweep = (keys: readonly string[]): void => {
      const unit = readUnit(keys);
      if (matches(unit) && readUnit(keys).every((value, index) => value === unit[index])) removeUnit(keys, unit);
    };
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith(prefix)) {
        const raw = handoffs.get(key);
        const unit = decodeUnit(raw);
        if (unit !== null && matches(unit) && handoffs.get(key) === raw) handoffs.remove(key);
      } else {
        const unitPrefix = key.startsWith(scratch) ? scratch : key.startsWith(rows) ? rows : undefined;
        if (unitPrefix === undefined) continue;
        const id = key.slice(unitPrefix.length);
        if ((id !== own || includeCurrent) && /^[A-Za-z0-9_-]{1,64}$/.test(id)) sweep(unitKeys(`${scope}.${id}`));
      }
    }
    sweep(unitKeys(scope));
  } catch { /* a refused jar leaves the units for the next recovery */ }
}

/**
 * IS THE COMPOSE SURFACE STILL HOLDING THE MESSAGE THIS OPERATION WAS FOR? — the whole of the
 * one-composer-per-draft rule. A settlement that lands while the person is writing something
 * else must act on the message it was for or on nothing; it used to act on whatever was open,
 * so finishing one message emptied the draft beside it and deleted its row. The surface's own
 * names are the answer, and {@link composeRowKey} is the one place that says which draft this
 * composer owns — so a second owner is refused by asking it, not by a registry beside it.
 */
export function composeStillHolds(
  held: ComposeHeld, owner: StorageScope,
): boolean {
  // A ROW NAMES ITSELF. The send carried one, so the question is whether the composer still has
  // that one — a different row, or none, is a different message.
  if (held.draftId !== null) return readComposeRow(owner) === held.draftId;
  /* NO ROW: the press beat the first autosave, so the session is the message's only name. Every
     door that replaces the form drops it ({@link clearComposeDraft}) and the next read mints a
     fresh one, which is exactly what makes this comparison the door's own signature. */
  // …and an operation that can name NEITHER is admitted — see {@link ComposeHeld.session}. It
  // has said nothing about which message it is for, which is not evidence that it is a
  // different one, and refusing on it would leave a delivered message in the composer.
  if (held.session === null) return true;
  return readComposeSession(owner) === held.session;
}

/**
 * IS THIS AN ADDRESS? — checked HERE, before Send lights up, and not by the SMTP server. "An SMTP rejection after the
 * fact is a bad way to learn about a typo": the send path is two requests and a reservation, and a 550 arrives as
 * `unverified` — the one outcome the product cannot resolve for the user. A local check costs nothing and turns "we
 * couldn't confirm this send" back into "that address has no dot in it". CONSERVATIVE ON PURPOSE: The rule is not RFC
 * 5322 and does not try to be — the grammar admits quoted local parts, comments and bare IP-literal domains, and a
 * validator that implemented it would reject nothing anyone types by hand while adding a page of code. What it DOES
 * do is refuse the four things a human actually mistypes: no `@`, two `@`, no dot in the domain, and a stray space.
 */

/**
 * Anything past that is the server's business, which is where a genuinely exotic but legal address is still accepted
 * — this gate only decides whether Send is offered. It must never reject a valid ordinary address, so `+` tags, dots,
 * dashes, apostrophes and underscores in the local part all pass, and so do multi-label domains and long TLDs.
 */
export function isEmailAddress(raw: string): boolean {
  const s = raw.trim();
  if (s.length === 0 || s.length > 254) return false;
  if (/[\s<>,;"()[\]\\]/.test(s)) return false;
  const at = s.indexOf("@");
  if (at <= 0 || at !== s.lastIndexOf("@")) return false;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (local.length > 64) return false;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
    if (!/^[a-z0-9-]+$/i.test(label)) return false;
  }
  // A TLD is letters. `user@host.1` is a typo every time, and an IP-literal domain would need
  // the bracket form this parser refuses above.
  return /^[a-z]{2,}$/i.test(labels[labels.length - 1]!);
}

export interface RecipientParse {
  /** Everything that parsed, in the order typed, de-duplicated by address. */
  addresses: EmailAddress[];
  /** Entries that did not parse, verbatim, for the error line under the field. */
  invalid: string[];
}

/**
 * One line of typed text → recipients. Commas and semicolons both separate, because every mail client accepts both
 * and a user who pastes a list from elsewhere has no idea which one they got. `Name <addr>` is accepted because that
 * is what copying a recipient out of another client yields; the display name is kept, so the person's name survives
 * into `drafts.to` and out onto the wire's To header. De-duplicated case-insensitively on the address: a list pasted
 * twice must not mail anyone twice, and the SMTP envelope is built straight from this array (`SendService` →
 * `to.map(a => a.address)`).
 */
export function parseRecipients(raw: string): RecipientParse {
  const addresses: EmailAddress[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const part of raw.split(/[,;]/)) {
    const entry = part.trim();
    if (entry === "") continue;
    const angled = /^(.*?)<([^<>]*)>$/.exec(entry);
    const address = (angled ? angled[2]! : entry).trim();
    const name = angled ? angled[1]!.trim().replace(/^"(.*)"$/, "$1").trim() : "";
    if (!isEmailAddress(address)) {
      invalid.push(entry);
      continue;
    }
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    addresses.push({ name: name === "" ? null : name, address });
  }

  return { addresses, invalid };
}

export type MailSend = Extract<EngineMutation, { kind: "mail_send" }>;

export interface ComposePlan extends RecipientParse {
  /** The mutation as it would go out right now. `canSend` judges THIS. */
  mutation: MailSend;
  /** True when the subject is blank — a warning on screen, never a refusal. See below. */
  noSubject: boolean;
  /**
   * The Cc and Bcc parses, each their own {@link RecipientParse}. The `to` parse is the spread
   * `addresses`/`invalid` above (backwards-compatible — `plan.invalid` still means the To field);
   * these two are named so `ComposeView` can draw a per-field error line and run the same
   * still-typing gate the To field has, without re-parsing.
   */
  cc: RecipientParse;
  bcc: RecipientParse;
}

/**
 * The compose form as a send, or as the reason it is not one yet. A typo blocks the WHOLE send,
 * it does not silently drop one recipient: `to` is `[]` whenever anything failed to parse, even
 * if three of four entries were fine. That is the load-bearing line — the refusal is expressed
 * in the MUTATION rather than as a second predicate beside `canSend`, so every caller (the
 * button's `disabled`, the state machine's guard, a keyboard shortcut, a future Reply Run) is
 * stopped by the same rule. Dropping the bad entry and mailing the rest would be the worst
 * option: the user would learn about the typo from the person who never answered.
 */

/**
 * An empty subject sends — no block, no confirm dialog: a subjectless message is legitimate mail, and a modal is the
 * exact shape Compose was moved away from. `noSubject` is surfaced as a factual note in the send row BEFORE the
 * press, the same warning arriving early enough to be useful. `mailboxId` is omitted rather than nulled when nothing
 * can name one, so `canSend` refuses and `Engine.enrich` has nothing to disagree with. And it is HANDED the answer,
 * it does not choose: `mailboxId` is `resolveComposeFrom(...).mailboxId` — the user's revalidated pick or the derived
 * default — resolved by the caller so the id on the wire is the same object the From line rendered. Passing
 * `fields.fromMailboxId` straight through would be the bug this resolution removes wearing a different hat: a
 * days-old pick against a since-disconnected mailbox would go out and collect a 409 nobody could act on.
 */
/**
 * @param draftId THE ROW THIS MESSAGE ALREADY IS, when autosave has written one. It goes on the
 * mutation so the send uses that row instead of creating a second — one draft from the first
 * keystroke to delivery. Absent for any caller that does not autosave (a test, a surface without
 * an engine), which is exactly the behaviour this had before autosave existed.
 */
export function composePlan(
  fields: ComposeFields, mailboxId: string | null, draftId?: string | null,
): ComposePlan {
  const parsed = parseRecipients(fields.to);
  // `?? ""` because `composePlan` is called directly by tests with a bare `{to,subject,body,html}`
  // form, and by a scratch buffer written before these fields existed — both reach here with `cc`
  // and `bcc` undefined, which is an empty field, not an error.
  const cc = parseRecipients(fields.cc ?? "");
  const bcc = parseRecipients(fields.bcc ?? "");
  // A typo in ANY of the three fields blocks the whole send — the same rule the To field already
  // enforces, widened to Cc and Bcc. It is expressed by emptying the recipient set the mutation
  // carries, so `canSend` (which reads `mutation.to`) refuses with no second predicate, and a bad
  // Cc address can no more "send the valid ones" than a bad To address can.
  const anyInvalid = parsed.invalid.length + cc.invalid.length + bcc.invalid.length > 0;
  return {
    ...parsed,
    cc,
    bcc,
    noSubject: fields.subject.trim().length === 0,
    mutation: {
      kind: "mail_send",
      // THE COMPOSE FORK. Null is not a default here — it is what keeps `In-Reply-To` and
      // `References` off a message that is not answering anyone (see `types.ts`).
      inReplyTo: null,
      body: fields.body,
      // ONE OR THE OTHER ON THE WIRE, and the adapter is what enforces it: `html` present
      // means `POST /drafts` carries the markup and no `body` at all, because a client that
      // supplied its own plain part would be asserting what plaintext readers see. `null` when
      // the editor holds no formatting: `Engine.enrich` drops it unless the row is formatted, so
      // a plain compose produces the same request it always did.
      html: fields.html ? fields.html : null,
      subject: fields.subject,
      // When anything is unparseable the mutation carries NO recipients at all — not the valid
      // subset — so a half-typed or mistyped address cannot leave a partial send on the wire.
      to: anyInvalid ? [] : parsed.addresses,
      cc: anyInvalid ? [] : cc.addresses,
      bcc: anyInvalid ? [] : bcc.addresses,
      // Files ride the send request, not the draft — carried straight onto the mutation so the
      // adapter puts them on `POST /drafts/:id/send`. Omitted when there are none, so a plain send
      // builds the exact request it always did. The caller hands this function the whole form, so
      // the files reach the wire without any other call site changing.
      ...(fields.attachments && fields.attachments.length ? { attachments: fields.attachments } : {}),
      // THE FORWARD FORK, and it is the peer of the `inReplyTo: null` above rather than a second
      // way of saying the same thing: this message quotes the original and carries its attachments,
      // but it threads onto nothing and carries no `In-Reply-To`. Omitted — not sent as `null` —
      // when there is nothing to forward, so a plain compose builds the identical request it always
      // did and the http adapter's `if (m.forwardOf)` sees no key at all.
      ...(fields.forwardOf ? { forwardOf: fields.forwardOf } : {}),
      // The kept files ride only a forward that has a list: absent, the server sends every one.
      ...(fields.forwardOf && fields.forwardParts ? { forwardParts: [...fields.forwardParts] } : {}),
      ...(fields.forwardSources !== undefined ? { forwardSources: forwardSourcesForSave(fields.forwardSources) } : {}),
      ...(mailboxId ? { mailboxId } : {}),
      ...(draftId ? { draftId } : {}),
      threadId: null,
    },
  };
}
