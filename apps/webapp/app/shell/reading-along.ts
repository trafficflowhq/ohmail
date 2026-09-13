/**
 * ═══ READING ALONG ON PURPOSE ═══════════════════════════════════════════════════════════════
 *
 * Issue #5's second half: a person who has DECIDED that another install organizes this mailbox —
 * the desktop files it, this browser reads it, and that is the arrangement they chose — is told
 * so again on every surface, every poll, for ever. The sentence is right and the repetition is
 * not, so one press silences it here.
 *
 * ── WHAT IT MAY NOT DO ──────────────────────────────────────────────────────────────────────
 * It may not hide a CHANGE. Silence about "your desktop organizes this" is a statement about one
 * holder, and a DIFFERENT install taking the mailbox over is news whatever anybody pressed — so
 * the intention is stored against the holder it was made about and lapses the moment that holder
 * is not the one on the row.
 *
 * ── WHY A FINGERPRINT AND NOT AN ID ─────────────────────────────────────────────────────────
 * `organizedBy` carries no install id, deliberately: `dto/types.ts` rules it off the wire ("an
 * internal deployment name every viewer would receive for no purpose — so the server compares and
 * sends the answer"). The row's own `since` is the usable half — it is when that install BECAME
 * the organizer, so a different install taking over re-stamps it. `kind|name|since` therefore
 * changes whenever the holder does. It ALSO changes when the same install stops and re-becomes,
 * which re-shows a sentence somebody had silenced: a false positive that fails SAFE — it speaks
 * again rather than staying quiet about a holder that may be new. The alternative, an opaque
 * per-mailbox holder ref on the DTO, is a wire change and is filed as one.
 *
 * NEVER A SERVER WRITE, and never account-wide: `storageOwner()` scopes it to the account, the
 * browser scopes it to the install, and that is the whole of what "here" means.
 */
import { durableSet, type DurableWrite } from "./durable";
import { storageOwner } from "./storage-owner";
import type { HolderWho } from "./reader-holder";

/** The record's shape. `v` is the version, every other key a mailbox id. */
const VERSION = 1;

/**
 * THE PREFIX SIGN-OUT SWEEPS — and this record IS swept, which is not the obvious answer.
 *
 * It looks like a per-browser preference, and its siblings under `ohmail.ui.` survive. It does
 * not, for one reason: the VALUE carries the holder's own machine name. That name is the
 * account's (it is on the admin DTO's deny-list for exactly that reason), so leaving the record
 * behind would leave "Louis' iMac" in a shared browser's jar after the person signed out. The
 * intention is cheap to state again and the name is not ours to keep.
 */
export const READING_ALONG_PREFIX = "ohmail.ui.readingAlong.";

/**
 * One record per account, on this install. Per account because two people sharing a browser must
 * not inherit each other's intentions, and per install because that is the whole of what "here"
 * means. `storageOwner()`, never `readOwner()` — the second is null on the whole standalone
 * desktop and would give every account one shared key (`persisted-ui.ts` records that measurement).
 */
export function readingAlongKey(owner: string | null): string {
  return `${READING_ALONG_PREFIX}${owner ?? "local"}`;
}

/**
 * THE HOLDER, AS THE THING A SILENCE IS ABOUT.
 *
 * `null` where nothing is recorded: there is no holder to be reading along WITH, so no intention
 * can be stored and none can be in force. An unnamed holder fingerprints on its kind and date,
 * which is what distinguishes it from a different unnamed one that arrives later.
 */
export function holderFingerprint(who: HolderWho | null | undefined): string | null {
  if (!who) return null;
  const kind = typeof who.kind === "string" && who.kind !== "" ? who.kind : "unknown";
  const name = (who.name ?? "").trim();
  const since = who.since ?? "";
  /* JSON.stringify, never a control byte and never a bare join: a machine name may contain any
     character a person can type, `|` included, and two holders must not fingerprint alike
     because one of them has a pipe in its name. */
  return JSON.stringify([kind, name, since]);
}

function load(owner: string | null): Record<string, string> {
  try {
    const raw = globalThis.localStorage?.getItem(readingAlongKey(owner));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) return {};
    if (parsed.v !== VERSION) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (k !== "v" && typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    /* A jar that will not open is a jar with no intention in it. The sentence shows, which is the
       safe direction: it says something true a person may silence again. */
    return {};
  }
}

function save(rows: Record<string, string>, owner: string | null): DurableWrite {
  return durableSet(readingAlongKey(owner), JSON.stringify({ v: VERSION, ...rows }), "ui.readalong");
}

/**
 * IS THE SENTENCE SILENCED FOR THIS MAILBOX AND THIS HOLDER — the one question the surfaces ask.
 *
 * False whenever anything differs: no intention, a holder that is not the one it was made about,
 * or no holder at all. A surface reads this and renders nothing where it is true; it never reads
 * the record itself, so "what silence means" is decided once.
 */
export function readingAlong(
  mailboxId: string,
  who: HolderWho | null | undefined,
  owner: string | null = storageOwner(),
  /**
   * A CALLER'S OWN "the record moved" COUNTER, read and ignored.
   *
   * This record is not React state: a surface that renders from it has nothing to re-render on
   * when a press writes it, and the desktop pane's first version left the offer standing with the
   * old sentence under it. Naming the counter in the signature is what makes the dependency
   * VISIBLE at the call site rather than a comment somebody deletes; the value means nothing here
   * and is never compared.
   */
  _said?: number,
): boolean {
  const fingerprint = holderFingerprint(who);
  if (fingerprint === null) return false;
  return load(owner)[mailboxId] === fingerprint;
}

/** Read along here, about THIS holder. A press, and the only writer of the affirmative. */
export function setReadingAlong(
  mailboxId: string,
  who: HolderWho | null | undefined,
  owner: string | null = storageOwner(),
): DurableWrite {
  const fingerprint = holderFingerprint(who);
  /* No holder, no intention: there is nothing to read along WITH, and storing one would silence
     the next holder to arrive before anybody had seen it. */
  if (fingerprint === null) return "stored";
  return save({ ...load(owner), [mailboxId]: fingerprint }, owner);
}

/**
 * STOP READING ALONG — and a REFUSED PRESS is the other caller.
 *
 * Somebody who presses to organize the mailbox here has withdrawn the intention by pressing, and
 * a refusal is exactly when they need the sentence back. The two callers are one act: an
 * intention that survived its own contradiction would be a silence nobody could clear.
 */
export function clearReadingAlong(
  mailboxId: string,
  owner: string | null = storageOwner(),
): DurableWrite {
  const rows = load(owner);
  if (!(mailboxId in rows)) return "stored";
  delete rows[mailboxId];
  return save(rows, owner);
}
