import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from "node:crypto";
import {
  CAPABILITY_REQUESTS, CAPABILITY_MOVES, CAPABILITY_RULES, CAPABILITY_PROFILE,
  type OrganizerIntent,
} from "@trafficflow/db";
import { WATCHED_FOLDERS, type ImapAuth } from "./imap-types.js";
import {
  boundListResponse, boundedFetch, ImapBoundConfigError, ImapDeadline, isImapBoundExceeded,
  IMAP_META_BYTES_MAX, IMAP_META_DEADLINE_MS, META_ENUM_BYTES_MAX,
} from "./imap-bounds.js";
import { epochOf, epochVerdict, uidRefsAtEpoch } from "../epoch.js";
import {
  assertMetaIdentity, readMemo, writeMemo, forgetMemo, peekMemo, noteMetaNearCeiling,
  type MetaIdentity, type Generation,
} from "./meta-memo.js";

/* Re-exported so hosts reach one surface for the meta folder rather than importing the memory
 * from a second path — the drain keeps a position here too, and a second import path is how two
 * callers come to disagree about which store they are writing to. */
export {
  readMemo, writeMemo, forgetMemo, peekMemo, assertMetaIdentity, metaShrinkDue, noteMetaShrinkRan,
  type MetaIdentity, type Generation, type MetaMemo, type MemoRead, MetaIdentityError,
} from "./meta-memo.js";

/**
 * The organizer lease: two databases that can never see each other agree on who organizes a
 * mailbox through the one medium they share — one claim message per organizer in the unsubscribed
 * `ohmail/_meta`. The invariant: a destructive IMAP write happens only under a permit naming
 * (install, mailbox, uidvalidity, nonce, issued-at) younger than `DEFAULT_PERMIT_TTL_MS`,
 * re-validated on a cadence (`apps/worker/src/lease.ts`). A LEASE, not a mutex — IMAP has no
 * compare-and-swap; a one-cycle overlap is idempotent-safe. Records are headers-only; an
 * unreadable record is evidence, never permission. Three layers: format, decision ({@link
 * decideLease}, pure), IO ({@link runLeaseGate}).
 */

/**
 * The folder holding the claims. **No leading dot**, so it survives both `/` and `.` hierarchy
 * delimiters when mapped through the adapter's `toServerPath`.
 *
 * It must stay OUT of {@link WATCHED_FOLDERS} — that constant is the input to `changesSince`, so
 * a watched `_meta` would ingest the lease's own bookkeeping as mail, classify it, and file it.
 * {@link META_FOLDER_IS_UNWATCHED} is that assertion rather than a comment, and it is evaluated
 * at module load so the two constants cannot drift apart unnoticed.
 */
export const META_FOLDER = "ohmail/_meta";

/** `true` iff {@link META_FOLDER} is absent from the watched set. Asserted by the suite. */
export const META_FOLDER_IS_UNWATCHED: boolean = !(WATCHED_FOLDERS as readonly string[]).includes(META_FOLDER);

/**
 * Where `ohmail/_meta` actually lives on this server. `toServerPath(META_FOLDER)` answers what
 * the folder is CALLED, not where it IS: Dovecot with personal prefix `INBOX.` files a root-named
 * CREATE under the prefix, so the claim lives at `INBOX.ohmail._meta` while the mapped name says
 * `ohmail._meta` — and every path-equality read answered NO on a mailbox holding a live claim, so
 * the pre-consent peek reported no holder and a person was never told their other machine
 * organizes this mailbox. The resolution is one function used by both sides ({@link
 * makeMetaFolderRef}); `meta-folder.test.ts` censuses the source to keep it that way.
 */

/**
 * A LIST row, as much of one as the meta-folder resolution reads.
 *
 * `delimiter` is optional because it is a client-library convenience rather than something every
 * fake carries. It is read the way {@link LeaseImapClient.mailbox} is read: absence means
 * "unknown", never a value.
 */
export interface MetaFolderRow {
  readonly path: string;
  readonly subscribed?: boolean;
  readonly delimiter?: string;
}

/** One personal namespace, as RFC 2342's NAMESPACE response describes it. */
export interface MetaNamespaceEntry {
  /** Already delimiter-terminated by the client library — `INBOX.`, not `INBOX`. */
  readonly prefix?: string;
  /** NIL for a namespace with no hierarchy, which RFC 2342 §5 allows. */
  readonly delimiter?: string | null;
}

/**
 * The NAMESPACE half of a client, read structurally and defensively.
 *
 * `ImapFlow` sets both fields during `connect()` — and sets them even on a server without the
 * NAMESPACE extension, by falling back to `LIST "" ""`, which is why the authoritative branch
 * below is the one that runs in production rather than the derived one. A client that exposes
 * neither is not an error; it takes the derived branch.
 */
export interface MetaNamespaceSource {
  readonly namespace?: MetaNamespaceEntry | null | undefined;
  readonly namespaces?: { readonly personal?: readonly MetaNamespaceEntry[] | false | null } | null | undefined;
}

/** Where `ohmail/_meta` is — or, when nothing holds it yet, where it should be created. */
export interface MetaFolderLocation {
  /** The server path to CREATE, SELECT, APPEND and EXPUNGE at. */
  readonly path: string;
  /** The LIST row that matched, or `null` when no such folder exists on this server. */
  readonly row: MetaFolderRow | null;
}

/**
 * Two folders both look like `ohmail/_meta`, and picking one is the thing this must not do.
 * Reachable when an older build created `ohmail._meta` at the root and a newer one created
 * `INBOX.ohmail._meta`: choosing either puts the reader and the writer in different folders for
 * as long as both exist — the dual-organizer bug with a longer fuse. It THROWS, and every
 * caller's wrapper turns that into {@link LeaseUnavailableError} — could-not-look, which must be
 * unreachable from nobody-holds-it. A person has to delete one of the two folders; nothing here
 * can know which.
 */
export class AmbiguousMetaFolderError extends Error {
  readonly paths: readonly string[];
  constructor(paths: readonly string[]) {
    super(
      `${META_FOLDER} resolves to more than one folder on this server (${paths.join(", ")}), so which `
      + `one carries the organizer lease is unknown; nothing was read and nothing was written`,
    );
    this.name = "AmbiguousMetaFolderError";
    this.paths = paths;
  }
}

/** `META_FOLDER` is exactly two segments, and both halves are needed to read a mapped spelling. */

/**
 * The personal namespaces a client learned at login, most-preferred first.
 *
 * `namespaces.personal` before `namespace` because the first is the whole list and the second is
 * only its head — a server declaring two personal namespaces would otherwise have one of them
 * silently invisible to the match below.
 */
export function personalNamespacesOf(client: MetaNamespaceSource | undefined): readonly MetaNamespaceEntry[] {
  if (client === undefined || client === null) return [];
  const declared = client.namespaces?.personal;
  if (Array.isArray(declared) && declared.length > 0) return declared;
  const one = client.namespace;
  return one ? [one] : [];
}

/**
 * One alphabet for the whole resolution — the delimiter, and `ohmail/_meta` re-spelled in it. A
 * namespace prefix is concatenated onto the mapped name, so the two must be spelled the same way;
 * the adapter once produced `INBOX./ohmail/_meta` by mixing them. The FIRST personal namespace's
 * delimiter wins, because the prefix is the half that cannot be re-spelled; below it the LIST
 * row's own delimiter, and only then `bare`'s separator — `toServerPath` short-circuits on `"/"`
 * and returns the canonical unchanged, so `between` can be a default wearing the costume of a
 * discovery, and trusting it over the server returned "absent" on a prefixed server with no
 * NAMESPACE reply: the peek reported `state=none` on an actively organized mailbox.
 */
function metaAlphabet(
  bare: string,
  list: readonly MetaFolderRow[],
  ns: readonly MetaNamespaceEntry[],
  canonical: string,
): { delimiter: string; bare: string } {
  /* The two segments of THIS canonical name, not `ohmail/_meta`'s. Every folder this resolution
     serves is exactly two segments (`WATCHED_FOLDERS`), and reading the split off the canonical
     rather than off two module constants is what lets the watched folders share the rule — with
     `ohmail/_meta` still passing its own name and getting exactly what it got before. Deriving a
     FIXED tail length here was the bug in waiting: `_meta` is five characters, so slicing by it
     found the right separator for `ohmail.Reads` by coincidence and garbage for
     `ohmail.Screener`. */
  const one = (d: unknown): string | undefined => (typeof d === "string" && d.length === 1 ? d : undefined);
  const cut = canonical.indexOf("/");
  if (cut === -1) {
    /* A SINGLE-SEGMENT NAME has no separator to discover and nothing to re-spell — `INBOX` is
       one `WATCHED_FOLDERS` entry away from arriving here now that this is a general export.
       Without this the slice arithmetic below is nonsense rather than merely wrong: `head` drops
       the name's last character (`slice(0, -1)`), `tail` is the whole name, and the re-spelling
       builds a folder path out of the overlap. */
    const only = list.find((f) => f.path.toUpperCase() === "INBOX") ?? list[0];
    return { delimiter: one(ns[0]?.delimiter) ?? one(only?.delimiter) ?? "/", bare };
  }
  const head = canonical.slice(0, cut);
  const tail = canonical.slice(cut + 1);
  const between = one(bare.slice(head.length, bare.length - tail.length));
  const row = list.find((f) => f.path.toUpperCase() === "INBOX") ?? list[0];
  const delimiter = one(ns[0]?.delimiter) ?? one(row?.delimiter) ?? between ?? "/";
  return {
    delimiter,
    bare: between !== undefined && between !== delimiter ? `${head}${delimiter}${tail}` : bare,
  };
}

/**
 * Find `ohmail/_meta` on this server, or say where to put it. Pure — a LIST and a NAMESPACE in, a
 * path out. A prefix has to be credible, never any suffix match (which would adopt a customer's
 * `Backup.ohmail._meta` as the lease): when the client reports personal namespaces, only those
 * prefixes count; otherwise a prefix counts when the server LISTS the mailbox it names. The root
 * spelling is always a candidate — on a flat server the root is where the folder lives. Two
 * matches is {@link AmbiguousMetaFolderError}, never a choice. When nothing matches, the answer
 * is the first declared personal prefix plus the mapped name: the server would file a root-named
 * CREATE there anyway.
 */
export function resolveMetaFolder(input: {
  list: readonly MetaFolderRow[];
  /** `toServerPath(META_FOLDER)` — the mapped name, without a namespace prefix. */
  bare: string;
  namespaces?: readonly MetaNamespaceEntry[];
}): MetaFolderLocation {
  return resolveOhmailFolder({ ...input, canonical: META_FOLDER });
}

/**
 * The same resolution, for any one of our folders — `ohmail/_meta` is just the caller with the
 * strictest need. Generalised because `ImapAdapter.ensureFolders` had the identical defect: it
 * matched `OHMAIL_FOLDERS` against the LIST by string equality, so on a prefixed server none of
 * the five watched folders was recognised and all five were re-CREATEd on every connect — each
 * caught as "already exists", costing round trips and nothing else. See {@link resolveMetaFolder}
 * for the rule; the prefix-credibility argument is identical.
 */
export function resolveOhmailFolder(input: {
  list: readonly MetaFolderRow[];
  /** `toServerPath(canonical)` — the mapped name, without a namespace prefix. */
  bare: string;
  namespaces?: readonly MetaNamespaceEntry[];
  /** The canonical, slash-spelled name `bare` is the server mapping of. Exactly two segments. */
  canonical: string;
}): MetaFolderLocation {
  const { list } = input;
  const ns = input.namespaces ?? [];
  const { delimiter, bare } = metaAlphabet(input.bare, list, ns, input.canonical);
  // A CLIENT THAT ANSWERED IS AUTHORITATIVE EVEN WHEN ITS ANSWER IS "no prefix", and reading
  // this off "are there any NON-EMPTY prefixes" instead would be a hole in exactly the servers
  // most people use. Gmail and Fastmail declare ONE personal namespace whose prefix is empty;
  // that is a positive statement that mailboxes live at the root, so the only candidate is the
  // root. Falling through to the derived branch there would let a customer's own
  // `Archive/ohmail/_meta` — any folder under any listed parent — be adopted as the lease.
  const authoritative = ns.length > 0;

  // The FIRST personal namespace, and only it. A server may declare several; `ImapFlow` uses
  // exactly one — it sets `namespace = namespaces.personal[0]` and prepends that prefix to every
  // path it sends and receives — so a folder under a second declared namespace is not where this
  // connection's organizer would ever write, and treating it as the lease would read a claim from
  // somewhere the writer will never renew (on personal = (("" "/") ("Shared/" "/")), a stranger's
  // `Shared/ohmail/_meta`). Also the create path, same spelling: filtering empty prefixes out
  // before taking the first once created the folder under `Shared/`.
  const head = authoritative ? (ns[0]?.prefix ?? "") : "";
  const primary = head === "" || head.endsWith(delimiter) ? head : `${head}${delimiter}`;

  const credible = (prefix: string): boolean => {
    if (prefix === "" || !prefix.endsWith(delimiter)) return false;
    if (authoritative) return prefix === primary;
    // No NAMESPACE to ask, and this branch trades a risk for an answer. Reachable in production:
    // `ImapFlow`'s handler assigns onto `personal[0]` when the server answers NIL, `personal` is
    // `false` there, strict mode throws, its own catch swallows it — no namespace at all. Here a
    // prefix counts when the server LISTS the mailbox it names — weaker, and weaker in a
    // direction that matters: a customer's `Backup/ohmail/_meta` IS adopted when `Backup` is
    // listed. The alternative is a lease unreadable rather than occasionally wrong; the root
    // candidate stays in play, and two matches are refused rather than picked. The trade is
    // recorded rather than hidden.
    const parent = prefix.slice(0, prefix.length - delimiter.length);
    return list.some((f) => f.path === parent);
  };

  const hits = list.filter((f) => f.path === bare
    || (f.path.endsWith(bare) && credible(f.path.slice(0, f.path.length - bare.length))));

  if (hits.length > 1) throw new AmbiguousMetaFolderError(hits.map((f) => f.path));
  const hit = hits[0];
  if (hit !== undefined) return { path: hit.path, row: hit };
  return { path: `${primary}${bare}`, row: null };
}

/** The minimum a client has to be for {@link makeMetaFolderRef} to resolve against it. */
export interface MetaFolderClient extends MetaNamespaceSource {
  list(): Promise<MetaFolderRow[]>;
}

/**
 * `ohmail/_meta` on ONE connection: resolve it once, then address it.
 *
 * The memo is per REF, and every IO factory builds a fresh one per call, so it lives exactly as
 * long as one gate cycle or one peek — long enough that `ensureMetaFolder` → `listClaims` →
 * `appendClaim` costs one LIST rather than three, and short enough that a folder created or
 * moved between cycles is seen on the next one.
 */
export interface MetaFolderRef {
  /**
   * LIST and resolve, fresh. Also warms {@link MetaFolderRef.path}. Takes the read's budget where
   * it has one — see {@link metaReadBudget}: the LIST is the first of the read's four commands and
   * was the one with no clock on it at all.
   */
  locate(budget?: ImapDeadline): Promise<MetaFolderLocation>;
  /** The path to address, resolving on first use and remembered after. */
  path(budget?: ImapDeadline): Promise<string>;
  /** Remember a path the SERVER named — a CREATE's landed path is truer than any derivation. */
  adopt(path: string): void;
}

export function makeMetaFolderRef(
  client: MetaFolderClient,
  toServerPath: (canonical: string) => string,
  /** A path this LOGIN already resolved, and where to keep one it resolves — see {@link MetaPathSeed}. */
  seed?: MetaPathSeed,
): MetaFolderRef {
  let known: string | null = seed?.known ?? null;

  const locate = async (budget?: ImapDeadline): Promise<MetaFolderLocation> => {
    const listed = await (budget === undefined
      ? client.list()
      : budget.race(client.list(), META_FOLDER));
    const at = resolveMetaFolder({
      /*
       * THE ONE LIST THIS MODULE ISSUES, AND IT IS THE SERVER'S ARRAY.
       *
       * The adapter funnels its LIST sites through one bounded helper, but this one is reached
       * with the RAW client, so it was outside that guarantee — a server naming a million folders
       * cost a million strings every cycle, in a process every other mailbox shares. Same helper,
       * same ceilings: a count on the response and a length on each path, raced against the read's
       * own budget, since a server may also answer this one command slowly for ever, which no
       * count sees.
       */
      list: boundListResponse(listed),
      bare: toServerPath(META_FOLDER),
      namespaces: personalNamespacesOf(client),
    });
    known = at.path;
    seed?.learned(at.path);
    return at;
  };

  return {
    locate,
    async path(budget?: ImapDeadline): Promise<string> {
      return known ?? (await locate(budget)).path;
    },
    adopt(path: string): void {
      known = path;
      seed?.learned(path);
    },
  };
}

/**
 * A RESOLVED `_meta` PATH KEPT ACROSS PASSES ON ONE LOGIN — the organizer io's, so a shrink pass
 * costs no LIST of its own (REVIEW-02514 LOW 1). The adapter forgets it at every dial.
 */
export interface MetaPathSeed {
  readonly known: string | null;
  learned(path: string): void;
}

/**
 * THE BUDGET ONE READ OF `ohmail/_meta` SPENDS — entered where the read BEGINS, not where its
 * last segment does.
 *
 * A read of this folder is four server commands: LIST, SELECT, STATUS, FETCH. Only the FETCH
 * carried a clock, so the three in front were bounded by nothing and the FETCH started its
 * {@link IMAP_META_DEADLINE_MS} fresh however long they had taken — the constant bounded a quarter
 * of the read and named the whole of it. One object, created here and passed down, is what makes
 * that sentence true.
 */
export function metaReadBudget(now: () => number = Date.now): ImapDeadline {
  return ImapDeadline.in(IMAP_META_DEADLINE_MS, "read_deadline", now);
}

/**
 * SELECT the folder under the read's clock — the second of the four segments.
 *
 * A lock that arrives after the clock ran out would be held by nobody: the waiter has left, its
 * `finally` can no longer run, and every later command on the connection queues behind a lock with
 * no owner. So the release is attached to the late arrival BEFORE the wait is abandoned. Without a
 * budget this is the bare call it always was.
 */
async function lockWithin(
  client: Pick<LeaseImapClient, "getMailboxLock">, path: string, budget?: ImapDeadline,
): Promise<{ release(): void }> {
  const pending = client.getMailboxLock(path);
  if (budget === undefined) return pending;
  try {
    return await budget.race(pending, path);
  } catch (err) {
    // Not `await`ed: the point is to stop waiting. If the SELECT never lands there is nothing to
    // release and the rejection is already the caller's answer.
    void pending.then((lock) => { lock.release(); }, () => { /* it never arrived */ });
    throw err;
  }
}

/** The claim format this build writes and understands. */
export const CLAIM_PROTOCOL = 1;

/**
 * How long a claim stays fresh without a renew.
 *
 * Generous relative to plausible clock skew between two machines, and generous relative to a
 * poll interval measured in seconds. The failure this window guards is a real one in both
 * directions: too short and a laptop that slept through a renew is treated as gone while it is
 * still organizing; too long and a genuinely dead install holds a mailbox hostage. Ten minutes
 * against a renew every cycle means roughly forty missed renews before anyone is declared stale.
 */
export const DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * Who is holding a claim. A closed set — an unrecognised value is foreign-and-unknown ({@link
 * readClaim} answers `"unknown"`). `mobile` is a member, and its absence from the read set once
 * cost this: a renew appends the new claim then expunges the old, so the folder briefly holds two
 * of an install's claims, and `decideLease` excludes only `rawOurs` (install id AND the armed
 * nonce) — the phone's own older copy was a live claim it could not rank, and it stood down from
 * its own mailbox every cycle. Both halves are one set now; the database carries the member too
 * (`ORGANIZER_KINDS`, `packages/db/src/organizer-role.ts`). A VALUE, not only a type: the writers
 * are not all TypeScript, and a tool outside this package derives its word list from this line.
 */
export const ORGANIZER_KIND_WORDS = ["local", "cloud", "mobile"] as const;

/** Who is holding a claim — see {@link ORGANIZER_KIND_WORDS}. */
export type OrganizerKind = (typeof ORGANIZER_KIND_WORDS)[number];

/**
 * Is this a word this build both writes and admits? One predicate for the claim door and the
 * request door: a rig that wrote `desktop` produced claims every build parsed as `unknown`.
 */
export function isOrganizerKindWord(word: string): word is OrganizerKind {
  return (ORGANIZER_KIND_WORDS as readonly string[]).includes(word);
}

/**
 * A human asked for this install, and WHEN. It used to be the string `"authorized"`: a
 * boolean-shaped authorization cannot rank two installs that were both pressed, so `kind` ranked
 * instead and a local install had no path over a live Cloud however recently its owner asked. The
 * instant makes the press itself rankable — a stale press loses to a fresh one from the same
 * folder contents. An object rather than a bare `Date | null` so the type CANNOT accept the old
 * string: a union still admitting a string would leave an un-updated call site reading as
 * pressed-at-the-epoch, silently, with the suite green.
 */
export interface TakeoverAuthorization {
  /** The instant the press was recorded, as the row holds it. */
  authorizedAt: Date;
  /**
   * WHICH VERB WAS PRESSED — required, and the one field here whose absence would be dangerous.
   *
   * Optional it would default at every call site to the value that displaces, so the install with
   * no takeover verb would keep taking live holders' mailboxes behind a green suite. The five
   * call sites are all in `src` and the compiler names them.
   */
  intent: OrganizerIntent;
}

/**
 * WHAT THE PERSON PRESSED, per claim — never which KIND of machine they pressed it on.
 *
 * `takeover` asks for the mailbox whoever holds it; `join` asks only for a mailbox nobody is
 * organizing, and yields to a live holder however recently it was pressed. The distinction is the
 * verb's, so an install that grows a second verb carries both, and `kind` stays out of the
 * decision table the 0.14.1 ruling emptied of it.
 */
export { ORGANIZER_INTENTS, type OrganizerIntent } from "@trafficflow/db";

/** A claim message, parsed. */
export interface OrganizerClaim {
  installId: string;
  kind: OrganizerKind | "unknown";
  protocol: number;
  /** ISO instant of the last renew. NOT IMAP INTERNALDATE — that is the server's clock. */
  heartbeat: Date;
  /**
   * THE SERVER'S OWN STAMP FOR THIS RECORD — IMAP INTERNALDATE, the instant the mail server took
   * delivery of it, and the one time in this folder no install's clock can be wrong about.
   *
   * The decision layer ages and ranks by it ({@link withServerClock}), so a laptop reading 2099
   * can neither age every honest claim nor look newer than one. `null` where the READ could not
   * report it, and absence keeps the writer's own stamp rather than inventing a time.
   */
  serverStamp: Date | null;
  /**
   * WHAT THE WRITER'S OWN CLOCK SAID, kept beside the substitution rather than under it.
   *
   * `withServerClock` replaces `heartbeat` with {@link serverStamp}, which is right for every
   * comparison BETWEEN machines. One comparison is between two records of ONE machine — which of
   * its own appends came last — and the server's second-resolution stamp cannot answer it for a
   * renew's two appends. See {@link compareRecency}.
   */
  writerStamp: Date;
  /** ISO instant this install BECAME organizer, as distinct from last seen. */
  claimedAt: Date;
  displayName: string;
  /** Per-write nonce. See the clone defence on {@link LeaseSelf}. */
  nonce: string;
  /**
   * THE INSTANT OF THE PRESS THIS TENURE RESTS ON — what {@link compareStrength} ranks first.
   *
   * `null` for three populations and they are not the same thing, though the election treats them
   * alike (lowest): a claim written on an empty folder, where there was nobody to take over from;
   * a claim written by an install that predates this field; and a renewal descended from either.
   * All three mean "nobody pressed for this", which is the honest thing to rank below a press.
   */
  authorizedAt: Date | null;
  /**
   * WHICH VERB THIS TENURE RESTS ON. Descriptive here: a FOREIGN claim's intent decides nothing,
   * so an unreadable one is folded to `takeover` rather than refused — see {@link parseClaim}.
   * Its one reader is the gate's own carry-forward, so a tenure keeps the verb it was taken with.
   * A record written before this field says `takeover`, which is what those installs do.
   */
  intent: OrganizerIntent;
  /**
   * WHAT THIS ORGANIZER OFFERS A READER, as the claim advertises it. Empty means none — which is
   * what every pre-0.14.1 claim says, and it is a true statement about those installs rather than
   * a gap in the parse.
   */
  capabilities: readonly string[];
  /** Whatever the IO layer needs to expunge this exact message. */
  ref?: unknown;
}

/**
 * A message that says it is a claim and then is not parseable as one.
 *
 * Distinct from "not a claim" on purpose. A message in `ohmail/_meta` WITHOUT
 * `X-Ohmail-Lease: 1` is a stray or a future meta record type and is invisible to this module —
 * that is what makes the discriminator header worth having. A message WITH it whose fields are
 * unreadable is EVIDENCE THAT SOMEBODY CLAIMED, and evidence is not nothing: it produces
 * `available`, never `organize`. Reading it as "no claim, so organize" is the dual-organizer bug
 * through the back door.
 */
export interface MalformedClaim {
  malformed: true;
  /** Why, for the log. Never surfaced to a user. */
  reason: string;
  ref?: unknown;
}

export type ClaimRecord = OrganizerClaim | MalformedClaim;

export function isMalformed(c: ClaimRecord): c is MalformedClaim {
  return (c as MalformedClaim).malformed === true;
}

/**
 * Who we are, for the gate. The clone defence: restore-from-backup clones the install id, and two
 * machines then both believe every claim carrying it is their own — identity matching silently
 * permits exactly the dual organizing it exists to prevent. So every write carries a fresh nonce
 * and the writer remembers the last one: an "own" claim whose nonce is not ours with a newer
 * heartbeat is somebody else with our id. `lastNonce` is memory-only, deliberately: persisting it
 * would break own-role resumption after a crash, and forgetting it means a fresh process trusts
 * any claim bearing its id exactly once — the clone case needs two LIVE writers to be dangerous,
 * exactly what a null nonce cannot reach.
 */
export interface LeaseSelf {
  installId: string;
  /** What this install stamps into its own claim. One set with the read set. */
  kind: OrganizerKind;
  displayName: string;
  /** The nonce of our last write this process, or `null` on a fresh start. */
  lastNonce: string | null;
  /**
   * THE NONCE THIS PROCESS MINTED FOR A WRITE WHOSE OUTCOME IT NEVER LEARNED.
   *
   * A renewal APPENDs and the answer is lost: the write committed, so the FOLDER's idea of this
   * install moved while {@link lastNonce}, which only an answer updates, did not — and the next
   * gate read our own claim as a clone's and stood the running install down. Recorded before the
   * append, so a claim bearing either value is ours ({@link bearsOurNonce}). Memory-only exactly as
   * `lastNonce` is and for its reason: a fresh process trusts its own id once, which is what keeps
   * own-role resumption working. Nothing is persisted and no row gains a column.
   */
  pendingNonce?: string | null;
  /**
   * THIS PROCESS HAS SEEN ITS OWN CLOCK CORRECTED SINCE IT LAST WROTE — supplied by the caller,
   * because only a process can observe its own clock being set.
   *
   * Both stamps on a claim are immutable, so a record written under a wrong clock refuses for
   * ever. A LAUNCH escapes that on `lastNonce === null`; this is the same arm made reachable while
   * running. NOT `lastNonce = null`, which would re-enter {@link bearsOurNonce}'s "trust anything
   * wearing my id" on a live install. One correction buys ONE renewal, never a standing exemption.
   */
  clockCorrected?: boolean;
  protocol?: number;
}

/**
 * IS THIS CLAIM'S NONCE ONE OF OURS? — the one resolver, because three predicates asked it and a
 * fourth spelling is how they come to disagree about a single record.
 *
 * `lastNonce === null` is "trust anything wearing my id", the fresh-process arm, unchanged. With a
 * nonce armed it is the current one OR the pending one and NOTHING else: an unrecognised nonce is
 * never ours by default, which is the invariant inverted and would admit a real second organizer.
 */
export function bearsOurNonce(self: LeaseSelf, nonce: string): boolean {
  if (self.lastNonce === null) return true;
  return nonce === self.lastNonce || (self.pendingNonce != null && nonce === self.pendingNonce);
}

export type StandDownReason =
  | "organized_elsewhere:cloud"
  | "organized_elsewhere:local"
  | "organized_elsewhere:mobile"
  | "organized_elsewhere:unknown";

/** Organize this mailbox, and renew our claim while doing so. */
export interface OrganizeVerdict {
  verdict: "organize";
  renew: true;
  /**
   * Refs of the foreign claims this win displaced, for the IO layer to expunge. Populated only on
   * an AUTHORIZED takeover — never on a renew or own-role resumption. Without it the arbitration
   * is undone one cycle later, measured: a human authorizes B over A; B wins and appends; next
   * cycle both elect over {A, B} and A wins on incumbency, so B stands down and the takeover
   * quietly reverses, permanently. The folder is the only shared medium, so the decision is
   * recorded THERE: once A's claim is gone, A's own next read stands down. Narrow by design —
   * only when a human asked, and the worst case with a live peer is fewer organizers, never more.
   */
  displace: readonly unknown[];
  /**
   * Did this win come from the PRESS, or from continuation? `true` only on rule 6 — a press
   * outranked every live claim; `false` on rules 3 and 4, which can be reached with a press
   * outstanding, so "was a press present" is not the same question. The gate needs it to decide
   * what stamp the renewed claim carries: an authorized win writes the press it rested on,
   * everything else carries forward the prior claim's. Deriving it from `displace.length > 0`
   * would be true today by accident and silently wrong for a rule-6 win whose beaten claims had
   * no refs — the gate would write no stamp and hand the mailbox back on the next election.
   */
  authorized: boolean;
}

/** Somebody else is organizing this mailbox right now. Stop, and release our own claim. */
export interface StandDownVerdict {
  verdict: "stand_down";
  reason: StandDownReason;
  /** The winning claim, so a UI can name the machine. `null` when it was malformed. */
  by: OrganizerClaim | null;
}

/**
 * Nobody is organizing this mailbox, but somebody WAS — the third verdict a two-verdict table
 * gets wrong. "No fresh foreign claim, so organize" is the forbidden auto-resume: a Cloud
 * subscription lapses and a forgotten office install silently becomes the thing that moves
 * someone's mail, triggered by a billing event, with a rules store frozen at stand-down. Ceasing
 * to organize is always automatic; BECOMING an organizer always requires an explicit human
 * action, Cloud included. `available` converts to `organize` only with `takeover: "authorized"`.
 * Zero claims is NOT this: a mailbox nobody ever organized has nobody to take over from.
 */
export interface AvailableVerdict {
  verdict: "available";
  /** The stale claim we would be taking over from, or `null` if it was malformed. */
  by: OrganizerClaim | null;
}

export type LeaseVerdict = OrganizeVerdict | StandDownVerdict | AvailableVerdict;

// ── LAYER 1: FORMAT ─────────────────────────────────────────────────────────────────────────

/**
 * "THIS RECORD CARRIES ITS DISCRIMINATOR" — the value `1` every `ohmail/_meta` record type writes
 * and every parser admits. Once a SEARCH term; no lease decision asks SEARCH now, and the ack
 * sweep's local matcher ({@link hasAckHeader}) reads the value from here so the two cannot drift.
 */
export function metaHeaderTerm(name: string): Record<string, string> {
  return { [name]: "1" };
}

const H = {
  lease: "X-Ohmail-Lease",
  kind: "X-Ohmail-Organizer-Kind",
  installId: "X-Ohmail-Install-Id",
  protocol: "X-Ohmail-Protocol",
  heartbeat: "X-Ohmail-Heartbeat",
  claimedAt: "X-Ohmail-Claimed-At",
  displayName: "X-Ohmail-Display-Name",
  nonce: "X-Ohmail-Nonce",
  /**
   * THE INSTANT OF THE PRESS THAT CREATED THIS TENURE — the field the election now ranks on.
   *
   * Additive at protocol 1, deliberately: an install one release older parses every field it knows
   * and ignores this one, which is exactly the behaviour a cross-version handover needs. What it
   * costs is stated where the ranking is (see {@link compareStrength}) — an older install ranks by
   * incumbency alone and can therefore win an election a newer one would give to the press.
   */
  authorizedAt: "X-Ohmail-Authorized-At",
  /**
   * WHAT THIS ORGANIZER CAN DO FOR A READER — a comma-separated set; absent means none.
   *
   * It exists so a reader can tell "the organizer will take my decisions" from "the organizer is
   * an older build that will never look", and say so instead of leaving somebody waiting for ever
   * on a machine that is never going to answer.
   */
  capabilities: "X-Ohmail-Capabilities",
  /**
   * WHICH VERB THIS TENURE RESTS ON — written only for `join`, absent for `takeover`.
   *
   * Absent is the only spelling of "takeover" on purpose: every record any shipped build wrote
   * lacks the header, and those installs DO take over, so no record needs migrating and an older
   * reader that ignores the key still ranks the folder the way its own build always did.
   */
  intent: "X-Ohmail-Intent",
} as const;

/**
 * The one capability there is today: this organizer drains decision records out of the meta
 * folder. Re-exported because writers and the reader's door name the same string, and two
 * spellings of a capability is a capability never detected. It was two literals held equal by a
 * test, argued from a dependency direction — `@trafficflow/db` must never import
 * `@trafficflow/core`, which is true; the wrong half was the conclusion, since the edge runs the
 * other way (`packages/core` already imports from db). One definition, in the package that cannot
 * reach the other; the equality test is deleted with the second literal.
 */
export { CAPABILITY_REQUESTS, CAPABILITY_MOVES, CAPABILITY_RULES, CAPABILITY_PROFILE };

/** Strip CR/LF so a display name can never inject a header. */
function headerSafe(v: string): string {
  return v.replace(/[\r\n]+/g, " ").trim();
}

export interface ClaimInput {
  installId: string;
  /** What this install stamps into its own claim. One set with the read set. */
  kind: OrganizerKind;
  displayName: string;
  heartbeat: Date;
  claimedAt: Date;
  nonce: string;
  protocol?: number;
  /**
   * The press this tenure rests on, or `null` for a tenure nobody pressed for. REQUIRED, not
   * optional — `authorizedAt?: Date` would compile at every existing call site and write nothing
   * at all of them, so every claim this build wrote would rank as unpressed, every authorized
   * takeover would read stale to the next election, and the feature would be off in production
   * behind a green suite. Required means every write site decides once, and the compiler names
   * the sites. `null` is a real answer and the common one: a claim on an empty folder is not a
   * press and must not rank as one.
   */
  authorizedAt: Date | null;
  /**
   * WHAT THIS ORGANIZER OFFERS A READER. Required for {@link authorizedAt}'s reason exactly: an
   * optional field left off every call site would advertise nothing from every organizer, and a
   * reader reading that would tell its user the holder is too old to take decisions — on a fleet
   * where every holder is this build.
   *
   * Empty is legal and means "none"; the header is then omitted, which is what an older reader
   * sees anyway.
   */
  capabilities: readonly string[];
  /**
   * WHICH VERB THIS TENURE RESTS ON. OPTIONAL, and deliberately not required the way
   * {@link authorizedAt} is: there the default was the dangerous value — an omitted press ranked
   * every claim unpressed and turned the feature off behind a green suite — while here the
   * default is `takeover`, which is exactly what every call site written before this field
   * already did. Nothing reads a foreign claim's intent, so an omitted one decides nothing.
   */
  intent?: OrganizerIntent;
}

/**
 * One RFC822 message per organizer.
 *
 * The body is a sentence for a human who opens `ohmail/_meta` in Apple Mail and wonders what
 * this is. It carries no information the headers do not — a reader that parses the body would be
 * a second format.
 */
export function formatClaim(c: ClaimInput): string {
  const protocol = c.protocol ?? CLAIM_PROTOCOL;
  // ── AN ABSENT HEADER IS THE ONLY SPELLING OF "NONE" ─────────────────────────────────────
  //
  // Neither field is ever written empty. `X-Ohmail-Authorized-At:` with nothing after it would
  // parse to an unreadable date, which is a MALFORMED claim — evidence somebody claimed that
  // cannot be read, and the strongest refusal in this module. `X-Ohmail-Capabilities:` empty would
  // be a set containing one empty string. Both are the same mistake: a field that means "nothing"
  // has to be absent, because a reader one release older cannot tell an empty value from a value
  // it does not understand.
  const capabilities = c.capabilities.map(headerSafe).filter((v) => v !== "");
  const lines = [
    `${H.lease}: 1`,
    `${H.kind}: ${c.kind}`,
    `${H.installId}: ${headerSafe(c.installId)}`,
    `${H.protocol}: ${protocol}`,
    `${H.heartbeat}: ${c.heartbeat.toISOString()}`,
    `${H.claimedAt}: ${c.claimedAt.toISOString()}`,
    ...(c.authorizedAt ? [`${H.authorizedAt}: ${c.authorizedAt.toISOString()}`] : []),
    // ONLY `join` IS WRITTEN — the absent header is "takeover", on the rule three lines above.
    ...(c.intent === "join" ? [`${H.intent}: join`] : []),
    ...(capabilities.length > 0 ? [`${H.capabilities}: ${capabilities.join(", ")}`] : []),
    `${H.displayName}: ${headerSafe(c.displayName)}`,
    `${H.nonce}: ${headerSafe(c.nonce)}`,
    `Subject: ohmail organizer claim`,
    `Date: ${c.heartbeat.toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    "",
    `ohmail is organizing this mailbox from ${headerSafe(c.displayName)}.`,
    "This message is bookkeeping. Deleting it is safe; ohmail writes a new one on its next cycle.",
    "",
  ];
  return lines.join("\r\n");
}

/**
 * Read the headers of one message. Returns `null` when it is not a claim at all.
 *
 * `serverStamp` is the record's IMAP INTERNALDATE, which is not a header and so cannot be parsed
 * out of `raw` — it is carried BESIDE the source by every read ({@link RawClaimMessage}) and
 * handed in here so that one object holds both of a record's two times.
 */
export function parseClaim(raw: string, ref?: unknown, serverStamp?: Date | null): ClaimRecord | null {
  const headerBlock = raw.split(/\r?\n\r?\n/, 1)[0] ?? "";
  const headers = new Map<string, string>();
  const seen = new Map<string, number>();
  // Unfold continuation lines before splitting: a long display name may be wrapped by the
  // server, and a folded header read line-by-line loses everything after the first line.
  for (const line of headerBlock.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    headers.set(name, line.slice(at + 1).trim());
    seen.set(name, (seen.get(name) ?? 0) + 1);
  }

  const get = (k: string): string | undefined => headers.get(k.toLowerCase());
  const count = (k: string): number => seen.get(k.toLowerCase()) ?? 0;

  const malformed = (reason: string): MalformedClaim =>
    ref === undefined ? { malformed: true, reason } : { malformed: true, reason, ref };

  // A record that says `X-Ohmail-Lease: 1` anywhere is never invisible. The discriminator was
  // read last-value-wins, so `X-Ohmail-Lease: 1 … X-Ohmail-Lease: 0` parsed as not-a-claim —
  // `null`, dropped entirely — and an incumbent's only claim could be erased from every reader's
  // view by one duplicated header; the next install found an empty folder and organized beside
  // it. Reproduced against the parser. So the DUPLICATE is refused, as `malformed` rather than
  // `null`: a message that announces itself and cannot be read is evidence somebody claimed, and
  // evidence produces `available` at worst. `null` is reserved for a record that never claimed
  // anything.
  if (count(H.lease) > 1) return malformed("duplicate lease header");
  if (get(H.lease) !== "1") return null; // not a claim — a stray, or a future meta record type
  // Every field the decision reads gets the same treatment, for the same reason: a duplicated
  // `X-Ohmail-Install-Id` or `X-Ohmail-Heartbeat` would let a crafted record present one identity
  // to a reader that takes the first value and another to one that takes the last.
  //
  // `X-Ohmail-Authorized-At` joins that list because the ELECTION reads it first, so a duplicate
  // is the same attack one field over: a crafted record could rank as a fresh press to a reader
  // that takes the last value and as an unpressed claim to one that takes the first, and the two
  // readers would elect different organizers off the same folder. `X-Ohmail-Capabilities` joins it
  // because a reader DECIDES on it — whether to hand this organizer a decision or to tell its user
  // nobody will take one — and a record that answers that question twice has not answered it.
  for (const field of [
    H.kind, H.installId, H.protocol, H.heartbeat, H.claimedAt, H.nonce,
    H.authorizedAt, H.capabilities,
  ]) {
    if (count(field) > 1) return malformed(`duplicate ${field}`);
  }

  const installId = get(H.installId);
  if (!installId) return malformed("no install id");

  const protocolRaw = get(H.protocol);
  const protocol = Number(protocolRaw);
  if (!protocolRaw || !Number.isFinite(protocol) || protocol < 1) return malformed("unreadable protocol");

  const heartbeat = new Date(get(H.heartbeat) ?? "");
  if (Number.isNaN(heartbeat.getTime())) return malformed("unreadable heartbeat");

  // A claim with no `claimedAt` is still a claim; it just cannot win the local-vs-local
  // incumbent comparison. Defaulting to the heartbeat makes it the NEWEST possible incumbent,
  // which is the losing side of §3.2 rule 4 — the fail-safe direction.
  const claimedAtRaw = get(H.claimedAt);
  const claimedAt = claimedAtRaw ? new Date(claimedAtRaw) : heartbeat;

  /* THE READ SET, AND IT HAS TO MATCH THE WRITE SET EXACTLY. A kind this build writes but does
     not admit here parses as `unknown`, which rules 1/2 read as a live unrankable peer — and for
     `mobile` that peer was the install's own renew residue, so a phone stood down from itself.
     `isOrganizerKind` in `@trafficflow/db` carries the same members; this package cannot import
     it (the engine tier may not depend on the private half) and `organizer-lease-reasons.test.ts`
     reconciles the two. */
  const kindRaw = (get(H.kind) ?? "").toLowerCase();
  const kind: OrganizerKind | "unknown" = isOrganizerKindWord(kindRaw) ? kindRaw : "unknown";

  /* ── AN ABSENT PRESS IS `null`; AN UNREADABLE ONE IS MALFORMED ──────────────────────────────
   *
   * The two are deliberately not folded together, and the direction matters. Absent is the common
   * case — every pre-0.14.1 claim and every arm-4 claim — and it means "nobody pressed", which is
   * a fact the election ranks lowest and carries on with. A header that is PRESENT and unreadable
   * is a record that tried to say something about its own authority and failed, and reading that
   * as "nobody pressed" would let a corrupted or crafted stamp quietly demote a real press to the
   * bottom of the order. `heartbeat` above takes the same line for the same reason.
   */
  const authorizedAtRaw = get(H.authorizedAt);
  let authorizedAt: Date | null = null;
  if (authorizedAtRaw !== undefined) {
    const parsed = new Date(authorizedAtRaw);
    if (Number.isNaN(parsed.getTime())) return malformed("unreadable authorized-at");
    authorizedAt = parsed;
  }

  /* A SET, ORDER-FREE AND CASE-FOLDED, and an unknown member is KEPT rather than dropped: this
     build cannot know what a later one advertises, and a reader that silently discarded the
     members it did not recognise would be unable to say "that organizer offers something I do not
     understand" — which is a different sentence from "that organizer offers nothing". Empty
     members are dropped, so `a, , b` is two capabilities and not three. */
  const capabilities = (get(H.capabilities) ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v !== "");

  /* ── AN INTENT THIS READER CANNOT READ IS `takeover`, AND THAT IS NOT `authorizedAt`'S RULE ──
   *
   * `X-Ohmail-Authorized-At` is refused when present-and-unreadable, and duplicated when the
   * election RANKS it: a crafted stamp that two readers read differently elects two organizers.
   * Nothing ranks a foreign claim's intent — the only intent the decision consults is the one on
   * the press being offered — so a claim whose intent is absent, misspelled or stated twice is
   * read as `takeover`, the value every record written before this field means. Refusing it here
   * would let an unreadable header decide the election through the back door, and folding it to
   * `join` would let a corrupted byte quietly demote a real press.
   */
  const intent: OrganizerIntent =
    count(H.intent) === 1 && (get(H.intent) ?? "").toLowerCase() === "join" ? "join" : "takeover";

  const claim: OrganizerClaim = {
    installId,
    kind,
    protocol,
    heartbeat,
    writerStamp: heartbeat,
    serverStamp: serverStamp instanceof Date && !Number.isNaN(serverStamp.getTime()) ? serverStamp : null,
    claimedAt: Number.isNaN(claimedAt.getTime()) ? heartbeat : claimedAt,
    displayName: get(H.displayName) ?? "",
    nonce: get(H.nonce) ?? "",
    authorizedAt,
    intent,
    capabilities,
  };
  return ref === undefined ? claim : { ...claim, ref };
}

// ── LAYER 2: THE DECISION ───────────────────────────────────────────────────────────────────

/**
 * This install's own clock skew, measured from a record IT wrote — or `null` when it wrote none.
 * Every claim carries two stamps for one instant: `X-Ohmail-Heartbeat` (the install's clock) and
 * IMAP INTERNALDATE (the server's), and their difference is the skew, independent of the reader's
 * clock and of the folder's age. That independence is why `now − INTERNALDATE` is not the
 * reading: it cannot tell "my clock is ahead" from "nothing has been appended in a while" — every
 * fixture with a fixed clock read as days of skew under that form. The newest of our own records
 * by server time, the most recent instant this clock is known to have been at.
 */
export function ownClockSkewMs(
  records: readonly RawClaimMessage[], installId: string,
): number | null {
  return ownClockReading(records, installId)?.skewMs ?? null;
}

/**
 * The same measurement, WITH THE RECORD IT CAME FROM — a discrepancy is evidence about the clock
 * this install has NOW only if this process wrote the record.
 *
 * Both stamps on a message are immutable, and the refusal precedes the append: a record written
 * with a wrong clock refuses every later cycle by itself, so no record measurable under a
 * CORRECTED clock can ever be written and the person is refused for ever by the clock they fixed.
 * The nonce tells the two cases apart — see {@link writtenByThisProcess}.
 */
export function ownClockReading(
  records: readonly RawClaimMessage[], installId: string,
): { skewMs: number; nonce: string } | null {
  let newestServer = -Infinity;
  let reading: { skewMs: number; nonce: string } | null = null;
  for (const r of records) {
    const at = r.internalDate instanceof Date ? r.internalDate.getTime() : NaN;
    if (!Number.isFinite(at) || at <= newestServer) continue;
    const c = parseClaim(r.raw, r.ref);
    if (c === null || isMalformed(c) || c.installId !== installId) continue;
    newestServer = at;
    reading = { skewMs: c.heartbeat.getTime() - at, nonce: c.nonce };
  }
  return reading;
}

/**
 * DID THIS PROCESS WRITE THAT RECORD? — and it is deliberately NOT {@link bearsOurNonce}.
 *
 * `bearsOurNonce` answers "may I treat this claim as mine", and with no armed nonce its answer is
 * yes: a fresh process trusts any claim wearing its id exactly once, which is what keeps own-role
 * resumption working. This asks the opposite question — "is this record evidence about the state I
 * am in now" — and with no armed nonce the honest answer is NO, because the record predates this
 * process's memory entirely.
 */
export function writtenByThisProcess(self: LeaseSelf, nonce: string): boolean {
  if (self.lastNonce === null) return false;
  return nonce === self.lastNonce || (self.pendingNonce != null && nonce === self.pendingNonce);
}

/**
 * HOW FAR THE TWO CLOCKS MAY DRIFT APART BEFORE IT IS A CORRECTION AND NOT DRIFT.
 *
 * NTP SLEWS at about half a millisecond per second, so a minute between polls moves the wall clock
 * about 30 ms against the monotonic one. A correction worth re-admitting for is the one a person
 * makes to answer this module's own refusal, which is larger than {@link clockSkewBoundMs} —
 * seconds at the shortest window, minutes at the default. A second sits an order of magnitude
 * above the drift and two below the smallest correction that could matter.
 */
export const CLOCK_CORRECTION_TOLERANCE_MS = 1_000;

/**
 * HAS THIS PROCESS'S WALL CLOCK BEEN SET — the watch behind {@link LeaseSelf.clockCorrected}. The
 * two clocks advance together unless something SETS the wall one, so a step is `|Δwall − Δmono|`
 * over the tolerance.
 *
 * A COUNT AND NOT A ONE-SHOT: a process organizes SEVERAL mailboxes, so a boolean spent by the
 * first reader would leave every other one refusing for ever. Each runtime latches the count it
 * has acted on. Generous on purpose — a resumed laptop reads as a correction, and the BOUND makes
 * that safe: a spurious count buys one renewal, exactly as an honest one does.
 */
export function makeClockCorrectionWatch(opts: {
  wall?: () => number; mono?: () => number; toleranceMs?: number;
} = {}): () => number {
  const wall = opts.wall ?? ((): number => Date.now());
  const mono = opts.mono ?? ((): number => performance.now());
  const tolerance = opts.toleranceMs ?? CLOCK_CORRECTION_TOLERANCE_MS;
  let lastWall = wall();
  let lastMono = mono();
  let corrections = 0;
  return (): number => {
    const w = wall();
    const m = mono();
    if (Math.abs((w - lastWall) - (m - lastMono)) > tolerance) corrections += 1;
    lastWall = w;
    lastMono = m;
    return corrections;
  };
}

/**
 * A QUARTER OF THE STALENESS WINDOW — how far this install's own clock may sit from the mail
 * server's and still write a claim.
 *
 * A FRACTION of the window rather than a fixed figure, because the window is a parameter and the
 * damage scales with it: at a one-minute window, 61 seconds of lag was enough for a reader to take
 * the mailbox with our live record in `displace`. A quarter leaves three quarters of the window for
 * the thing the window is actually for — a machine that slept through a renew.
 */
export const CLOCK_SKEW_WINDOW_FRACTION = 4;

/**
 * The bound, in both directions, for a given window. Capped at {@link MAX_FUTURE_SKEW_MS} on the
 * way up: a window above forty minutes would otherwise license a writer to stamp a heartbeat
 * further ahead than any reader will believe, which is the one state a writer-side check exists to
 * make unreachable. The cap is what closes the configured-window case — the tolerance is not
 * widened to meet the window (that is the seventy-three-year lockout with a shorter number); the
 * WRITER is held to the smaller of the two.
 */
export function clockSkewBoundMs(staleAfterMs: number): number {
  return Math.min(Math.floor(staleAfterMs / CLOCK_SKEW_WINDOW_FRACTION), MAX_FUTURE_SKEW_MS);
}

/**
 * Is this install's clock fit to write a claim — the WRITER-side check, and it has to be here: no
 * reader-side rule can fix a wrong writer clock, and the tie-breaker is the server's clock, which
 * both machines see. SYMMETRIC, because both directions cost the same thing: ahead, our heartbeat
 * outranks and ages every honest peer and our press outranks every honest press; behind, our live
 * record reads as residue and the mailbox is handed to somebody else while we go on filing mail
 * into it. Two organizers either way. The refusal names which bound fired. `null` skew — an
 * install that has never written a claim here — refuses nothing.
 */
export function clockSkewRefusal(input: {
  skewMs: number | null; staleAfterMs: number;
}): { skewMs: number; bound: "ahead" | "behind"; boundMs: number } | null {
  const { skewMs, staleAfterMs } = input;
  if (skewMs === null) return null;
  const boundMs = clockSkewBoundMs(staleAfterMs);
  if (skewMs > boundMs) return { skewMs, bound: "ahead", boundMs };
  if (-skewMs > boundMs) return { skewMs, bound: "behind", boundMs };
  return null;
}

/**
 * THE REFERENCE CLOCK, SUBSTITUTED ONCE — every decision about AGE and RECENCY reads the mail
 * server's stamp, never the writer's.
 *
 * `X-Ohmail-Heartbeat` is a claim about time by the machine whose clock is in question: a laptop
 * booting at 2099 outranked every honest peer and one 61 seconds slow read as residue, and no
 * reader-side rule told either from the truth. INTERNALDATE is the SERVER's. ONE substitution, at
 * the two doors ({@link decideLease}, {@link peekLease}), over ADJUSTED COPIES; a record with NO
 * server stamp is left as it is, because absence means this READ could not ask.
 */
export function withServerClock(claims: readonly ClaimRecord[]): readonly ClaimRecord[] {
  let changed = false;
  const out = claims.map((c) => {
    if (isMalformed(c)) return c;
    /* READ STRUCTURALLY, not as the type promises. `serverStamp` is REQUIRED on the claim so that
       the one producer — the parser — cannot forget it; but this package's tests are not
       typechecked and build claims as object literals, so an absent field arrives here as
       `undefined` and the type says otherwise. Absent and `null` are the same answer anyway: this
       read could not ask the server. */
    const stamp = c.serverStamp;
    if (!(stamp instanceof Date) || Number.isNaN(stamp.getTime())) return c;
    if (stamp.getTime() === c.heartbeat.getTime()) return c;
    changed = true;
    return { ...c, heartbeat: stamp };
  });
  /* The same array back when nothing moved, so the ordinary path allocates nothing and an identity
     comparison a caller makes across the two is not quietly broken by a no-op substitution. */
  return changed ? out : claims;
}

export interface DecideLeaseInput {
  self: LeaseSelf;
  claims: readonly ClaimRecord[];
  now: Date;
  staleAfterMs?: number;
  /**
   * The press this install is acting on, or `null` when nobody has asked for it.
   *
   * Carrying the INSTANT rather than a flag is what lets rule 6 ask the only question that
   * matters between two pressed installs: whose press is newer. See {@link TakeoverAuthorization}.
   */
  takeover?: TakeoverAuthorization | null;
}

/**
 * A heartbeat in the FUTURE counts as fresh.
 *
 * Two machines, two wall clocks. A peer whose clock runs ahead is still alive, and the fail-safe
 * direction is to believe it — treating a skewed peer as stale is how both sides decide they are
 * the organizer.
 */
function isFresh(heartbeat: Date, now: Date, staleAfterMs: number): boolean {
  return now.getTime() - heartbeat.getTime() < staleAfterMs;
}

/**
 * Coalesce to one claim per install id, newest heartbeat wins.
 *
 * §3.3: renewing is append-then-expunge, because IMAP has no in-place update. A crash between
 * the two steps therefore leaves TWO of our own claims in the folder, and that is a state to
 * handle rather than to hope against. Readers coalesce; the writer cleans up the extras on its
 * next renew.
 */
function coalesce(claims: readonly ClaimRecord[], now: Date): { valid: OrganizerClaim[]; malformed: MalformedClaim[] } {
  const malformed: MalformedClaim[] = [];
  const newest = new Map<string, OrganizerClaim>();
  for (const c of claims) {
    if (isMalformed(c)) {
      malformed.push(c);
      continue;
    }
    const prior = newest.get(c.installId);
    // ── ORDER-INDEPENDENT, AND THE TIE-BREAK IS NOT COSMETIC ────────────────────────────────
    //
    // `>` alone left equal heartbeats resolved by INPUT ORDER, and IMAP does not promise one. Two
    // restored clones sharing an install id and renewing in the same millisecond therefore each
    // selected the record whose nonce happened to arrive first — which each then recognised as its
    // own, so both organized. Measured against the decision function with the two orderings.
    //
    // The nonce is a per-write random, so comparing it gives every reader the same answer from the
    // same set regardless of the order the server hands it over.
    if (!prior || compareRecency(c, prior, now) < 0) newest.set(c.installId, c);
  }
  return { valid: [...newest.values()], malformed };
}

/**
 * Newest first, and the ONLY comparison in this module between two records of ONE INSTALL: which
 * of these did this machine write last.
 *
 * THE WRITER'S CLOCK DECIDES WHILE IT IS BELIEVABLE, arrival decides otherwise. Between INSTALLS
 * the server's stamp is the only honest one; between one install's own records INTERNALDATE
 * answers a different question — a residue re-appended after the claim that superseded it arrives
 * LATER, and reaches the clone defence as a stranger wearing our id. One clock cannot be wrong
 * about the order of its own writes unless it JUMPED ({@link isBelievableHeartbeat}).
 */
function compareRecency(a: OrganizerClaim, b: OrganizerClaim, now: Date): number {
  const wa = writerStampOf(a);
  const wb = writerStampOf(b);
  const believable = isBelievableHeartbeat(new Date(wa), now)
    && isBelievableHeartbeat(new Date(wb), now);
  if (believable && wb !== wa) return wb - wa;
  const d = b.heartbeat.getTime() - a.heartbeat.getTime();
  if (d !== 0) return d;
  if (wb !== wa) return wb - wa;
  return a.nonce < b.nonce ? -1 : a.nonce > b.nonce ? 1 : 0;
}

/**
 * The instant the WRITER put on this record, whether or not the decision layer has substituted the
 * server's over it. `withServerClock` replaces `heartbeat`, so the original survives only on
 * `serverStamp`'s twin — which is the point: this is the one term that must read the writer's clock
 * on purpose, and it says so rather than reaching for a field that may already have been replaced.
 */
function writerStampOf(c: OrganizerClaim): number {
  return c.writerStamp instanceof Date ? c.writerStamp.getTime() : c.heartbeat.getTime();
}

/**
 * How far into the future a peer's clock is believed. A heartbeat ahead of our own clock is
 * normal — two machines, two clocks — but the tolerance has to end, and it did not: a claim dated
 * 2099 by a dead clock battery stayed "fresh" for seventy-three years and no authorization could
 * take the mailbox back (measured against the decision function: a `cloud` claim at `2099-01-01`
 * produced `stand_down` for an authorized local, indefinitely). One staleness window; beyond it
 * the heartbeat is CLAMPED rather than rejected — the claim still counts, it simply stops being
 * able to look newer than now.
 */
export const MAX_FUTURE_SKEW_MS = DEFAULT_STALE_AFTER_MS;

/**
 * Is this heartbeat evidence of anything? A stamp beyond `now + MAX_FUTURE_SKEW_MS` is not. A
 * 2099 claim is still a CLAIM and must still be RANKED — two readers disagreeing about the
 * candidate set could each conclude they won, which is why {@link clampFuture} clamps rather than
 * drops. What it must not do is grant its writer the protections reserved for an organizer that
 * is demonstrably alive: "when was this last renewed" is the question its stamp cannot answer, so
 * implausibility is tracked beside liveness rather than by removing the claim from the election.
 */
function isBelievableHeartbeat(heartbeat: Date, now: Date): boolean {
  return heartbeat.getTime() <= now.getTime() + MAX_FUTURE_SKEW_MS;
}

/**
 * Evidence that something renewed this record recently — believable, AND inside the window. The
 * conjunction has a name because its halves drifted apart: the election excluded implausible
 * stamps while the gate's unrankable scan and the preview's per-holder `fresh` read the bare
 * reader-clock test, under which a 2099 stamp is fresh at every real instant. Its caller today is
 * {@link peekLease}'s per-holder `fresh`; {@link readFolderClock} deliberately does not call it —
 * it establishes believability first with a `continue`, and calling this afterwards would test
 * believability twice.
 */
function isRenewalEvidence(heartbeat: Date, now: Date, staleAfterMs: number): boolean {
  // CAPPED AT `now`, exactly as the reference is, and for the same reason: a stamp ahead of us is
  // evidence that the writer is ALIVE, not evidence about how much time has passed. For every
  // positive window the cap changes nothing — an ahead stamp gives `now − now = 0`, which is fresh
  // either way — and at `staleAfterMs = 0`, which the worker's configuration accepts, the two
  // spellings disagree: an uncapped residue at `now + 5 min` satisfied `isFresh` and reported the
  // mailbox HELD for five minutes under a zero window. Two spellings of one question that agree
  // everywhere except one accepted configuration is the shape that gets found by a grid rather
  // than by reading, so they are now one spelling.
  if (!isBelievableHeartbeat(heartbeat, now)) return false;
  const capped = new Date(Math.min(heartbeat.getTime(), now.getTime()));
  return isFresh(capped, now, staleAfterMs);
}

/**
 * WHAT ONE FOLDER'S CLAIMS SAY ABOUT TIME — read once, and read by every liveness question asked
 * of that folder, so no two of them can answer differently.
 */
interface FolderClock {
  /**
   * The newest believable heartbeat present, CAPPED AT `now`; `-Infinity` when no claim carries
   * one. Not the newest clamped one: a 2099 record clamped to `now + 10 min` dragged the
   * reference there, so an honest record stamped ten seconds ago sat past the 600 s window and
   * read STALE — rule 1/2 did not fire and an authorized press took the mailbox from a live
   * organizer. Excluding unbelievable stamps removes the class. And capped at `now`, because a
   * stamp one millisecond inside the tolerance still dragged the reference a window forward with
   * the same outcome. The tolerance keeps an ahead peer from being treated as GONE; it was never
   * meant to let that peer's stamp age everybody else.
   */
  newestHeartbeat: number;
  /**
   * SOMETHING BELIEVABLE HAS BEEN RENEWED WITHIN THE WINDOW, by the reader's clock.
   *
   * The only question in this module a reader's own clock is allowed to decide about the folder as
   * a whole, and it is the content of {@link Election.quiet}. Implausible stamps are excluded: a
   * folder holding nothing but a claim dated 2099 has gone quiet, and reading it as busy is what
   * let one dead machine hold a mailbox for seventy-three years with no way out short of a person
   * deleting the message by hand.
   */
  renewing: boolean;
}

function readFolderClock(
  claims: readonly OrganizerClaim[],
  now: Date,
  staleAfterMs: number,
): FolderClock {
  let newestHeartbeat = -Infinity;
  let renewing = false;
  for (const c of claims) {
    // One test, one `continue`: a claim whose stamp is not believable contributes to NEITHER the
    // reference nor the renewal evidence. Two separate conditions here is how the reference came
    // to admit what the evidence excluded.
    if (!isBelievableHeartbeat(c.heartbeat, now)) continue;
    // The REFERENCE is capped at `now`; the renewal EVIDENCE is not. A peer ahead of us is alive
    // (`isFresh` reads its raw stamp and says so) and its stamp still may not age anybody else.
    newestHeartbeat = Math.max(newestHeartbeat, Math.min(c.heartbeat.getTime(), now.getTime()));
    if (isFresh(c.heartbeat, now, staleAfterMs)) renewing = true;
  }
  return { newestHeartbeat, renewing };
}

/**
 * Is this claim still being renewed? One predicate. The reference is IN THE FOLDER, so two
 * readers cannot disagree — with one degenerate case: the newest heartbeat measures against
 * itself, live at any age. Harmless for the election; fatal in rules 1/2 — a decommissioned
 * install's year-old record refused every press for ever. So the reader's clock decides one thing
 * about the FOLDER — has anything believable renewed within a window (`FolderClock.renewing`) —
 * and if not, every record is residue; only a renewing folder uses the folder-relative
 * comparison. An unbelievable stamp rides on the folder's evidence with no branch for it: {@link
 * readFolderClock} excludes it from the reference, so the arithmetic answers.
 */
function isClaimLive(
  c: OrganizerClaim,
  clock: FolderClock,
  staleAfterMs: number,
): boolean {
  if (!clock.renewing) return false;
  return clock.newestHeartbeat - c.heartbeat.getTime() < staleAfterMs;
}

/**
 * The election. A pure function of the folder's contents — never of the reader's clock. The old
 * table asked "is this peer fresh" as `now(mine) − heartbeat(theirs)`, mixing two clocks, and two
 * readers could answer differently — three split-brains reproduced by execution: a laptop that
 * slept (both organize), five minutes of skew (a takeover offered over a live claim), two clouds
 * (`freshCloud` consulted only for locals). Freshness is folder-relative now: the newest
 * heartbeat present is the reference, a claim a window older has lapsed, every reader computes
 * the same winner. The reader's clock keeps two uses — a ceiling on a future heartbeat, and
 * whether the folder has gone QUIET — and neither can decide who organizes.
 */
interface Election {
  /** Claims present in the folder, coalesced, with a clamped heartbeat. */
  candidates: readonly OrganizerClaim[];
  /** Not lapsed relative to the newest heartbeat in the folder. */
  live: readonly OrganizerClaim[];
  /**
   * THE ONE ORDER: `live`, strongest first by {@link compareStrength}. The winner is its head and
   * the peek names holders in it, so the gate and the screen cannot name two organizers for one
   * folder (LEASE-SCREEN-AND-ELECTION-COMPARATORS-DIVERGE).
   */
  ranked: readonly OrganizerClaim[];
  /** The strongest live candidate — `ranked[0]` — or `null` when the folder holds no readable claim. */
  winner: OrganizerClaim | null;
  /**
   * WHAT THE FOLDER SAYS ABOUT TIME, read once — see {@link FolderClock}.
   *
   * On the election so that {@link decideLease}'s rule 1/2 scan and {@link Election.quiet} cannot
   * be two computations of one question. It used to be a `plausible` SET plus a re-derivation of
   * "newest plausible, then compare" beside a third folder-relative expression in the rules, and
   * the three disagreed about a folder holding one claim.
   */
  clock: FolderClock;
  /**
   * Claims whose PRESS is not implausibly far in the future — {@link plausible}'s idea, one field
   * over, because 0.14.1 moved the election onto a field the heartbeat's ceiling does not cover.
   * Measured: a claim stamped 2099 clamps to `now + MAX_FUTURE_SKEW_MS`, strictly greater than
   * any press a human makes at `now`, so the honest press could never win rule 6 — the
   * seventy-three-year lockout on the deciding field. The clamp is kept (it bounds the ranking
   * every reader must compute identically); an implausible press additionally loses the one
   * protection it must not have: the ability to refuse a human's takeover. Reader-clock use two
   * of two: single-sided, displacing at worst a live install — one organizer, the safe direction.
   */
  plausiblePress: ReadonlySet<OrganizerClaim>;
  /** Nothing PLAUSIBLE in the folder has been renewed within one window of the READER's now. */
  quiet: boolean;
  /** Claims that announce themselves and cannot be read. Evidence, never nothing. */
  malformed: readonly MalformedClaim[];
}

/**
 * `min(t, now + MAX_FUTURE_SKEW_MS)` for BOTH instants a broken clock can inflate — the heartbeat
 * and the press. The press needs the ceiling for a sharper reason: `authorizedAt` is the first
 * term of the order, so an install whose clock reads 2099 would write a press that outranks every
 * honest one for seventy-three years. Clamped rather than rejected: a press with a silly clock is
 * still a press, it simply stops being able to look newer than now.
 */
function clampFuture(c: OrganizerClaim, now: Date): OrganizerClaim {
  const ceiling = now.getTime() + MAX_FUTURE_SKEW_MS;
  const hbOver = c.heartbeat.getTime() > ceiling;
  const azOver = c.authorizedAt !== null && c.authorizedAt.getTime() > ceiling;
  if (!hbOver && !azOver) return c;
  return {
    ...c,
    ...(hbOver ? { heartbeat: new Date(ceiling) } : {}),
    ...(azOver ? { authorizedAt: new Date(ceiling) } : {}),
  };
}

/**
 * Strongest first. A press ranks; kind does not — the old first term let a live Cloud refuse an
 * authorized local for ever, stranding the person who lost access to the Cloud side. Liveness is
 * not authority; presence still protects an incumbent against anything that merely arrives. The
 * order: (1) the press, newest first, clamped by {@link clampFuture}; `null` ranks lowest — the
 * mechanism of a takeover; (2) incumbency, oldest `claimedAt`; (3) `installId`, then `nonce` — a
 * TOTAL order, closing the case where two restored clones each elected themselves. `kind`
 * survives for display; it decides nothing. An older build ranks by incumbency alone — bounded,
 * enumerated as decide-table tests.
 */
function compareStrength(a: OrganizerClaim, b: OrganizerClaim): number {
  // Newest press first, and a claim with no press is `-Infinity` — below every real instant, and
  // below another unpressed claim only by the terms after this one.
  const press = (c: OrganizerClaim): number => c.authorizedAt?.getTime() ?? -Infinity;
  const byPress = press(b) - press(a);
  // `-Infinity - -Infinity` is NaN, and `NaN !== 0` is TRUE — so an unguarded subtraction here
  // would return NaN for the ordinary two-unpressed-claims case, which `Array.sort` treats as
  // "leave them where they are" and which is exactly the order-dependent tie the total order below
  // exists to make impossible. Both-null is the steady state of every mailbox nobody has pressed
  // on, so this is the common path rather than an edge.
  if (byPress !== 0 && !Number.isNaN(byPress)) return byPress;
  const byClaimed = a.claimedAt.getTime() - b.claimedAt.getTime();
  if (byClaimed !== 0) return byClaimed;
  if (a.installId !== b.installId) return a.installId < b.installId ? -1 : 1;
  return a.nonce < b.nonce ? -1 : a.nonce > b.nonce ? 1 : 0;
}

function runElection(claims: readonly ClaimRecord[], now: Date, staleAfterMs: number): Election {
  const { valid, malformed } = coalesce(claims, now);
  const ceiling = now.getTime() + MAX_FUTURE_SKEW_MS;
  const plausiblePress = new Set<OrganizerClaim>();
  const candidates = valid.map((raw) => {
    const c = clampFuture(raw, now);
    // A claim with NO press is plausible about its press by construction: there is nothing to
    // disbelieve. Only a stamp beyond the ceiling is excluded — see `Election.plausiblePress`.
    if (raw.authorizedAt === null || raw.authorizedAt.getTime() <= ceiling) plausiblePress.add(c);
    return c;
  });

  /**
   * The clock is read over the RAW claims, not the coalesced candidates. Raw because that is the
   * set rules 1/2 and an authorized displacement judge — and coalesce keeps the NEWEST record per
   * install, so a 2099 duplicate REPRESENTED an install renewing honestly beside it: the fresh
   * record dropped, the folder read QUIET, a takeover offered over an active organizer. Widening
   * `renewing` can only refuse a takeover the narrower form would have offered — the safe
   * direction. And not over `candidates` for a sharper reason: `clampFuture` has already pulled
   * every stamp under the ceiling there, so the no-evidence rule would be silently disabled. Two
   * separate mutations pin the two ways to lose this.
   */
  const clock = readFolderClock(
    claims.filter((c): c is OrganizerClaim => !isMalformed(c)),
    now,
    staleAfterMs,
  );

  // The reference is IN THE FOLDER, not on this machine — clamped, so a broken clock cannot lapse
  // every honest claim by more than one window. And the election's own liveness stays
  // folder-relative for every candidate, including the newest — the opposite of `isClaimLive`,
  // deliberately: `live` is the set the WINNER is chosen from, and a folder holding only our own
  // claim (a laptop that slept a week) must still elect us on rule 3 without asking anybody.
  // Judging this set by the reader's clock would empty it and turn own-role resumption into a
  // takeover needing a human press. Whether the folder has gone QUIET is a different question,
  // asked below on the reader's clock, deciding only arm 7 against arm 8.
  const newest = candidates.reduce<number>((m, c) => Math.max(m, c.heartbeat.getTime()), -Infinity);
  const live = candidates.filter((c) => newest - c.heartbeat.getTime() < staleAfterMs);
  const ranked = [...live].sort(compareStrength);
  const winner = ranked[0] ?? null;

  // The one place the reader's clock decides anything about the folder as a whole, and it decides
  // only whether to ASK a human. It is now literally `!clock.renewing` rather than a second
  // derivation beside it, which is what makes `quiet` and `decideLease`'s rule 1/2 agree BY
  // CONSTRUCTION: the gate refuses a press over a lone unrankable record exactly while the folder
  // is being renewed. They used to be two expressions with two authors, and they disagreed for
  // every folder holding one claim.
  const quiet = !clock.renewing;

  return { candidates, live, ranked, winner, clock, plausiblePress, quiet, malformed };
}

/**
 * Who may organize this mailbox. Pure — no clock, no IO. (1) A live claim in a protocol we do not
 * understand — stand down; no authorization overrides what we cannot rank. (2) A live claim of an
 * unrecognised KIND — stand down. (3) We hold the strongest live claim — organize; continuation
 * covers resumption. (4) No readable claim — organize. (5) DELETED — it refused an authorized
 * local over a live Cloud; the numbering keeps the names tests use. (6) A human pressed for THIS
 * install more recently than any live rival, AND pressed a verb that displaces — organize and
 * DISPLACE; STRICT, and no stamp-older-than-claimedAt check, which would break the two-press
 * race. (7) Lost, folder renewing — stand down. (8) Lost, folder quiet — offerable, never taken.
 */
export function decideLease(input: DecideLeaseInput): LeaseVerdict {
  const { self, now } = input;
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const takeover = input.takeover ?? null;
  const ourProtocol = self.protocol ?? CLAIM_PROTOCOL;

  /* THE SERVER'S CLOCK ENTERS HERE AND NOWHERE ELSE BELOW — see {@link withServerClock}. Every
     read of the claim list in this function is of `claims` rather than `input.claims`, including
     the RAW scans: a raw scan against the un-substituted list would judge liveness on the writer's
     own stamp, which is the whole of the defect, and the two lists would disagree about one
     record. */
  const claims = withServerClock(input.claims);

  const election = runElection(claims, now, staleAfterMs);

  /**
   * Is this claim OURS? The clone defence, unchanged in substance.
   *
   * A claim bearing our install id whose nonce is not the one we wrote, and which is live, is
   * somebody else running a restored copy of us. `lastNonce` is memory-only, so a fresh process
   * trusts its own id exactly once — which is what keeps own-role resumption working after a
   * crash. The residual case of two clones starting simultaneously (both with a null nonce) is now
   * caught one cycle later by `compareStrength`'s total order, where it used to be a coin toss.
   */
  const isOurs = (c: OrganizerClaim): boolean => {
    if (c.installId !== self.installId) return false;
    const clonedUs = !bearsOurNonce(self, c.nonce) && election.live.includes(c);
    return !clonedUs;
  };

  // Liveness for a RAW record — {@link isClaimLive}, the one predicate, against the newest clamped
  // heartbeat in the folder. Needed on the raw list because coalesce keeps ONE record per install,
  // and both rule 1/2 and an authorized displacement have to see the records coalesce dropped.
  //
  // `election.clock` is read over the RAW claims, so this is the same clock `quiet` is computed
  // from and the same one `peekLease` reads — one question, one computation. Deliberately NOT a
  // reference re-derived from `election.candidates`: `clampFuture` has already applied the ceiling
  // to those, so the ceiling would be applied twice on this path and neither copy could be removed
  // on its own without the other covering for it — a ceiling nobody can watch fail. `clampFuture`
  // keeps its own job, which is bounding what `compareStrength` ranks.
  const rawIsLive = (c: OrganizerClaim): boolean =>
    isClaimLive(c, election.clock, staleAfterMs);
  /** Unambiguously this process's current claim, by VALUE — the raw list's `isOurs`. */
  const rawOurs = (c: OrganizerClaim): boolean =>
    c.installId === self.installId && bearsOurNonce(self, c.nonce);

  // 1 / 2 — a live peer we cannot rank. Checked first, no authorization overrides them, and
  // checked over the RAW list: coalesce keeps the newest record per install, so an unrankable
  // OLDER record hidden behind a rankable newer sibling would otherwise never trip this arm —
  // and every downstream consumer of this verdict (the takeover's displacement above all)
  // would treat a live claim in a format we cannot read as beatable residue.
  const unrankable = claims.find((c): c is OrganizerClaim =>
    !isMalformed(c) && !rawOurs(c) && (c.protocol > ourProtocol || c.kind === "unknown") && rawIsLive(c));
  if (unrankable) {
    return { verdict: "stand_down", reason: "organized_elsewhere:unknown", by: namedHolder(unrankable, ourProtocol) };
  }

  const { winner } = election;

  // 3 — we hold the strongest live claim. Continuation.
  if (winner && isOurs(winner)) return { verdict: "organize", renew: true, displace: [], authorized: false };

  // 4 — an EMPTY folder. Nobody has ever organized this mailbox, so there is nobody to take over
  // from. Emptiness is the whole condition, and "no winner" is deliberately not the test: a folder
  // that holds only unreadable claims, or only a claim dated 2099, has evidence in it and belongs
  // to the arms below.
  if (election.candidates.length === 0 && election.malformed.length === 0) {
    /**
     * And it stamps the press when there is one, which is not obvious — there is nothing to
     * displace on an empty folder, so `authorized: false` tempts, and it inverts a decision:
     * somebody presses on a sleeping laptop (stamp unspent), changes their mind and presses on
     * Cloud, Cloud takes arm 4 — an unstamped claim ranks at minus infinity — then the laptop
     * wakes, offers its EARLIER press against Cloud's unpressed claim, and wins rule 6. The older
     * decision reverses the newer one. So the flag says what the field says: this tenure rests on
     * that press; false on rule 3 (continuation carries the prior stamp) and false here when
     * nobody pressed.
     */
    return { verdict: "organize", renew: true, displace: [], authorized: takeover !== null };
  }

  /* -- 5 IS GONE (0.14.1). The paragraph that stood here is preserved in the header's rule 5,
   * because the argument it made was not careless — it was a considered asymmetry, and it is the
   * asymmetry that is now ruled wrong. Nothing takes its place: with `kind` out of
   * `compareStrength`, a live cloud claim and a live local claim are ranked by the same two
   * questions as any other pair, and the press is the first of them.
   *
   * What is NOT lost with it: `election.quiet` and the implausibility test rule 5 also consulted
   * are still computed and still used — `quiet` decides arm 8 (offerable vs held), and
   * `isBelievableHeartbeat` (now inside {@link FolderClock}, where it was a `plausible` set) keeps
   * a 2099 claim from being treated as a live organizer. Only the kind comparison is deleted. */

  // Rule 6 — a human asked for this mailbox more recently than anything alive in it: take it and
  // record the handover. Strictly newer than the live maximum, and that comparison IS the replay
  // protection: a press that already won carries the same instant on our own winning claim, so
  // `>` is false against ourselves and a re-offered stamp decides nothing. STRICT, so an equal
  // instant breaks on `installId` in `compareStrength` — under `>=` both installs would displace
  // each other in one cycle and the mailbox would end with no claim at all. Deliberately not
  // "newer than the holder's claimedAt": that breaks the two-press race, where B's later press is
  // older than A's tenure by construction. Over the live AND plausibly-pressed claims — without
  // the second filter a 2099 stamp clamps above any human press and vetoes every takeover for
  // ever; such a claim is still ranked, it only loses the veto.
  const livePress = election.live
    .filter((c) => election.plausiblePress.has(c))
    .reduce<number>((m, c) => Math.max(m, c.authorizedAt?.getTime() ?? -Infinity), -Infinity);
  const ourPress = takeover === null
    ? -Infinity
    // Clamped exactly as a claim's own stamp is, and for the same reason: a machine whose clock
    // reads 2099 must not be able to press its way past every honest organizer for ever. The row
    // is not a more trustworthy clock than the folder — it is the SAME machine's clock.
    : Math.min(takeover.authorizedAt.getTime(), now.getTime() + MAX_FUTURE_SKEW_MS);
  /**
   * AND THE VERB DECIDES WHETHER A NEWER PRESS MAY DISPLACE AT ALL. A `join` asks for a mailbox
   * nobody is organizing; against a live foreign claim it yields however recent it is, and rules
   * 7/8 name the holder. Liveness is the RAW predicate rules 1/2 use, never `election.live`:
   * that set has no `renewing` term, so on a folder holding only stale residue every candidate
   * is "live" against the newest of them and a join would be refused the mailbox it is entitled
   * to. Tested as `=== "takeover"`, so an untyped caller reads as a join — the direction that
   * can only produce FEWER organizers.
   */
  const liveForeign = claims.some((c): boolean =>
    !isMalformed(c) && !rawOurs(c) && rawIsLive(c));
  const mayDisplace = takeover !== null && (takeover.intent === "takeover" || !liveForeign);
  if (mayDisplace && ourPress > livePress) {
    // Every ref the read held for the beaten organizers — the RAW claim list, not the candidates:
    // coalesce keeps one claim per install, the folder legitimately holds duplicates
    // (append-then-expunge crash residue), and a displacement built from the coalesced set misses
    // the residue copy — which then wins the verify on incumbency, and the takeover loses to a
    // message the incumbent was going to clean up. Malformed claims displace too. "Ours" is
    // decided by VALUE — install id plus nonce — never `isOurs`, whose clone defence keys on
    // object identity; kept out is exactly the unambiguously-current claim (and, with no armed
    // nonce, anything bearing our id). A same-id claim with a different nonce while ours is armed
    // is a restored clone's and displaces like any other. Rules 1/2 hold over the raw list too:
    // an authorized expunge of a record we cannot read must be impossible by construction.
    const displaced = claims
      .filter((c) => (isMalformed(c)
        ? true
        : !(c.installId === self.installId && bearsOurNonce(self, c.nonce))
          && !((c.protocol > ourProtocol || c.kind === "unknown") && rawIsLive(c))))
      .map((c) => c.ref)
      .filter((r): r is unknown => r !== undefined);
    return { verdict: "organize", renew: true, displace: displaced, authorized: true };
  }

  // 7 / 8 — we lost. Whether it is offerable is the only thing left to say.
  //
  // A STALE PRESS ARRIVES HERE, and that is where it is meant to arrive. It is not an error and it
  // gets no arm of its own: the caller's stand-down path already voids the stamp it just offered,
  // so the request is consumed by the pass that considered and refused it rather than left on the
  // row to be re-offered every cycle against an organizer it can never beat.
  if (!election.quiet && winner !== null) {
    const by = namedHolder(winner, ourProtocol);
    return { verdict: "stand_down", reason: reasonFor(by), by };
  }
  return { verdict: "available", by: winner === null ? null : namedHolder(winner, ourProtocol) };
}

/**
 * THE KIND A HOLDER IS NAMED BY: its own header when this build can rank the claim, `unknown`
 * when it cannot. A newer protocol's kind header is not evidence this build can read, so no reader
 * names Cloud from it (STAND-DOWN-AND-PEEK-NAME-AN-UNRANKABLE-HOLDER-TWO-WAYS). The gate's `by`
 * and the peek's holders both take it, so one folder names one holder one way.
 */
export function holderKind(
  c: Pick<OrganizerClaim, "kind" | "protocol">, ourProtocol: number = CLAIM_PROTOCOL,
): OrganizerKind | "unknown" {
  return c.protocol > ourProtocol || c.kind === "unknown" ? "unknown" : c.kind;
}

/** The claim as a verdict names it: {@link holderKind} applied, every other field its own. */
function namedHolder(c: OrganizerClaim, ourProtocol: number): OrganizerClaim {
  const kind = holderKind(c, ourProtocol);
  return kind === c.kind ? c : { ...c, kind };
}

/**
 * The winning claim's kind, as the closed reason set spells it.
 *
 * EVERY MEMBER ON ITS OWN ARM. `mobile` falling through to `:unknown` would tell a person
 * "another ohmail organizer" about a mailbox a phone holds — true but useless, and the answer
 * they need is the one a phone makes different: it organizes only while it is open.
 */
function reasonFor(c: OrganizerClaim): StandDownReason {
  return c.kind === "cloud" ? "organized_elsewhere:cloud"
    : c.kind === "local" ? "organized_elsewhere:local"
      : c.kind === "mobile" ? "organized_elsewhere:mobile"
        : "organized_elsewhere:unknown";
}


/** The most foreign residue one renew's cleanup removes, oldest uid first; the rest waits a pass. */
export const RESIDUE_REMOVE_MAX_PER_PASS = 1_000;

/**
 * OTHER INSTALLS' CLAIMS NO ELECTION CAN RANK — what a confirmed organizer may remove outside a
 * takeover (ARCH-LEASE-BLIND-SEARCH §3.1(f)). A record is residue iff (1) it is readable, of a kind
 * and protocol this build ranks; (2) another install wrote it; (3) it is not its install's coalesce
 * winner, and that winner stands without the install's residue; (4) it is two windows behind the
 * folder's newest heartbeat AND the reader's clock. `decideLease` over the claims with and without
 * it gives the same verdict, reason, winner and `authorized` (property-tested). Pure.
 */
export function claimResidue(
  claims: readonly ClaimRecord[],
  self: Pick<LeaseSelf, "installId" | "protocol">,
  now: Date,
  staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
): OrganizerClaim[] {
  const stamped = withServerClock(claims);
  const election = runElection(stamped, now, staleAfterMs);
  const winners = new Map(election.candidates.map((c) => [c.installId, c.ref] as const));
  const ourProtocol = self.protocol ?? CLAIM_PROTOCOL;
  const twoWindows = 2 * staleAfterMs;
  const byInstall = new Map<string, number[]>();
  stamped.forEach((c, i) => {
    if (isMalformed(c) || c.kind === "unknown" || c.protocol > ourProtocol) return;
    if (c.installId === self.installId) return;
    if (c.ref === undefined || winners.get(c.installId) === c.ref) return;
    const hb = c.heartbeat.getTime();
    if (election.clock.newestHeartbeat - hb < twoWindows || now.getTime() - hb < twoWindows) return;
    byInstall.set(c.installId, [...(byInstall.get(c.installId) ?? []), i]);
  });
  const out: OrganizerClaim[] = [];
  for (const [installId, at] of byInstall) {
    /* The install's winner must survive its own residue's removal: `compareRecency` is not
       transitive across a believable and an unbelievable writer stamp, so removing a loser can
       change which record coalesce keeps. Such an install keeps all its records. */
    const gone = new Set(at);
    const without = coalesce(stamped.filter((c, i) => !gone.has(i) && !isMalformed(c) && c.installId === installId), now);
    if (without.valid[0]?.ref !== winners.get(installId)) continue;
    for (const i of at) out.push(claims[i] as OrganizerClaim);
  }
  return out;
}

// ── LAYER 2b: LOOKING WITHOUT DECIDING ──────────────────────────────────────────────────────

/**
 * Who holds this mailbox, REPORTED rather than ruled on. Not `decideLease` with the writes off:
 * the gate answers "may I organize" and needs an identity ({@link LeaseSelf}), and a reporting
 * surface has none — fabricating one turns a read into a write. Two reachable failures from one
 * fabricated id: against an empty `ohmail/_meta` the gate APPENDS, so a preview would make the
 * previewer the organizer; against a live claim with the same id the renew EXPUNGES older claims,
 * so a preview sharing the worker's id can delete the worker's fresh claim. So this layer takes
 * no `self`, returns no verdict, and cannot write; the confirm step stamps an authorization and
 * the GATE decides later, in the process that will actually organize.
 */
export interface LeaseHolder {
  kind: OrganizerKind | "unknown";
  /**
   * `X-Ohmail-Install-Id` — WHICH install wrote this claim, as opposed to which KIND of one.
   *
   * On the preview because the row that mirrors it has to answer "is this claim ours", and `kind`
   * cannot: it is one of a few words, and the Cloud id is scoped by environment precisely so that
   * two Cloud deployments over one mailbox are different organizers. The claim removal already
   * matches on this id, so exposing it here is what lets the row and the removal use one unit.
   */
  installId: string;
  /** `X-Ohmail-Display-Name` — the machine, for a human. May be empty. */
  displayName: string;
  /** Last renew, by the WRITER's clock. */
  heartbeat: Date;
  /** When this organizer became the organizer, as distinct from last seen. */
  claimedAt: Date;
  /** Still being renewed, judged against the same window the gate judges against. */
  fresh: boolean;
  /**
   * WHAT THIS HOLDER OFFERS A READER, off its claim (0.14.1). Empty means none, which is the true
   * answer for every install older than this field rather than a gap in the read.
   *
   * It is on the PREVIEW and not only in the gate because the surface that needs it is a reader's,
   * and a reader never runs the gate. Without it a reader would have to choose between offering a
   * decision to an organizer that will never look at it and refusing every organizer on principle.
   */
  capabilities: readonly string[];
}

/**
 * `none` — nobody has ever organized this mailbox.
 * `held` — at least one claim is still being renewed.
 * `stopped` — somebody WAS organizing and is not now.
 *
 * The three map exactly onto the gate's three verdicts for a FOREIGN claim (`organize` on an
 * empty folder, `stand_down`, `available`), which is what makes a preview and the gate that runs
 * afterwards agree about the world rather than merely tend to.
 */
export type LeaseOccupancy = "none" | "held" | "stopped";

export interface LeasePeek {
  state: LeaseOccupancy;
  /** In the gate's order (see `peekLease`). One entry per install id, the same coalescing the gate does. */
  holders: LeaseHolder[];
  /**
   * Claims that say they are claims and are not readable as one.
   *
   * Counted rather than dropped, for {@link MalformedClaim}'s reason: evidence that somebody
   * claimed is not nothing. A folder holding only unreadable claims is `stopped`, never `none` —
   * reporting "nobody has ever organized this" about a mailbox with a claim in it is the
   * dual-organizer bug wearing a UI.
   */
  unreadable: number;
}

export interface PeekLeaseInput {
  claims: readonly ClaimRecord[];
  now: Date;
  staleAfterMs?: number;
}

/** Pure. No IO, no identity, no side effects — the whole table is unit-testable. */
export function peekLease(input: PeekLeaseInput): LeasePeek {
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  /* The SAME substitution the gate makes, at this surface's own door — see {@link
     withServerClock}. The preview and the gate reading one folder through two clocks is
     `LEASE-PREVIEW-BELIEVABILITY-BOUNDARY`: the preview offered a takeover the gate then refused,
     and the caller's stand-down path spent the person's one-shot press on it. */
  const claims = withServerClock(input.claims);
  const { valid, malformed } = coalesce(claims, input.now);

  /**
   * The preview sees what the gate sees, raw duplicates included. Rule 1/2 scans the RAW list: a
   * fresh record this build cannot rank refuses even an authorized takeover, and coalescing keeps
   * only the newest record per install, so such a record can hide behind a rankable sibling. A
   * preview built from the coalesced list would show an ordinary holder and offer a takeover the
   * gate will refuse for ever — a button that no-ops on exactly the surface that exists to tell
   * the truth. An install with a fresh unrankable record among its duplicates is reported
   * `unknown` and fresh, the gate's own sentence.
   */
  // Liveness for the unrankable scan is {@link isClaimLive} — the SAME FUNCTION the gate's rule
  // 1/2 calls, not a second expression that agrees with it. The preview's per-holder `fresh`
  // keeps its own reader-clock idiom, but this set has to answer as the gate answers or the two
  // describe different worlds: a record the gate reads as live-unknown reported here as an
  // ordinary stopped holder, or — the direction that was shipping — a STALE lone record reported
  // as a live holder while the gate had already stopped refusing over it, so a person was told
  // another computer was organizing their mailbox by a build that would have let them take it.
  // This is the seam the two copies of the folder-relative test hid from each other.
  const rawValid = claims.filter((c): c is OrganizerClaim => !isMalformed(c));
  /* THE GATE'S OWN ELECTION: its clock for the unrankable scan and its order for the holders. */
  const election = runElection(claims, input.now, staleAfterMs);
  const { clock } = election;
  /**
   * An install is renewing if ANY of its raw records says so. Coalesce keeps the newest heartbeat
   * per install, and a 2099 cleanup residue IS the newest — so an install renewing honestly at
   * `now − 5 s` was represented by the residue and reported `fresh: false`. Not only a wrong
   * screen: the worker certifies a mailbox release only when no holder is fresh and nothing is
   * unreadable, so it stamped RELEASED while another install was demonstrably renewing — and the
   * gate, reading the raw list, said `stand_down` about the same folder at the same instant. The
   * clock already reads the raw list; this is the same lesson applied to the per-holder
   * projection.
   */
  const renewingInstalls = new Set(
    rawValid
      .filter((c) => isRenewalEvidence(c.heartbeat, input.now, staleAfterMs))
      .map((c) => c.installId),
  );
  const unrankableInstalls = new Set(
    rawValid
      .filter((c) => (c.protocol > CLAIM_PROTOCOL || c.kind === "unknown")
        && isClaimLive(c, clock, staleAfterMs))
      .map((c) => c.installId),
  );

  const lapsed = election.candidates.filter((c) => !election.ranked.includes(c)).sort(compareStrength);
  const position = new Map([...election.ranked, ...lapsed].map((c, i) => [c.installId, i] as const));
  const holders: LeaseHolder[] = valid
    .map((c) => ({
      kind: unrankableInstalls.has(c.installId) ? ("unknown" as const) : holderKind(c),
      installId: c.installId,
      displayName: c.displayName,
      heartbeat: c.heartbeat,
      claimedAt: c.claimedAt,
      /* Per INSTALL, over its raw records — see `renewingInstalls`. `isRenewalEvidence` rather
         than the bare reader-clock test, because a stamp beyond the skew tolerance is no evidence
         that this machine is alive, and reporting it as fresh named a live organizer for a record
         the gate had already stopped defending. The unrankable arm beside it stays: a record we
         cannot READ is reported as held while the gate refuses over it, which is a different
         sentence about a different thing. */
      fresh: renewingInstalls.has(c.installId) || unrankableInstalls.has(c.installId),
      /* Reported for the holder the coalesce KEPT — the newest claim per install — because that is
         the build currently running there. An older duplicate advertising less is residue of a
         renew this same install is about to expunge, and reporting the weaker set would tell a
         reader its live organizer had gone backwards. */
      capabilities: c.capabilities,
    }))
    /**
     * IN THE GATE'S ORDER, because `holders[0]` is read as "the organizer" by the worker, the
     * sidecar, the API and {@link answerLeasePeek}. A live record this build cannot rank first
     * (the gate's rule 1/2 answer), then the election's `ranked`, then the lapsed by
     * {@link compareStrength}. Recency ordered it before, and on two unpressed live claims it named
     * the newer renewer while the election kept the incumbent
     * (LEASE-SCREEN-AND-ELECTION-COMPARATORS-DIVERGE).
     */
    .sort((a, b) => {
      const ua = unrankableInstalls.has(a.installId) ? 0 : 1;
      const ub = unrankableInstalls.has(b.installId) ? 0 : 1;
      if (ua !== ub) return ua - ub;
      return (position.get(a.installId) ?? position.size) - (position.get(b.installId) ?? position.size);
    });

  const state: LeaseOccupancy =
    holders.some((h) => h.fresh) ? "held"
      : holders.length > 0 || malformed.length > 0 ? "stopped"
        : "none";

  return { state, holders, unreadable: malformed.length };
}

/**
 * The read-only half of {@link LeaseIo}, and the narrowness is the enforcement.
 *
 * It is a separate interface rather than `Pick<LeaseIo, "listClaims">` so that a caller cannot
 * pass a full {@link LeaseIo} where this is expected and quietly regain APPEND: structurally
 * `LeaseIo` DOES satisfy this type, so the guard cannot live in the type system alone — it lives
 * in {@link makeLeasePeekIo}, whose returned object has no other method to reach for, and in the
 * adapter accessor that hands one out.
 */
export interface LeasePeekIo {
  listClaims(): Promise<RawClaimMessage[]>;
}

/**
 * A {@link LeasePeekIo} bound to a live connection. LIST, SELECT, FETCH — nothing else. It does
 * not create `ohmail/_meta`: a reader has no business creating a folder to answer a question
 * about it, and doing so changes the answer for the next reader from "no folder" to "empty
 * folder". An absent folder is zero claims — the truth. It resolves the folder through {@link
 * makeMetaFolderRef}, the same resolution the writer uses — the fix for the defect where a
 * path-equality read reported "nobody organizes this mailbox" while the claim sat one namespace
 * prefix away, renewing.
 */
export function makeLeasePeekIo(
  client: LeaseImapClient,
  toServerPath: (canonical: string) => string,
  /**
   * The clock the read's budget reads. Injectable for the same reason {@link
   * readMetaFolderWindow}'s is: a case drives the SHIPPING ceiling rather than a lowered one,
   * because a test that has to shorten the bound is not testing the bound.
   */
  limits?: { now?: () => number },
): LeasePeekIo {
  const now = limits?.now ?? Date.now;
  const meta = makeMetaFolderRef(client, toServerPath);
  return {
    async listClaims(): Promise<RawClaimMessage[]> {
      /*
       * THE CLOCK STARTS HERE, not at the FETCH. This look is four server commands and the FETCH
       * was the only one under a budget, so a server that answered the LIST, the SELECT or the
       * STATUS a byte at a time held this peek — and the door waiting on it — for as long as it
       * liked, while the ceiling that was supposed to bound the read reported nothing. Every
       * breach leaves by the same door as any other fault here: `LeaseUnavailableError`, which
       * renders as "could not look" and never as "nobody holds it".
       */
      const budget = metaReadBudget(now);
      const at = await meta.locate(budget);
      // An ABSENT folder is zero claims — the truth, and the semantics this object's docblock
      // promises. A folder that could not be RESOLVED is a throw, which `readLeasePeek` turns
      // into `LeaseUnavailableError`: "I could not look" and "nobody holds it" must stay
      // unreachable from one another.
      if (at.row === null) return [];

      const lock = await lockWithin(client, at.path, budget);
      try {
        /* The gate's own read, so the person is shown the holder the gate elects. Past the window
           it enumerates the folder; a read that cannot prove itself complete refuses, which
           {@link readLeasePeek} renders as unreadable and never as nobody. */
        return (await readLeaseRecords(client, at.path, budget, null)).records;
      } finally {
        lock.release();
      }
    },
  };
}

export interface ReadLeasePeekInput {
  io: LeasePeekIo;
  now: Date;
  staleAfterMs?: number;
  /**
   * Optional, because it reports rather than guards: a peek with no logger answers exactly as it
   * did before. What it carries is the one fault here that does not clear on its own — see the
   * call below.
   */
  log?: (event: string, detail: Record<string, unknown>) => void;
}

/**
 * READ `ohmail/_meta` AND SAY WHO IS IN IT.
 *
 * An IO failure is {@link LeaseUnavailableError}, exactly as it is for the gate, and for §3.4's
 * reason restated as copy: "could not look" must never render as "nobody holds it". A surface
 * that showed an empty organizer panel because a FETCH timed out would invite a takeover of a
 * mailbox somebody is actively organizing.
 */
/** `meta_folder_full` for a read the folder's SIZE refused; `null` for every other fault. */
function metaFullOp(err: unknown): "meta_folder_full" | null {
  if (err instanceof MetaEnumRefusedError && (err.code === "over_ceiling" || err.code === "bytes")) return "meta_folder_full";
  return null;
}

/** A size refusal's message is the person's sentence; any other enumeration refusal keeps its own. */
function enumRefusalMessage(err: MetaEnumRefusedError): string {
  return metaFullOp(err) === null ? err.message
    : metaFolderFullSentence(err.total, err.ceiling, err.code === "bytes" ? "bytes" : "records");
}

export async function readLeasePeek(input: ReadLeasePeekInput): Promise<LeasePeek> {
  let messages: RawClaimMessage[];
  try {
    messages = await input.io.listClaims();
  } catch (err) {
    /* A full folder gets its own line here as at the gate: same event, same fields, same fact. */
    if (err instanceof MetaEnumRefusedError) {
      input.log?.("lease_enum_refused", { code: err.code, records: err.rows, total: err.total, ceiling: err.ceiling });
    }
    /* ── THE FAULT KEEPS ITS OWN NAME ────────────────────────────────────────────────────────
     *
     * Every throw here used to leave as `list_claims`, so one `LeaseOp` stood for two facts that
     * an operator has to tell apart: a read that failed and will succeed on the next cycle, and a
     * `_meta` too full to read, which never heals by waiting. The election's catch already keeps
     * a refusal that says why — this is the same rule at the other door, and it is what makes the
     * two doors report one fact under one name. */
    if (err instanceof LeaseUnavailableError) throw err;
    throw new LeaseUnavailableError(
      err instanceof MetaEnumRefusedError
        ? enumRefusalMessage(err)
        : `the organizer lease in ${META_FOLDER} could not be read`,
      { op: metaFullOp(err) ?? "list_claims", cause: err },
    );
  }
  const claims = messages
    .map((m) => parseClaim(m.raw, m.ref, m.internalDate ?? null))
    .filter((c): c is ClaimRecord => c !== null);
  return peekLease({
    claims,
    now: input.now,
    ...(input.staleAfterMs !== undefined ? { staleAfterMs: input.staleAfterMs } : {}),
  });
}

// ── THE PEEK'S THREE ANSWERS ────────────────────────────────────────────────────────────────

/**
 * WHAT A LOOK AT `ohmail/_meta` ANSWERED — three answers, and the third is why this type exists.
 *
 * `free` and `held` are facts about the folder. `unreadable` is a fact about the LOOK, and the one
 * a caller keeps collapsing into `free` because both leave it with no holder to name. Measured on
 * the phone's consent door: an install whose adapter could not read the folder left the holder
 * columns exactly as an unorganized mailbox leaves them, so the door admitted the press, wrote the
 * consent and answered "claimed". So the answers are a VALUE rather than a return-or-throw, and
 * the compiler names the third arm. Only `free` means "nothing holds this mailbox".
 */
export type LeasePeekAnswer =
  /** The folder was read and nothing is renewing a claim in it. The only answer that admits one. */
  | { readonly answer: "free"; readonly peek: LeasePeek }
  /** The folder was read and somebody is renewing. `holder` is `holders[0]`, the one the gate names. */
  | { readonly answer: "held"; readonly peek: LeasePeek; readonly holder: LeaseHolder }
  /**
   * The folder was NOT read. Says nothing about who holds the mailbox — in particular not that
   * nobody does.
   *
   * `op` is `no_lease_peek_io` for an adapter with no read-only accessor, and otherwise whatever
   * {@link readLeasePeek} assigned: `meta_folder_full` for a folder too full to read, `list_claims`
   * for every other fault out of `listClaims`.
   */
  | { readonly answer: "unreadable"; readonly op: LeaseOp; readonly cause: unknown };

export interface AnswerLeasePeekInput {
  /**
   * The read-only IO, or `undefined` where the adapter has none.
   *
   * `undefined` is admitted DELIBERATELY rather than pushed back to the caller as a guard: every
   * call site reaches this through a structural probe (`typeof adapter.leasePeekIo === "function"`)
   * because `MailboxAdapter` does not declare the accessor, and each of them answered a failed
   * probe with a bare `return` — a silent skip that leaves the holder columns saying what an
   * unorganized mailbox says. Taking `undefined` here makes the missing capability an ANSWER.
   */
  io: LeasePeekIo | undefined;
  now: Date;
  staleAfterMs?: number;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

/**
 * READ `ohmail/_meta` AND ANSWER IN THREE WORDS. Never throws.
 *
 * {@link readLeasePeek} is still the layer that reads; this is the layer that DECIDES, and the
 * difference is the throw. A `LeaseUnavailableError` is the truthful shape for a reader that will
 * render an apology, and the wrong shape for a door with a press in its hand: a `try` around a
 * decision is where "could not look" turns back into "nobody is there", once per call site.
 */
export async function answerLeasePeek(input: AnswerLeasePeekInput): Promise<LeasePeekAnswer> {
  if (input.io === undefined) {
    return { answer: "unreadable", op: "no_lease_peek_io", cause: undefined };
  }
  let peek: LeasePeek;
  try {
    peek = await readLeasePeek({
      io: input.io,
      now: input.now,
      ...(input.staleAfterMs !== undefined ? { staleAfterMs: input.staleAfterMs } : {}),
      ...(input.log !== undefined ? { log: input.log } : {}),
    });
  } catch (err) {
    /* BY CLASS, as every other caller exempts it. Anything else is a fault this function has no
       reading of, and swallowing it would answer `unreadable` for a programming error — safe in
       direction and indistinguishable from a folder fault in a report, which is how one gets
       diagnosed for a week as the other. */
    if (err instanceof LeaseUnavailableError) {
      return { answer: "unreadable", op: err.op, cause: err };
    }
    throw err;
  }
  /* `held` IS THE LIVENESS, not the presence of records. `peekLease` already decides it from the
     same `isClaimLive` the gate uses, and `holders[0]` is the holder the gate names — so a
     `stopped` folder answers `free`, which is what the gate's `available` verdict means and what
     a person pressing "organize here" on a machine whose other install went quiet expects. */
  if (peek.state === "held") {
    const holder = peek.holders[0];
    /* A `held` with no holder is unrepresentable through `peekLease` — `state` is `held` only
       because some holder is fresh — but this narrowing is the compiler's, not a comment's, and
       the safe reading of "held by nobody nameable" is still not `free`. */
    if (holder !== undefined) return { answer: "held", peek, holder };
    return { answer: "unreadable", op: "list_claims", cause: undefined };
  }
  return { answer: "free", peek };
}

// ── LAYER 3: IO ─────────────────────────────────────────────────────────────────────────────

/**
 * A lease IO failure is a mailbox fault, never a stand-down. A mailbox whose `_meta` cannot be
 * read is one we cannot safely organize, and reading that as "no claim, so organize" is the
 * dual-organizer bug through the back door; reading it as stand-down is nearly as wrong the other
 * way — stand-down is sticky caller-side, so a transient network error would permanently disable
 * a mailbox nobody else wants. Its own class, exempted BY CLASS by callers — the pattern the
 * worker uses for `ClassifierFaultError`, which keeps "an outage can never quarantine a mailbox"
 * true at every tuning.
 */
/**
 * Which lease operation failed — a closed set of literals, chosen at compile time. The rule this
 * states: a catch that wraps more than one operation must name which one threw. One try around
 * `ensureMetaFolder()` and `listClaims()` reported neither, and "the lease could not be read" is
 * the same sentence whether the folder could not be CREATED (our path is wrong) or could not be
 * LISTED (a `FETCH 1:*` against an empty mailbox that Dovecot rejects — the actual case). And it
 * costs nothing to log: every member is a string we wrote in this file — no server, mailbox or
 * user chooses it — which is what makes it emittable where `err.message` is not.
 */
export type LeaseOp =
  /** CREATE + UNSUBSCRIBE `ohmail/_meta`. */
  | "ensure_meta"
  /** FETCH the claim messages out of it. */
  | "list_claims"
  /** APPEND our renewed claim. */
  | "renew_claim"
  /** STORE `\Deleted` + EXPUNGE our older claims. */
  | "remove_claims"
  /** The adapter has no `leaseIo()` at all, so no operation was even attempted. */
  | "no_lease_io"
  /**
   * The adapter has no `leasePeekIo()` — the READ-ONLY accessor — so a caller that only wanted to
   * LOOK could not, and no operation was attempted.
   *
   * Distinct from {@link no_lease_io} and added 2026-09-01 rather than folded into it, because the
   * two send an operator to different missing methods and an adapter can genuinely have one and not
   * the other. It was folded in briefly, and a review round caught the telemetry lying about which
   * capability was absent — which is the whole reason this union is a closed set of literals rather
   * than a free string.
   */
  | "no_lease_peek_io"
  /**
   * THIS INSTALL'S CLOCK DISAGREES WITH THE MAIL SERVER'S past what the lease can tolerate. Not a
   * provider fault and not a folder fault: the machine is wrong, and no claim was written.
   */
  | "clock_skew"
  /* The folder holds more than one enumeration may read (`META_ENUM_RECORDS_MAX` records or
   * `META_ENUM_BYTES_MAX` bytes); the message is {@link metaFolderFullSentence}.
   * Same CLASS as every other lease IO fault on purpose: the hosts' exemptions and the LOCAL/Cloud
   * exclusions are all by class, so a new class would fall into `maxSyncFailures` and quarantine a
   * customer's mailbox over a folder that is not its fault. */
  | "meta_folder_full"
  /* The folder takes no delete of this install's own records: {@link META_CLEANUP_REFUSALS_MAX}
   * renew cleanups in a row were proved not carried out, and the probe of one own claim found it
   * still standing. No claim is written while it holds. Same class, for the reason above. */
  | "meta_undeletable"
  /** STORE `\Deleted` + EXPUNGE the acknowledgements past their life — see {@link RequestOp}. */
  | "sweep_acks"
  /** COPY + EXPUNGE the records deeper than {@link SEARCH_WALK_SPAN} — see {@link RequestOp}. */
  | "compact_meta";

export class LeaseUnavailableError extends Error {
  /**
   * Which operation threw. REQUIRED, so a construction site cannot forget it — the alternative
   * (an optional field) is a field that is absent at the one call site nobody thought about, which
   * is the call site that fires during the incident.
   */
  readonly op: LeaseOp;
  constructor(message: string, options: { op: LeaseOp; cause?: unknown }) {
    super(message, options);
    this.name = "LeaseUnavailableError";
    this.op = options.op;
  }
}

/**
 * THIS COMPUTER'S CLOCK DISAGREES WITH THE MAIL SERVER'S, so no claim was written.
 *
 * A {@link LeaseUnavailableError} and deliberately a SUBCLASS of it rather than a fourth verdict:
 * every host already exempts that class by name, so a wrong clock leaves the mailbox unattached and
 * un-quarantined and our own claim ages out un-renewed — while a STAND-DOWN would void a one-shot
 * press this pass could never have honoured, which is the defect the preview row names. The numbers
 * ride on the error because the sentence a person is shown needs them, and an optional field on the
 * base class would be a field absent at the one site that reads it.
 */
export class LeaseClockSkewError extends LeaseUnavailableError {
  /** Our stamp minus the server's. Positive is ahead. */
  readonly skewMs: number;
  /** Which bound fired, and what it was — {@link clockSkewBoundMs}. */
  readonly bound: "ahead" | "behind";
  readonly boundMs: number;
  constructor(message: string, detail: { skewMs: number; bound: "ahead" | "behind"; boundMs: number }) {
    super(message, { op: "clock_skew" });
    this.name = "LeaseClockSkewError";
    this.skewMs = detail.skewMs;
    this.bound = detail.bound;
    this.boundMs = detail.boundMs;
  }
  /**
   * How far off, in whole minutes, never below one — the figure the sentence quotes. A skew of
   * forty seconds rounds to zero, and "your clock is off by 0 minutes" is a sentence that tells
   * somebody nothing is wrong while their mailbox is not being organized.
   */
  get offByMinutes(): number {
    return Math.max(1, Math.round(Math.abs(this.skewMs) / 60_000));
  }
}

/** One message in the meta folder, as the IO layer sees it. */
export interface RawClaimMessage {
  /** Whatever the implementation needs to delete this exact message. */
  ref: unknown;
  /** The headers (a full source is fine too — only the header block is read). */
  raw: string;
  /**
   * THE SERVER'S OWN CLOCK — IMAP INTERNALDATE, the instant this server took delivery of the
   * record. It is the one time in this folder no install's clock can be wrong about, which is why
   * the writer-side clock check reads it and never the `X-Ohmail-Heartbeat` header beside it.
   * Absent where the IO layer does not fetch it, and absent is "unknown", never "no skew".
   */
  internalDate?: Date | null;
}

/**
 * WHAT THE FOLDER LOOKED LIKE FROM OUTSIDE IT — three counters the server keeps, and no record.
 *
 * A claim is a message, so "is my claim still there" is a question about the folder's CONTENT and
 * answering it properly costs a SELECT and a FETCH. This is the cheap half of it: nothing may be
 * appended without raising `uidNext`, and with `uidNext` unmoved nothing can have been expunged
 * without moving `messages` — so a stamp equal to an earlier one proves the folder holds exactly
 * the records it held then, our own claim among them. It cannot say WHAT changed, only that
 * something did, and the caller's answer to that is to read the folder properly.
 */
export interface MetaFolderStamp {
  /** The generation these counters are numbered in; `null` where the server did not say. */
  readonly uidValidity: number | bigint | null;
  /** The uid the next APPEND will be given. Monotone within a generation — the append detector. */
  readonly uidNext: number;
  /** How many messages the folder holds. With `uidNext` held, the expunge detector. */
  readonly messages: number;
}

/**
 * DID THE FOLDER STAND STILL BETWEEN THESE TWO STAMPS?
 *
 * The generation goes through the door like every other epoch here: a PROVEN renumbering is
 * movement whatever the counters say, and an UNNAMED one proves nothing either way — it must not
 * report movement on every boundary against a server that does not report UIDVALIDITY, which would
 * be a gate run per write. The counters answer in that case, and they are the terms the takeover
 * moves anyway.
 */
export function sameMetaStamp(a: MetaFolderStamp, b: MetaFolderStamp): boolean {
  if (epochVerdict(epochOf(a.uidValidity), epochOf(b.uidValidity)) === "stale") return false;
  return a.uidNext === b.uidNext && a.messages === b.messages;
}

/**
 * The narrow IO the lease needs, and nothing else.
 *
 * None of these operations is on `MailboxAdapter` — the lease needs APPEND, SEARCH,
 * FETCH-headers, STORE `\Deleted` + EXPUNGE, CREATE and UNSUBSCRIBE, and that interface has none
 * of them. Rather than widening the adapter surface every caller sees, `ImapAdapter.leaseIo()`
 * hands back this object bound to the LIVE login. A lease that opened its own connection would
 * mean a second login per mailbox per cycle, which is how a provider decides to throttle a user.
 */
export interface LeaseIo {
  /** Create `ohmail/_meta` if absent and unsubscribe it. Idempotent. */
  ensureMetaFolder(): Promise<void>;
  /** Every message in the meta folder. */
  listClaims(): Promise<RawClaimMessage[]>;
  /** APPEND one claim. */
  appendClaim(raw: string): Promise<void>;
  /** STORE `\Deleted` + EXPUNGE the given messages. */
  removeClaims(refs: readonly unknown[]): Promise<void>;
  /**
   * The records a release may decide from — the lease's own complete read, or a refusal
   * ({@link ClaimReleaseError}), never a slice. CANDIDATES, other installs' records included:
   * the selection is the caller's, with the gate's own parser, so a settings document carrying
   * the install-id header is never expunged here.
   */
  findOwnRecords?(installId: string): Promise<RawClaimMessage[] | null>;
  /**
   * HOW THE LAST `listClaims` READ THE FOLDER: `null` for the window, the counts when it read past
   * it by enumeration. The gate's `lease_meta_enumerated` line comes from here and decides nothing.
   */
  lastEnumeration?(): { records: number; claims: number; total: number } | null;

  /**
   * THE SELECTED FOLDER'S UID GENERATION, where the server reports one.
   *
   * Optional on the TYPE and never on an implementation: {@link makeLeaseIo} is the only one this
   * product ships and it always has the accessor, so absence means one thing — this connection
   * cannot tell us — and the takeover's confirm refuses on it rather than reading it as "nothing
   * changed". A double that leaves it out drives the gate in a state no install reaches, which is
   * what `lease-io-doubles.test.ts` censuses.
   */
  uidValidity?(): number | bigint | null;

  /**
   * THE FOLDER'S OWN COUNTERS, ASKED OF THE SERVER BY NAME — one command that reads no record.
   *
   * What a holder of a permit asks between reads: a stamp equal to the one taken at its last read
   * proves the folder has not moved, so the claim that read admitted is still standing. `null` for
   * every way of not knowing — no STATUS on this connection, a refusal, a reply missing a counter —
   * and the caller then keeps whatever bound it had, because an unanswerable probe is not evidence
   * that anything changed and must never become a stand-down on its own.
   */
  stampMeta?(): Promise<MetaFolderStamp | null>;

  /** The renew cleanups proved refused in a row, and the own claim to probe — this memory's. */
  cleanupStreak?(): { refusals: number; uid: number | null };
  /**
   * Record one renew cleanup's PROVEN outcome: landed resets, refused counts, with the probe uid
   * stamped under `generation` — the read that NAMED it (the election), never a later one.
   */
  noteCleanup?(outcome: { landed: true } | { landed: false; uid: number | null; generation: number | bigint | null }): void;
  /**
   * Delete the remembered claim under the numbering it was read in, and say what became of it.
   * `forgotten`: nothing to probe, renumbered, or already gone (the memory is cleared).
   */
  probeUndeletable?(): Promise<
    { kind: "landed" } | { kind: "standing"; uid: number; code: "still_present" | "expunge_refused" }
    | { kind: "unproven" } | { kind: "forgotten" }>;
}

/**
 * The minimum an IMAP client has to be for {@link makeLeaseIo} to drive it.
 *
 * Structural, not `ImapFlow`, so the whole IO layer is testable against a fake without a server
 * and so this module does not import the client library at all — `organizer-lease.ts` needs only
 * `imap-types.ts`, which is what keeps `imap.ts → organizer-lease.ts` a one-way edge with no
 * cycle.
 */
export interface LeaseImapClient extends MetaFolderClient {
  /**
   * The SELECTED mailbox, which `getMailboxLock` sets, and whose `exists` is its message count.
   *
   * Optional, and read defensively in {@link makeLeaseIo}, because it is the one field here that
   * is a client-library convenience rather than a command: a fake that omits it must behave
   * exactly as before, so absence means "unknown", never "empty".
   */
  /**
   * `uidNext` is the top of the uid space, and it is what a descending windowed SEARCH walks down
   * from — see {@link searchDescending}. Optional like the rest: a connection that cannot say has
   * no way to window, and falls back to one unbounded search.
   */
  readonly mailbox?: { exists?: number; uidValidity?: number | bigint; uidNext?: number } | false;
  /**
   * A NOOP, which is how a long-lived connection LEARNS what changed under it.
   *
   * Optional, so every existing fake is unaffected and behaves exactly as it did. Where it IS
   * present, {@link selectedCount} calls it before trusting a zero — see that function for the
   * measurement that made it necessary.
   */
  noop?(): Promise<unknown>;
  /**
   * STATUS on a folder BY NAME — the only form of "how many messages" this module asks, because it
   * is the only one that answers with a single number. Optional: a client without it falls back to
   * reading the folder whole, which is bounded in what it RETAINS. See {@link lastSequence}.
   */
  status?(
    path: string,
    /**
     * `uidNext` is asked for the same way the count is: from the SERVER, by name, on the folder.
     * Never from `client.mailbox`, whose fields are whatever the last untagged response left
     * behind — see {@link searchDescending} for what a stale one costs.
     *
     * `uidValidity` rides the same command for {@link MetaFolderStamp}: the counters mean nothing
     * across a renumbering, and asking for it separately would be a second round trip for a field
     * the server is already composing a reply about.
     */
    query: { messages?: boolean; uidNext?: boolean; uidValidity?: boolean },
  ): Promise<{ messages?: number; uidNext?: number; uidValidity?: number | bigint } | false | undefined>;
  /**
   * SEARCH the selected folder by HEADER. Optional. Not the count probe — that asks STATUS for a
   * scalar; this asks the server WHICH messages carry an id, so a release can find its own records
   * without reading the folder.
   */
  search?(
    /**
     * `uid` is a UID SEQUENCE criterion (`UID <lo>:<hi>`), which is how the search is bounded to a
     * window rather than asked about the whole folder. imapflow compiles it in
     * `lib/search-compiler.js` under `case 'UID'`, read there rather than assumed.
     */
    query: { header?: Record<string, string | boolean>; before?: Date; uid?: string },
    options?: { uid?: boolean },
  ): Promise<number[] | false | undefined>;
  mailboxCreate(path: string): Promise<unknown>;
  mailboxUnsubscribe(path: string): Promise<unknown>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  fetch(
    range: string,
    /* `internalDate` is the SERVER's clock — the writer-side skew check's only source. Optional on
       the query and on the reply: a client that does not report it leaves the skew unknown, which
       refuses nothing. See `clockSkewRefusal`. */
    query: { uid?: boolean; headers?: boolean | string[]; internalDate?: boolean; flags?: boolean },
    options?: { uid?: boolean },
  ): AsyncIterableIterator<{ uid: number; seq?: number; headers?: Buffer; internalDate?: Date; flags?: Set<string> }>;
  append(path: string, content: string | Buffer, flags?: string[]): Promise<unknown>;
  /**
   * COPY `ohmail/_meta` INTO ITSELF, so its records get fresh uids at the top of its uid space —
   * one caller, {@link RequestOrganizerIo.compactMeta}.
   *
   * A copy and not a re-APPEND of the bytes: the server keeps the message's flags and its
   * INTERNALDATE, so what lands is the SAME record with a new number. A re-append restamps, and a
   * restamped claim reads as freshly live. `uidMap` is UIDPLUS's `COPYUID`, old uid to new, and it
   * is the only proof a copy landed — without it nothing may be expunged.
   */
  messageCopy?(
    range: number[], destination: string, options?: { uid?: boolean },
  ): Promise<{ uidValidity?: number | bigint; uidMap?: Map<number, number> } | boolean | undefined>;
  messageDelete(range: number[], options?: { uid?: boolean }): Promise<unknown>;
  /**
   * imapflow's own "this connection still works". Read after a `messageDelete` that resolved
   * `false`: the library answers `false` for a socket that died mid-EXPUNGE too, and that is a
   * transport fault, never the server refusing. Optional; absent reads as usable.
   */
  readonly usable?: boolean;
}

/** Did the connection die under the last command? Only an explicit `false` says so. */
const connectionGone = (client: { readonly usable?: boolean }): boolean => client.usable === false;

/**
 * A {@link LeaseIo} bound to a live connection. `toServerPath` is passed in rather than
 * recomputed: the delimiter is discovered at login and is private to the adapter, and
 * `ohmail/_meta` must survive a `.` server (GreenMail) and a `/` server (Dovecot) — hand-writing
 * the mapping a second time is how two spellings drift. The claim is appended with `\Seen` so a
 * user who subscribes to the folder in another client is not shown an unread count for our
 * bookkeeping.
 */
/**
 * The selected folder's message count — and why it is not simply `client.mailbox.exists`. Three
 * reads skip their `FETCH 1:*` on a zero count (Dovecot refuses the command), documented as "only
 * a POSITIVELY KNOWN zero skips" — and the cached value does not meet that bar. Measured against
 * a real Dovecot: `exists` updates only from untagged responses and `getMailboxLock` does not
 * re-SELECT, so a stale 0 survived for ~20 s until IDLE delivered the EXISTS. A stale zero made
 * the gate elect over an "empty" folder holding a live claim — two organizers — and emptied the
 * peek and the request read. One NOOP removes the timing dependence; a failed NOOP leaves the
 * cached value standing, so it is swallowed.
 */
async function selectedCount(client: LeaseImapClient): Promise<number | undefined> {
  /**
   * There is no such thing as a refreshed cache here, and the flag that said so was a lie.
   * imapflow's `noop()` discards the command's own result — a REFUSED NOOP still resolves
   * normally — so success was inferred from the absence of a throw. The consequence: a connection
   * holding a cached `exists = 0` from before another install appended would refuse the NOOP, be
   * recorded as refreshed, return the stale zero, and the gate would elect over an empty folder
   * and append a second live claim. A refresh must be proven by the thing it refreshes: the count
   * is asked for outright ({@link lastSequence}, a STATUS naming the folder), the cache consulted
   * only where that is impossible.
   */
  const selected = client.mailbox;
  return typeof selected === "object" && selected !== null ? selected.exists : undefined;
}

/**
 * The narrowest client this probe needs. Structural rather than {@link LeaseImapClient} so the
 * PROFILE read of the same folder calls the same function: the two clients ask for different things
 * (headers against sources) and agree about exactly this, and one folder should not have two
 * implementations of "how many messages are in it".
 */
export interface SequenceProbeClient {
  /**
   * STATUS by folder name. Optional, because a client that does not offer it simply falls back to
   * reading the folder whole — see {@link lastSequence} for why this is the only form of the
   * question this module asks.
   */
  status?(
    path: string,
    /**
     * `uidNext` is asked for the same way the count is: from the SERVER, by name, on the folder.
     * Never from `client.mailbox`, whose fields are whatever the last untagged response left
     * behind — see {@link searchDescending} for what a stale one costs.
     */
    query: { messages?: boolean; uidNext?: boolean },
  ): Promise<{ messages?: number; uidNext?: number } | false | undefined>;
}

/**
 * Ask the server how many messages the folder holds — in a form the CLIENT cannot answer out of
 * its own cache. Not `FETCH *`: ImapFlow rewrites `*` to `this.mailbox.exists` before issuing the
 * command, so the probe was answered with the cached count it exists to distrust — the stale
 * number with extra steps, and on a cached zero it returned `false`, which the loop threw on; the
 * fake hid it by resolving `*` the way a server does. SEARCH is not rewritten: `ALL` returns
 * every sequence number, so the highest is the count and an empty answer is an empty folder.
 * `undefined` on anything unexpected — the caller falls back to the sliding window, which is
 * correct and merely costs the folder over the wire. Never a throw.
 */
export async function lastSequence(
  client: SequenceProbeClient,
  path: string | undefined,
  /** The read's clock — the third of its four segments. See {@link metaReadBudget}. */
  budget?: ImapDeadline,
): Promise<number | undefined> {
  if (path === undefined || typeof client.status !== "function") return undefined;
  try {
    const probe = client.status(path, { messages: true });
    const st = await (budget === undefined ? probe : budget.race(probe, path));
    // `false` is a real answer here, not a missing one: the library returns it when the command's
    // preconditions are not met or it fails, so this cannot optional-chain through `st`. Both that
    // and a reply without the field mean the same thing to the caller — the count is unknown, use
    // the whole-folder fallback.
    const messages = typeof st === "object" && st !== null ? st.messages : undefined;
    return typeof messages === "number" ? messages : undefined;
  } catch (err) {
    /*
     * A SPENT CLOCK IS NOT AN UNKNOWN COUNT. The `catch` is here for a server that cannot answer
     * STATUS, whose caller then reads the folder whole — which is exactly the wrong thing to do
     * with a budget that has already run out: the refusal would be swallowed here and re-raised
     * one round trip later, naming the FETCH for a stall that happened in the STATUS.
     */
    if (isImapBoundExceeded(err)) throw err;
    return undefined;
  }
}

/**
 * One bounded read of `ohmail/_meta`, NEWEST FIRST. Newest first because `1:*` returns oldest
 * first and a ceiling breaking out of that loop keeps the OLDEST records: everything live is
 * appended at the END. Over the ceiling the FETCH asks `exists - ceiling + 1 : *`. `truncated` is
 * the point of returning a record: {@link readMetaRecords} reads the whole folder instead, so
 * nothing decides from a truncated window. Exactly-the-ceiling is complete.
 */
export interface MetaFolderRead {
  /** The records the window covered, in the server's own order (oldest first WITHIN the window). */
  records: RawMetaMessage[];
  /** The folder holds more than one read may take; older records were not read. */
  truncated: boolean;
  /**
   * WHICH ceiling ended it — the record count or the byte budget. Optional so a test double
   * building this record by hand still compiles; production always sets it, and the refusal
   * built from it names the ceiling that fired rather than assuming the count.
   */
  truncatedBy?: MetaTruncation;
  /** The folder's message count as the server reported it, or `null` when it did not say. */
  total: number | null;
}

/** Which ceiling ended a read of the folder. The refusal's sentence and its limit follow it. */
export type MetaTruncation = "records" | "bytes";

/**
 * The window read itself. The folder must already be SELECTED by the caller's lock. Its ONE caller
 * is {@link readMetaRecords}, which enumerates instead of working with a truncated window (a census
 * pins the one call site). Exported so the window stays testable as the mechanism it is: "the
 * window runs from the END of the folder" would otherwise be asserted nowhere.
 */
export async function readMetaFolderWindow(
  client: LeaseImapClient,
  path?: string,
  /**
   * The clock the read's deadline reads. Injectable so a case can drive the SHIPPING ceiling
   * instead of a lowered one — a test that has to shorten the bound is not testing the bound.
   * Ignored when `budget` is supplied: that budget already carries its own clock.
   */
  now: () => number = Date.now,
  /**
   * THE READ'S BUDGET, where the caller entered one — see {@link metaReadBudget}. This function
   * is the LAST of the four segments, so a fresh clock here is a clock that cannot see the three
   * commands in front of it: whatever the LIST, the SELECT and the STATUS spent, a budget made
   * here would hand the FETCH the whole ceiling again. Absent, it makes its own, which is what a
   * caller reading the window on its own still gets.
   */
  budget?: ImapDeadline,
  /** A count the caller already asked STATUS for under this lock, so the read sends no second one. */
  counted?: { count: number | undefined },
): Promise<MetaFolderRead> {
  // An empty `_meta` is the normal state of a fresh mailbox, and `1:*` is not a valid messageset
  // when a mailbox holds nothing. The failure this defends: the folder is created one call
  // earlier, so on a first attach this FETCH always ran against zero messages; Dovecot refuses it
  // outright (`Invalid messageset`), which becomes a lease that "could not be read", which the
  // sync loop exempts by class — retried every thirty seconds for ever, and every genuinely fresh
  // mailbox showed "waiting for first sync" permanently. Read defensively: only a positively
  // known zero skips the fetch; an unknown count still runs it.
  const cached = await selectedCount(client);
  /**
   * Ask the server, then fall back — not the other way round. The probe is a STATUS naming the
   * folder: one scalar round trip, answered on an empty folder as readily as a full one, which is
   * why the zero check now comes AFTER it — the reason to skip on a cached zero was that `*` is
   * refused by the same servers that refuse `1:*`, and STATUS is refused by neither. The
   * connection's cached `exists` is consulted only where the server cannot be asked at all; it is
   * not a fast path, because there is no way to know whether it is current ({@link
   * selectedCount}).
   */
  const probed = counted !== undefined ? counted.count : await lastSequence(client, path, budget);

  /* A CACHED COUNT MAY END THE READ, BUT MAY NEVER BE COUNTED BACK FROM ────────────────────
   *
   * Those are different amounts of trust and they were conflated. Skipping an empty folder is safe
   * to get wrong in only one direction — a stale zero costs a read that finds nothing — while
   * counting BACK from a wrong number puts the window in the wrong place, which is how a live
   * claim disappears. Nothing now confirms a cached value (see {@link selectedCount}), so it keeps
   * the cheap job and loses the load-bearing one.
   *
   * `null` therefore means "unknown", and unknown reads the folder whole with the sliding eviction
   * behind it — bounded in what it RETAINS, and correct about which records those are. */
  if (probed === 0) return { records: [], truncated: false, total: 0 };
  if (probed === undefined && cached === 0) return { records: [], truncated: false, total: 0 };
  const total = probed ?? null;

  // The window's start. Above the ceiling this deliberately skips the oldest records — see the
  // header: in this folder the oldest are the ones that have been superseded or were never ours.
  const from = total !== null && total > META_RECORDS_MAX_PER_FETCH
    ? total - META_RECORDS_MAX_PER_FETCH + 1
    : 1;
  // HEADERS ONLY. A claim's body is one sentence for a human, a decision's payload rides in its
  // headers, and fetching sources here would make every cycle's cost scale with whatever else ends
  // up in this folder.
  //
  // A function rather than a loop in place, because the shift check below has to be able to run it
  // AGAIN with a wider range — and the two attempts SHARE one clock. A budget per attempt would
  // make the constant's own claim ("one read of the folder") false in exactly the case the
  // re-read fires, and per-read ceilings compose into a total nobody bounded. The caller's budget
  // is that same clock reaching one segment further back; it is used as given, never composed
  // with a second one made here.
  const clock = budget ?? metaReadBudget(now);
  const readFrom = async (
    start: number,
  ): Promise<{ records: RawMetaMessage[]; evicted: boolean; by: MetaTruncation | null }> => {
  const range = `${start}:*`;
  /**
   * Three ceilings, all on the READ. COUNT evicts from the FRONT rather than stopping — a
   * sequence range arrives oldest first, so stopping keeps the superseded half. BYTES, because
   * the count says nothing about how large one header block is and the server chooses that. TIME,
   * because a glacial answer resets the socket's inactivity timer for ever. A `map` yielding
   * `null` keeps a header-less reply COUNTED — the ceiling bounds what the server sends, not what
   * survives the filter. Nothing is deleted on the way past: the folder is the customer's.
   * `internalDate` rides along — the only reading of the server's clock this folder gives; the
   * `client.fetch(range,` call stays one line for the census.
   */
  const read = await boundedFetch(
    client.fetch(range, { uid: true, headers: true, internalDate: true }, { uid: false }),
    {
      max: META_RECORDS_MAX_PER_FETCH,
      bytes: { max: IMAP_META_BYTES_MAX, of: (m) => m.headers?.byteLength ?? 0 },
      deadline: clock,
      onOverflow: "evict",
      ...(path === undefined ? {} : { folder: path }),
      map: (m): RawMetaMessage | null =>
        m.headers
          ? {
              ref: m.uid, raw: m.headers.toString("utf8"),
              internalDate: m.internalDate instanceof Date ? m.internalDate : null,
            }
          : null,
    },
  );
  return {
    records: read.items.filter((r): r is RawMetaMessage => r !== null),
    evicted: read.evicted,
    by: read.evictedBy === "bytes" ? "bytes" : read.evictedBy === "count" ? "records" : null,
  };
  };

  const first = await readFrom(from);

  /**
   * The numbering can shift between the count and the FETCH, and EXPUNGE does it silently: `from`
   * is a sequence number from a count one round trip earlier, another connection's expunge
   * renumbers everything above it downward, and UIDVALIDITY does not move. Mild case: the window
   * covers fewer records than asked. Severe: `from` is past the end and the unordered-range rule
   * turns `501:*` into `400:501` — one record, and the gate elects on it. Both are visible in one
   * number: a capped window asks for exactly the ceiling, so anything less means the folder moved
   * — the answer is thrown away and the folder read whole. `1:*` is anchored at both ends;
   * appends only grow `*`.
   */
  if (from > 1 && first.records.length < META_RECORDS_MAX_PER_FETCH) {
    const wide = await readFrom(1);
    // The count that produced `from` is now known to be wrong, so it is not reported. When the
    // wide read evicted nothing it counted the folder itself, which is a better answer than the
    // one the server gave a round trip ago.
    return {
      records: wide.records,
      truncated: wide.evicted,
      ...(wide.by === null ? {} : { truncatedBy: wide.by }),
      total: wide.evicted ? null : wide.records.length,
    };
  }

  /* A WINDOW THAT SKIPPED OLDER RECORDS IS A RECORD-COUNT TRUNCATION even when nothing was
   * evicted: the range itself started past them. The eviction's own reason wins where there is
   * one, because it is the ceiling the read actually crossed. */
  return {
    records: first.records,
    truncated: from > 1 || first.evicted,
    ...(first.by !== null ? { truncatedBy: first.by } : from > 1 ? { truncatedBy: "records" as const } : {}),
    total,
  };
}

// ── THE WHOLE FOLDER, ENUMERATED ─────────────────────────────────────────────────────────────

/**
 * THE MOST RECORDS ONE ENUMERATION OF `ohmail/_meta` MAY LIST — the one ceiling every reader of
 * the whole folder shares (the settings listing, the lease past its window). Above it the read
 * refuses by name before any FETCH is sent; nothing is decided from part of the folder.
 */
export const META_ENUM_RECORDS_MAX = 20_000;

/** The client {@link enumerateMetaFolder} drives. Both ImapFlow-backed clients satisfy it structurally. */
export interface MetaEnumClient {
  fetch(
    range: string,
    query: { uid?: boolean; headers?: boolean; internalDate?: boolean; flags?: boolean },
    options?: { uid?: boolean },
  ): AsyncIterable<{ uid: number; headers?: Buffer; internalDate?: Date; flags?: Set<string> }>;
  status?: SequenceProbeClient["status"];
  readonly mailbox?: { exists?: number; uidValidity?: number | bigint } | false;
}

/** One retained row: the uid, its header section as sent, the server's clock and the message's flags. */
export interface MetaEnumRow {
  ref: number;
  raw: string;
  internalDate: Date | null;
  flags: readonly string[];
}

/** Why an enumeration refused. Each one is "could not prove what the folder holds", never "it holds nothing". */
export type MetaEnumCode =
  | "no_count" | "over_ceiling" | "bytes" | "incomplete" | "headerless" | "generation_moved"
  | "read_deadline" | "blind";

export class MetaEnumRefusedError extends Error {
  readonly code: MetaEnumCode;
  /** Rows the read had seen when it refused. */
  readonly rows: number;
  /** The server's message count, where it gave one. */
  readonly total: number | null;
  readonly ceiling: number;
  constructor(code: MetaEnumCode, detail: { rows: number; total: number | null; ceiling: number; cause?: unknown }) {
    super(`${META_FOLDER} could not be enumerated: ${code} (${detail.rows} rows seen, `
      + `${detail.total ?? "no"} counted, ceiling ${detail.ceiling})`, detail.cause === undefined ? {} : { cause: detail.cause });
    this.name = "MetaEnumRefusedError";
    this.code = code;
    this.rows = detail.rows;
    this.total = detail.total;
    this.ceiling = detail.ceiling;
  }
}

/**
 * EVERY MESSAGE IN `ohmail/_meta`, BY ONE HEADER FETCH, PROVED COMPLETE BY THE SERVER'S OWN COUNT.
 *
 * `UID FETCH 1:* (UID FLAGS INTERNALDATE BODY.PEEK[HEADER])`, anchored at both ends, under the
 * caller's lock and budget. Every row is COUNTED; only rows `keep` accepts are RETAINED, so memory
 * holds what the caller reads. It refuses rather than answer from part of the folder: no count,
 * over the ceiling (before any FETCH), a renumbering during the read, a row without headers, fewer
 * rows than the count (asked twice), or the caller's own record listed unrecognised (`probe`, the
 * positive control, judged first so it names itself). An empty answer is complete by construction.
 */
export async function enumerateMetaFolder(
  client: MetaEnumClient,
  path: string,
  budget: ImapDeadline,
  opts: {
    keep: (headerBlock: string) => boolean;
    probe?: { uid: number; recognised: (headerBlock: string) => boolean } | null;
    /** Default {@link META_ENUM_RECORDS_MAX} and {@link META_ENUM_BYTES_MAX}. Tests only. */
    recordsMax?: number;
    bytesMax?: number;
  },
): Promise<{
  records: MetaEnumRow[]; total: number; count: number; bytes: number; generation: Generation;
  probe: "kept" | "seen_not_kept" | "absent" | "unasked";
}> {
  const recordsMax = opts.recordsMax ?? META_ENUM_RECORDS_MAX;
  const bytesMax = opts.bytesMax ?? META_ENUM_BYTES_MAX;
  const probe = opts.probe ?? null;
  const refuse = (code: MetaEnumCode, rows: number, total: number | null, cause?: unknown): MetaEnumRefusedError =>
    new MetaEnumRefusedError(code, { rows, total, ceiling: code === "bytes" ? bytesMax : recordsMax, cause });

  const count = await lastSequence(client, path, budget);
  if (count === undefined) throw refuse("no_count", 0, null);
  const before = generationOf(client);
  if (count === 0) return { records: [], total: 0, count: 0, bytes: 0, generation: before, probe: probe === null ? "unasked" : "absent" };
  if (count > recordsMax) throw refuse("over_ceiling", 0, count);

  type Seen = { uid: number; raw: string; bytes: number; headerless: boolean; kept: boolean; internalDate: Date | null; flags: readonly string[] };
  let seen: Seen[];
  try {
    const read = await boundedFetch(
      client.fetch("1:*", { uid: true, headers: true, internalDate: true, flags: true }, { uid: true }),
      {
        max: recordsMax, bound: "enumerate_uids", onOverflow: "throw", deadline: budget, folder: path,
        bytes: { max: bytesMax, of: (m) => m.headers?.byteLength ?? 0 },
        map: (m): Seen => {
          const raw = m.headers?.toString("utf8") ?? "";
          const headerless = raw.length === 0;
          return {
            uid: m.uid, raw, bytes: m.headers?.byteLength ?? 0, headerless, kept: !headerless && opts.keep(raw),
            internalDate: m.internalDate instanceof Date ? m.internalDate : null,
            flags: m.flags === undefined ? [] : [...m.flags],
          };
        },
      },
    );
    seen = read.items;
  } catch (err) {
    if (isImapBoundExceeded(err)) {
      const code: MetaEnumCode = err.bound === "read_bytes" ? "bytes" : err.bound === "read_deadline" ? "read_deadline" : "over_ceiling";
      throw refuse(code, err.bound === "enumerate_uids" ? err.observed : 0, count, err);
    }
    throw err;
  }

  /* Through the door, as every `_meta` cleanup compares: only a PROVEN renumbering refuses, and a
     connection that states no UIDVALIDITY is not one. */
  if (epochVerdict(epochOf(before), epochOf(generationOf(client))) === "stale") {
    throw refuse("generation_moved", seen.length, count);
  }

  let probed: "kept" | "seen_not_kept" | "absent" | "unasked" = "unasked";
  if (probe !== null) {
    const own = seen.find((s) => s.uid === probe.uid);
    if (own === undefined) probed = "absent";
    else if (own.headerless || !probe.recognised(own.raw)) throw refuse("blind", seen.length, count);
    else probed = own.kept ? "kept" : "seen_not_kept";
  }
  if (seen.some((s) => s.headerless)) throw refuse("headerless", seen.length, count);

  const distinct = new Set(seen.map((s) => s.uid)).size;
  if (distinct < count) {
    const again = await lastSequence(client, path, budget);
    if (again === undefined || distinct < again) throw refuse("incomplete", seen.length, again ?? count);
  }
  return {
    records: seen.filter((s) => s.kept)
      .map((s) => ({ ref: s.uid, raw: s.raw, internalDate: s.internalDate, flags: s.flags })),
    total: seen.length, count, bytes: seen.reduce((n, s) => n + s.bytes, 0), generation: before, probe: probed,
  };
}

/** What one read of the folder found: the KEPT records, and the size of the whole folder. */
export interface MetaRecordsRead {
  records: RawClaimMessage[];
  /** The folder's message count from this read: the server's own, or every row a whole read saw. */
  count: number;
  /** The header bytes this read was sent, over every row, kept or not. */
  bytes: number;
  generation: Generation;
  /** The counts, when the read went past the window. */
  enumerated: { records: number; claims: number; total: number } | null;
  probe: "kept" | "seen_not_kept" | "absent" | "unasked";
}

/**
 * THE ONE DOOR EVERY READER OF `ohmail/_meta` GOES THROUGH: the lease, the request drains and
 * compaction. One STATUS; at or under {@link META_RECORDS_MAX_PER_FETCH} one window FETCH; past it,
 * or when the window came back short of the folder, {@link enumerateMetaFolder}. Both branches hand
 * back only what `keep` accepts, plus the folder's count and bytes. It is complete or it throws
 * {@link MetaEnumRefusedError}; no caller sees part of the folder. The bound (ruled): past
 * {@link META_ENUM_RECORDS_MAX} records, {@link META_ENUM_BYTES_MAX} bytes or the read's clock every
 * reader refuses by name, and {@link metaFolderFullSentence} says so. Caller holds the lock.
 */
export async function readMetaRecords(
  client: LeaseImapClient, path: string, budget: ImapDeadline,
  opts: {
    keep: (headerBlock: string) => boolean;
    probe: { uid: number; recognised: (headerBlock: string) => boolean } | null;
  },
): Promise<MetaRecordsRead> {
  const count = await lastSequence(client, path, budget);
  if (count === undefined || count <= META_RECORDS_MAX_PER_FETCH) {
    const read = await readMetaFolderWindow(client, path, undefined, budget, { count });
    if (!read.truncated) {
      return {
        records: read.records.filter((r) => opts.keep(r.raw)),
        /* The larger of the two: a writer between STATUS and the FETCH (the holder's acks) leaves
           STATUS short, and the readers' append headroom is counted from this. */
        count: Math.max(count ?? 0, read.records.length),
        bytes: read.records.reduce((n, r) => n + Buffer.byteLength(r.raw, "utf8"), 0),
        generation: generationOf(client), enumerated: null, probe: "unasked",
      };
    }
  }
  const listed = await enumerateMetaFolder(client, path, budget, { keep: opts.keep, probe: opts.probe });
  return {
    records: listed.records.map((r) => ({ ref: r.ref, raw: r.raw, internalDate: r.internalDate })),
    count: listed.count,
    bytes: listed.bytes,
    generation: listed.generation,
    enumerated: { records: listed.total, claims: listed.records.length, total: listed.count },
    probe: listed.probe,
  };
}

/** The lease's read: the door, keeping claims, with this install's own claim as the probe. */
async function readLeaseRecords(
  client: LeaseImapClient, path: string, budget: ImapDeadline,
  own: { uid: number; installId: string } | null,
): Promise<MetaRecordsRead> {
  const isOwn = (h: string): boolean => {
    const c = parseClaim(h);
    return c !== null && !isMalformed(c) && own !== null && c.installId === own.installId;
  };
  return readMetaRecords(client, path, budget, {
    keep: (h) => parseClaim(h) !== null,
    probe: own === null ? null : { uid: own.uid, recognised: isOwn },
  });
}

/**
 * THE SENTENCE FOR A FOLDER PAST THE ENUMERATION'S CEILING — the message every reader's refusal
 * carries for `meta_folder_full`. It names the count and the ceiling and nothing else.
 */
export function metaFolderFullSentence(
  count: number | null, ceiling: number, unit: "records" | "bytes" = "records",
): string {
  const held = count === null ? "more messages than ohmail reads" : `${count} messages`;
  const most = unit === "bytes" ? `${Math.floor(ceiling / (1024 * 1024))} MiB of it` : `${ceiling}`;
  return `${META_FOLDER} holds ${held}. ohmail reads at most ${most}, so organizing is paused on this `
    + "mailbox until the folder is smaller.";
}

/**
 * An expunge that resolved `true` is not a removal, and this is the only place that says so.
 * `messageDelete` is `resolveRange` then `run('EXPUNGE')`; the STORE marking `\Deleted` is
 * internal and its result is not propagated, so a refused STORE under an accepted EXPUNGE
 * resolves `true` having removed nothing — the only proof is asking the folder for the uids
 * again. Two outcomes are failures: the uids are still there, and the read could not RUN — and
 * the second must not return normally, because every caller treats a normal return as "removed"
 * and reports a count. One implementation for all three deletion paths — claims, settings
 * documents, stale acknowledgements.
 */
async function proveGone(
  client: Pick<LeaseImapClient, "fetch">,
  uids: readonly number[],
  what: string,
  op: LeaseOp,
): Promise<void> {
  const read = await custodyOf(client, uids);
  if (read.kind === "unreadable") {
    throw new LeaseUnavailableError(goneUnverified(uids.length, what, read.err), { op });
  }
  if (read.kind === "standing") throw new LeaseUnavailableError(goneSurvived(read.uids.length, what), { op });
}

/** Which of `uids` the folder still holds, or that the read-back could not run. No FETCH: gone. */
async function custodyOf(
  client: Pick<LeaseImapClient, "fetch">, uids: readonly number[],
): Promise<{ kind: "gone" } | { kind: "standing"; uids: number[] } | { kind: "unreadable"; err: unknown }> {
  if (typeof client.fetch !== "function") return { kind: "gone" };
  const still: number[] = [];
  try {
    for await (const m of client.fetch(uids.join(","), { uid: true }, { uid: true })) {
      if (typeof m.uid === "number") still.push(m.uid);
    }
  } catch (err) {
    return { kind: "unreadable", err };
  }
  return still.length > 0 ? { kind: "standing", uids: still } : { kind: "gone" };
}

const goneUnverified = (n: number, what: string, err: unknown): string =>
  `the expunge of ${n} ${what} from ${META_FOLDER} could not be verified: `
  + `${err instanceof Error ? err.message : String(err)}`;
const goneSurvived = (n: number, what: string): string =>
  `${n} ${what} survived the expunge in ${META_FOLDER} — the server accepted the command and removed nothing`;

/**
 * HOW MANY RENEW CLEANUPS IN A ROW MAY BE PROVED NOT CARRIED OUT before the gate stops appending.
 * Only `still_present` and `expunge_refused` count; an unverifiable read-back, a renumbering or a
 * transport throw neither count nor reset, and a cleanup that lands resets. In-process, so a
 * restart costs at most k+1 appends per install (META-RENEW-WITHOUT-EXPUNGE, ruled).
 */
export const META_CLEANUP_REFUSALS_MAX = 3;

/** The most uids one compaction window's SEARCH may carry; a window names at most 500. */
const SEARCH_UIDS_MAX = 501;

/** How wide one UID window is — the compaction's move and the ack sweep's read. */
const SEARCH_UID_WINDOW = 500;

/** How many windows one uid walk may take before it reports that it could not say. */
const SEARCH_WINDOW_BUDGET = 20;

/**
 * The uid depth compaction keeps `ohmail/_meta` inside: past it the organizer moves its oldest
 * records to the top ({@link RequestOrganizerIo.compactMeta}). Builds up to 0.25.4 read claims by
 * a walk this deep, so a folder kept inside it still elects the same winner on those builds.
 */
export const SEARCH_WALK_SPAN = SEARCH_UID_WINDOW * SEARCH_WINDOW_BUDGET;

/**
 * How many uids one EXPUNGE carries — the ack sweep's and the claim removal's. The command line
 * stays a fixed size whatever the folder did, and a refusal costs one batch rather than the pass.
 */
const SWEEP_DELETE_BATCH = 200;

/**
 * How many expunges one cycle may run, and how far down the folder it may look to fill them.
 * Batching the deletes bounded each COMMAND and left the CYCLE unbounded: a folder holding a
 * hundred thousand stale acknowledgements was one cycle's work, and the search ahead of it asked
 * the server to name an unbounded set. The sweep can afford a budget in a way the election
 * cannot: deletion is durable progress — a partial sweep is the same answer, later, and the
 * folder is smaller either way.
 */
const SWEEP_BATCHES_MAX_PER_CYCLE = 5;
const SWEEP_SEARCH_WINDOW_BUDGET = 12;

/**
 * How many uid windows one compaction pass may move. The sweep's budget and its reasoning: moving
 * records is durable progress — a folder half compacted is shallower than it was and the next pass
 * carries on from the new bottom — so a pass may be small, and a pass that is not bounded at all is
 * a cycle whose cost the folder chooses.
 */
const COMPACT_WINDOWS_MAX_PER_CYCLE = 5;

/**
 * The cutoff the ack sweep actually deletes by — floored to the start of its UTC day. Exported
 * because a test double answering `before` with the raw instant is MORE PERMISSIVE than the
 * server, and a double kinder than production is how a guard passes for something that would not
 * happen. Why a floor: IMAP SEARCH BEFORE takes a DATE, and without `WITHIN` the library widens a
 * time-of-day cutoff by a day — right for a reader, wrong for something that DELETES, since the
 * widened term reaches records filed on the cutoff's own day. Flooring puts the only remaining
 * error on the safe side: an ack may outlive its nominal life by up to a day, and none younger is
 * ever removed.
 */
export function ackSweepCutoff(before: Date): Date {
  return new Date(Date.UTC(before.getUTCFullYear(), before.getUTCMonth(), before.getUTCDate()));
}

/**
 * The most records one install may own in `ohmail/_meta` before a release refuses to enumerate.
 *
 * Deliberately far above anything an honest folder holds — a live install owns ONE claim and the
 * settings document — so this is a bound on WORK, not a policy. What it is not is the decision
 * ceiling: a release that quietly stopped at 501 would report success while a claim of ours stayed
 * behind, which is the one outcome the release path exists to prevent.
 */
const OWN_RECORDS_MAX = 5_000;

/**
 * Why a release of this install's own records did not happen — typed. The shape it replaces threw
 * a bare `Error` on every poll (38 in one session), indistinguishable across three states with
 * three remedies. The codes: `search_refused` — could not enumerate; `over_ceiling` — more
 * records than one bounded read may take, nothing removed (the caller's lapse bound ends the
 * state); `unreadable` — the read itself failed, the provider's failure in `cause`, reduced to
 * class + code; `renumbered` — UIDVALIDITY moved between read and delete; `still_present` — a
 * re-read still finds our records, so the next pass locates afresh. Every code retries the same
 * way, and none is "released": the one impossible reading is a count.
 */
export type ClaimReleaseFailureCode =
  "search_refused" | "over_ceiling" | "unreadable" | "renumbered" | "still_present"
  /** The server answered the EXPUNGE with a refusal (`messageDelete` resolved `false`). */
  | "expunge_refused"
  /**
   * THIS INSTALL CANNOT NAME THE CLAIM IT HOLDS, so it may not delete one by identity alone.
   *
   * A release is scoped to (install, nonce): under a shared install id — the restored-image
   * lineage — an id-only delete takes a sibling's claim. An install whose local store was wiped
   * has no nonce to name, and the way out is not a wider delete: the request stands and the
   * caller's lapse bound records the release once the claim has been un-renewed for a whole
   * staleness window, because by then it is residue whoever wrote it.
   */
  | "nonce_unknown";

export class ClaimReleaseError extends Error {
  readonly code: ClaimReleaseFailureCode;
  constructor(code: ClaimReleaseFailureCode, message: string, opts?: { cause?: unknown }) {
    super(message, opts);
    this.name = "ClaimReleaseError";
    this.code = code;
  }
}

/**
 * The UIDS in one bounded uid range of the folder, asked of the server in descending windows
 * (`UID SEARCH <criteria> UID <lo>:<hi>`), each reply bounded by construction. Compaction's
 * enumeration only, with no HEADER term: no lease decision rests on a SEARCH. A refused window,
 * no `uidNext`, or a walk out of its window budget is `refused`, never an answer.
 */
async function searchDescending(
  client: Pick<LeaseImapClient, "search" | "mailbox" | "status" | "fetch">,
  path: string,
  query: { header: Record<string, string | boolean>; before?: Date },
  max: number,
  span?: { from?: number; downTo?: number },
  /** The read's clock, where the caller entered one — see {@link metaReadBudget}. */
  budget?: ImapDeadline,
): Promise<DescendingWalk> {
  if (typeof client.search !== "function") return { kind: "refused" };
  /* The top is asked of the SERVER by STATUS, never read off the connection's cached mailbox:
     a stale-low top puts every window below the newest records. No top, no window. */
  const ceiling = span?.from ?? await highestUid(client, path, budget);
  if (ceiling === null || ceiling < 1) return { kind: "refused" };
  const bottom = Math.max(1, span?.downTo ?? 1);
  if (ceiling < bottom) return { kind: "covered", uids: [] };

  const out: number[] = [];
  let hi = ceiling;
  for (let window = 0; window < SEARCH_WINDOW_BUDGET; window++) {
    const lo = Math.max(bottom, hi - SEARCH_UID_WINDOW + 1);
    // One call site: the census counts it, and the read's clock bounds the whole walk.
    const search = client.search({ ...query, uid: `${lo}:${hi}` }, { uid: true });
    const found = await (budget === undefined ? search : budget.race(search, path));
    if (!Array.isArray(found)) return { kind: "refused" };
    out.push(...found);
    if (lo === bottom || out.length > max) return { kind: "covered", uids: out };
    hi = lo - 1;
  }
  return { kind: "refused" };
}

/**
 * THE LOWEST UID THE FOLDER HOLDS — sequence 1, whose uid is the smallest because uids ascend with
 * sequence numbers inside a generation. One row over the wire, asked of the server.
 *
 * `null` is every way of not knowing, which compaction reads as "nothing to move" rather than as an
 * empty folder. A FETCH and not a SEARCH because `UID SEARCH ALL` answers with every uid in the
 * folder — the unbounded reply the windows exist to avoid.
 */
async function folderBottomUid(
  client: Pick<LeaseImapClient, "fetch">,
  /** The read's clock, where the caller entered one — see {@link metaReadBudget}. */
  budget?: ImapDeadline,
): Promise<number | null> {
  if (typeof client.fetch !== "function") return null;
  try {
    /* By SEQUENCE, which is the point: sequence 1 is the oldest message the folder holds, and its
       uid is the floor beneath which nothing in this generation can be. */
    const page = await boundedFetch(client.fetch("1", { uid: true }, { uid: false }), {
      max: 1,
      ...(budget === undefined ? {} : { deadline: budget }),
      onOverflow: "stop",
      bound: "page_rows",
      map: (m): number | null => (typeof m.uid === "number" && m.uid > 0 ? m.uid : null),
    });
    const first = page.items.find((u): u is number => u !== null);
    return first ?? null;
  } catch (err) {
    // `highestUid`'s rule and for its reason: a spent clock is the read's refusal and must not be
    // swallowed into "I could not tell", which reads here as a folder that may still be compacted.
    if (isImapBoundExceeded(err)) throw err;
    return null;
  }
}

/**
 * The highest uid the folder could hold, asked of the SERVER — or `null` for every way of not
 * knowing: the compaction and the ack sweep both start from it, and the census counts the STATUS
 * sites. Never `client.mailbox.uidNext` — that is whatever the last untagged response left on the
 * connection, and a stale-low ceiling puts every window below the newest records.
 */
async function highestUid(
  client: Pick<LeaseImapClient, "status">, path: string,
  /** The read's clock, where the caller entered one — see {@link metaReadBudget}. */
  budget?: ImapDeadline,
): Promise<number | null> {
  if (typeof client.status !== "function") return null;
  try {
    const probe = client.status(path, { uidNext: true });
    const st = await (budget === undefined ? probe : budget.race(probe, path));
    const next = typeof st === "object" && st !== null ? st.uidNext : undefined;
    return typeof next === "number" && next > 1 ? next - 1 : null;
  } catch (err) {
    // `lastSequence`'s rule, and for its reason: a spent clock is the read's refusal, not a
    // server declining to answer. Swallowed here it would come back as "could not ask", which
    // every caller reads as a mailbox it may not organize — a stall wearing a refusal's clothes.
    if (isImapBoundExceeded(err)) throw err;
    return null;
  }
}

/**
 * THE FOLDER'S CURRENT GENERATION, read from the selected mailbox under the caller's own lock.
 *
 * Every position this module remembers is a position in a NUMBERING, and this is the only thing
 * that says whether that numbering is still the one it was learned under. See `meta-memo.ts` for
 * why the positions themselves no longer live beside the connection.
 */
function generationOf(client: { readonly mailbox?: { uidValidity?: number | bigint } | false }): Generation {
  const selected = client.mailbox;
  const v = typeof selected === "object" && selected !== null ? selected.uidValidity : undefined;
  return typeof v === "number" || typeof v === "bigint" ? v : null;
}

/** What a bounded uid walk covered: every window answered, or it could not say. */
type DescendingWalk = { kind: "covered"; uids: number[] } | { kind: "refused" };

export function makeLeaseIo(
  client: LeaseImapClient,
  toServerPath: (canonical: string) => string,
  identity: MetaIdentity,
  /** The clock the reads' budgets read — see {@link makeLeasePeekIo}. */
  limits?: { now?: () => number },
): LeaseIo {
  // The seam's own check: this package's tests are not typechecked, so a construction site that
  // omits an identity would bind `undefined` and every mailbox in the process would share one
  // memory under that key. Silent, and the exact defect the key exists to prevent.
  assertMetaIdentity("makeLeaseIo", identity);
  const now = limits?.now ?? Date.now;
  // ONE resolution, shared with the APPEND-less peek. A writer and a reader that spell "where is
  // `_meta`" differently is exactly how each ends up renewing a claim the other cannot see.
  const meta = makeMetaFolderRef(client, toServerPath);

  /**
   * THE UID GENERATION AS OF THE LAST READ, SAMPLED UNDER THAT READ'S OWN LOCK.
   *
   * The gate compares refs between two reads and refuses when the folder was renumbered between
   * them. Reading `client.mailbox.uidValidity` when the gate ASKS — after the lock is released —
   * would sample a generation that is not the one the records came from, so a renumbering landing in
   * that gap would be attributed to the wrong read and the check would look at two values that
   * matched while the refs it is guarding did not. Sampled beside the records instead, which is the
   * only moment the two are known to belong together.
   */
  let generationAtLastRead: number | bigint | null = null;
  let lastEnumeration: { records: number; claims: number; total: number } | null = null;
  const currentGeneration = (): Generation => generationOf(client);

  /**
   * THE LEASE'S READ, UNDER THE CALLER'S LOCK, WITH ITS POSITIVE CONTROL: our own last claim, by the
   * uid the server gave it, must come back recognised or the enumeration refuses `blind`. A uid our
   * claim no longer holds is forgotten. The generation is the one the records came from.
   */
  const readClaimsLocked = async (metaPath: string, budget: ImapDeadline): Promise<RawClaimMessage[]> => {
    const remembered = readMemo(identity, currentGeneration());
    const ownUid = remembered.kind === "memo" && typeof remembered.memo.claimUid === "number"
      ? remembered.memo.claimUid : null;
    const read = await readLeaseRecords(
      client, metaPath, budget, ownUid === null ? null : { uid: ownUid, installId: identity.installId },
    );
    if (read.probe === "absent") forgetMemo(identity, "claimUid");
    generationAtLastRead = read.generation;
    lastEnumeration = read.enumerated;
    noteMetaNearCeiling(identity, metaNearCeiling(read));
    return read.records;
  };


  return {
    async ensureMetaFolder(): Promise<void> {
      const at = await meta.locate();
      const found = at.row;
      if (!found) {
        try {
          const info = await client.mailboxCreate(at.path);
          // THE SERVER'S OWN ANSWER, where it gives one — `ImapAdapter.createFolder` follows the
          // same rule for the same measured reason: a root-named CREATE lands under the personal
          // namespace on some servers, and the path the server reports is the one LIST will show.
          const landed = (info as { path?: string } | undefined)?.path;
          if (typeof landed === "string" && landed !== "") meta.adopt(landed);
        } catch (err) {
          if (!/already exists/i.test(String((err as Error).message))) throw err;
        }
      }
      // UNSUBSCRIBED, always — a subscribed `_meta` shows up in every other mail client the user
      // owns, as a folder of machine bookkeeping they did not ask for. `ListResponse.subscribed`
      // means this is assertable against a real server rather than merely requested.
      if (!found || found.subscribed) await client.mailboxUnsubscribe(await meta.path());
    },

    async listClaims(): Promise<RawClaimMessage[]> {
      /* ONE BUDGET FOR THE WHOLE READ — see {@link metaReadBudget}. The gate holds the folder's lock
         across it, so an unclocked segment stalls the mailbox's mail. A read that cannot prove it
         saw every claim refuses ({@link readLeaseRecords}); nothing is decided from part of it. */
      const budget = metaReadBudget(now);
      const metaPath = await meta.path(budget);
      const lock = await lockWithin(client, metaPath, budget);
      try {
        return await readClaimsLocked(metaPath, budget);
      } finally {
        lock.release();
      }
    },

    lastEnumeration(): { records: number; claims: number; total: number } | null {
      return lastEnumeration;
    },

    uidValidity(): number | bigint | null {
      return generationAtLastRead;
    },

    /**
     * ONE STATUS, NO SELECT, NO FETCH — see {@link MetaFolderStamp}. Asked of the server by name
     * while the pass holds another folder open, which is the situation this exists for.
     *
     * It NEVER throws, and that is the load-bearing part: the caller is a write boundary, and a
     * throw there is classified by callers as this message's own failure. Every unknown — no
     * STATUS on the connection, a refused command, a reply short of a counter, a spent read budget
     * — is `null`, "I could not prove the folder stood still", and the caller decides what to do
     * about not knowing. Nothing here decides whether anybody organizes anything.
     */
    async stampMeta(): Promise<MetaFolderStamp | null> {
      if (typeof client.status !== "function") return null;
      try {
        const budget = metaReadBudget(now);
        const path = await meta.path(budget);
        const st = await budget.race(
          client.status(path, { messages: true, uidNext: true, uidValidity: true }), path,
        );
        if (typeof st !== "object" || st === null) return null;
        // BOTH counters or nothing: with either half missing the pair proves nothing, and half a
        // stamp compared as a whole one would read an append as "unchanged".
        if (typeof st.messages !== "number" || typeof st.uidNext !== "number") return null;
        const gen = st.uidValidity;
        return {
          messages: st.messages,
          uidNext: st.uidNext,
          uidValidity: typeof gen === "number" || typeof gen === "bigint" ? gen : null,
        };
      } catch {
        return null;
      }
    },

    async appendClaim(raw: string): Promise<void> {
      const reply = await client.append(await meta.path(), raw, ["\\Seen"]);
      /* UIDPLUS reports the uid the appended message was given. Servers that do not support it
       * say nothing, and then the read below simply works the way it did before this existed —
       * which is why nothing may be concluded from the absence of a uid here. */
      const uid = typeof reply === "object" && reply !== null
        ? (reply as { uid?: unknown }).uid
        : undefined;
      const gen = typeof reply === "object" && reply !== null
        ? (reply as { uidValidity?: unknown }).uidValidity
        : undefined;
      const generation = typeof gen === "number" || typeof gen === "bigint" ? gen : null;
      /* A uid with no generation cannot be checked for staleness later, so it is not kept: an
       * unverifiable anchor is worse than none, because none leaves the read's own-claim control
       * unasked and the count check standing. */
      if (typeof uid === "number" && Number.isFinite(uid) && uid > 0 && generation !== null) {
        const mono = monoNowMs();
        writeMemo(identity, generation, { claimUid: uid, ...(mono === null ? {} : { claimWrittenMonoMs: mono }) });
      } else {
        forgetMemo(identity, "claimUid");
      }
    },

    async findOwnRecords(_installId: string): Promise<RawClaimMessage[] | null> {
      /* The gate's own read, complete or refused, under the caller's lock and the current
         UIDVALIDITY; the selection is the caller's parser. A folder over the enumeration's ceiling
         is `over_ceiling`, every other refusal `unreadable` with the read's error in `cause`. */
      const budget = metaReadBudget(now);
      const metaPath = await meta.path(budget);
      const lock = await lockWithin(client, metaPath, budget);
      try {
        let records: RawClaimMessage[];
        try {
          records = await readClaimsLocked(metaPath, budget);
        } catch (err) {
          if (metaFullOp(err) !== null) {
            throw new ClaimReleaseError(
              "over_ceiling",
              `${META_FOLDER} holds more than one read of it may take, so a complete release cannot `
              + "be told from a partial one and nothing was removed",
              { cause: err },
            );
          }
          throw new ClaimReleaseError(
            "unreadable",
            `the records in ${META_FOLDER} could not be read on this connection, so a complete `
            + "release cannot be told from a partial one and nothing was removed",
            { cause: err },
          );
        }
        return records.map((m) => ({ ...m }));
      } finally {
        lock.release();
      }
    },

    async removeClaims(refs: readonly unknown[]): Promise<void> {
      const uids = refs.filter((r): r is number => typeof r === "number");
      if (uids.length === 0) return;
      const lock = await client.getMailboxLock(await meta.path());
      try {
        /**
         * A uid is a fact only under the numbering it was read under: if the folder was replaced
         * between the read that named these refs and this lock, they name whatever sits at them
         * now — another install's live claim, or the settings document. Only a PROVEN mismatch
         * refuses (both generations known and different); an unknowable one proceeds, with the
         * confirm-by-re-read as backstop. Through the door, so that every spelling of "no epoch"
         * — absent, `0`, out of RFC 3501's range — is ONE unknown here rather than a
         * contradiction, which would refuse every cleanup this mailbox ever needs.
         */
        const gen = currentGeneration();
        const refEpoch = epochOf(generationAtLastRead);
        if (uidRefsAtEpoch(uids.map((uid) => ({ epoch: refEpoch, uid })), epochOf(gen)) === "stale") {
          throw new ClaimReleaseError(
            "renumbered",
            `${META_FOLDER} was renumbered between the read that named these ${uids.length} `
            + "record(s) and the delete, so the refs cannot be trusted and nothing was expunged",
          );
        }
        /* In batches of {@link SWEEP_DELETE_BATCH}, each proved gone before the next. imapflow's
           `messageDelete` RESOLVES `false` on a refused STORE/EXPUNGE, which is a failure here; and
           a `true` proves only that an expunge RAN, so custody is read back ({@link proveGone}).
           A failing batch throws with the earlier ones removed: the folder is smaller either way. */
        /* Typed, because the gate counts two of these (META-RENEW-WITHOUT-EXPUNGE): a refusal and
           a survivor are proof the server will not delete; an unverifiable read-back is not. */
        for (let i = 0; i < uids.length; i += SWEEP_DELETE_BATCH) {
          const batch = uids.slice(i, i + SWEEP_DELETE_BATCH);
          const done = await client.messageDelete(batch, { uid: true });
          if (done === false && connectionGone(client)) {
            throw new LeaseUnavailableError(
              `the connection to ${META_FOLDER} closed during the expunge of ${batch.length} claim message(s)`,
              { op: "remove_claims" },
            );
          }
          if (done === false) {
            throw new ClaimReleaseError(
              "expunge_refused",
              `the server refused to expunge ${batch.length} claim message(s) from ${META_FOLDER}`,
            );
          }
          const read = await custodyOf(client, batch);
          if (read.kind === "unreadable") {
            throw new ClaimReleaseError("unreadable", goneUnverified(batch.length, "claim message(s)", read.err), {
              cause: read.err,
            });
          }
          if (read.kind === "standing") {
            throw new ClaimReleaseError("still_present", goneSurvived(read.uids.length, "claim message(s)"));
          }
        }
      } finally {
        lock.release();
      }
    },

    cleanupStreak(): { refusals: number; uid: number | null } {
      const held = peekMemo(identity)?.memo;
      return { refusals: held?.cleanupRefusals ?? 0, uid: held?.undeletableUid ?? null };
    },

    noteCleanup(outcome: CleanupOutcome): void {
      noteCleanupOutcome(identity, outcome);
    },

    async probeUndeletable() {
      const held = peekMemo(identity);
      const uid = held?.memo.undeletableUid;
      if (held === null || typeof uid !== "number") return { kind: "forgotten" as const };
      const forget = (): { kind: "forgotten" } => {
        forgetMemo(identity, "cleanupRefusals");
        forgetMemo(identity, "undeletableUid");
        return { kind: "forgotten" };
      };
      const lock = await client.getMailboxLock(await meta.path());
      try {
        /* A uid is a fact only under its numbering: a renumbered folder voids the probe. */
        if (uidRefsAtEpoch([{ epoch: epochOf(held.generation), uid }], epochOf(currentGeneration())) === "stale") {
          return forget();
        }
        const present = await custodyOf(client, [uid]);
        if (present.kind === "unreadable") return { kind: "unproven" as const };
        if (present.kind === "gone") return forget();
        const done = await client.messageDelete([uid], { uid: true });
        if (done === false && connectionGone(client)) return { kind: "unproven" as const };
        if (done === false) return { kind: "standing" as const, uid, code: "expunge_refused" as const };
        const after = await custodyOf(client, [uid]);
        if (after.kind === "unreadable") return { kind: "unproven" as const };
        if (after.kind === "standing") return { kind: "standing" as const, uid, code: "still_present" as const };
        forget();
        return { kind: "landed" as const };
      } finally {
        lock.release();
      }
    },
  };
}

/** One cleanup's proof: landed, or provably refused by the server (the uid the probe may aim at). */
type CleanupOutcome = { landed: true } | { landed: false; uid: number | null; generation: number | bigint | null };

/**
 * THE CLEANUP STREAK, written by the renew's cleanup and the sweep alike: a proven refusal counts
 * toward {@link META_CLEANUP_REFUSALS_MAX}, a landed one resets. The sweep's count is what lets a
 * folder already too full to read reach `meta_undeletable` (META-FULL-AND-UNDELETABLE-READS-FULL).
 */
function noteCleanupOutcome(identity: MetaIdentity, outcome: CleanupOutcome): void {
  if (outcome.landed) {
    forgetMemo(identity, "cleanupRefusals");
    forgetMemo(identity, "undeletableUid");
    return;
  }
  /* Under the generation the refs were read in; with none known nothing is kept, and the
     other positions in this memory are left alone rather than cleared by `writeMemo`. */
  if (!epochOf(outcome.generation).known) return;
  const held = readMemo(identity, outcome.generation);
  const memo = held.kind === "memo" ? held.memo : {};
  writeMemo(identity, outcome.generation, {
    cleanupRefusals: (memo.cleanupRefusals ?? 0) + 1,
    ...(outcome.uid !== null ? { undeletableUid: outcome.uid } : {}),
  });
}

export interface LeaseGateInput {
  io: LeaseIo;
  self: LeaseSelf;
  now: Date;
  staleAfterMs?: number;
  takeover?: TakeoverAuthorization | null;
  /**
   * WHAT THIS ORGANIZER ADVERTISES TO READERS — written onto every claim this gate renews.
   *
   * Required, on {@link ClaimInput.capabilities}'s reasoning: an optional field defaulted to empty
   * would make every organizer in the fleet look like a build too old to take a reader's decision,
   * with nothing failing anywhere.
   */
  capabilities: readonly string[];
  /** Injected for tests; production uses `randomUUID` from `node:crypto`. */
  newNonce?: () => string;
  /**
   * THE NONCE THIS CYCLE IS ABOUT TO WRITE, HANDED OVER BEFORE THE WRITE IS ISSUED.
   *
   * A caller's memory of its own identity moves with the WRITE, never with the ANSWER: a renewal
   * that commits and loses its response leaves this gate throwing and the caller on its previous
   * nonce, which the next gate reads as a stranger's ({@link LeaseSelf.pendingNonce}). Called
   * synchronously immediately before the APPEND, and returning nothing, so no arrangement of
   * failures leaves the folder carrying a nonce the caller was never told about.
   */
  onNonceMinted?: (nonce: string) => void;
  /**
   * WHAT A CONFIRMED RENEW DOES WITH OTHER INSTALLS' CLAIM RESIDUE ({@link claimResidue}):
   * `remove` (the default) removes it with our own older claims, `count` logs the plan and removes
   * no foreign record. Our own older claims go in both modes.
   */
  residue?: "remove" | "count";
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export interface LeaseGateResult {
  verdict: LeaseVerdict;
  /** The nonce written this cycle, to be held in memory as the next `self.lastNonce`. */
  nonce: string | null;
  /**
   * THE UID GENERATION THE ELECTION READ THIS VERDICT UNDER, where the server reports one.
   *
   * A verdict is a fact about the folder as it was numbered at that read. A caller that holds the
   * answer past the read — the permit does — compares this against a later one, because every uid
   * it remembers is void the moment the server renumbers. `null` is "the server did not say", which
   * is unknown and never "the same generation".
   */
  uidValidity: number | bigint | null;
  /**
   * THE BASELINE THIS VERDICT GRANTED, ISSUED HERE AND AWAITED BY WHOEVER NEEDS IT.
   *
   * On `organize` only; `custody: "unproven"` on every other verdict, because there is no claim of
   * ours to take a baseline for. See {@link MetaBaselineReading} for why it is a reading and not a
   * stamp, and `runLeaseGate`'s tail for the order the two halves are asked in.
   */
  stamp: Promise<MetaBaselineReading>;
}

/**
 * WHAT THE FOLDER LOOKED LIKE AT THE INSTANT THIS CLAIM WAS PROVED TO STAND — a baseline and the
 * custody question, answered together because either alone is worthless.
 *
 * Counters are the cheap half of "is my claim still there" ({@link MetaFolderStamp}), and a
 * BASELINE only if our claim stood when they were read. Taken by a separate round trip after the
 * gate returned, a takeover landing before the server answered was already inside them. So the gate
 * asks for the counters and re-proves custody by nonce BEHIND them. Three answers and not two:
 * "I could not look" is not "somebody took it", this module's rule everywhere else.
 */
export type MetaBaselineReading =
  /** Our claim stood when these counters were read. `stamp: null` — no counters, so no baseline. */
  | { readonly custody: "held"; readonly stamp: MetaFolderStamp | null }
  /** The folder could not be re-read, so custody is unproven: no baseline, and never a stand-down. */
  | { readonly custody: "unproven" }
  /**
   * Somebody else holds the mailbox now, and this is the verdict the survivors elected. A
   * {@link StandDownVerdict} and not a `LeaseVerdict`: the only reading that loses custody is one
   * where a LIVE rival stands, and a lost WRITE — nobody there — is `unproven`, so the caller
   * cannot be handed a "lost" it would have to re-classify.
   */
  | { readonly custody: "lost"; readonly verdict: StandDownVerdict };

/**
 * Read, decide, then write — the whole gate, in that order. Reconnect is learn-then-act: the
 * local sidecar reads the lease before its first move, and reconnect-after-sleep is exactly when
 * a mailbox is most likely to have changed hands. On `organize` it renews: APPEND the new claim,
 * THEN expunge the older ones — expunging first means a crash leaves no claim of ours, which
 * reads as an available mailbox; appending first leaves two, which {@link decideLease} coalesces.
 * On `stand_down` it releases our claims, or the winner waits out the whole staleness window.
 * Every IO failure becomes {@link LeaseUnavailableError}; the one place a stand-down is
 * constructed is {@link decideLease}.
 */
/** One of the gate's reads of the folder, complete by construction. */
interface GateRead {
  records: RawClaimMessage[];
  /**
   * THE FOLDER'S UID GENERATION AT THE MOMENT OF THE READ, where the server reports one.
   *
   * Refs are UIDs, and a UID means nothing across a UIDVALIDITY change: the server has renumbered
   * everything, so a ref from an earlier read names a different message or none at all. The confirm
   * compares refs between two reads, so a change between them makes its whole comparison
   * meaningless — see there.
   */
  uidValidity: number | bigint | null;
}

/**
 * WHICH IOs HAVE ALREADY REPORTED A WRONG CLOCK. See the refusal in {@link runLeaseGate}.
 *
 * A `WeakSet` so a mailbox that goes away takes its entry with it — this module holds no registry
 * and must not start one. The only state in the decision path, and it decides nothing: dropping it
 * would cost log volume, never a verdict.
 */
const clockSkewReported = new WeakSet<object>();

/**
 * THE OWN CLAIM A BLOCKED GATE PROBES: the one already remembered while it still stands, else the
 * oldest own claim this process wrote or one older than the stale window by the server's clock.
 * Never a younger claim under our id that this process did not write — a shared-id sibling's.
 */
function probeCandidate(
  claims: readonly ClaimRecord[], after: readonly ClaimRecord[], self: LeaseSelf,
  streak: { uid: number | null } | null, staleWindowMs: number,
): number | null {
  const own = claims.filter((c): c is OrganizerClaim => !isMalformed(c) && c.installId === self.installId
    && typeof c.ref === "number");
  if (streak?.uid != null && own.some((c) => c.ref === streak.uid)) return streak.uid;
  const serverNow = after.reduce((n, c) => Math.max(n, isMalformed(c) ? -Infinity : c.serverStamp?.getTime() ?? -Infinity), -Infinity);
  const eligible = own.filter((c) => writtenByThisProcess(self, c.nonce)
    || (c.serverStamp !== null && Number.isFinite(serverNow) && serverNow - c.serverStamp.getTime() >= staleWindowMs));
  const uids = eligible.map((c) => c.ref as number).sort((a, b) => a - b);
  return uids[0] ?? null;
}

export async function runLeaseGate(input: LeaseGateInput): Promise<LeaseGateResult> {
  const { io, self, now } = input;
  const log = input.log ?? ((): void => undefined);
  /* `randomUUID` from the MODULE, never the global `crypto`. The phone runs this file out of a
     bundle on Hermes, which has no global `crypto` at all, and the nonce is the clone defence —
     so reading a global meant a phone that could not claim its own mailbox, measured on a device.
     The import is substituted for the platform's crypto module in that bundle and is Node's here. */
  const newNonce = input.newNonce ?? ((): string => randomUUID());
  /* NO CLAIM OF OURS, SO NO BASELINE. Every non-`organize` return carries this: `unproven` is the
     honest name — there is nothing of ours to prove custody of — and no caller reads it, because a
     baseline is only ever asked for on the organize path. */
  const noBaseline: Promise<MetaBaselineReading> = Promise.resolve({ custody: "unproven" });

  // ── ONE OPERATION PER TRY, AND THAT IS THE RULE RATHER THAN A STYLE ────────────────────────
  //
  // These two used to share a single try that reported neither. They fail for completely different
  // reasons — CREATE against a namespace we have no rights in, versus a FETCH the server refuses —
  // and telling them apart is the difference between "our folder path is wrong for this provider"
  // and "the folder is there and empty and this server will not FETCH an empty mailbox", which is
  // that bug exactly. Splitting the try is what makes `op` a fact instead of a guess:
  // there is no arithmetic deciding which literal to use, only two blocks that each know.
  try {
    await io.ensureMetaFolder();
  } catch (err) {
    throw new LeaseUnavailableError(
      `the organizer lease folder ${META_FOLDER} could not be created; this mailbox cannot be ` +
      `organized safely`,
      { op: "ensure_meta", cause: err },
    );
  }
  /**
   * PROBE FIRST, ON A FOLDER THAT HAS REFUSED OUR DELETES (META-RENEW-WITHOUT-EXPUNGE). After
   * {@link META_CLEANUP_REFUSALS_MAX} proven refusals the gate deletes ONE own claim before it
   * reads; still standing, it refuses `meta_undeletable` with nothing appended and nothing read.
   * Before the read, so this outranks `meta_folder_full` when both hold: a person told to move
   * mail out of a folder that takes no delete cannot. Landed or unprovable, the ordinary gate runs.
   */
  const streak = io.cleanupStreak?.() ?? null;
  if (streak !== null && streak.uid !== null && streak.refusals >= META_CLEANUP_REFUSALS_MAX
    && io.probeUndeletable !== undefined) {
    const probe = await io.probeUndeletable().catch(() => ({ kind: "unproven" as const }));
    if (probe.kind === "standing") {
      log("lease_meta_undeletable", { uid: probe.uid, code: probe.code, count: streak.refusals });
      throw new LeaseUnavailableError(
        `${META_FOLDER} does not let this install remove its own records (${streak.refusals} cleanups `
        + "in a row were refused and the oldest claim still stands), so no claim is written",
        { op: "meta_undeletable" },
      );
    }
    log("lease_meta_probe", { uid: streak.uid, state: probe.kind });
  }
  /**
   * EVERY READ OF THE GATE IS COMPLETE, OR IT REFUSES AND WRITES NOTHING. The io reads the whole
   * folder past the window ({@link readLeaseRecords}), so the election, the read-back, the custody
   * check and the baseline each decide over every claim the folder holds. A refused enumeration
   * keeps its code in `op` (`meta_folder_full` for the folder's size, carrying
   * {@link metaFolderFullSentence}; `list_claims` for anything else) and is logged once.
   */
  let enumRefusalSaid = false;
  const readClaims = async (): Promise<GateRead> => {
    try {
      const records = await io.listClaims();
      return { records, uidValidity: io.uidValidity?.() ?? null };
    } catch (err) {
      if (err instanceof MetaEnumRefusedError) {
        if (!enumRefusalSaid) {
          enumRefusalSaid = true;
          log("lease_enum_refused", { code: err.code, records: err.rows, total: err.total, ceiling: err.ceiling });
          if (err.code === "blind") log("lease_enum_blind", { records: err.rows, total: err.total });
        }
        throw new LeaseUnavailableError(
          metaFullOp(err) !== null ? enumRefusalMessage(err)
            : `${err.message}, so no organizer can be proved or ruled out and nothing was written`,
          { op: metaFullOp(err) ?? "list_claims", cause: err },
        );
      }
      throw err;
    }
  };

  let messages: RawClaimMessage[];
  /** The UID generation the ELECTION saw — the confirm compares refs against this. See there. */
  let electionUidValidity: number | bigint | null = null;
  try {
    const first = await readClaims();
    messages = first.records;
    electionUidValidity = first.uidValidity;
    const enumerated = io.lastEnumeration?.() ?? null;
    if (enumerated !== null) log("lease_meta_enumerated", { ...enumerated });
  } catch (err) {
    /* A REFUSAL THAT ALREADY SAYS WHY KEEPS ITS OWN WORDS: `meta_folder_full` names a folder too
     * full to read, which `list_claims` would erase. Same CLASS either way, so every host's
     * exemption is unaffected. */
    if (err instanceof LeaseUnavailableError) throw err;
    throw new LeaseUnavailableError(
      `the organizer lease in ${META_FOLDER} could not be read; this mailbox cannot be organized safely`,
      { op: "list_claims", cause: err },
    );
  }

  /**
   * The writer's own clock, before any append — read off our own claim's two stamps, so no round
   * trip, judged before this gate can write. A refusal is {@link LeaseClockSkewError}, exempt by
   * class on both hosts and never a stand-down, which would void a press this pass could never
   * honour. THE RULED BOUND (FIRST-GATE-SKEW-HOLE): an install that has never written a claim has
   * no pair to measure, so its first gate run is unchecked; its own append supplies the pair and
   * the next cycle refuses. One cycle, accepted over a probe append before the first claim.
   */
  const staleWindowMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  if (staleWindowMs > MAX_FUTURE_SKEW_MS) {
    // The honest interim for a window above the cutoff: the cutoff is fixed, so a
    // longer configured window is silently the smaller of the two. Said out loud, never widened.
    log("lease_window_above_skew_cutoff", { staleAfterMs: staleWindowMs, effectiveMs: MAX_FUTURE_SKEW_MS });
  }
  const clockReading = ownClockReading(messages, self.installId);
  /**
   * A DISCREPANCY ON A RECORD THIS PROCESS DID NOT WRITE COSTS ONE RENEWAL, NOT THE MAILBOX.
   *
   * Both stamps are immutable and the refusal precedes the append, so a claim written with a wrong
   * clock refused for ever and told the person, every cycle, that the clock they had just fixed was
   * wrong. A record from before this process's memory is admitted once; the renewal it licenses
   * writes a claim under the clock this install has NOW, and every later cycle measures THAT one.
   * RESIDUAL: a process running across a correction clears only at its next launch. An install
   * whose clock is wrong still writes one claim per launch and then stops.
   */
  /* AND A CORRECTION MAKES OUR OWN RECORD STALE TOO — see {@link LeaseSelf.clockCorrected}. The
     record is still ours; it is no longer EVIDENCE about the clock this install has now. */
  const staleReading = clockReading !== null
    && (!writtenByThisProcess(self, clockReading.nonce) || self.clockCorrected === true);
  const skew = staleReading ? null : clockSkewRefusal({
    skewMs: clockReading?.skewMs ?? null, staleAfterMs: staleWindowMs,
  });
  if (staleReading) {
    const wouldRefuse = clockSkewRefusal({
      skewMs: clockReading?.skewMs ?? null, staleAfterMs: staleWindowMs,
    });
    if (wouldRefuse !== null) {
      log("lease_clock_skew_stale_reading", {
        skewMs: wouldRefuse.skewMs, bound: wouldRefuse.bound, boundMs: wouldRefuse.boundMs,
      });
    }
  }
  if (skew === null) {
    /* Re-armed the moment the clock is inside the bound again, so the line is written once PER
       EPISODE rather than once per process: a clock corrected and then broken again is a second
       thing worth reading about. */
    clockSkewReported.delete(io);
  } else {
    /* ONCE, not once a cycle. A wrong clock lasts days and this gate runs every poll, so the
       unlatched form wrote thousands of identical lines and buried the one that mattered. The
       latch is per IO — one connection's view of one mailbox — because that is the granularity a
       person's fix (correct the clock) clears. */
    if (!clockSkewReported.has(io)) {
      clockSkewReported.add(io);
      log("lease_clock_skew_refused", { skewMs: skew.skewMs, bound: skew.bound, boundMs: skew.boundMs });
    }
    throw new LeaseClockSkewError(
      `this computer's clock is ${Math.round(Math.abs(skew.skewMs) / 1000)}s ` +
      `${skew.bound === "ahead" ? "ahead of" : "behind"} the mail server's, which is more than the ` +
      `${Math.round(skew.boundMs / 1000)}s the organizer lease can tolerate; no claim is written ` +
      `until the clock is corrected`,
      skew,
    );
  }

  const claims = messages
    .map((m) => parseClaim(m.raw, m.ref, m.internalDate ?? null))
    .filter((c): c is ClaimRecord => c !== null);

  const verdict = decideLease({
    self,
    claims,
    now,
    ...(input.staleAfterMs !== undefined ? { staleAfterMs: input.staleAfterMs } : {}),
    ...(input.takeover !== undefined ? { takeover: input.takeover } : {}),
  });

  const ourRefs = claims
    .filter((c): c is OrganizerClaim => !isMalformed(c) && c.installId === self.installId)
    .map((c) => c.ref)
    .filter((r): r is unknown => r !== undefined);

  if (verdict.verdict !== "organize") {
    /**
     * The loser releases its own claims and never the winner's. `ourRefs` matches on install id
     * ALONE while the verdict decides ours-ness by id AND nonce — against a clone those disagree:
     * the peer's claim carries our id, so the release expunged the claim that had just beaten us,
     * the folder read empty, arm 4 said organize, and the loser re-seized on its next pass — dual
     * seizure produced by the defence that exists to stop it. `ourRefs` is deliberately not
     * narrowed — the renew reuses it for our own superseded claims, which carry older nonces by
     * design. The invariant: whoever won, we do not touch their claim; on `available` there is no
     * winner to protect.
     */
    const winner = verdict.verdict === "stand_down" ? verdict.by?.ref : undefined;
    const toRelease = winner === undefined ? ourRefs : ourRefs.filter((r) => r !== winner);
    if (toRelease.length > 0) {
      try {
        await io.removeClaims(toRelease);
      } catch (err) {
        // Failing to release is not failing to stand down — we are already not organizing; the
        // only cost is the winner waiting out the staleness window. Logged, never thrown. The
        // caught value goes to the logger WHOLE: `log.ts` writes an Error as its class and code,
        // never its message, which can carry the mail server's name or the failing command. A
        // string here would be written out as `errorText`. `op` rides along because this catch
        // wraps ONE operation, and the literal keeps that true.
        log("lease_release_failed", {
          op: "remove_claims" satisfies LeaseOp,
          err,
        });
      }
    }
    log("lease_stand_down", { verdict: verdict.verdict });
    return { verdict, nonce: null, uidValidity: electionUidValidity, stamp: noBaseline };
  }

  // The incumbency clock. Renewing must NOT restart it, or two installs that both renew every
  // cycle would each keep looking like the newest arrival and the election would never settle.
  const priorOwn = claims
    .filter((c): c is OrganizerClaim => !isMalformed(c) && c.installId === self.installId)
    .sort((a, b) => a.claimedAt.getTime() - b.claimedAt.getTime())[0];
  const claimedAt = priorOwn?.claimedAt ?? now;

  /**
   * The press travels with the tenure, exactly as `claimedAt` does. The failure if not carried:
   * an authorized takeover writes a stamped claim; a minute later the same install renews on rule
   * 3, and a renewal writing no stamp replaces the winning claim with an UNPRESSED one — the next
   * election ranks it below the incumbent it displaced, and the takeover undoes itself. So an
   * authorized win writes the press it rested on; every other win carries forward the prior
   * claim's. The flag comes off the VERDICT, not `input.takeover !== null`: a press can be
   * outstanding while the win comes from rules 3 or 4, and then nothing was taken over and
   * nothing should be stamped.
   */
  /**
   * And it is the NEWEST own claim that carries it, not `priorOwn`. `priorOwn` is the oldest by
   * `claimedAt` — right for the incumbency clock, wrong here: `claimedAt` is itself carried
   * forward, so a pre-press claim and the post-press claim tie, and array order (uid ascending —
   * the older residue first) decides which is read. Reachable through a partial expunge: a rule-6
   * win whose own older ref survives a refused STORE leaves the residue as `priorOwn` one cycle
   * later, the renewal writes `authorizedAt: null`, and the tenure a person authorized ranks
   * unpressed — the self-reversal this field exists to prevent, reached through the field. Newest
   * heartbeat wins, nonce as tie-break, so the answer is order-free.
   */
  const newestOwn = claims
    .filter((c): c is OrganizerClaim => !isMalformed(c) && c.installId === self.installId)
    .sort((a, b) => compareRecency(a, b, now))[0];
  const authorizedAt = verdict.authorized
    ? (input.takeover?.authorizedAt ?? null)
    : (newestOwn?.authorizedAt ?? null);
  /* The VERB travels with the tenure exactly as the press does, off the same two sources: an
     authorized win carries the verb it rested on, every other win carries forward the one the
     prior claim recorded. A renewal that wrote nothing would make a join tenure describe itself
     as a takeover one cycle later — harmless to the election, which never reads a foreign
     claim's intent, and a lie in the folder a person can open. */
  const intent: OrganizerIntent = verdict.authorized
    ? (input.takeover?.intent ?? "takeover")
    : (newestOwn?.intent ?? "takeover");

  const nonce = newNonce();
  /* RECORDED BEFORE IT IS WRITTEN — see {@link LeaseGateInput.onNonceMinted}. Nothing between this
     line and the APPEND, so a caller can always prove from what it wrote which claim is its own. */
  input.onNonceMinted?.(nonce);
  try {
    await io.appendClaim(
      formatClaim({
        installId: self.installId,
        kind: self.kind,
        displayName: self.displayName,
        heartbeat: now,
        claimedAt,
        nonce,
        protocol: self.protocol ?? CLAIM_PROTOCOL,
        authorizedAt,
        intent,
        capabilities: input.capabilities,
      }),
    );
  } catch (err) {
    throw new LeaseUnavailableError(
      `the organizer claim in ${META_FOLDER} could not be renewed`,
      { op: "renew_claim", cause: err },
    );
  }

  /**
   * Append, then look again before touching any mail. Two installs can both decide to organize
   * and both append; the gate used to return `organize` the moment its APPEND succeeded — a
   * dual-write window one poll interval wide. So the claim just written is read back and the
   * election re-run. `takeover` is NOT passed — the authorization was spent; `lastNonce` is the
   * nonce just written; the displaced claims are excluded BY REF — re-counting them re-elects the
   * incumbent, so the takeover would lose its own confirm — never by install id: an incumbent
   * that renewed in the gap wrote a message the decision never ranked, which stays in and wins,
   * so the press retries. A verify that cannot be READ throws — a mailbox fault, not a loss.
   */
  let verifyClaims: readonly ClaimRecord[];
  try {
    /* As complete as the election's read, whatever the folder did in between: a rival renewed
       under a burst of appends is still seen, so a write is never confirmed over a read that could
       not see all of what it decides about. */
    const after = (await readClaims()).records;
    verifyClaims = after
      .map((m) => parseClaim(m.raw, m.ref, m.internalDate ?? null))
      .filter((c): c is ClaimRecord => c !== null);
  } catch (err) {
    /* A refusal that names itself keeps its words: our own append can be what crossed the ceiling. */
    if (err instanceof LeaseUnavailableError) throw err;
    throw new LeaseUnavailableError(
      `the organizer lease in ${META_FOLDER} could not be re-read after the claim was renewed, so ` +
      `this mailbox cannot be organized safely`,
      { op: "list_claims", cause: err },
    );
  }

  // ── THE CLAIM WE JUST WROTE MUST BE IN WHAT WE READ BACK ──────────────────────────────────
  //
  // If it is not, something with delete rights acted on the folder between the append and this
  // read — a restored clone releasing every claim under our id, a takeover racing ours — and we
  // do not hold custody. Without this guard the displaced-ref exclusion below could hand the
  // election an EMPTY set, whose verdict is `organize`: the gate would then expunge the
  // incumbent and proceed WITH NO STANDING CLAIM AT ALL, which is unleased organizing — the
  // exact thing every line of this module exists to prevent. Reported as a lost race, not a
  // mailbox fault: the folder was readable, we simply did not win it.
  const ownSurvived = verifyClaims.some(
    (c): c is OrganizerClaim => !isMalformed(c) && c.installId === self.installId && c.nonce === nonce,
  );
  if (!ownSurvived) {
    log("lease_lost_race", { verdict: "own_claim_missing" });
    // The verdict is still derived from what the folder holds — with the caller's OWN identity,
    // not one armed with the vanished nonce: on an ordinary renew the folder still holds our
    // prior claim (its nonce IS `self.lastNonce`), and arming the clone defence with the vanished
    // nonce would classify that prior claim as a live clone of ourselves — a durable stand-down
    // naming us while our own claim keeps every peer out. A live FOREIGN winner among the
    // survivors is a genuine lost race: return the stand-down naming them. Anything else — the
    // survivors elect ourselves, or the folder is empty or stale — is a WRITE THAT WAS LOST:
    // retryable, and the next gate re-enters with our prior claim exactly as the election
    // expects.
    const survivors = decideLease({
      self,
      claims: verifyClaims,
      now,
      ...(input.staleAfterMs !== undefined ? { staleAfterMs: input.staleAfterMs } : {}),
    });
    if (survivors.verdict === "stand_down") {
      // A stand-down RELEASES, here as on the ordinary path: our prior claims are still in the
      // folder (only the new append vanished), and left behind they obstruct the winner for the
      // whole staleness window. Best effort, as every release is.
      const ownRemaining = verifyClaims
        .filter((c): c is OrganizerClaim => !isMalformed(c) && c.installId === self.installId)
        .map((c) => c.ref)
        .filter((r): r is unknown => r !== undefined);
      if (ownRemaining.length > 0) {
        try {
          await io.removeClaims(ownRemaining);
        } catch (err) {
          log("lease_release_failed", {
            op: "remove_claims" satisfies LeaseOp,
            err,
          });
        }
      }
      return { verdict: survivors, nonce: null, uidValidity: electionUidValidity, stamp: noBaseline };
    }
    throw new LeaseUnavailableError(
      `the claim this gate just appended to ${META_FOLDER} is no longer there and no live rival ` +
      `stands — the write was lost, and the gate will retry`,
      { op: "renew_claim" },
    );
  }

  // The header's third rule: the displaced are not rivals. `ref` is compared by value identity
  // (a uid, or a fake harness's int); a claim with no ref cannot have been displaced.
  const displacedRefs = new Set(verdict.displace);
  /* AND THE RECORDS THIS PROCESS WROTE ARE NOT RIVALS EITHER. The confirm arms the clone defence
     on the nonce just appended, which the claim being replaced no longer bears; `coalesce` keeps
     the newest record per install by the writer's stamp, so two gate runs inside one instant, or
     a wall clock stepped back between them, left the superseded record "newest" and the defence
     read this install's own claim as a live clone — every claim expunged, no organizer left.
     `writtenByThisProcess`, never `bearsOurNonce`: with no armed nonce the latter admits every
     record under our id and would hide a clone the next election is meant to see. */
  const supersededOwn = (c: ClaimRecord): boolean =>
    !isMalformed(c) && c.installId === self.installId && writtenByThisProcess(self, c.nonce);
  const confirmed = decideLease({
    self: { ...self, lastNonce: nonce },
    claims: verifyClaims.filter((c) => (c.ref === undefined || !displacedRefs.has(c.ref)) && !supersededOwn(c)),
    now,
    ...(input.staleAfterMs !== undefined ? { staleAfterMs: input.staleAfterMs } : {}),
  });

  if (confirmed.verdict !== "organize") {
    /* The loser releases its own claims and never the winner's — the election's rule, held here
       too: a clone's winning claim carries our id, and an id-scoped expunge deleted the record that
       had just beaten us, so the folder read empty to both sides. */
    const winner = confirmed.verdict === "stand_down" ? confirmed.by?.ref : undefined;
    const ours = verifyClaims
      .filter((c): c is OrganizerClaim => !isMalformed(c) && c.installId === self.installId)
      .map((c) => c.ref)
      .filter((r): r is unknown => r !== undefined && r !== winner);
    if (ours.length > 0) {
      try {
        await io.removeClaims(ours);
      } catch (err) {
        log("lease_release_failed", {
          op: "remove_claims" satisfies LeaseOp,
          err,
        });
      }
    }
    log("lease_lost_race", { verdict: confirmed.verdict });
    return { verdict: confirmed, nonce: null, uidValidity: electionUidValidity, stamp: noBaseline };
  }

  // WHAT THIS WIN DISPLACED, plus our own older copies. A takeover that lands half-applied is
  // caught by the custody re-read below — leaving the beaten claim behind is what made a takeover
  // reverse itself on the next cycle; our own older copies are the residue readers coalesce away.
  // A best-effort release of a set of refs — the failure mode of every release: logged, never
  // thrown, because a cleanup must not convert the state it is cleaning into a fault.
  const releaseRefs = async (refs: readonly unknown[]): Promise<void> => {
    if (refs.length === 0) return;
    try {
      await io.removeClaims(refs);
    } catch (releaseErr) {
      log("lease_release_failed", {
        op: "remove_claims" satisfies LeaseOp,
        err: releaseErr,
      });
    }
  };

  /* A RENEW'S CLEANUP: our own older claims, as ever, and — displacing nothing — the foreign
     residue no election can rank ({@link claimResidue}), computed over the verify's complete read,
     oldest uid first, at most {@link RESIDUE_REMOVE_MAX_PER_PASS} per pass. A takeover already
     displaces every foreign claim, so residue is a renew's alone; `count` mode removes none. */
  const residueMode = input.residue ?? "remove";
  const byUid = (a: unknown, b: unknown): number =>
    (typeof a === "number" ? a : Infinity) - (typeof b === "number" ? b : Infinity) || 0;
  const foreign = verdict.displace.length === 0
    ? claimResidue(verifyClaims, self, now, staleWindowMs).map((c) => c.ref)
      .filter((r): r is unknown => r !== undefined).sort(byUid)
    : [];
  const thisPass = residueMode === "remove" ? foreign.slice(0, RESIDUE_REMOVE_MAX_PER_PASS) : [];
  const toRemove = [...new Set([...ourRefs, ...thisPass, ...verdict.displace])].sort(byUid);
  let cleanupLanded = toRemove.length === 0;
  if (toRemove.length > 0) {
    let removalErr: unknown = null;
    try {
      await io.removeClaims(toRemove);
      cleanupLanded = true;
      io.noteCleanup?.({ landed: true });
    } catch (err) {
      /* PROVEN not carried out counts toward the probe; an unverifiable read-back, a renumbering
         or a transport fault says nothing about the server's will and neither counts nor resets. */
      if (err instanceof ClaimReleaseError && (err.code === "still_present" || err.code === "expunge_refused")) {
        io.noteCleanup?.({
          landed: false, uid: probeCandidate(claims, verifyClaims, self, streak, staleWindowMs),
          generation: electionUidValidity,
        });
      }
      if (verdict.displace.length === 0) {
        // An ORDINARY renew's failed cleanup is harmless: the folder holds our new claim plus
        // our own older copies, and readers coalesce by newest heartbeat. The next renew tries
        // again. The error goes to the logger whole, as at `lease_release_failed` above.
        log("lease_cleanup_failed", {
          op: "remove_claims" satisfies LeaseOp,
          err,
        });
      } else {
        // A TAKEOVER's removal is judged by the re-read below, not by what the driver reported:
        // a removal can fail after PARTIALLY landing (the STORE applied, the EXPUNGE refused),
        // so "it threw" proves neither that the incumbent stands nor that it fell. Held, not
        // thrown, until the folder has been looked at.
        removalErr = err;
      }
    }

    // The handover is verified by CUSTODY, not assumed from the driver. Takeovers only: the
    // folder is re-read and both halves must hold — every displaced ref absent, our own claim
    // present. Neither follows from the removal's outcome: `messageDelete` returns the EXPUNGE's
    // verdict, so a refused STORE under a no-op EXPUNGE resolves `true` with the message still
    // there, and a shared EXPUNGE on a non-UIDPLUS server can take messages this gate never named
    // — including, through a racing clone's release, the claim just written. A renew's cleanup
    // is proved per batch inside `removeClaims`; what it leaves is our own duplicates and residue
    // the next pass takes, not worth a re-read per cycle. The re-read has its own failure path: a FETCH rejecting after a removal that may
    // have landed is a READ fault — rolling back could leave no claim at all — so it throws
    // `list_claims` and rolls nothing back.
    if (verdict.displace.length > 0) {
      let read: GateRead;
      try {
        read = await readClaims();
      } catch (err) {
        if (err instanceof LeaseUnavailableError) throw err;
        throw new LeaseUnavailableError(
          `the organizer lease in ${META_FOLDER} could not be re-read after the handover was ` +
          `recorded, so the takeover cannot be confirmed this cycle`,
          { op: "list_claims", cause: err },
        );
      }
      const after = read.records;
      const afterClaims = after
        .map((m) => parseClaim(m.raw, m.ref, m.internalDate ?? null))
        .filter((c): c is ClaimRecord => c !== null);
      const ownStanding = afterClaims
        .filter((c): c is OrganizerClaim => !isMalformed(c) && c.installId === self.installId && c.nonce === nonce);
      const stillRefs = new Set(after.map((m) => m.ref));
      /**
       * The read is complete, so an absent ref is an expunged one — while the UID GENERATION says
       * the two reads' refs are comparable at all. After a renumbering `stillRefs.has(r)` compares
       * two numberings and can answer "gone" for a claim sitting there under a new uid. The door
       * (`epoch.ts`) answers agree, contradict, or NOBODY NAMED ONE; both non-`usable` answers mean
       * this read cannot speak about those refs: could-not-look, never a stand-down. What a server
       * that never names one costs is measured in `organizer-lease-meta-window.test.ts`.
       */
      const electionEpoch = epochOf(electionUidValidity);
      const confirmEpoch = epochOf(read.uidValidity);
      const epochs = epochVerdict(electionEpoch, confirmEpoch);
      if (epochs === "unknown") {
        log("lease_epoch_unknown", {
          op: "remove_claims" satisfies LeaseOp,
          state: electionEpoch.known ? "confirm_read" : confirmEpoch.known ? "election_read" : "neither_read",
          reason: "the mail server did not name this folder's uid generation, so the claims this "
            + "handover displaced cannot be proved gone; the takeover is not confirmed, this "
            + "install's own claim is withdrawn, and the mailbox keeps the organizer it has",
        });
      } else if (epochs === "stale") {
        log("lease_folder_renumbered", { op: "remove_claims" satisfies LeaseOp });
      }
      const incomparable = epochs !== "usable";
      const unprovable = incomparable ? verdict.displace.find((r) => !stillRefs.has(r)) : undefined;
      const survivor = verdict.displace.find((r) => stillRefs.has(r)) ?? unprovable;

      if (ownStanding.length === 0) {
        // Our claim did not survive the cleanup — a racing release under our id, or the shared
        // EXPUNGE taking more than the named refs. A live foreign winner is reported as the
        // loss it is, anything else is a lost write to retry — the same two arms as the
        // verify's own vanished-claim guard, and the same release: any OLDER claim of ours the
        // partial cleanup left behind goes too, or the stopped install's residue obstructs the
        // winner for the whole staleness window.
        log("lease_lost_race", { verdict: "own_claim_missing" });
        const survivors = decideLease({
          self,
          claims: afterClaims,
          now,
          ...(input.staleAfterMs !== undefined ? { staleAfterMs: input.staleAfterMs } : {}),
        });
        if (survivors.verdict === "stand_down") {
          await releaseRefs(afterClaims
            .filter((c): c is OrganizerClaim => !isMalformed(c) && c.installId === self.installId)
            .map((c) => c.ref)
            .filter((r): r is unknown => r !== undefined));
          return { verdict: survivors, nonce: null, uidValidity: electionUidValidity, stamp: noBaseline };
        }
        throw new LeaseUnavailableError(
          `the claim this gate appended to ${META_FOLDER} did not survive the handover's ` +
          `cleanup and no live rival stands — the write was lost, and the gate will retry`,
          { op: "remove_claims", ...(removalErr !== null ? { cause: removalErr } : {}) },
        );
      }

      if (survivor !== undefined) {
        // The beaten claim still stands while ours does too. Confirming would spend the
        // caller's one-shot authorization on a win the next election reverses on incumbency —
        // the one-click verb that appears to do nothing, again. Our own appended claim is
        // rolled back, best effort, so the retry re-enters the folder as it found it: left
        // standing, our fresh claim wins the NEXT gate outright wherever the beaten claim is
        // weaker — continuation, with an empty displace list — and the displacement this cycle
        // still owes is never attempted again while the authorization is spent on the
        // continuation.
        await releaseRefs(ownStanding.map((c) => c.ref).filter((r): r is unknown => r !== undefined));
        throw new LeaseUnavailableError(
          `the organizer handover in ${META_FOLDER} could not be recorded (a displaced claim ` +
          `survived the expunge), so the takeover did not complete`,
          { op: "remove_claims", ...(removalErr !== null ? { cause: removalErr } : {}) },
        );
      }

      // ── AND THE ELECTION IS RE-RUN OVER WHAT ACTUALLY STANDS ─────────────────────────────
      //
      // The displaced refs being gone is necessary, not sufficient: an incumbent that RENEWED
      // between the verify read and the cleanup wrote a NEW message the displace list never
      // named — its old uid is gone (we expunged it), its renewal is live, and confirming over
      // uid absence alone would spend the authorization on a win the very next election
      // reverses on incumbency. The renewal is proof of an actively live peer, so it wins here
      // exactly as it wins in the verify: our claim is released and the loss is reported as
      // held-by-them, and the press retries rather than steamrolling a live renewal.
      const finalElection = decideLease({
        self: { ...self, lastNonce: nonce },
        claims: afterClaims,
        now,
        ...(input.staleAfterMs !== undefined ? { staleAfterMs: input.staleAfterMs } : {}),
      });
      if (finalElection.verdict !== "organize") {
        await releaseRefs(afterClaims
          .filter((c): c is OrganizerClaim => !isMalformed(c) && c.installId === self.installId)
          .map((c) => c.ref)
          .filter((r): r is unknown => r !== undefined));
        log("lease_lost_race", { verdict: finalElection.verdict });
        return { verdict: finalElection, nonce: null, uidValidity: electionUidValidity, stamp: noBaseline };
      }

      // Custody holds: the displaced are gone and our claim stands — the handover landed,
      // whatever the driver reported on the way. A held removal error is downgraded to the
      // renew-cleanup log line: it described a write whose effect the re-read has now seen.
      if (removalErr !== null) {
        log("lease_cleanup_failed", {
          op: "remove_claims" satisfies LeaseOp,
          err: removalErr,
        });
      }
    }
  }
  if (foreign.length > 0 || (residueMode === "count" && verdict.displace.length === 0)) {
    const removed = cleanupLanded ? thisPass.length : 0;
    log("lease_claim_residue", { residue: foreign.length, removed, remaining: foreign.length - removed });
  }
  /**
   * THE BASELINE, AND THE PROOF THAT IT IS ONE — the gate's last act, issued and never awaited.
   * Counters FIRST, custody re-proved by nonce behind them: a takeover before or between them
   * leaves our claim missing from the proof, one after moves the counters off the baseline.
   * Not awaited: the row write follows the verified claim ({@link LeaseGateResult.stamp}), and the
   * permit awaits this before it grants. THE RULED BOUND, LEASE-BASELINE-RACES-THE-STATUS-ROUND-TRIP:
   * a rival APPEND the server takes between our last write and this STATUS is inside the baseline
   * — one round trip, irreducible for any answer read off the folder; the permit's TTL and write
   * count stand behind it.
   */
  const proveAndStamp = async (): Promise<MetaBaselineReading> => {
    const stamp = io.stampMeta === undefined ? null : await io.stampMeta().catch(() => null);
    let after: readonly ClaimRecord[];
    try {
      after = (await readClaims()).records
        .map((m) => parseClaim(m.raw, m.ref, m.internalDate ?? null))
        .filter((c): c is ClaimRecord => c !== null);
    } catch {
      /* COULD NOT LOOK, which is never a stand-down — this module's rule at every other probe. And
         no baseline either: counters nothing can vouch for are not one. */
      log("lease_baseline_unproven", { op: "list_claims" satisfies LeaseOp });
      return { custody: "unproven" };
    }
    if (after.some((c): c is OrganizerClaim =>
      !isMalformed(c) && c.installId === self.installId && c.nonce === nonce)) {
      return { custody: "held", stamp };
    }
    /* OUR CLAIM IS GONE FROM UNDER THE COUNTERS. Decided over the survivors with this caller's own
       identity, exactly as the verify's vanished-claim arm decides it: a live foreign winner is a
       takeover we lost and this install stops; anything else is a WRITE we lost, which the next gate
       re-enters cleanly, so it costs a look rather than somebody's mailbox. */
    const survivors = decideLease({
      self,
      claims: after,
      now,
      ...(input.staleAfterMs !== undefined ? { staleAfterMs: input.staleAfterMs } : {}),
    });
    if (survivors.verdict !== "stand_down") {
      log("lease_baseline_unproven", { op: "renew_claim" satisfies LeaseOp });
      return { custody: "unproven" };
    }
    log("lease_lost_race", { verdict: "taken_over_mid_stamp" });
    /* AND THE MAILBOX IS LEFT CONSISTENT — no half-move. Our records go back, best effort, so the
       winner is not obstructed for a whole staleness window by an install that has stopped. */
    await releaseRefs(after
      .filter((c): c is OrganizerClaim => !isMalformed(c) && c.installId === self.installId)
      .map((c) => c.ref)
      .filter((r): r is unknown => r !== undefined));
    return { custody: "lost", verdict: survivors };
  };
  return { verdict, nonce, uidValidity: electionUidValidity, stamp: proveAndStamp() };
}

// Layer 4: requests — a reader's decision, waiting for the organizer. The claim answers "who
// organizes this mailbox"; a request answers what a READER decided and whether the organizer has
// taken it yet. Both live in `ohmail/_meta` and both come off the same headers FETCH a cycle
// already pays — the discriminator (`X-Ohmail-Request: 1` vs `X-Ohmail-Lease: 1`) is read off the
// same header block. A request record is headers-only, like a claim: the payload is a customer's
// own screener decision, bounded and validated by the same function the organizer's own door uses
// — and it travels base64url-encoded in `X-Ohmail-Request-Payload`, so a value containing a
// colon, CRLF or folding space cannot be misread as a second header.

/** The one capability a request record needs from the organizer. See {@link CAPABILITY_REQUESTS}. */
const RH = {
  request: "X-Ohmail-Request",
  requestId: "X-Ohmail-Request-Id",
  requestKind: "X-Ohmail-Request-Kind",
  /**
   * THE WRITER'S OWN ROW ID FOR THE MAILBOX, inside the signed body. Every install mints its own,
   * so an organizer judges a record about the mailbox whose folder it read it from (the key is
   * that mailbox's) and refuses only one naming ANOTHER row its own store holds.
   */
  mailboxId: "X-Ohmail-Request-Mailbox",
  installId: "X-Ohmail-Install-Id",
  organizerKind: "X-Ohmail-Organizer-Kind",
  decidedAt: "X-Ohmail-Decided-At",
  protocol: "X-Ohmail-Protocol",
  payload: "X-Ohmail-Request-Payload",
  /** HMAC-SHA256 over {@link canonicalRequest}, base64url. The whole of the record's authenticity. */
  sig: "X-Ohmail-Request-Sig",
} as const;

/**
 * The request record's own protocol — independent of {@link CLAIM_PROTOCOL}, additive the same
 * way, EXCEPT the acknowledgement's fields: {@link parseAck} hard-requires
 * `X-Ohmail-Request-Mailbox` and folds it into {@link canonicalAck} unconditionally, so the ack's
 * signed shape is fixed at this number. An ack field added later is a BREAKING change — fold a
 * new field into the canonical bytes and every ack from an older build FAILS verification, both
 * installs telling each other genuine records are unauthenticated. So a new field goes behind a
 * protocol bump whose parser canonicalizes by the ack's own declared protocol, reading the older
 * shape tolerantly. Recorded now, while no older shape exists in the wild.
 */
export const REQUEST_PROTOCOL = 1;

/**
 * THE WIRE CEILING ON `X-Ohmail-Request-Payload`, once base64url-encoded.
 *
 * A customer's own screener decision is small (a scope, a decision, an address or a domain, a
 * destination folder) and this is generous against it — the ceiling exists to keep a malformed or
 * hostile payload from growing an RFC822 header without bound, not to accommodate a legitimate
 * decision that is close to it. `formatRequest` refuses to write past it rather than truncate,
 * because a truncated payload is a payload that decodes to something the sender never decided.
 */
export const REQUEST_PAYLOAD_MAX_BYTES = 4096;

/**
 * Origin authentication — the signature and the canonical bytes. Anyone with APPEND rights can
 * write a record; the only distinction from a stranger is a secret the installs share and a
 * forger does not — DERIVED, never stored ({@link deriveRequestKey}); the attacker here has
 * folder rights and no password. (A stored-key design was refused: an install is either
 * session-bearing or IMAP-bearing, never both.) The canonical form is length-prefixed, not
 * `join("|")`: attacker-influenced fields can impersonate the boundary between two others in a
 * joined form; the length prefix makes the mapping injective. It signs the ENCODED payload:
 * `JSON.parse` runs only after the record proved it came from a key holder.
 */
/**
 * The key is derived from the mailbox credential, not distributed. Two installs need the same
 * secret and cannot ask each other: a local install talks only to the mail server, and handing a
 * key over the hosted API would give it a session it deliberately does not have. They already
 * share exactly one secret — the mailbox password — and it draws the right boundary: the attacker
 * with APPEND rights through a shared-folder ACL or a sieve rule never holds it. Rotation IS the
 * password change: every install derives a different key on its next cycle and old records stop
 * verifying. Never stored, derived at use. OAuth mailboxes have no shared secret: `null`, no
 * `requests` capability, and a reader is refused at its own door.
 */
const REQUEST_KEY_INFO = "ohmail request key v1";

/**
 * THE ACCOUNT-SHARED SIGNING KEY FOR ONE MAILBOX, or `null` when there is no shared secret.
 *
 * The salt is the mailbox address, lower-cased — public and stable, which is all a salt has to be
 * here. Its job is domain separation between mailboxes: two mailboxes that happen to share a
 * password must not share a signing key, or a record from one would verify against the other.
 */
export function deriveRequestKey(o: { auth: ImapAuth; address: string }): string | null {
  const pass = (o.auth as { pass?: unknown }).pass;
  if (typeof pass !== "string" || pass === "") return null;
  const salt = o.address.trim().toLowerCase();
  if (salt === "") return null;
  return Buffer.from(hkdfSync("sha256", pass, salt, REQUEST_KEY_INFO, 32)).toString("base64url");
}

function canonicalField(v: string): string {
  return `${Buffer.byteLength(v, "utf8")}:${v}`;
}

/** The exact fields a signature covers. `payload` is the ENCODED text — see the header above. */
export interface RequestSignatureFields {
  requestId: string;
  kind: string;
  mailboxId: string;
  installId: string;
  /** ISO-8601, exactly as the header carries it — the string, never a re-formatted `Date`. */
  decidedAt: string;
  protocol: number;
  /** base64url, exactly as `X-Ohmail-Request-Payload` carries it. */
  encodedPayload: string;
}

/**
 * THE BYTES THE HMAC IS TAKEN OVER. Injective in every field (see the header): a change to any
 * one of them, including a change that only moves a character from one field into the next,
 * produces different bytes and therefore a different signature.
 */
export function canonicalRequest(f: RequestSignatureFields): string {
  return [
    f.requestId, f.kind, f.mailboxId, f.installId,
    f.decidedAt, String(f.protocol), f.encodedPayload,
  ].map(canonicalField).join("");
}

/** HMAC-SHA256 of {@link canonicalRequest} under the account's request key, base64url. */
export function signRequest(key: string, f: RequestSignatureFields): string {
  return createHmac("sha256", key).update(canonicalRequest(f), "utf8").digest("base64url");
}

/**
 * Does this signature belong to these fields under this key? Constant-time through
 * `timingSafeEqual` — a byte-at-a-time `===` on an HMAC leaks how much of a guess was right, and
 * an attacker who can append records can measure the drain's response by watching which survive a
 * cycle. The length check before it is not a leak: `timingSafeEqual` THROWS on unequal lengths,
 * so the guard is required, and an HMAC-SHA256's length is a constant. Returns FALSE for every
 * failure and never throws: a caller must not be able to turn "this record is forged" into an
 * exception some enclosing catch retries as a transient IO fault.
 */
export function verifyRequestSignature(key: string, f: RequestSignatureFields, sig: string): boolean {
  if (key === "" || sig === "") return false;
  let expected: Buffer;
  let given: Buffer;
  try {
    expected = Buffer.from(signRequest(key, f), "base64url");
    given = Buffer.from(sig, "base64url");
  } catch {
    return false;
  }
  if (expected.length !== given.length || expected.length === 0) return false;
  return timingSafeEqual(expected, given);
}

/**
 * WHAT AN ORGANIZER DRAINS. Closed by `organizer_requests_kind_closed` in Postgres — the same SIX
 * members, and the two lists must move together in that order: the widening migration ships ahead
 * of the code that writes the new member, so a row an older build wrote still satisfies the CHECK
 * and an older build keeps working against a migrated database (mail 0094's own marker).
 *
 * See {@link isRequestKind} for what a kind this build does not recognise gets: left standing, not
 * refused and not expunged — it is a record for a FUTURE build, written by a newer install on the
 * same account, and it becomes applicable the moment this organizer updates.
 */
export const REQUEST_KINDS = [
  "screener.decide",
  "rule.create", "rule.update", "rule.delete",
  "message.move",
  "profile.update",
] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export function isRequestKind(v: unknown): v is RequestKind {
  return typeof v === "string" && (REQUEST_KINDS as readonly string[]).includes(v);
}

/**
 * Which capability a holder must advertise before this kind is worth queueing. A `Record` over
 * the union rather than a `switch` with a default, deliberately: adding a member to {@link
 * REQUEST_KINDS} without deciding its capability is a COMPILE ERROR rather than a fall-through —
 * a default would gate the new kind on `requests`, which every organizer advertises, so the
 * reader would write a record the organizer has no applier for and the person would watch it sit
 * pending until it expired. The three `rule.*` members share one capability because they share
 * one applier and one table. The map lives beside the kinds because the edge runs core → db: this
 * file can import the strings, that file could not import the kinds.
 */
export const REQUEST_KIND_CAPABILITY: Readonly<Record<RequestKind, string>> = {
  "screener.decide": CAPABILITY_REQUESTS,
  "rule.create": CAPABILITY_RULES,
  "rule.update": CAPABILITY_RULES,
  "rule.delete": CAPABILITY_RULES,
  "message.move": CAPABILITY_MOVES,
  "profile.update": CAPABILITY_PROFILE,
};

/** The capability {@link REQUEST_KIND_CAPABILITY} names for one kind. */
export function capabilityForKind(kind: RequestKind): string {
  return REQUEST_KIND_CAPABILITY[kind];
}

export interface RequestInput {
  /** Also the row id in `organizer_requests` — the two identities are one, by design. */
  requestId: string;
  kind: RequestKind;
  /** THE MAILBOX THIS DECISION IS ABOUT. Signed, and checked against the folder it is read from. */
  mailboxId: string;
  installId: string;
  /**
   * This install's own kind, so the organizer's drain can log who asked without a second lookup.
   *
   * The SAME set the claim header carries, and the request parse arm below admits the same three:
   * a composition that stamps `mobile` into the claim it renews stamps it into every request it
   * appends, so widening one without the other refuses the phone at this field alone.
   */
  organizerKind: OrganizerKind;
  /** WHEN THE PERSON DECIDED, by the deciding door's clock — the drain applies in this order. */
  decidedAt: Date;
  protocol?: number;
  /** The decision itself. Bounded and encoded by this function; never trust it unvalidated. */
  payload: unknown;
  /**
   * THE ACCOUNT'S REQUEST KEY — required, with no unsigned path past it.
   *
   * A caller that has no key has no business writing a record: the organizer would refuse it
   * `unauthenticated`, and a reader that appends one anyway has put an unverifiable message into
   * a shared folder for nothing. `ScreenerService` and the reader's cycle both check for the key
   * BEFORE they get here — this type is what makes forgetting that a compile error rather than a
   * silent downgrade to the pre-0090 behaviour.
   */
  key: string;
}

/**
 * A request record's headers, read and bounded, with the payload STILL ENCODED — the halfway
 * state that makes verify-before-decode expressible: every field is length-checked, nothing is
 * base64-decoded, no JSON is parsed, so an organizer can compute the signature over {@link
 * encodedPayload} and refuse a forgery having spent nothing but a header read. `kind` is NOT
 * narrowed to {@link RequestKind}: an unrecognised kind is a record for a future build, and the
 * disposition is to leave it standing, which requires reading it far enough to know that is what
 * it is.
 */
export interface RequestEnvelope {
  requestId: string;
  kind: string;
  /** The mailbox the decision names, from inside the signed body. */
  mailboxId: string;
  installId: string;
  organizerKind: OrganizerKind | "unknown";
  decidedAt: Date;
  /**
   * The `X-Ohmail-Decided-At` header VERBATIM. The signature covers this string, not
   * `decidedAt.toISOString()` — a `Date` round-trip normalises (`+00:00` becomes `Z`, fractional
   * seconds are re-rendered), and a normalised re-render is different bytes and therefore a
   * different HMAC. Verifying against the parsed date would refuse records this codebase wrote.
   */
  decidedAtRaw: string;
  protocol: number;
  /** base64url, UNDECODED and bounded. The signature is taken over exactly this text. */
  encodedPayload: string;
  /** `X-Ohmail-Request-Sig`, base64url. Absent reads as `""`, which never verifies. */
  sig: string;
  ref?: unknown;
}

/** A request record, envelope plus the decoded payload. See {@link decodeRequestPayload}. */
export interface RequestRecord extends RequestEnvelope {
  /** Decoded JSON. STILL UNTRUSTED — the organizer's drain validates it before applying anything. */
  payload: unknown;
}

/** A message that says it is a request and then is not parseable as one. See {@link MalformedClaim}. */
export interface MalformedRequestRecord {
  malformed: true;
  reason: string;
  ref?: unknown;
}

/** What {@link parseRequestEnvelope} answers: headers read and bounded, or evidence of a broken record. */
export type RequestEnvelopeRecord = RequestEnvelope | MalformedRequestRecord;

/** What {@link decodeRequestPayload} answers: a whole record, or a payload that would not decode. */
export type RequestMessageRecord = RequestRecord | MalformedRequestRecord;

export function isMalformedRequest(
  r: RequestEnvelopeRecord | RequestMessageRecord,
): r is MalformedRequestRecord {
  return (r as MalformedRequestRecord).malformed === true;
}

function b64urlEncode(json: string): string {
  return Buffer.from(json, "utf8").toString("base64url");
}
function b64urlDecode(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

/**
 * One RFC822 message per outstanding decision. Mirrors {@link formatClaim}'s shape and rule: the
 * body is a sentence for a human who opens `ohmail/_meta` and carries no information the headers
 * do not. `organizer-request.test.ts` pins that the output never contains `X-Ohmail-Lease` or
 * `X-Ohmail-Profile` — a request record accidentally carrying either would be read as a different
 * kind of record by a reader that checks discriminators in a different order than this file does.
 */
export function formatRequest(r: RequestInput): string {
  const protocol = r.protocol ?? REQUEST_PROTOCOL;
  const encoded = b64urlEncode(JSON.stringify(r.payload ?? null));
  if (encoded.length > REQUEST_PAYLOAD_MAX_BYTES) {
    throw new Error(
      `request payload for ${r.requestId} is ${encoded.length} bytes encoded, over the `
      + `${REQUEST_PAYLOAD_MAX_BYTES}-byte ceiling — refused rather than truncated`,
    );
  }
  if (r.key === "") {
    throw new Error(
      `request ${r.requestId} cannot be written without the account's request key — an unsigned `
      + `record is refused by every organizer, so writing one would leave an unverifiable message `
      + `in a shared folder for nothing`,
    );
  }
  // SIGNED OVER THE HEADER-SAFE VALUES, not the raw inputs. `headerSafe` strips CR/LF and trims,
  // so a value that changes under it would be signed as one string and READ as another, and the
  // organizer would refuse a record this install itself wrote. The two must see identical bytes,
  // so the transformation happens once, here, and both the signature and the header use its output.
  const requestId = headerSafe(r.requestId);
  const kind = headerSafe(r.kind);
  const mailboxId = headerSafe(r.mailboxId);
  const installId = headerSafe(r.installId);
  const decidedAt = r.decidedAt.toISOString();
  const sig = signRequest(r.key, {
    requestId, kind, mailboxId, installId, decidedAt, protocol, encodedPayload: encoded,
  });
  const lines = [
    `${RH.request}: 1`,
    `${RH.requestId}: ${requestId}`,
    `${RH.requestKind}: ${kind}`,
    `${RH.mailboxId}: ${mailboxId}`,
    `${RH.installId}: ${installId}`,
    `${RH.organizerKind}: ${r.organizerKind}`,
    `${RH.decidedAt}: ${decidedAt}`,
    `${RH.protocol}: ${protocol}`,
    `${RH.payload}: ${encoded}`,
    `${RH.sig}: ${sig}`,
    `Subject: ohmail organizer request`,
    `Date: ${r.decidedAt.toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    "",
    "A reader made a decision on this mailbox and is waiting for the install that organizes it to",
    "apply it. This message is bookkeeping — deleting it before that happens loses the decision.",
    "",
  ];
  return lines.join("\r\n");
}

/**
 * Read the headers of one message as a request record. Returns `null` when it is not a request at
 * all (a claim, a profile record, or a stray) — mirrors {@link parseClaim}'s discriminator rule
 * exactly, including the duplicate-header refusal: a record that announces itself twice and
 * disagrees with itself is evidence of a request that cannot be trusted, not an absent one.
 */
/**
 * Does this message CLAIM to be a request record? A header test, and deliberately nothing more.
 *
 * `ohmail/_meta` is shared with the lease's claims and the portable profile, so a caller that
 * counts messages is not counting requests. This is the negative {@link requestEnvelopesIn} uses
 * to sort one shared read into its kinds; {@link parseRequestEnvelope} — which re-reads the same
 * header and returns `null` for anything that is not a request — stays the authority on whether
 * one is WELL FORMED. A record this returns `true` for can still be malformed, and must still be
 * parsed.
 */
export function isRequestRecord(raw: string): boolean {
  const headerBlock = raw.split(/\r?\n\r?\n/, 1)[0] ?? "";
  let seen = 0;
  let anyIsOne = false;
  for (const line of headerBlock.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    if (line.slice(0, at).trim().toLowerCase() !== RH.request.toLowerCase()) continue;
    seen += 1;
    if (line.slice(at + 1).trim() === "1") anyIsOne = true;
  }
  // It must not disagree with the parser about what is a request. This returned on the FIRST
  // occurrence while {@link parseRequestEnvelope} refuses duplicates outright — so
  // `X-Ohmail-Request: 0` followed by `X-Ohmail-Request: 1` answered `false` here, the message
  // never reached the parser, and the `malformed` disposition — the only thing that would put its
  // ref on the removal list — was unreachable. One APPEND bought a message every drain and both
  // lease reads re-fetch and re-parse for ever, with no log line and no way to remove it. A
  // repeated header is therefore always handed on so the parser can refuse it and the drain can
  // remove it; a single occurrence still has to say `1`.
  return seen > 1 || anyIsOne;
}

export function parseRequestEnvelope(raw: string, ref?: unknown): RequestEnvelopeRecord | null {
  const headerBlock = raw.split(/\r?\n\r?\n/, 1)[0] ?? "";
  const headers = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const line of headerBlock.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    headers.set(name, line.slice(at + 1).trim());
    seen.set(name, (seen.get(name) ?? 0) + 1);
  }
  const get = (k: string): string | undefined => headers.get(k.toLowerCase());
  const count = (k: string): number => seen.get(k.toLowerCase()) ?? 0;
  const malformed = (reason: string): MalformedRequestRecord =>
    ref === undefined ? { malformed: true, reason } : { malformed: true, reason, ref };

  if (count(RH.request) > 1) return malformed("duplicate request header");
  if (get(RH.request) !== "1") return null; // not a request — a claim, a profile record, or a stray

  for (const field of [
    RH.requestId, RH.requestKind, RH.mailboxId, RH.installId, RH.organizerKind, RH.decidedAt,
    RH.protocol, RH.payload, RH.sig,
  ]) {
    if (count(field) > 1) return malformed(`duplicate ${field}`);
  }

  /**
   * BOUNDED BEFORE ANYTHING ELSE READS THEM. A record is another install's input — or, until the
   * request channel is authenticated, the input of ANYONE with APPEND rights on this folder — so
   * every field gets a length ceiling before it is used for anything, including as a component of
   * the idempotency key downstream.
   */
  const requestId = get(RH.requestId);
  if (!requestId || requestId.length > 128) return malformed("no or oversized request id");

  const kind = get(RH.requestKind);
  if (!kind || kind.length > 64) return malformed("no or oversized request kind");

  // Bounded like its neighbours even though a legitimate value is always a 36-character uuid: this
  // is a stranger's input until the signature says otherwise, and the comparison the drain makes
  // against its own mailbox id must not be handed an unbounded string to walk.
  const mailboxId = get(RH.mailboxId);
  if (!mailboxId || mailboxId.length > 128) return malformed("no or oversized mailbox id");

  const installId = get(RH.installId);
  if (!installId || installId.length > 256) return malformed("no or oversized install id");

  /* The claim arm's set, asked through the same predicate: the request header is a second door
     onto one vocabulary, and a set spelled twice is a set that widens on one door only. */
  const organizerKindRaw = (get(RH.organizerKind) ?? "").toLowerCase();
  const organizerKind: OrganizerKind | "unknown" =
    isOrganizerKindWord(organizerKindRaw) ? organizerKindRaw : "unknown";

  const protocolRaw = get(RH.protocol);
  const protocol = Number(protocolRaw);
  if (!protocolRaw || !Number.isFinite(protocol) || protocol < 1) return malformed("unreadable protocol");

  const decidedAtRaw = get(RH.decidedAt) ?? "";
  const decidedAt = new Date(decidedAtRaw);
  if (Number.isNaN(decidedAt.getTime())) return malformed("unreadable decided-at");

  const encoded = get(RH.payload);
  if (!encoded) return malformed("no payload");
  // BOUNDED BEFORE DECODING, and the rule is stated as a size test on the ENCODED text: "encoded.length >
  // REQUEST_PAYLOAD_MAX_BYTES refused before decoding". A record whose header claims a payload
  // past the write side's own ceiling is refused on the length ALONE, so a hostile record cannot
  // spend a base64 decode plus a `JSON.parse` over an attacker-chosen number of bytes — the read
  // side must not trust that every writer honours `formatRequest`'s own refusal to write past it.
  if (encoded.length > REQUEST_PAYLOAD_MAX_BYTES) return malformed("payload exceeds the byte ceiling");

  // ── AND THIS IS WHERE THE READ STOPS ────────────────────────────────────────────────────────
  //
  // No `b64urlDecode`, no `JSON.parse`. The payload is still exactly the text the header carried,
  // which is the text the signature covers, and the caller's next move is to VERIFY — see
  // {@link decodeRequestPayload}, which is the only way past this point and takes a verified
  // envelope to get there. An absent signature reads as `""` rather than as a malformation,
  // because "no signature" is not a broken record: it is an UNAUTHENTICATED one, and the refusal
  // it earns says so by name.
  const sig = get(RH.sig) ?? "";
  const envelope: RequestEnvelope = {
    requestId, kind, mailboxId, installId, organizerKind,
    decidedAt, decidedAtRaw, protocol, encodedPayload: encoded, sig,
  };
  return ref === undefined ? envelope : { ...envelope, ref };
}

/**
 * IS THIS ENVELOPE SIGNED BY A HOLDER OF THE ACCOUNT'S KEY? The one question that stands between
 * a message in a shared folder and somebody's mail being filed.
 *
 * Split from {@link parseRequestEnvelope} rather than folded into it because the two have
 * different inputs and different failure meanings: parsing needs only the message, verification
 * needs the account's secret, and a record that parses but does not verify is a FORGERY rather
 * than a malformation. Keeping them apart is also what lets the reader's own cycle read a folder
 * without ever being handed a decode of someone else's payload.
 */
export function verifyRequestEnvelope(e: RequestEnvelope, key: string): boolean {
  return verifyRequestSignature(key, {
    requestId: e.requestId, kind: e.kind, mailboxId: e.mailboxId, installId: e.installId,
    decidedAt: e.decidedAtRaw, protocol: e.protocol, encodedPayload: e.encodedPayload,
  }, e.sig);
}

/**
 * Decode the payload of an envelope that has ALREADY been verified. The caller owes the
 * verification; this function cannot check it and does not pretend to — it is separate so the
 * ORDER is visible at the call site: a drain reads verify-then-decode in sequence, and an edit
 * removing the first line leaves an obviously unguarded second one rather than a silently
 * weakened single call. The result is STILL untrusted content: a verified signature proves the
 * record came from a key holder, nothing about whether the decoded object is a decision this
 * build can apply — `validateRequestPayload` answers that, after this.
 */
export function decodeRequestPayload(e: RequestEnvelope): RequestMessageRecord {
  const malformed = (reason: string): MalformedRequestRecord =>
    e.ref === undefined ? { malformed: true, reason } : { malformed: true, reason, ref: e.ref };
  let payload: unknown;
  try {
    payload = JSON.parse(b64urlDecode(e.encodedPayload));
  } catch {
    return malformed("unreadable payload");
  }
  return { ...e, payload };
}

// Layer 4b: acks — what the organizer said, carried back. Absence was the bug, and about truth
// rather than plumbing: the reader inferred `applied` from a record's absence, but an organizer
// removes a record for two opposite reasons — applied, or REFUSED — so a person who screened a
// sender out was told "done" whether their decision was carried out or thrown away. Absence is
// not evidence. The ack is: the organizer appends one naming the request and the OUTCOME, and the
// reader moves its row only on an ack it can read; a `sent` row with no ack stays `sent` until
// the stale window expires it. Signed, for the request's reason: a forged `applied` tells a
// person their Screener rule exists while the mail keeps arriving; a forged `refused` invites
// them to press again. One HMAC closes the return path.

const AH = {
  ack: "X-Ohmail-Ack",
  requestId: "X-Ohmail-Request-Id",
  mailboxId: "X-Ohmail-Request-Mailbox",
  outcome: "X-Ohmail-Ack-Outcome",
  reason: "X-Ohmail-Ack-Reason",
  ackedAt: "X-Ohmail-Ack-At",
  protocol: "X-Ohmail-Protocol",
  sig: "X-Ohmail-Ack-Sig",
} as const;

/**
 * WHY AN ORGANIZER SAID NO — a CLOSED set this codebase defines, never a sentence a payload
 * supplied. It reaches a person's screen through `pendingDecisions[]`, so an open vocabulary here
 * would be a stranger's text rendered in the product's own voice.
 */
export const REQUEST_REFUSAL_REASONS = [
  /** No signature, or one that does not verify under this account's key. A forgery, or a rotation. */
  "unauthenticated",
  /** The id is already spent by a record with DIFFERENT content — a reused id never applies. */
  "conflict",
  /** The record names another mailbox row the organizer's own store holds. */
  "wrong_mailbox",
  /** Verified, decoded, and not a decision this build can apply. */
  "invalid_payload",
  /** The wire format itself is broken — it says it is a request and then is not one. */
  "malformed",
  /** A kind with no applier here. Distinct from `malformed`: the record is well formed. */
  "unhandled_kind",
  /** Older than the window a reader would itself have expired it at. */
  "stale",
  /** The account has been erased; there is nothing left to apply it to. */
  "account_erased",
  /**
   * mail 0094. The record was valid, verified and understood, and the message it names is not in
   * THIS organizer's store — never synced here, or since deleted. Not an error and not a fault of
   * the record: two installs of one mailbox legitimately hold different subsets of it. It is a
   * refusal to the READER because the alternative is a record that quietly disappears, leaving
   * them unable to tell "done" from "never happened".
   */
  "no_such_message",
  /**
   * mail 0094. The destination was `trash` and this mailbox has no Trash folder discovered. ohmail
   * never expunges, so there is nowhere to put it and no default that would not be a lie about
   * where the mail went — the same refusal the organizer's own delete door gives.
   */
  "no_trash_folder",
  /**
   * mail 0094. An `update` or `delete` named a rule this organizer's store does not hold —
   * deleted here since, or never travelled. Not a fault of the record: named back so the person
   * is told, on `no_such_message`'s reasoning exactly.
   */
  "no_such_rule",
  /**
   * mail 0145. A move pressed a day or more before it reached the organizer, over a placement
   * decided here after the press. The newer decision stands and owns the sentence, so the waiting
   * list says nothing for it; `stale` keeps meaning a request older than the reader's window.
   */
  "superseded",
] as const;
export type RequestRefusalReason = (typeof REQUEST_REFUSAL_REASONS)[number];

export function isRequestRefusalReason(v: unknown): v is RequestRefusalReason {
  return typeof v === "string" && (REQUEST_REFUSAL_REASONS as readonly string[]).includes(v);
}

export const ACK_OUTCOMES = ["applied", "refused"] as const;
export type AckOutcome = (typeof ACK_OUTCOMES)[number];

export interface AckInput {
  requestId: string;
  /** The mailbox this answer belongs to. Signed, so an ack cannot be moved between mailboxes. */
  mailboxId: string;
  outcome: AckOutcome;
  /** Required for `refused`, and meaningless for `applied` — the formatter writes `""` for it. */
  reason?: RequestRefusalReason;
  ackedAt: Date;
  protocol?: number;
  key: string;
}

export interface AckRecord {
  requestId: string;
  mailboxId: string;
  outcome: AckOutcome;
  /** `null` on an `applied` ack, and on a `refused` one whose reason this build does not know. */
  reason: RequestRefusalReason | null;
  ackedAt: Date;
  protocol: number;
  ref?: unknown;
}

/** Does this message CLAIM to be an ack? The cheap negative, mirroring {@link isRequestRecord}. */
export function isAckRecord(raw: string): boolean {
  const headerBlock = raw.split(/\r?\n\r?\n/, 1)[0] ?? "";
  for (const line of headerBlock.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    if (line.slice(0, at).trim().toLowerCase() !== AH.ack.toLowerCase()) continue;
    return line.slice(at + 1).trim() === "1";
  }
  return false;
}

/**
 * DOES THE ACK HEADER CARRY `1` — the set the sweep's old `HEADER X-Ohmail-Ack 1` term matched
 * ({@link metaHeaderTerm}): a value CONTAINING it. Deliberately NOT {@link isAckRecord}, which
 * reads the value exactly: the sweep covers the records it always covered, on every provider.
 */
function hasAckHeader(raw: string): boolean {
  const headerBlock = raw.split(/\r?\n\r?\n/, 1)[0] ?? "";
  const want = metaHeaderTerm(AH.ack)[AH.ack]!;
  for (const line of headerBlock.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    if (line.slice(0, at).trim().toLowerCase() === AH.ack.toLowerCase() && line.slice(at + 1).includes(want)) {
      return true;
    }
  }
  return false;
}

/**
 * THE ACK COVERS ITS MAILBOX TOO, for the reason the request does.
 *
 * Without it an acknowledgement was portable between an account's mailboxes: copy a genuine record
 * for request X into mailbox A, let A's organizer refuse it `wrong_mailbox` and sign an ack for X,
 * then copy that ack into mailbox B's folder — where it verifies (same account key) and, arriving
 * at a lower uid than B's own answer, wins the reader's first-wins match. The person is shown a
 * refusal for a decision that WAS applied, presses again, and a second rule is written.
 */
function canonicalAck(f: {
  requestId: string; mailboxId: string; outcome: string; reason: string;
  ackedAt: string; protocol: number;
}): string {
  return [f.requestId, f.mailboxId, f.outcome, f.reason, f.ackedAt, String(f.protocol)]
    .map(canonicalField).join("");
}

/**
 * ONE RFC822 MESSAGE SAYING WHAT BECAME OF ONE REQUEST. Carries no payload and no copy of the
 * decision: a reader looking one up already holds the row, and repeating the decision here would
 * put a second copy of a customer's content in the folder for no reader that needs it.
 */
export function formatAck(a: AckInput): string {
  if (a.key === "") {
    throw new Error(
      `ack for ${a.requestId} cannot be written without the account's request key — an unsigned `
      + `ack is refused by every reader, so writing one would tell nobody anything`,
    );
  }
  const protocol = a.protocol ?? REQUEST_PROTOCOL;
  const requestId = headerSafe(a.requestId);
  const mailboxId = headerSafe(a.mailboxId);
  const reason = a.outcome === "refused" ? (a.reason ?? "malformed") : "";
  const ackedAt = a.ackedAt.toISOString();
  const sig = createHmac("sha256", a.key)
    .update(canonicalAck({ requestId, mailboxId, outcome: a.outcome, reason, ackedAt, protocol }), "utf8")
    .digest("base64url");
  const lines = [
    `${AH.ack}: 1`,
    `${AH.requestId}: ${requestId}`,
    `${AH.mailboxId}: ${mailboxId}`,
    `${AH.outcome}: ${a.outcome}`,
    `${AH.reason}: ${reason}`,
    `${AH.ackedAt}: ${ackedAt}`,
    `${AH.protocol}: ${protocol}`,
    `${AH.sig}: ${sig}`,
    `Subject: ohmail organizer acknowledgement`,
    `Date: ${a.ackedAt.toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    "",
    "The install that organizes this mailbox has answered a decision another install made. This",
    "message is bookkeeping and is cleaned up automatically.",
    "",
  ];
  return lines.join("\r\n");
}

/**
 * Read and verify an ack in one step — deliberately unlike the request path, and the asymmetry is
 * the point. A request splits parse-then-verify because the organizer must not decode a hostile
 * payload before trusting the record; an ack carries no payload, so there is no dangerous second
 * half to protect, and folding verification in means the reader's state machine cannot be handed
 * an unverified ack at all. Returns `null` for "not an ack" and "does not verify" alike: a reader
 * treats both as silence — an unverifiable ack is not evidence, and the `sent` row waits for a
 * real one or the stale window.
 */
export function parseAck(raw: string, key: string, ref?: unknown): AckRecord | null {
  const headerBlock = raw.split(/\r?\n\r?\n/, 1)[0] ?? "";
  const headers = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const line of headerBlock.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    headers.set(name, line.slice(at + 1).trim());
    seen.set(name, (seen.get(name) ?? 0) + 1);
  }
  const get = (k: string): string => headers.get(k.toLowerCase()) ?? "";
  const count = (k: string): number => seen.get(k.toLowerCase()) ?? 0;

  // DUPLICATES FIRST, then the discriminator — the order `parseClaim` and
  // `parseRequestEnvelope` both use. Reading the discriminator first meant a message carrying two
  // `X-Ohmail-Ack` headers resolved last-wins instead of being refused, so a record that
  // contradicts itself could still be read as an outcome.
  for (const f of [AH.ack, AH.requestId, AH.mailboxId, AH.outcome, AH.reason, AH.ackedAt, AH.protocol, AH.sig]) {
    if (count(f) > 1) return null;
  }
  if (get(AH.ack) !== "1") return null;

  const requestId = get(AH.requestId);
  if (!requestId || requestId.length > 128) return null;
  const mailboxId = get(AH.mailboxId);
  if (!mailboxId || mailboxId.length > 128) return null;
  const outcome = get(AH.outcome);
  if (outcome !== "applied" && outcome !== "refused") return null;
  const reason = get(AH.reason);
  if (reason.length > 64) return null;
  const ackedAtRaw = get(AH.ackedAt);
  const ackedAt = new Date(ackedAtRaw);
  if (Number.isNaN(ackedAt.getTime())) return null;
  const protocolRaw = get(AH.protocol);
  const protocol = Number(protocolRaw);
  if (!protocolRaw || !Number.isFinite(protocol) || protocol < 1) return null;

  const sig = get(AH.sig);
  if (key === "" || sig === "") return null;
  let expected: Buffer;
  let given: Buffer;
  try {
    expected = Buffer.from(
      createHmac("sha256", key)
        .update(canonicalAck({ requestId, mailboxId, outcome, reason, ackedAt: ackedAtRaw, protocol }), "utf8")
        .digest("base64url"),
      "base64url",
    );
    given = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (expected.length !== given.length || expected.length === 0) return null;
  if (!timingSafeEqual(expected, given)) return null;

  const record: AckRecord = {
    requestId,
    mailboxId,
    outcome,
    // An unrecognised reason becomes `null` rather than being carried through as a string: it
    // would otherwise reach a person's screen, and this vocabulary is the product's own.
    reason: isRequestRefusalReason(reason) ? reason : null,
    ackedAt,
    protocol,
  };
  return ref === undefined ? record : { ...record, ref };
}

/**
 * WHICH REQUEST OPERATION FAILED. Mirrors {@link LeaseOp} and for the same reason: a catch that
 * wraps more than one IMAP command must name which one threw.
 */
export type RequestOp =
  | "list_requests"
  | "append_request"
  | "remove_requests"
  /**
   * SEARCH + EXPUNGE the acknowledgements past their life. Its own op rather than
   * {@link remove_requests} because the two fail for different reasons and an operator reading
   * "requests could not be removed" would go looking at the drain: this is the COMPACTOR, the only
   * thing that ever makes `ohmail/_meta` smaller, and a folder that stops shrinking is the fault
   * worth naming on its own.
   */
  | "sweep_acks"
  /**
   * COPY + EXPUNGE the records that have fallen out of the claim read's reach. Its own op beside
   * {@link sweep_acks} because the two answer different questions about the same folder — one is
   * "is it too big", the other "is it too deep" — and only the second is fixed by moving records
   * nobody wants removed.
   */
  | "compact_meta"
  | "no_request_io";

export class RequestUnavailableError extends Error {
  readonly op: RequestOp;
  /**
   * WHICH refusal this is, in the one slot a log line carries without the message. The hardened
   * logger reads `name` and `code` off a thrown value and never its text, so a refusal that wants
   * to be greppable has to spell itself here; the sentence stays for a person reading a stack.
   * Optional because most refusals of one op have one cause — this exists for the sweep, whose
   * two forms fail for different reasons and need telling apart in production.
   */
  readonly code?: string;
  constructor(message: string, options: { op: RequestOp; code?: string; cause?: unknown }) {
    super(message, options);
    this.name = "RequestUnavailableError";
    this.op = options.op;
    if (options.code !== undefined) this.code = options.code;
  }
}

/**
 * The folder, read once — and the two ROLES that read it. One read, two parsers: {@link
 * listMetaRecords} sorts one read into its kinds, so a fourth record type costs no round trip.
 * The read underneath is the one door every reader takes ({@link readMetaRecords}): complete past
 * the 500-record window, or refused by name. And two objects,
 * because a reader must not be able to expunge: a READER appends and never removes; an ORGANIZER
 * removes and appends acks. One object made the expunge reachable from the reader's accessor; two
 * types, and the compiler says so.
 */
export interface RawMetaMessage {
  ref: unknown;
  raw: string;
  /** See {@link RawClaimMessage.internalDate} — the server's own clock, where it reports one. */
  internalDate?: Date | null;
}

/**
 * THE WINDOW: how many records one window FETCH of `ohmail/_meta` takes. A WIRE FACT, not a
 * tunable: builds up to 0.25.4 read claims by this window and refuse past it as `meta_folder_full`.
 * Past it this build enumerates the whole folder ({@link readMetaRecords}); nothing is decided from
 * a window that came back short.
 */
export const META_RECORDS_MAX_PER_FETCH = 500;

/**
 * HOW MANY RECORDS ONE PRESS MAY BECOME. A press that moves N messages on a mailbox this install
 * only reads writes N records under one key, and the reader's cycle appends them inside its own
 * headroom ({@link requestAppendHeadroom}) — so the folder cannot be driven over a ceiling by a
 * long queue whatever this says. What this bounds is the QUEUE: a press asking
 * for more records than one readable folder could ever hold is a press whose tail would sit
 * pending across cycles with nothing to show for it, and the door refuses it at the press where
 * the count is known rather than emitting the flood and hoping. Derived from the ceiling so the
 * two cannot drift.
 */
export const REQUEST_SET_MAX = META_RECORDS_MAX_PER_FETCH;


/**
 * THE HEADER BYTES ONE FORMATTED REQUEST MAY TAKE, at {@link REQUEST_PAYLOAD_MAX_BYTES} of payload.
 * A test over {@link formatRequest} holds the bound; the reader's byte headroom is counted in it.
 */
export const REQUEST_RECORD_MAX_BYTES = 6 * 1024;

/** The reserve each byte ceiling keeps for one window of appended requests. */
const REQUEST_APPEND_BYTE_RESERVE = META_RECORDS_MAX_PER_FETCH * REQUEST_RECORD_MAX_BYTES;
for (const [key, ceiling] of [["TF_IMAP_META_MAX_BYTES", IMAP_META_BYTES_MAX], ["TF_IMAP_META_ENUM_MAX_BYTES", META_ENUM_BYTES_MAX]] as const) {
  if (REQUEST_APPEND_BYTE_RESERVE >= ceiling) {
    throw new ImapBoundConfigError(key, `${key} must exceed the ${REQUEST_APPEND_BYTE_RESERVE}-byte reserve one window of requests needs`);
  }
}

/**
 * WHAT A READER LEAVES THE HOLDER INSIDE THE WINDOW, in records and at the per-record byte bound:
 * a renewal is appended before the old claim goes, so a folder filled to exactly the window was
 * crossed by the holder's own next renewal (META-WINDOW-HOLDS-NOTHING-BACK-FOR-THE-HOLDER). It
 * replaces the whole window of bytes the reserve used to charge on top of every append
 * (META-WINDOW-BYTE-RESERVE-CHARGED-TWICE).
 */
export const META_HOLDER_RESERVE_RECORDS = 16;

/**
 * HOW MANY REQUESTS A READER MAY APPEND THIS CYCLE, and which ceiling bound it. THE MIXED-FLEET
 * RULE is the invariant: at or under the window, this install's appends never take the folder past
 * {@link META_RECORDS_MAX_PER_FETCH} records or the window's byte ceiling, which is what builds up to
 * 0.25.4 read claims by, less {@link META_HOLDER_RESERVE_RECORDS} for the holder; past the window
 * those builds are blind already and the bound is the enumeration's, less one window kept for the
 * holder's own acks and renewals.
 */
export function requestAppendHeadroom(read: { count: number; bytes: number }): {
  headroom: number; boundBy: "records" | "bytes" | null; recordCeiling: number; byteCeiling: number;
} {
  const window = META_RECORDS_MAX_PER_FETCH;
  const inWindow = read.count <= window;
  const recordCeiling = inWindow ? window - META_HOLDER_RESERVE_RECORDS : META_ENUM_RECORDS_MAX - window;
  const byteCeiling = inWindow
    ? IMAP_META_BYTES_MAX - META_HOLDER_RESERVE_RECORDS * REQUEST_RECORD_MAX_BYTES
    : META_ENUM_BYTES_MAX - REQUEST_APPEND_BYTE_RESERVE;
  const byRecords = Math.max(0, recordCeiling - read.count);
  const byBytes = Math.max(0, Math.floor((byteCeiling - read.bytes) / REQUEST_RECORD_MAX_BYTES));
  const headroom = Math.min(window, byRecords, byBytes);
  const boundBy = headroom >= window ? null : byBytes < byRecords ? "bytes" : "records";
  return { headroom, boundBy, recordCeiling, byteCeiling };
}

/**
 * DID THE GATE'S READ SEE THE FOLDER WHERE A KEYLESS ORGANIZER MUST SHRINK IT: past the window, or
 * inside the holder's reserve below it in records or bytes. A reader's appends stop there too.
 */
export function metaNearCeiling(read: { count: number; bytes: number; enumerated: unknown }): boolean {
  if (read.enumerated !== null) return true;
  return read.count >= META_RECORDS_MAX_PER_FETCH - META_HOLDER_RESERVE_RECORDS
    || read.bytes >= IMAP_META_BYTES_MAX - META_HOLDER_RESERVE_RECORDS * REQUEST_RECORD_MAX_BYTES;
}

/** One complete read of the folder: the request and ack records, and the folder's size. */
export interface MetaRecordsList {
  records: RawMetaMessage[];
  /** The folder's message count — every record, not only the ones listed. */
  count: number;
  /** The header bytes of every record in the folder. */
  bytes: number;
}

/** The shared read: the folder's request and ack records, complete or refused. */
export interface MetaRecordsIo {
  /** Every request and ack in `ohmail/_meta`, through {@link readMetaRecords}. */
  listMetaRecords(): Promise<MetaRecordsList>;
}

/** WHAT A READER MAY DO to `ohmail/_meta`: look, and append its own decisions. Nothing else. */
export interface RequestReaderIo extends MetaRecordsIo {
  /** APPEND one decision. Does NOT create `ohmail/_meta` — see {@link makeRequestReaderIo}. */
  append(raw: string): Promise<void>;
}

/** WHAT AN ORGANIZER MAY DO: look, acknowledge what it handled, and remove what it is done with. */
export interface RequestOrganizerIo extends MetaRecordsIo {
  /**
   * THE FOLDER'S UID GENERATION, so a caller's remembered position can be checked against it.
   *
   * Optional, and the absence resolves the safe way: a caller that cannot learn the generation
   * treats every remembered position as unusable and walks from the top, which costs a re-walk
   * and can never act on a position from a numbering that no longer exists.
   */
  uidValidity?(): number | bigint | null;
  /** APPEND one ack record saying what became of one request. */
  ack(raw: string): Promise<void>;
  /** STORE `\Deleted` + EXPUNGE the given messages, in ONE round trip. */
  remove(refs: readonly unknown[]): Promise<void>;
  /**
   * Expunge every ack older than the cutoff, WITHOUT reading the folder first: the sweep is the only
   * thing that makes `ohmail/_meta` smaller, and behind the bounded read a folder past the ceiling
   * could never come back down. Uid windows by FETCH (header and INTERNALDATE, never SEARCH),
   * bounded per window and per pass; this install's own claims older than the cutoff go in the same
   * walk. `{ staleAfterMs }` dates the cutoff by the folder's newest INTERNALDATE, the server's clock
   * (SWEEP-CUTOFF-READS-THE-HOST-CLOCK) — the hosts' form; a `Date` is taken as given. Returns how
   * many were removed.
   */
  sweepStaleAcks?(before: Date | SweepClock): Promise<number>;
  /**
   * MOVE THE FOLDER'S RECORDS BACK INSIDE THE WALK — what the sweep cannot do. The sweep makes
   * `ohmail/_meta` SMALLER; nothing made it SHALLOWER, so the span between its lowest record and
   * the top of its uid space passes {@link SEARCH_WALK_SPAN} and every gate refuses.
   *
   * The organizer copies its old records into the same folder, where they get uids at the top, and
   * expunges the originals: same bytes, flags and INTERNALDATE, new number. UNDER THE LEASE — a
   * live claim of ours, read in the same lock — refusing on a generation that moved, never
   * expunging what `COPYUID` did not name. 0 is the ordinary answer and costs one probe.
   */
  compactMeta?(now: Date): Promise<number>;
}

/**
 * The parser registry — one discriminator per kind: the module header's table as data, so a fifth
 * record type is ONE ENTRY plus a parser rather than a fourth hand-written predicate — which is
 * how the third went wrong: `isRequestRecord` answered on the first occurrence while the parser
 * refused duplicates, leaving a class of message permanently unremovable. The `match` functions
 * are the EXISTING predicates, deliberately: each differs on a repeated discriminator, and each
 * difference was argued at its parser — a uniform reader would quietly re-decide all three.
 * `profile` is listed with no matcher: `organizer-profile.ts` owns that format; listing it keeps
 * the count four everywhere.
 */
export type MetaRecordKind = "claim" | "request" | "ack" | "profile";

export interface MetaRecordKindSpec {
  kind: MetaRecordKind;
  /** The header whose presence declares the kind. */
  header: string;
  /** Does this raw record declare this kind? `null` for a kind another module owns. */
  match: ((raw: string) => boolean) | null;
}

export const META_RECORD_KINDS: readonly MetaRecordKindSpec[] = [
  // A claim's matcher is the PARSER, which is the strongest form this table can take: `parseClaim`
  // answers `null` for "not a claim" and a MALFORMED claim for "says it is one and cannot be read",
  // so the two cannot disagree about a duplicated discriminator by construction. The other two
  // reached that same rule the long way, through a defect each.
  { kind: "claim", header: H.lease, match: (raw: string): boolean => parseClaim(raw) !== null },
  { kind: "request", header: RH.request, match: isRequestRecord },
  { kind: "ack", header: AH.ack, match: isAckRecord },
  // Owned by `organizer-profile.ts` — see the registry's docblock.
  { kind: "profile", header: "X-Ohmail-Profile", match: null },
];

/**
 * WHICH KIND IS THIS RECORD, or `null` for one this build does not recognise.
 *
 * `null` is a real answer and the common one: somebody else's mail client may keep something in
 * this folder, and a record we cannot name is not ours to parse, count or destroy.
 */
export function classifyMetaRecord(raw: string): MetaRecordKind | null {
  for (const spec of META_RECORD_KINDS) {
    if (spec.match !== null && spec.match(raw)) return spec.kind;
  }
  return null;
}

/** Every message in the folder that says it is a request, envelope-parsed. */
export function requestEnvelopesIn(
  records: readonly RawMetaMessage[],
): RequestEnvelopeRecord[] {
  const out: RequestEnvelopeRecord[] = [];
  for (const m of records) {
    if (classifyMetaRecord(m.raw) !== "request") continue;
    const parsed = parseRequestEnvelope(m.raw, m.ref);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

/** Every message in the folder that says it is an ack AND verifies under this account's key. */
export function acksIn(records: readonly RawMetaMessage[], key: string): AckRecord[] {
  const out: AckRecord[] = [];
  for (const m of records) {
    if (classifyMetaRecord(m.raw) !== "ack") continue;
    const parsed = parseAck(m.raw, key, m.ref);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

/**
 * The shared read — `ohmail/_meta` through {@link readMetaRecords}, keeping requests and acks: the
 * drains sort one read into its kinds with {@link requestEnvelopesIn} and {@link acksIn}. No probe:
 * a blind read yields no request, applies nothing and removes nothing, and a reader's re-append is
 * idempotent by key. An absent folder THROWS: answering `[]` read to a reader as "the organizer took
 * every decision" at the moment nobody was organizing. A refusal is {@link RequestUnavailableError}
 * carrying the enumeration's code; the reader transitions nothing.
 */
function makeMetaRecordsList(
  client: LeaseImapClient,
  meta: MetaFolderRef,
  op: RequestOp,
  /**
   * REPORTS THE GENERATION OF THE FOLDER THIS READ ACTUALLY OPENED, sampled while it is still
   * selected — never `client.mailbox` afterwards, which names whatever folder the cycle selected
   * last (the INBOX, for the worker).
   */
  onGeneration?: (generation: Generation) => void,
  /** The clock the read's budget reads — see {@link makeLeasePeekIo}. */
  now: () => number = Date.now,
): () => Promise<MetaRecordsList> {
  return async (): Promise<MetaRecordsList> => {
    const budget = metaReadBudget(now);
    let at: MetaFolderLocation;
    try {
      at = await meta.locate(budget);
    } catch (err) {
      throw new RequestUnavailableError(
        `${META_FOLDER} could not be located`, { op, cause: err },
      );
    }
    if (at.row === null) {
      throw new RequestUnavailableError(
        `${META_FOLDER} does not exist, so nothing in it can be read`, { op },
      );
    }
    try {
      const lock = await lockWithin(client, at.path, budget);
      try {
        const read = await readMetaRecords(client, at.path, budget, {
          keep: (h) => {
            const kind = classifyMetaRecord(h);
            return kind === "request" || kind === "ack";
          },
          probe: null,
        });
        onGeneration?.(read.generation);
        return { records: read.records, count: read.count, bytes: read.bytes };
      } finally {
        lock.release();
      }
    } catch (err) {
      if (err instanceof RequestUnavailableError) throw err;
      // NAMED: the two drains log the message, and a full folder is not a mail-server fault.
      if (err instanceof MetaEnumRefusedError) {
        throw new RequestUnavailableError(enumRefusalMessage(err), { op, code: err.code, cause: err });
      }
      throw new RequestUnavailableError(
        `the records in ${META_FOLDER} could not be read`, { op, cause: err },
      );
    }
  };
}

/**
 * The reader's half — look, and append its own decisions. It never creates `ohmail/_meta`: a
 * request is offered to a reader only while a holder's claim advertises {@link
 * CAPABILITY_REQUESTS} and `organizer_state='held'`, which is only true once an organizer has run
 * `ensureMetaFolder()` — so by the time `append` is called the folder exists, and creating it
 * here would be a write this object has no standing to make: a reader that could conjure the
 * organizer's folder is one step from conjuring a claim into it. There is no `remove` on this
 * object and that is the point — see {@link RequestReaderIo}.
 */
export function makeRequestReaderIo(
  client: LeaseImapClient, toServerPath: (canonical: string) => string,
): RequestReaderIo {
  const meta = makeMetaFolderRef(client, toServerPath);
  return {
    listMetaRecords: makeMetaRecordsList(client, meta, "list_requests"),
    async append(raw: string): Promise<void> {
      try {
        await client.append(await meta.path(), raw, ["\\Seen"]);
      } catch (err) {
        throw new RequestUnavailableError(
          `a decision could not be appended to ${META_FOLDER}`,
          { op: "append_request", cause: err },
        );
      }
    },
  };
}

/**
 * THE ORGANIZER'S HALF — look, acknowledge, and remove what it has handled.
 *
 * `ack` and `append` are the same IMAP verb on the same folder and are deliberately NOT one
 * method: what may be written differs by role, and a single `append(raw)` shared by both objects
 * would make a reader's accessor capable of writing an organizer's acknowledgement. The name is
 * the boundary the type system can actually hold.
 */
/**
 * THE STALE ACKS IN ONE UID WINDOW, READ BY FETCH — the window's headers and INTERNALDATE, keyed
 * on the ack header carrying `1` and a server stamp below a cutoff already floored to midnight.
 * Never a SEARCH: a server whose header search answers nothing (or refuses it, iCloud's compound
 * term) would otherwise report "none stale" and the one thing that shrinks this folder would stop.
 * The same walk takes THIS install's own well-formed claims below the same cutoff: a claim of ours
 * a day old is residue whoever wrote it (a live sibling under a shared id renews every cycle).
 * Never another install's claim, a request, the settings document, or mail with no discriminator.
 */
async function staleAckUidsInWindow(
  client: Pick<LeaseImapClient, "fetch">, lo: number, hi: number, before: Date, installId: string,
): Promise<Array<{ uid: number; claim: boolean }>> {
  const read = await boundedFetch(
    client.fetch(`${lo}:${hi}`, { uid: true, headers: true, internalDate: true }, { uid: true }),
    {
      max: META_RECORDS_MAX_PER_FETCH,
      bytes: { max: IMAP_META_BYTES_MAX, of: (m) => m.headers?.byteLength ?? 0 },
      bound: "page_rows",
      map: (m): { uid: number; claim: boolean } | null => {
        if (typeof m.uid !== "number" || m.headers === undefined) return null;
        /* A record the server stamped no date on cannot be shown to be past the cutoff, and the
         * safe direction for something that expunges is to leave it. */
        if (!(m.internalDate instanceof Date)) return null;
        if (m.internalDate.getTime() >= before.getTime()) return null;
        const h = m.headers.toString("utf8");
        if (hasAckHeader(h)) return { uid: m.uid, claim: false };
        const c = parseClaim(h);
        return c !== null && !isMalformed(c) && c.installId === installId ? { uid: m.uid, claim: true } : null;
      },
    },
  );
  return read.items.filter((u): u is { uid: number; claim: boolean } => u !== null);
}

/** The hosts' sweep clock: the stale window, this host's now, and whether the gate refused a full folder. */
export interface SweepClock {
  staleAfterMs: number;
  now: Date;
  /** The lease-refused arm: nothing appends, so the folder's newest date may be frozen. */
  refused?: boolean;
}

const monoNowMs = (): number | null => {
  const p = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof p?.now === "function" ? p.now() : null;
};

/**
 * THE SWEEP'S CUTOFF, from the server's clock (SWEEP-CUTOFF-READS-THE-HOST-CLOCK, with its
 * SAFETY and PROGRESS invariants). Server-now is the folder's newest INTERNALDATE, capped by our own newest claim's
 * INTERNALDATE plus the time elapsed since we wrote it (monotonic when this process wrote it), so a
 * future-dated record cannot reach a live claim of ours. On the refused arm that same estimate is
 * a floor, so a frozen folder still shrinks; read off the wall clock it is capped a window behind
 * this host's now, so a clock up to a window ahead cannot take a claim younger than the window.
 * Our own claims are swept only where our newest claim was located.
 */
async function sweepCutoff(
  client: LeaseImapClient, path: string, identity: MetaIdentity, clock: SweepClock,
): Promise<{ before: Date; floor: number | null; ownClaims: boolean } | null> {
  const newest = await newestInternalDate(client, path);
  if (newest === null) return null;
  const stale = clock.staleAfterMs;
  const hostNow = clock.now.getTime();
  const own = await ownNewestClaim(client, path, identity);
  let estimate: number | null = null;
  let exact = false;
  if (own !== null) {
    exact = own.writtenMonoMs !== null;
    const mono = monoNowMs();
    const elapsed = exact && mono !== null ? mono - own.writtenMonoMs! : hostNow - own.heartbeat;
    estimate = own.internalDate + Math.max(0, elapsed);
  }
  /* Unanchored by a claim of ours, a refused folder's newest date is capped a window behind this
     host's now too: nothing else bounds a future-dated record there. */
  const serverNow = estimate !== null ? Math.min(newest.getTime(), estimate)
    : clock.refused === true ? Math.min(newest.getTime(), hostNow - stale) : newest.getTime();
  let floor: number | null = null;
  if (clock.refused === true) {
    const fromOwn = estimate === null ? hostNow - stale : exact ? estimate : Math.min(estimate, hostNow - stale);
    floor = fromOwn - stale;
  }
  return { before: new Date(serverNow - stale), floor, ownClaims: own !== null || clock.refused === true };
}

/** Our newest claim by INTERNALDATE: the one the gate remembers writing, else the top window's. */
async function ownNewestClaim(
  client: LeaseImapClient, path: string, identity: MetaIdentity,
): Promise<{ internalDate: number; heartbeat: number; writtenMonoMs: number | null } | null> {
  if (typeof client.fetch !== "function") return null;
  const held = readMemo(identity, generationOf(client));
  const memo = held.kind === "memo" ? held.memo : null;
  const read = async (range: string): Promise<Array<{ uid: number; internalDate: number; heartbeat: number }>> => {
    const page = await boundedFetch(client.fetch(range, { uid: true, headers: true, internalDate: true }, { uid: true }), {
      max: META_RECORDS_MAX_PER_FETCH, onOverflow: "stop", bound: "page_rows",
      bytes: { max: IMAP_META_BYTES_MAX, of: (m) => m.headers?.byteLength ?? 0 },
      map: (m): { uid: number; internalDate: number; heartbeat: number } | null => {
        if (typeof m.uid !== "number" || m.headers === undefined || !(m.internalDate instanceof Date)) return null;
        const c = parseClaim(m.headers.toString("utf8"));
        if (c === null || isMalformed(c) || c.installId !== identity.installId) return null;
        return { uid: m.uid, internalDate: m.internalDate.getTime(), heartbeat: c.heartbeat.getTime() };
      },
    });
    return page.items.filter((x): x is { uid: number; internalDate: number; heartbeat: number } => x !== null);
  };
  const newestOf = (rows: Array<{ uid: number; internalDate: number; heartbeat: number }>) =>
    rows.reduce<(typeof rows)[number] | null>((a, r) => (a === null || r.internalDate > a.internalDate ? r : a), null);
  if (typeof memo?.claimUid === "number") {
    const hit = newestOf(await read(String(memo.claimUid)));
    if (hit !== null) {
      const mono = typeof memo.claimWrittenMonoMs === "number" ? memo.claimWrittenMonoMs : null;
      return { internalDate: hit.internalDate, heartbeat: hit.heartbeat, writtenMonoMs: mono };
    }
  }
  const top = await highestUid(client, path);
  if (top === null) return null;
  const hit = newestOf(await read(`${Math.max(1, top - SEARCH_UID_WINDOW + 1)}:${top}`));
  return hit === null ? null : { internalDate: hit.internalDate, heartbeat: hit.heartbeat, writtenMonoMs: null };
}

/**
 * THE SERVER'S CLOCK, AS THE FOLDER SHOWS IT: the INTERNALDATE of its newest message, by sequence.
 * `null` for an empty folder (nothing to sweep); a reply with no stamp refuses, because a cutoff
 * nobody can read must not fall back to this host's clock.
 */
async function newestInternalDate(client: LeaseImapClient, path: string): Promise<Date | null> {
  const count = await lastSequence(client, path);
  if (count === 0) return null;
  if (count === undefined || typeof client.fetch !== "function") {
    throw new RequestUnavailableError(
      `${META_FOLDER} gave no count, so its newest record could not be dated and nothing was swept`,
      { op: "sweep_acks", code: "sweep_no_clock" },
    );
  }
  const page = await boundedFetch(client.fetch(String(count), { uid: true, internalDate: true }, { uid: false }), {
    max: 1, onOverflow: "stop", bound: "page_rows",
    map: (m): Date | null => (m.internalDate instanceof Date ? m.internalDate : null),
  });
  const at = page.items.find((d): d is Date => d !== null);
  if (at === undefined) {
    throw new RequestUnavailableError(
      `${META_FOLDER}'s newest record carried no server date, so nothing was swept`,
      { op: "sweep_acks", code: "sweep_no_clock" },
    );
  }
  return at;
}

export function makeRequestOrganizerIo(
  client: LeaseImapClient,
  toServerPath: (canonical: string) => string,
  identity: MetaIdentity,
  /** The path this login already resolved — see {@link MetaPathSeed}. */
  seed?: MetaPathSeed,
): RequestOrganizerIo {
  assertMetaIdentity("makeRequestOrganizerIo", identity);
  const meta = makeMetaFolderRef(client, toServerPath, seed);
  let metaGeneration: Generation = null;
  return {
    listMetaRecords: makeMetaRecordsList(client, meta, "list_requests", (g) => { metaGeneration = g; }),

    /**
     * THE GENERATION OF THE META FOLDER THIS IO HAS ACTUALLY READ — `null` until it has read one.
     *
     * Not `client.mailbox` at the moment of asking: that describes whatever folder the surrounding
     * cycle last selected, which for the worker is the mailbox being synced. Pairing a position in
     * `ohmail/_meta` with the INBOX's generation is not a stale check, it is a check against
     * another folder, and it answers wrongly in both directions — it will call a good position
     * stale, and a stale one good.
     */
    uidValidity(): Generation {
      return metaGeneration;
    },

    /**
     * See {@link RequestOrganizerIo.sweepStaleAcks}. Acks match, and this install's own claims —
     * never a request, another install's claim or the settings document — and `before` is
     * compared against the server's INTERNALDATE, never a header.
     */
    async sweepStaleAcks(cutoff: Date | SweepClock): Promise<number> {
      const metaPath = await meta.path();
      const lock = await client.getMailboxLock(metaPath);
      try {
        let before: Date;
        let ownClaims = true;
        let unfloored: number | null = null;
        if (cutoff instanceof Date) {
          before = cutoff;
        } else {
          const at = await sweepCutoff(client, metaPath, identity, cutoff);
          if (at === null) return 0;
          before = at.before;
          ownClaims = at.ownClaims;
          unfloored = at.floor;
        }
        if (typeof client.fetch !== "function") {
          throw new RequestUnavailableError(
            `${META_FOLDER} cannot be fetched by this connection, so stale acknowledgements cannot `
            + "be identified and none were removed",
            { op: "sweep_acks", code: "sweep_no_reader" },
          );
        }
        /* The cutoff is floored to a day boundary, the set the SEARCH form reached, and the only
           error it leaves is on the safe side: keeping a record too long costs one row in a folder
           swept again next cycle; removing a live one loses an answer somebody is waiting for. */
        /* The refused arm's floor is exact, not floored: its own bound already keeps it a window
           clear of any claim this host could have written in the last window. */
        const floored = new Date(Math.max(ackSweepCutoff(before).getTime(), unfloored ?? -Infinity));
        /* WINDOWED. The ceiling comes from the server, never the connection's cached mailbox
         * object: a stale ceiling puts every window below the records that matter. Without one
         * there is no window to read, and this module has one answer for that. */
        const top = await highestUid(client, metaPath);
        if (top === null) {
          throw new RequestUnavailableError(
            `${META_FOLDER} reported no usable UIDNEXT, so stale acknowledgements could not be `
            + "searched for within a bounded window and none were removed",
            { op: "sweep_acks" },
          );
        }
        /* Enough uids to fill this cycle's expunges and no more: looking further down costs
         * round trips for records the budget below cannot delete this time round anyway. */
        const wanted = SWEEP_DELETE_BATCH * SWEEP_BATCHES_MAX_PER_CYCLE;
        const found: Array<{ uid: number; claim: boolean }> = [];
        let reachedBottom = false;
        let resumeBelow: number | null = null;
        /* Resume beneath the last pass's stopping point. A cursor above the current ceiling is
         * meaningless — the folder has been renumbered or replaced — so the top wins. */
        const sweepGeneration = generationOf(client);
        const held = readMemo(identity, sweepGeneration);
        const resumeAt = held.kind === "memo" ? held.memo.sweepCursor : undefined;
        let hi = resumeAt !== undefined && resumeAt < top ? resumeAt : top;
        for (let w = 0; w < SWEEP_SEARCH_WINDOW_BUDGET; w++) {
          const lo = Math.max(1, hi - SEARCH_UID_WINDOW + 1);
          found.push(...(await staleAckUidsInWindow(client, lo, hi, floored, identity.installId))
            .filter((f) => ownClaims || !f.claim));
          /* ── WHERE THIS PASS WOULD RESUME, DECIDED NOW AND WRITTEN LATER ────────────────
           *
           * Moving the mark here — before a single record has been removed — claims the stretch
           * above it is dealt with while it demonstrably is not. Two ways that goes wrong, and the
           * first happens on an ordinary pass: the walk may return up to a window more than the
           * delete budget, so the surplus is left ABOVE a mark that says not to look there again.
           * The second is worse: an expunge the server refuses throws, and the mark would already
           * have moved past everything the pass had merely LOOKED at. */
          if (lo === 1) { reachedBottom = true; break; }
          if (found.length >= wanted) { resumeBelow = lo - 1; break; }
          hi = lo - 1;
          resumeBelow = hi;
        }
        /* ── A PASS THAT FOUND NOTHING STILL COVERED ITS STRETCH ────────────────────────────
         *
         * Nothing to remove is the vacuous case of "everything found was removed", so the mark
         * moves and the next pass goes deeper. Returning here without moving it was how the
         * deferral broke the walk: a folder whose stale acknowledgements all sit below a long run
         * of ordinary mail produces empty pass after empty pass, and each one would have started
         * from the same place. A guard written for exactly that walk caught it. */
        const markProgress = (): void => {
          if (reachedBottom) forgetMemo(identity, "sweepCursor");
          else if (resumeBelow !== null) writeMemo(identity, sweepGeneration, { sweepCursor: resumeBelow });
        };
        if (found.length === 0) { markProgress(); return 0; }
        /**
         * Swept in bounded batches, because the set is as large as the folder got. One expunge
         * over the whole matching set grows with the mess it exists to clear: thousands of stale
         * acks produce a command a provider can refuse outright, the refusal leaves every one
         * standing, the folder stays over the ceiling, the bounded read refuses — and the only
         * thing that could shrink it is the command that just failed. {@link SWEEP_DELETE_BATCH}
         * uids per expunge, each batch proved gone before the next; a failing batch throws with
         * earlier batches already removed, so the folder is smaller either way. Progress that
         * survives a failure is the property this needs.
         */
        /**
         * Two bounds, and they bound different things: `wanted` stops the WALK once it holds a
         * cycle's worth; this clamps what is DELETED. They are not the same number — the walk
         * tests its total only after pushing a whole window, so a walk one short of `wanted`
         * takes another full window and returns up to `SEARCH_UID_WINDOW - 1` more than asked;
         * deleting all of it is a cycle half again as long as promised. Reasoning they were equal
         * is how this clamp was removed once already; the mutation that should have caught it was
         * green because the fixture's windows summed to exactly `wanted` — a fixture that aligns
         * is not a property.
         */
        let swept = 0;
        const budget = Math.min(found.length, SWEEP_DELETE_BATCH * SWEEP_BATCHES_MAX_PER_CYCLE);
        /* A PROVEN refusal counts toward the cleanup streak, aimed at one of our own claims where
           the batch holds one; a landed batch resets it; a dead socket or an unreadable read-back
           does neither (the renew's rule, {@link noteCleanupOutcome}). */
        const refused = (batch: ReadonlyArray<{ uid: number; claim: boolean }>): void => {
          noteCleanupOutcome(identity, {
            landed: false, uid: batch.find((f) => f.claim)?.uid ?? null, generation: sweepGeneration,
          });
        };
        for (let i = 0; i < budget; i += SWEEP_DELETE_BATCH) {
          const picked = found.slice(i, Math.min(i + SWEEP_DELETE_BATCH, budget));
          const batch = picked.map((f) => f.uid);
          const done = await client.messageDelete(batch, { uid: true });
          if (done === false && !connectionGone(client)) refused(picked);
          if (done === false) {
            throw new RequestUnavailableError(
              `the server refused to expunge ${batch.length} stale acknowledgement(s) from `
              + `${META_FOLDER} (${swept} already removed on this pass)`,
              { op: "sweep_acks" },
            );
          }
          /* And a `true` proves only that a command ran — the claim path's rule, for the same
           * reason. Reporting a sweep that removed nothing is how a permanently full folder gets
           * mistaken for one that is being kept in trim. */
          const after = await custodyOf(client, batch);
          if (after.kind === "unreadable") {
            throw new LeaseUnavailableError(goneUnverified(batch.length, "stale acknowledgement(s)", after.err), { op: "sweep_acks" });
          }
          if (after.kind === "standing") {
            refused(picked);
            throw new LeaseUnavailableError(goneSurvived(after.uids.length, "stale acknowledgement(s)"), { op: "sweep_acks" });
          }
          noteCleanupOutcome(identity, { landed: true });
          swept += batch.length;
        }
        /* ── ONLY NOW, AND ONLY OVER WHAT WAS ACTUALLY REMOVED ──────────────────────────────
         *
         * Every batch above is proved gone before the next is attempted, so reaching here means
         * the whole of `budget` really left the folder. If the walk found MORE than the budget
         * could delete, the surplus is still up there and the mark must not move past it — the
         * next pass re-covers the same stretch and finds it shorter, which is what durable
         * progress looks like. A throw anywhere above leaves the mark exactly where it was. */
        if (swept >= found.length) markProgress();
        return swept;
      } finally {
        lock.release();
      }
    },

    /** See {@link RequestOrganizerIo.compactMeta}. */
    async compactMeta(now: Date): Promise<number> {
      const metaPath = await meta.path();
      const lock = await client.getMailboxLock(metaPath);
      try {
        /* ── IS ANYTHING OWED? ONE PROBE, AND USUALLY THE WHOLE ANSWER ─────────────────────
         *
         * The span is the top of the uid space less the lowest record the folder still holds, and
         * both come from the SERVER. An honest folder answers `0` here for its whole life: this
         * costs a STATUS and a one-row FETCH per drain and does nothing. */
        const top = await highestUid(client, metaPath);
        const bottom = await folderBottomUid(client);
        if (top === null || bottom === null) return 0;
        if (top - bottom < SEARCH_WALK_SPAN) return 0;

        /* ── UNDER THE LEASE, PROVED FROM THE FOLDER AND NOT FROM THE CALLER ───────────────
         *
         * This io is the organizer's half and the drain only builds it on the organizing arm, and
         * neither of those is a fact about the folder. A live claim of ours, read in the same lock
         * as the copy, is: an install that lost the mailbox between its gate and here holds none,
         * and it may not move another organizer's records around underneath it. Read through the
         * one door, so a folder past the window is enumerated and one past the ceiling refuses. */
        const window = await readMetaRecords(client, metaPath, metaReadBudget(), {
          keep: (h) => parseClaim(h) !== null, probe: null,
        });
        /* Our OWN heartbeat against our OWN clock, which is the one comparison in this module a
           reader's clock may make: the stamp was written by this install, so both sides come from
           the same clock and the answer is this install's tenure, not a ranking of anybody. A
           heartbeat in the future means the clock moved under us and the answer is NO, which
           leaves the folder alone — the safe direction for something that expunges. */
        const ourLiveClaim = window.records
          .map((m) => parseClaim(m.raw, m.ref, m.internalDate ?? null))
          .some((c): boolean => {
            if (c === null || isMalformed(c) || c.installId !== identity.installId) return false;
            const age = now.getTime() - c.heartbeat.getTime();
            return age >= 0 && age < DEFAULT_STALE_AFTER_MS;
          });
        if (!ourLiveClaim) {
          throw new RequestUnavailableError(
            `${META_FOLDER} is deeper than one read of it reaches, and this install holds no live `
            + "claim in it — the records were left where they are, because compacting a folder is "
            + "the organizer's act and this install is not organizing this mailbox",
            { op: "compact_meta" },
          );
        }
        if (typeof client.messageCopy !== "function") {
          throw new RequestUnavailableError(
            `${META_FOLDER} is deeper than one read of it reaches and this connection cannot copy `
            + "messages, so its records could not be moved and nothing was removed",
            { op: "compact_meta" },
          );
        }

        /* The generation this whole pass is about. Every uid below is a fact under it and under
         * nothing else — see the epoch check before each expunge. */
        const generation = generationOf(client);

        /**
         * COPY, READ BACK, THEN EXPUNGE — in that order, and the order is the safety.
         *
         * `COPYUID` names every uid the server actually copied. Only those are expunged, so a
         * record the server declined to copy stays exactly where it is: the folder holds a copy of
         * everything at every instant, and the worst a failure here leaves is a duplicate — which
         * coalesces for a claim, is swept for an acknowledgement, and is refused by its own
         * idempotency key for a request. A generation that moved makes every uid in hand a number
         * about a different folder, so nothing is removed.
         */
        const moveToTop = async (batch: number[], lo: number, hi: number): Promise<number> => {
          const copy = await client.messageCopy?.(batch, metaPath, { uid: true });
          const reply = typeof copy === "object" && copy !== null ? copy : null;
          const map = reply?.uidMap;
          if (map === undefined) {
            throw new RequestUnavailableError(
              `the server copied the ${batch.length} record(s) between uid ${lo} and ${hi} in `
              + `${META_FOLDER} without saying where they landed, so none of the originals were `
              + "removed",
              { op: "compact_meta" },
            );
          }
          /* BOTH READINGS, because they are about two different moments and the expunge is the
             later one: `COPYUID`'s generation is the folder the copies landed in, and the live one
             is the folder this command is about to delete from. A renumbering between them takes
             the copies with it and leaves these uids describing whatever now sits at them. */
          const copiedUnder = reply?.uidValidity ?? generation;
          const atExpunge = generationOf(client);
          if (epochVerdict(epochOf(generation), epochOf(copiedUnder)) === "stale"
            || epochVerdict(epochOf(generation), epochOf(atExpunge)) === "stale") {
            throw new RequestUnavailableError(
              `${META_FOLDER} was renumbered while its records were being moved, so the uids this `
              + "pass holds describe a folder that no longer exists and nothing was removed",
              { op: "compact_meta" },
            );
          }
          /* A copy that landed BELOW where it started is not a move, and an absent entry is a
             record the server did not copy: neither may be expunged. */
          const landed = batch.filter((u) => {
            const to = map.get(u);
            return typeof to === "number" && to > u;
          });
          if (landed.length === 0) return 0;
          const done = await client.messageDelete(landed, { uid: true });
          if (done === false) {
            throw new RequestUnavailableError(
              `the server refused to expunge ${landed.length} moved record(s) from ${META_FOLDER}; `
              + "their copies stand at the top of the folder",
              { op: "compact_meta" },
            );
          }
          await proveGone(client, landed, "moved record(s)", "compact_meta");
          return landed.length;
        };

        let moved = 0;
        /** The lowest uid this pass has not dealt with yet. */
        let cursor = bottom;
        for (let w = 0; w < COMPACT_WINDOWS_MAX_PER_CYCLE; w++) {
          /* UPWARD from the bottom, one bounded window at a time. The records that have to move
           * are the OLDEST ones, so the work starts where they are; a window is a uid RANGE, so
           * the enumeration and the copy's reply are bounded by its width however dense the folder
           * is beneath it. */
          const lo = cursor;
          const hi = lo + SEARCH_UID_WINDOW - 1;
          const inWindow = await searchDescending(
            client, metaPath, { header: {} }, SEARCH_UIDS_MAX, { from: hi, downTo: lo },
          );
          if (inWindow.kind === "refused") {
            throw new RequestUnavailableError(
              `the records in ${META_FOLDER} between uid ${lo} and ${hi} could not be enumerated, `
              + `so they were not moved (${moved} already moved on this pass)`,
              { op: "compact_meta" },
            );
          }
          const batch = [...inWindow.uids].sort((a, b) => a - b);
          if (batch.length > 0) moved += await moveToTop(batch, lo, hi);
          /* THE LINE MOVES UP WITH EVERY COPY — each one spends uids of its own — so it is read
           * again rather than remembered, and so is the bottom, which jumps over whatever stretch
           * of the space holds nothing. Done when the folder's lowest record is inside the walk; a
           * folder too sparse to finish in one cycle finishes in the next and is shallower either
           * way, which is the sweep's rule and for its reason. */
          const nowTop = await highestUid(client, metaPath);
          const nowBottom = await folderBottomUid(client);
          if (nowTop === null || nowBottom === null) break;
          if (nowTop - nowBottom < SEARCH_WALK_SPAN) break;
          cursor = Math.max(hi + 1, nowBottom);
        }
        if (moved > 0) {
          /* EVERY POSITION THIS PROCESS REMEMBERS IN THIS FOLDER IS NOW WRONG. The records kept
           * their identity and lost their numbers, so an anchor or a sweep cursor left standing
           * would bound a later read at a uid that means nothing. Dropped rather than rewritten:
           * each is a hint whose only job is to save a walk. */
          forgetMemo(identity, "claimUid");
          forgetMemo(identity, "sweepCursor");
        }
        return moved;
      } finally {
        lock.release();
      }
    },

    async ack(raw: string): Promise<void> {
      try {
        await client.append(await meta.path(), raw, ["\\Seen"]);
      } catch (err) {
        throw new RequestUnavailableError(
          `an acknowledgement could not be appended to ${META_FOLDER}`,
          { op: "append_request", cause: err },
        );
      }
    },

    async remove(refs: readonly unknown[]): Promise<void> {
      const uids = refs.filter((r): r is number => typeof r === "number");
      // A ref this cannot address is NOT a no-op to report as done. The caller reads a clean
      // resolve as "expunged" and counts the record handled; the record is still in the folder,
      // so the next cycle refuses it again, and the cycle after that, for ever — a permanent log
      // line from a drain whose every counter says it is working. Refusing loudly is the only
      // answer that reaches anyone.
      if (uids.length !== refs.length) {
        throw new RequestUnavailableError(
          `${refs.length - uids.length} record(s) in ${META_FOLDER} have no addressable ref`,
          { op: "remove_requests" },
        );
      }
      if (uids.length === 0) return;
      try {
        const lock = await client.getMailboxLock(await meta.path());
        try {
          /**
           * THE REFS CAME OUT OF A READ, AND A UID IS A FACT ONLY UNDER THE NUMBERING IT WAS READ
           * UNDER. `ohmail/_meta` can be replaced between the drain's read and this lock — the
           * customer clearing it, a restore, a migration — and these numbers then name whatever
           * sits at them now: a reader on another computer appends a request, it lands at uid 1,
           * and the stale list expunges it. Nobody is told; the press simply never happens.
           * The one guard, and the fail-open arm `removeClaims` decided: only a PROVEN mismatch
           * refuses, because a connection that never states a UIDVALIDITY would otherwise be
           * unable to drain this folder at all, and the custody read-back below is the backstop.
           */
          const refEpoch = epochOf(metaGeneration);
          const nowEpoch = epochOf(generationOf(client));
          if (uidRefsAtEpoch(uids.map((uid) => ({ epoch: refEpoch, uid })), nowEpoch) === "stale") {
            throw new RequestUnavailableError(
              `${META_FOLDER} was renumbered between the read that named these ${uids.length} `
              + "record(s) and the delete, so the refs cannot be trusted and nothing was expunged",
              { op: "remove_requests" },
            );
          }
          // See `makeLeaseIo.removeClaims` for why a `false` resolve is treated as a failure
          // rather than swallowed: a refused expunge here is exactly what the idempotency key at
          // `meta-request:<id>` exists to make safe to retry, and swallowing it would leave a
          // request applied AND still sitting in the folder, re-read (and re-refused-to-reapply,
          // harmlessly) on every cycle for ever.
          //
          // ONE round trip for the whole batch: refusals are collected and removed in a single
          // STORE+EXPUNGE, so a flooded folder cannot become one IMAP command per hostile record.
          const done = await client.messageDelete(uids, { uid: true });
          if (done === false) {
            throw new Error(`the server refused to expunge ${uids.length} message(s) from ${META_FOLDER}`);
          }
          /* AND A `true` IS NOT A REMOVAL — the same proof the claim and settings paths take, for
           * the reason the comment above already gives and could not enforce. The refusal check
           * sees an explicit `false`; it cannot see a refused STORE under an accepted EXPUNGE,
           * which resolves `true` and removes nothing. Without the read-back the drain counted the
           * request settled while it sat in the folder, so every later cycle re-read it — and the
           * counters said the drain was working. */
          await proveGone(client, uids, "settled request record(s)", "remove_claims");
        } finally {
          lock.release();
        }
      } catch (err) {
        // A refusal this method MADE is not relabelled: the renumbering refusal above names what
        // happened and what was not done, and wrapping it as "could not be removed" would send an
        // operator looking at the server. Everything else is a failure of the commands below it.
        if (err instanceof RequestUnavailableError) throw err;
        throw new RequestUnavailableError(
          `${uids.length} message(s) in ${META_FOLDER} could not be removed`,
          { op: "remove_requests", cause: err },
        );
      }
    },
  };
}
