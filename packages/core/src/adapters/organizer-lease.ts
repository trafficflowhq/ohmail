import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from "node:crypto";
import {
  CAPABILITY_REQUESTS, CAPABILITY_MOVES, CAPABILITY_RULES, CAPABILITY_PROFILE,
} from "@trafficflow/db";
import { WATCHED_FOLDERS, type ImapAuth } from "./imap-types.js";
import {
  boundListResponse, boundedFetch, ImapDeadline, IMAP_META_BYTES_MAX, IMAP_META_DEADLINE_MS,
} from "./imap-bounds.js";
import {
  assertMetaIdentity, readMemo, writeMemo, forgetMemo,
  type MetaIdentity, type Generation,
} from "./meta-memo.js";

/* Re-exported so hosts reach one surface for the meta folder rather than importing the memory
 * from a second path — the drain keeps a position here too, and a second import path is how two
 * callers come to disagree about which store they are writing to. */
export {
  readMemo, writeMemo, forgetMemo, peekMemo, assertMetaIdentity,
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
  /** LIST and resolve, fresh. Also warms {@link MetaFolderRef.path}. */
  locate(): Promise<MetaFolderLocation>;
  /** The path to address, resolving on first use and remembered after. */
  path(): Promise<string>;
  /** Remember a path the SERVER named — a CREATE's landed path is truer than any derivation. */
  adopt(path: string): void;
}

export function makeMetaFolderRef(
  client: MetaFolderClient,
  toServerPath: (canonical: string) => string,
): MetaFolderRef {
  let known: string | null = null;

  const locate = async (): Promise<MetaFolderLocation> => {
    const at = resolveMetaFolder({
      /*
       * THE ONE LIST THIS MODULE ISSUES, AND IT IS THE SERVER'S ARRAY.
       *
       * The adapter funnels its own LIST sites through one bounded helper; this one is reached
       * with the RAW client, so it was outside that guarantee — a server naming a million folders
       * cost a million strings through the resolution below, on every cycle, in a process every
       * other mailbox shares. Same ceilings, same helper: a count on the response and a length on
       * each path.
       */
      list: boundListResponse(await client.list()),
      bare: toServerPath(META_FOLDER),
      namespaces: personalNamespacesOf(client),
    });
    known = at.path;
    return at;
  };

  return {
    locate,
    async path(): Promise<string> {
      return known ?? (await locate()).path;
    },
    adopt(path: string): void {
      known = path;
    },
  };
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
 * (`ORGANIZER_KINDS`, `packages/db/src/organizer-role.ts`).
 */
export type OrganizerKind = "local" | "cloud" | "mobile";

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
}

/** A claim message, parsed. */
export interface OrganizerClaim {
  installId: string;
  kind: OrganizerKind | "unknown";
  protocol: number;
  /** ISO instant of the last renew. NOT IMAP INTERNALDATE — that is the server's clock. */
  heartbeat: Date;
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
  protocol?: number;
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

/** Read the headers of one message. Returns `null` when it is not a claim at all. */
export function parseClaim(raw: string, ref?: unknown): ClaimRecord | null {
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
  const kind: OrganizerKind | "unknown" =
    kindRaw === "local" || kindRaw === "cloud" || kindRaw === "mobile" ? kindRaw : "unknown";

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

  const claim: OrganizerClaim = {
    installId,
    kind,
    protocol,
    heartbeat,
    claimedAt: Number.isNaN(claimedAt.getTime()) ? heartbeat : claimedAt,
    displayName: get(H.displayName) ?? "",
    nonce: get(H.nonce) ?? "",
    authorizedAt,
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
  let newestServer = -Infinity;
  let skewMs: number | null = null;
  for (const r of records) {
    const at = r.internalDate instanceof Date ? r.internalDate.getTime() : NaN;
    if (!Number.isFinite(at) || at <= newestServer) continue;
    const c = parseClaim(r.raw, r.ref);
    if (c === null || isMalformed(c) || c.installId !== installId) continue;
    newestServer = at;
    skewMs = c.heartbeat.getTime() - at;
  }
  return skewMs;
}

/**
 * Is this install's clock fit to write a claim — the WRITER-side check, and it has to be here: no
 * reader-side rule can fix a wrong writer clock, and the tie-breaker is the server's clock, which
 * both machines see. Two bounds, because the directions are not symmetric: AHEAD is tolerated to
 * {@link MAX_FUTURE_SKEW_MS} — past it every reader excludes our heartbeat from the renewal
 * evidence and the mailbox is offered to somebody else while we go on organizing it; BEHIND only
 * to `staleAfterMs` — at a one-minute window, 61 seconds of lag lets a reader take the mailbox
 * with our live record in `displace`. The refusal names which bound fired. `null` skew refuses
 * nothing.
 */
export function clockSkewRefusal(input: {
  skewMs: number | null; staleAfterMs: number;
}): { skewMs: number; bound: "ahead" | "behind"; boundMs: number } | null {
  const { skewMs, staleAfterMs } = input;
  if (skewMs === null) return null;
  if (skewMs > MAX_FUTURE_SKEW_MS) return { skewMs, bound: "ahead", boundMs: MAX_FUTURE_SKEW_MS };
  if (-skewMs >= staleAfterMs) return { skewMs, bound: "behind", boundMs: staleAfterMs };
  return null;
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
function coalesce(claims: readonly ClaimRecord[]): { valid: OrganizerClaim[]; malformed: MalformedClaim[] } {
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
    if (!prior || compareRecency(c, prior) < 0) newest.set(c.installId, c);
  }
  return { valid: [...newest.values()], malformed };
}

/** Newest heartbeat first; equal heartbeats break on the nonce, so the result is order-free. */
function compareRecency(a: OrganizerClaim, b: OrganizerClaim): number {
  const d = b.heartbeat.getTime() - a.heartbeat.getTime();
  if (d !== 0) return d;
  return a.nonce < b.nonce ? -1 : a.nonce > b.nonce ? 1 : 0;
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
  /** The strongest live candidate, or `null` when the folder holds no readable claim. */
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
  const { valid, malformed } = coalesce(claims);
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
  const winner = [...live].sort(compareStrength)[0] ?? null;

  // The one place the reader's clock decides anything about the folder as a whole, and it decides
  // only whether to ASK a human. It is now literally `!clock.renewing` rather than a second
  // derivation beside it, which is what makes `quiet` and `decideLease`'s rule 1/2 agree BY
  // CONSTRUCTION: the gate refuses a press over a lone unrankable record exactly while the folder
  // is being renewed. They used to be two expressions with two authors, and they disagreed for
  // every folder holding one claim.
  const quiet = !clock.renewing;

  return { candidates, live, winner, clock, plausiblePress, quiet, malformed };
}

/**
 * Who may organize this mailbox. Pure — no clock, no IO. (1) A live claim in a protocol we do not
 * understand — stand down; no authorization overrides what we cannot rank. (2) A live claim of an
 * unrecognised KIND — stand down. (3) We hold the strongest live claim — organize; continuation
 * covers resumption. (4) No readable claim — organize. (5) DELETED — it refused an authorized
 * local over a live Cloud; the numbering keeps the names tests use. (6) A human pressed for THIS
 * install more recently than any live rival — organize and DISPLACE; STRICT, and no
 * stamp-older-than-claimedAt check, which would break the two-press race. (7) Lost, folder
 * renewing — stand down. (8) Lost, folder quiet — `available`: offerable, never taken.
 */
export function decideLease(input: DecideLeaseInput): LeaseVerdict {
  const { self, now } = input;
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const takeover = input.takeover ?? null;
  const ourProtocol = self.protocol ?? CLAIM_PROTOCOL;

  const election = runElection(input.claims, now, staleAfterMs);

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
    const clonedUs =
      self.lastNonce !== null &&
      c.nonce !== self.lastNonce &&
      election.live.includes(c);
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
    c.installId === self.installId && (self.lastNonce === null || c.nonce === self.lastNonce);

  // 1 / 2 — a live peer we cannot rank. Checked first, no authorization overrides them, and
  // checked over the RAW list: coalesce keeps the newest record per install, so an unrankable
  // OLDER record hidden behind a rankable newer sibling would otherwise never trip this arm —
  // and every downstream consumer of this verdict (the takeover's displacement above all)
  // would treat a live claim in a format we cannot read as beatable residue.
  const unrankable = input.claims.find((c): c is OrganizerClaim =>
    !isMalformed(c) && !rawOurs(c) && (c.protocol > ourProtocol || c.kind === "unknown") && rawIsLive(c));
  if (unrankable) return { verdict: "stand_down", reason: "organized_elsewhere:unknown", by: unrankable };

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
  if (takeover !== null && ourPress > livePress) {
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
    const displaced = input.claims
      .filter((c) => (isMalformed(c)
        ? true
        : !(c.installId === self.installId && (self.lastNonce === null || c.nonce === self.lastNonce))
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
    return { verdict: "stand_down", reason: reasonFor(winner), by: winner };
  }
  return { verdict: "available", by: winner };
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
  /** Freshest first. One entry per install id, the same coalescing the gate does. */
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
  const { valid, malformed } = coalesce(input.claims);

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
  const rawValid = input.claims.filter((c): c is OrganizerClaim => !isMalformed(c));
  const clock = readFolderClock(rawValid, input.now, staleAfterMs);
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

  const holders: LeaseHolder[] = valid
    .map((c) => ({
      kind: unrankableInstalls.has(c.installId) ? ("unknown" as const) : c.kind,
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
     * Ordered by BELIEVABLE recency, because `holders[0]` is read as "the organizer" (the worker,
     * the sidecar and the API all take the first holder as the machine to name). Sorting on the
     * raw heartbeat let a stamp nobody believes decide that name: two installs each carrying a
     * live record and a 2099 duplicate — the election chose A on incumbency, the preview put B
     * first because B's residue was a day later in 2099, and the screen named the election's
     * loser. An unbelievable stamp sorts as `now`, the same cap the reference uses; ties break on
     * the install id so two readers produce the same order.
     */
    .sort((a, b) => {
      const rank = (h: LeaseHolder): number =>
        Math.min(h.heartbeat.getTime(), input.now.getTime());
      const byRecency = rank(b) - rank(a);
      if (byRecency !== 0) return byRecency;
      return a.installId < b.installId ? -1 : a.installId > b.installId ? 1 : 0;
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
export function makeLeasePeekIo(client: LeaseImapClient, toServerPath: (canonical: string) => string): LeasePeekIo {
  const meta = makeMetaFolderRef(client, toServerPath);
  return {
    async listClaims(): Promise<RawClaimMessage[]> {
      const at = await meta.locate();
      // An ABSENT folder is zero claims — the truth, and the semantics this object's docblock
      // promises. A folder that could not be RESOLVED is a throw, which `readLeasePeek` turns
      // into `LeaseUnavailableError`: "I could not look" and "nobody holds it" must stay
      // unreachable from one another.
      if (at.row === null) return [];

      const lock = await client.getMailboxLock(at.path);
      try {
        // The shared bounded read — see {@link readMetaFolderWindow}. A folder too full to read in
        // one window is reported as a read that FAILED, which {@link readLeasePeek} turns into
        // {@link LeaseUnavailableError}: this surface exists to tell a person who holds their
        // mailbox, and "I could not see all of it" must render as unknown rather than as nobody.
        const read = await readMetaFolderWindow(client, at.path);
        if (!read.truncated) return read.records;
        /* ── A FULL FOLDER MUST NOT RENDER AS "NOBODY HOLDS THIS MAILBOX" ────────────────────
         *
         * This surface exists to tell a person WHO organizes their mailbox, so the claims are asked
         * for by header exactly as the election asks for them — the answer is complete for claims
         * and independent of position, and the person is shown the real holder instead of an
         * apology. Read-only: SEARCH and FETCH, never an APPEND.
         *
         * The refusal survives for the case where the server cannot be asked, because "I could not
         * see all of it" must still render as unknown rather than as nobody. */
        /**
         * The peek refuses an oversized claim set; it never shows part of one. `searchHeaders`
         * caps what it carries; for a decider that cap is a bound (the gate refuses anything past
         * its own ceiling), but the peek had no ceiling, so the cap silently became its ANSWER:
         * seven hundred claims came back as the first five hundred and one, and what fell off is
         * by uid — the NEWEST. A live renewal omitted while old residue survives renders as
         * "stopped": telling a person nobody organizes a mailbox somebody is actively organizing.
         * So it asks to be REFUSED, in the class every lease fault uses — rendered as an
         * unreadable lease, never an empty one.
         */
        const claims = await searchHeaders(
          client,
          at.path,
          { header: { [H.lease]: true } },
          { max: META_RECORDS_MAX_PER_FETCH, refuseWhenOver: true },
        );
        if (claims !== null) return claims;
        throw new MetaFolderTruncatedError(
          read.records.length, read.total, read.records, read.truncatedBy,
        );
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
export async function readLeasePeek(input: ReadLeasePeekInput): Promise<LeasePeek> {
  let messages: RawClaimMessage[];
  try {
    messages = await input.io.listClaims();
  } catch (err) {
    /**
     * A full folder gets its own line here too, not only its own sentence. The counts survive
     * into the message because a folder too full to read is the only fault here that does not
     * clear on its own. But a thrown message reaches somebody only if the caller renders it, and
     * this refusal usually renders as "we could not check" — a blip. The gate emits
     * `lease_meta_truncated` on the same condition; the peek was silent, so one mailbox reported
     * the fault from one door and not the other. Same event name, same fields — it is the same
     * fact.
     */
    if (err instanceof MetaFolderTruncatedError) {
      input.log?.("lease_meta_truncated", { read: err.read, limit: err.limit, total: err.total });
    }
    throw new LeaseUnavailableError(
      err instanceof MetaFolderTruncatedError
        ? err.message
        : `the organizer lease in ${META_FOLDER} could not be read`,
      { op: "list_claims", cause: err },
    );
  }
  const claims = messages
    .map((m) => parseClaim(m.raw, m.ref))
    .filter((c): c is ClaimRecord => c !== null);
  return peekLease({
    claims,
    now: input.now,
    ...(input.staleAfterMs !== undefined ? { staleAfterMs: input.staleAfterMs } : {}),
  });
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
  /* The folder is over the ceiling AND the claim set could not be read, or itself exceeds it.
   * Same CLASS as every other lease IO fault on purpose: the hosts' exemptions and the LOCAL/Cloud
   * exclusions are all by class, so a new class would fall into `maxSyncFailures` and quarantine a
   * customer's mailbox over a folder that is not its fault. */
  | "meta_folder_full"
  /** STORE `\Deleted` + EXPUNGE the acknowledgements past their life — see {@link RequestOp}. */
  | "sweep_acks";

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
   * The records a release may decide from — a complete, current read of the folder, or a refusal.
   * A current folder read under the folder's UIDVALIDITY, not a server search: a real provider
   * refused the header search on every poll, and a release locatable only through a verb the
   * server may decline is refusable for ever. A whole-folder read answers "which are mine"
   * completely; one that could not throws {@link ClaimReleaseError} rather than returning a
   * slice. The result is CANDIDATES, other installs' records included: the selection is the
   * caller's, with the gate's own parser — the settings document carries the install-id header
   * too, and expunging it here would delete the mailbox's settings.
   */
  findOwnRecords?(installId: string): Promise<RawClaimMessage[] | null>;
  /**
   * Every claim in the folder, asked of the SERVER by header rather than read out of a window.
   * What an election reads when the bounded window could not cover the folder: a window is
   * newest-first, and a live incumbent renewed just before a burst of appends is exactly an old
   * record — electing on the window can report "nobody organizes this mailbox" about one somebody
   * is actively organizing, and a second install then claims it. Only claims carry
   * `X-Ohmail-Lease`, so the set is complete for claims and position-independent, and it is a
   * handful of records rather than a folder. `null` means the connection cannot ask, and the gate
   * refuses rather than guessing.
   */
  listClaimRecords?(): Promise<RawClaimMessage[] | null>;

  /**
   * WHY THE LAST CLAIM READ REFUSED, when it did. `null` after a read that answered.
   *
   * Optional because the peek's io has no such memory to report on; a caller that finds it absent
   * learns nothing and must not conclude anything from that.
   */
  claimReadFact?(): ClaimReadFact | null;
  /**
   * THE SELECTED FOLDER'S UID GENERATION, where the server reports one.
   *
   * OPTIONAL, and this is the one place in this module where an optional capability is the right
   * shape rather than the trap the rest of it avoids. Absence means "this connection cannot tell
   * me", which resolves to `null` on BOTH of the reads that are compared — so the comparison finds
   * no change and the gate behaves exactly as it did before this existed. The capability can only
   * ADD a refusal, never remove one, so a fake that omits it is not weaker than today; it is today.
   */
  uidValidity?(): number | bigint | null;
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
     */
    query: { messages?: boolean; uidNext?: boolean },
  ): Promise<{ messages?: number; uidNext?: number } | false | undefined>;
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
    query: { uid?: boolean; headers?: boolean | string[]; internalDate?: boolean },
    options?: { uid?: boolean },
  ): AsyncIterableIterator<{ uid: number; seq?: number; headers?: Buffer; internalDate?: Date }>;
  append(path: string, content: string | Buffer, flags?: string[]): Promise<unknown>;
  messageDelete(range: number[], options?: { uid?: boolean }): Promise<unknown>;
}

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
): Promise<number | undefined> {
  if (path === undefined || typeof client.status !== "function") return undefined;
  try {
    const st = await client.status(path, { messages: true });
    // `false` is a real answer here, not a missing one: the library returns it when the command's
    // preconditions are not met or it fails, so this cannot optional-chain through `st`. Both that
    // and a reply without the field mean the same thing to the caller — the count is unknown, use
    // the whole-folder fallback.
    const messages = typeof st === "object" && st !== null ? st.messages : undefined;
    return typeof messages === "number" ? messages : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One bounded read of `ohmail/_meta`, NEWEST FIRST — the only FETCH in this module (a census pins
 * the two `client.fetch(` calls). Newest first because `1:*` returns oldest first and a ceiling
 * breaking out of that loop keeps the OLDEST records: everything live is appended at the END, so
 * five hundred harmless messages would hide every claim and decision for good — and a truncated
 * read was indistinguishable from a complete one. Over the ceiling the FETCH asks `exists -
 * ceiling + 1 : *`. `truncated` is the point of returning a record: the peek and drains refuse on
 * it; the GATE acts on the window, because refusing there stops a customer's mail. One message
 * beyond the ceiling is read and discarded, so exactly-the-ceiling is complete.
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
 * THE FOLDER HOLDS MORE THAN ONE READ MAY TAKE.
 *
 * Its own class so that each caller can convert it into the refusal its own layer already has —
 * {@link LeaseUnavailableError} for the lease, {@link RequestUnavailableError} for the records —
 * rather than every caller re-deriving "a full folder is a look that failed" from a boolean it
 * might forget to check. Carrying the counts is what lets the refusal say how full the folder is,
 * which is the one thing that tells somebody reading a log what to do about it.
 */
export class MetaFolderTruncatedError extends Error {
  /** Which ceiling ended the read — the sentence and {@link limit} both follow it. */
  readonly by: MetaTruncation;
  /** How many records the window covered. */
  readonly read: number;
  /** The ceiling that bounded it. */
  readonly limit: number;
  /** The folder's message count, where the server reported one. */
  readonly total: number | null;
  /**
   * THE NEWEST RECORDS THE WINDOW DID COVER — carried so a caller that can act on a partial view
   * may, without a second round trip.
   *
   * An error carrying a payload is a smell and this one is deliberate: exactly one caller can act
   * on a partial view of this folder and it is the ELECTION, for the reason written at the gate's
   * own catch. The peek and both drains cannot, do not, and never touch this field.
   */
  readonly records: readonly RawMetaMessage[];
  /**
   * REQUIRED, with no default. A default of `[]` is the shape where a construction site that forgot
   * the window silently hands the gate an EMPTY election — which is `decideLease`'s "nobody has
   * ever organized this mailbox" arm, over a folder that is demonstrably full. The one field whose
   * absence would be worst is the one an optional parameter makes easiest to omit.
   */
  constructor(
    read: number,
    total: number | null,
    records: readonly RawMetaMessage[],
    /*
     * The RECORD ceiling by default, because that is what every construction site written before
     * the byte ceiling existed means — and it is the reading a caller with no window in hand can
     * honestly give.
     */
    by: MetaTruncation = "records",
  ) {
    const ceiling = by === "bytes" ? IMAP_META_BYTES_MAX : META_RECORDS_MAX_PER_FETCH;
    const what = by === "bytes" ? "bytes" : "records";
    super(
      `${META_FOLDER} holds more than the ${ceiling} ${what} one read may take` +
      `${total === null ? "" : ` (${total} messages present)`}, so what is in it is not fully ` +
      `known and nothing was decided from it`,
    );
    this.name = "MetaFolderTruncatedError";
    this.by = by;
    this.read = read;
    this.limit = ceiling;
    this.total = total;
    this.records = records;
  }
}

/**
 * The shared read itself. The folder must already be SELECTED — every caller takes the lock, and
 * taking it here would mean this function had to know the path, which is the one thing the three
 * callers legitimately resolve for themselves.
 *
 * Exported so the window is testable as the mechanism it is. Its callers all convert `truncated`
 * into a refusal, so a test driving them can only ever observe the refusal — which would leave
 * "the window runs from the END of the folder" asserted nowhere, and a ceiling that quietly went
 * back to keeping the oldest records would pass every guard above it.
 */
/**
 * Where the page below a bound starts and ends, and whether it reaches the bottom of the folder.
 * An empty window and an empty folder are not the same answer: the drain once treated a window
 * that fell in a UID GAP as "the folder read whole", cleared its resume point, and restarted from
 * the top — append-and-expunge churn leaves gaps wider than one window routinely, so the walk
 * could oscillate between the top and the gap for ever while the requests below were never
 * reached. This is arithmetic, not a reply, so it answers for an empty page exactly as well as a
 * full one; the read uses it too, so the walk and the reader take the same steps.
 */
export function metaPageBounds(beforeUid: number): { lo: number; hi: number; bottom: boolean } {
  const hi = Math.max(1, beforeUid - 1);
  const lo = Math.max(1, hi - META_RECORDS_MAX_PER_FETCH + 1);
  return { lo, hi, bottom: lo <= 1 };
}

export async function readMetaFolderWindow(
  client: LeaseImapClient,
  path?: string,
  /**
   * PAGE OLDER THAN THIS UID. Absent, the read covers the newest records, which is what every
   * decision wants. Given, it covers the newest records BELOW the bound — the next page down —
   * so a caller that has already handled a page can ask for the one before it and keep going.
   *
   * By UID rather than by position, for the reason the profile read learned the hard way: a
   * sequence number is a position in the folder as it stood a round trip ago, and an expunge
   * renumbers everything above it without saying so.
   */
  beforeUid?: number,
  /**
   * The clock the read's deadline reads. Injectable so a case can drive the SHIPPING ceiling
   * instead of a lowered one — a test that has to shorten the bound is not testing the bound.
   */
  now: () => number = Date.now,
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
  const probed = await lastSequence(client, path);

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
  // re-read fires, and per-read ceilings compose into a total nobody bounded.
  const budget = ImapDeadline.in(IMAP_META_DEADLINE_MS, "read_deadline", now);
  const readFrom = async (
    start: number,
  ): Promise<{ records: RawMetaMessage[]; evicted: boolean; by: MetaTruncation | null }> => {
  /**
   * A page asks for its own window, not for everything below the cursor. This asked
   * `1:<cursor-1>` and let the eviction keep the newest ceiling's worth — bounded in what it
   * RETAINED, unbounded in what it TRANSFERRED: every page re-read the entire older prefix, so
   * walking eight pages pulled the folder down eight times. The window is a uid RANGE now — one
   * ceiling's worth below the cursor — so each page costs the same as the first. A record whose
   * uid falls in a gap simply is not there; the walk's budget bounds the steps, not the density.
   */
  const { lo: pageLo, hi: pageHi } = metaPageBounds(beforeUid ?? 1);
  const range = beforeUid !== undefined ? `${pageLo}:${pageHi}` : `${start}:*`;
  const byUid = beforeUid !== undefined;
  if (beforeUid !== undefined && beforeUid <= 1) return { records: [], evicted: false, by: null };
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
    client.fetch(range, { uid: true, headers: true, internalDate: true }, { uid: byUid }),
    {
      max: META_RECORDS_MAX_PER_FETCH,
      bytes: { max: IMAP_META_BYTES_MAX, of: (m) => m.headers?.byteLength ?? 0 },
      deadline: budget,
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

/**
 * Every record in the folder matching a header, asked of the server — the one place this module
 * turns a header into a set of messages; three callers route through it (the own-records read,
 * the election's claim set, the peek), because a second copy is a second answer to "which
 * messages carry this header". `null`, never `[]`, when the connection cannot ask or the server
 * refuses: could-not-look and there-are-none are different answers — the election refuses on the
 * first and may elect on the second. `true` as a header value compiles to `HEADER <name> ""` —
 * header-PRESENT — measured on GreenMail and Dovecot rather than taken on the RFC's word. The
 * caller holds the lock; this issues no APPEND and no STORE.
 */
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
  if (typeof client.fetch !== "function") return;
  const still: number[] = [];
  try {
    for await (const m of client.fetch(uids.join(","), { uid: true }, { uid: true })) {
      if (typeof m.uid === "number") still.push(m.uid);
    }
  } catch (err) {
    throw new LeaseUnavailableError(
      `the expunge of ${uids.length} ${what} from ${META_FOLDER} could not be verified: `
      + `${err instanceof Error ? err.message : String(err)}`,
      { op },
    );
  }
  if (still.length > 0) {
    throw new LeaseUnavailableError(
      `${still.length} ${what} survived the expunge in ${META_FOLDER} — the server accepted the `
      + "command and removed nothing",
      { op },
    );
  }
}

/**
 * The most uids a header search will carry forward, one PAST the largest ceiling any caller
 * applies to the result — so "exactly at the ceiling" stays distinguishable from "over it", which
 * is what the claim-set refusal turns on. A server that answers with more than this is answering
 * about a folder no caller here will act on anyway.
 */
const SEARCH_UIDS_MAX = 501;

/**
 * How many uids go into one FETCH command. Keeps the command line and the in-flight reply bounded
 * regardless of what the server said, which the single-command form could not.
 */
const SEARCH_FETCH_BATCH = 100;

/**
 * How wide one descending UID window is. A window can name at most this many uids, so it bounds
 * the SEARCH reply the way {@link SEARCH_FETCH_BATCH} bounds the FETCH command.
 */
const SEARCH_UID_WINDOW = 500;

/**
 * How many windows one search may walk before it gives up and reports that it could not ask.
 * Bounds the ROUND TRIPS the way the window bounds the reply: a sparse uid space would otherwise
 * page for ever looking for a handful of records.
 */
const SEARCH_WINDOW_BUDGET = 20;

/**
 * How many uids one EXPUNGE of the ack sweep carries. Two hundred, for the same reason the fetch
 * batch is a hundred: the command line stays a fixed size whatever the folder did, and a refusal
 * costs one batch rather than the whole compaction.
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
 * The search itself is bounded, not only what is done with its answer. The reply to a bare `UID
 * SEARCH` is however many uids the server chooses, materialised before a line of ours runs — "we
 * then ignore most of them" is not a defence against having received them. So the folder is
 * searched in DESCENDING UID WINDOWS (`UID SEARCH <criteria> UID <lo>:<hi>`), each reply bounded
 * by construction; descending because every caller wants the newest records and stops once it has
 * enough. Two costs, stated: round trips on a sparse folder — hence a WINDOW BUDGET, and
 * exhausting it returns `null`, which callers treat as could-not-ask; and a starting point — with
 * no `uidNext` to ask for, the single unbounded search remains, kept deliberately.
 */
async function searchDescending(
  client: Pick<LeaseImapClient, "search" | "mailbox" | "status">,
  path: string,
  query: { header: Record<string, string | boolean>; before?: Date },
  max: number,
  span?: { from?: number; downTo?: number },
): Promise<DescendingWalk> {
  if (typeof client.search !== "function") return { kind: "refused" };

  /**
   * The top of the uid space is asked for, never remembered. This read `client.mailbox.uidNext`,
   * which is whatever the last untagged response left on the cached mailbox object; holding the
   * lock does not refresh it. Counting back from a stale value is worse here than for the count:
   * the windows walk DOWN from this number, so a stale-low value puts every window below the
   * newest records — and the caller most affected is the ELECTION, which reads a claim set
   * missing the incumbent's live claim, takes the nobody-organizes arm, and appends a second one.
   * So it is a STATUS on the folder by name, every time; an absent or unusable answer is `null`,
   * which every caller treats as could-not-ask and none organizes on.
   */
  const top = await highestUid(client, path);

  /* ONE CALL SITE, and the census in `organizer-lease-meta-window.test.ts` counts on it: two ways
   * of asking this server about this folder, no more. The windowed walk and the unbounded fallback
   * are the same question with and without a `UID` term, so they issue from one site rather than
   * two — a second would read as a third way of asking.
   *
   * The census matches source TEXT, so spelling the call pattern out in a comment counts as a use
   * of it. That is not a flaw in the census: it is why it can be trusted to notice a real one. */
  /* ── WITHOUT A CEILING THERE IS NO WINDOW, AND ONE UNBOUNDED PASS IS NOT THE ANSWER ──────
   *
   * The previous version fell back to a single unbounded search here, which made the bound
   * conditional on the server choosing to answer: a server that declines STATUS got exactly the
   * unbounded reply the windows exist to prevent, and nothing said so. "I could not ask in a way
   * I can bound" is a partial answer, and this module has one word for that. */
  const ceiling = span?.from ?? top;
  if (ceiling === null || ceiling < 1) return { kind: "refused" };
  /* The walk never goes below `bottom`. For the ordinary claim read that is the start of the uid
   * space; for the gap read below it is the incumbent's own uid, which is the only uid a walk is
   * ever allowed to stop above — see the note at its call site. */
  const bottom = Math.max(1, span?.downTo ?? 1);
  if (ceiling < bottom) return { kind: "covered", uids: [] };

  const out: number[] = [];
  let hi = ceiling;

  for (let window = 0; window < SEARCH_WINDOW_BUDGET; window++) {
    const lo = Math.max(bottom, hi - SEARCH_UID_WINDOW + 1);
    const found = await client.search({ ...query, uid: `${lo}:${hi}` }, { uid: true });
    if (!Array.isArray(found)) return { kind: "refused" };
    out.push(...found);
    if (lo === bottom) return { kind: "covered", uids: out };
    if (out.length > max) return { kind: "covered", uids: out };  // the caller's ceiling decides
    hi = lo - 1;
  }
  /* The budget ran out with folder still unexamined. That is not an answer, and reporting it as
   * one would be the "could not look" / "there are none" confusion this module refuses everywhere
   * else — but WHERE it ran out is a fact the caller can act on, so it comes back too. Everything
   * at or above `floor` was covered; nothing below it was looked at. */
  return { kind: "short", uids: out, floor: Math.max(bottom, hi + 1) };
}

/**
 * The highest uid the folder could hold, asked of the SERVER — or `null` for every way of not
 * knowing. One function because there is one question: both descending walks need a ceiling to
 * start from, and each had grown its own copy of this block; the census counts call sites so a
 * third cannot appear unnoticed. Never `client.mailbox.uidNext` — that is whatever the last
 * untagged response left on the connection, and a stale-low ceiling puts every window below the
 * newest records, rendering as a claim that cannot be found or settings that have vanished.
 */
async function highestUid(
  client: Pick<LeaseImapClient, "status">, path: string,
): Promise<number | null> {
  if (typeof client.status !== "function") return null;
  try {
    const st = await client.status(path, { uidNext: true });
    const next = typeof st === "object" && st !== null ? st.uidNext : undefined;
    return typeof next === "number" && next > 1 ? next - 1 : null;
  } catch {
    return null;
  }
}

/**
 * WHAT A DESCENDING WALK MANAGED TO COVER.
 *
 * `short` is the case that used to be indistinguishable from `refused`: the walk was well-formed
 * and the server answered every window, but the budget ran out with folder left beneath it. That
 * is not an answer to "which claims exist", and it never becomes one — but the caller can ask a
 * narrower question about the part that was missed, which is what `floor` is for.
 */
/**
 * The uid the server gave our own claim when we wrote it. Keyed on the CONNECTION: a map keyed by
 * folder path lets one account's uid answer another's question, and a closure inside the io is
 * rebuilt every call. The connection's lifetime matches — one per mailbox, gone on reconnect; a
 * weak key drops the entry with it. Paired with the GENERATION it was learned under: a recreated
 * folder renumbers from one, and the gap read is bounded BELOW by this number, so a stale uid
 * hides exactly the records the election must see — a second organizer. A mismatched or unknown
 * generation discards the memo. Only ever a HINT: every decision is made from records the server
 * returned this cycle.
 */
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

/**
 * WHY A CLAIM READ CAME BACK SHORT — the difference between a mailbox with nothing to say and one
 * that is permanently stuck.
 *
 * A read that cannot bound itself refuses, and refusing is correct: an election run on a partial
 * claim set is how two organizers happen. But the refusal on its own is indistinguishable from a
 * quiet mailbox, and the stuck case does not heal — uids only ever increase, so the same windows
 * come back empty for ever. Naming it is what turns "this mailbox seems idle" into something a
 * person can look at.
 */
export interface ClaimReadFact {
  /** `lease_gap_too_deep`, `lease_walk_short`, or `lease_own_record_absent`. */
  readonly fact: string;
  /** How many uids lie between our own record and where the read stopped. */
  readonly depth: number;
  readonly floor: number;
  readonly ownUid: number | null;
}

type DescendingWalk =
  | { kind: "covered"; uids: number[] }
  | { kind: "short"; uids: number[]; floor: number }
  | { kind: "refused" };

async function searchHeaders(
  client: Pick<LeaseImapClient, "search" | "fetch" | "mailbox" | "status">,
  path: string,
  query: { header: Record<string, string | boolean>; before?: Date },
  opts?: {
    max?: number;
    refuseWhenOver?: boolean;
    /** The caller's own record, when it knows it — the floor for the gap read described below. */
    gapDownTo?: number | null;
    /** Named so a permanent stall is visible rather than silent. */
    onShortfall?: (fact: { floor: number; ownUid: number | null; closed: boolean }) => void;
    /** Fired when the anchor actually bounded a read, so a caller can tell what rested on it. */
    onGapRead?: () => void;
  },
): Promise<RawClaimMessage[] | null> {
  if (typeof client.search !== "function") return null;
  const max = opts?.max ?? SEARCH_UIDS_MAX;
  const walk = await searchDescending(client, path, query, max);
  /* ── A WALK THAT RAN OUT OF BUDGET IS STILL NOT AN ANSWER ────────────────────────────────
   *
   * Every caller but one reads a short walk exactly as it always did: could not look. The claim
   * read is the exception, and it asks the narrower question itself rather than being handed a
   * partial set here — a partial claim set is the input to an election, and this module has one
   * rule about those. */
  const gap = opts?.gapDownTo;
  let found: number[];
  if (walk.kind === "refused") return null;
  else if (walk.kind === "covered") found = walk.uids;
  else if (gap === undefined || gap === null || gap >= walk.floor) {
    /* Nothing to narrow: either the caller keeps no uid of its own, or its record sits inside the
     * part the walk already covered — in which case a short walk means the folder genuinely
     * extends below anything this read can account for. */
    opts?.onShortfall?.({ floor: walk.floor, ownUid: gap ?? null, closed: false });
    return null;
  } else {
    /**
     * The uids between our own record and the walk's floor. The walk goes DOWN from the top, so
     * it meets every record newer than ours before ours — uids ascend on append. What the budget
     * can leave unread is the stretch between our record and where the walk stopped, and a
     * competing claim in there is newer than ours and would go unseen: that stretch is read as
     * its own bounded walk, and only then is the set complete. This never SEEDS the main walk
     * from our own uid — starting there begins the read underneath every newer claim, which is
     * how two organizers happen.
     */
    opts?.onGapRead?.();
    const below = await searchDescending(client, path, query, max, { from: walk.floor - 1, downTo: gap });
    if (below.kind === "refused") return null;
    if (below.kind === "short") {
      /* Even the gap is deeper than one cycle may read. Fail closed exactly as before — but say
       * so, because a stall that looks like a quiet mailbox is a stall nobody fixes. */
      opts?.onShortfall?.({ floor: below.floor, ownUid: gap, closed: true });
      return null;
    }
    found = [...walk.uids, ...below.uids];
  }
  if (found.length === 0) return [];
  /**
   * The reply is bounded before it is spent, not after. Every ceiling that acts on the uid list
   * applies to the RESULT of this function, and between the two sat an unbounded array turned
   * into one comma-separated FETCH: a server answering with a million uids got a megabytes-long
   * command built for it and the whole reply in memory before anything could refuse — the check
   * that refuses an oversized claim set cannot run if the process is already gone. The set is cut
   * to one PAST the largest ceiling (so a caller can tell exactly-at from over) and fetched in
   * batches. Bounded work for an unbounded answer.
   */
  /**
   * A slice is the right answer for a decision and the wrong one for a release. The election and
   * the peek apply their own ceiling to the result — a set larger than the ceiling is refused by
   * the caller, so the slice is a bound, not a loss. A release is enumerating, not deciding:
   * every record this install owns has to be found or the release is partial, and a partial
   * release that returns a COUNT reads as success — the omitted claim holds the mailbox against
   * the next install until it goes stale. Same bound, different meaning at the crossing: the
   * deciders take the slice; the release asks to be REFUSED, reported as a release that did not
   * happen.
   */
  if (found.length > max && opts?.refuseWhenOver === true) return null;
  /* ── SORTED BEFORE IT IS CAPPED, BECAUSE THE WINDOWS ARRIVE IN WINDOW ORDER ────────────────
   *
   * The walk collects one descending window at a time, so the array is ordered by WINDOW and not
   * by uid — the last window's uids are the oldest in the folder but the last in the list. A cap
   * applied to that keeps whatever the windows happened to yield first, which is not the newest
   * and is not anything a caller asked for. Every caller that caps wants the NEWEST records; a
   * caller that wants them all is not capping. So the set is put in newest-first order and the cap
   * then means what it says. */
  const ordered = [...found].sort((a, b) => b - a);
  const capped = ordered.length > max ? ordered.slice(0, max) : ordered;
  const out: RawClaimMessage[] = [];
  for (let i = 0; i < capped.length; i += SEARCH_FETCH_BATCH) {
    const batch = capped.slice(i, i + SEARCH_FETCH_BATCH);
    for await (const m of client.fetch(batch.join(","), { uid: true, headers: true }, { uid: true })) {
      if (!m.headers) continue;
      out.push({ ref: m.uid, raw: m.headers.toString("utf8") });
    }
  }
  return out;
}

export function makeLeaseIo(
  client: LeaseImapClient,
  toServerPath: (canonical: string) => string,
  identity: MetaIdentity,
): LeaseIo {
  // The seam's own check: this package's tests are not typechecked, so a construction site that
  // omits an identity would bind `undefined` and every mailbox in the process would share one
  // memory under that key. Silent, and the exact defect the key exists to prevent.
  assertMetaIdentity("makeLeaseIo", identity);
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

  /** Set by the claim read when it refuses or distrusts its own memory; cleared when it succeeds. */
  let lastClaimReadFact: ClaimReadFact | null = null;
  const currentGeneration = (): Generation => generationOf(client);
  const sampleGeneration = (): void => {
    generationAtLastRead = currentGeneration();
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
      const metaPath = await meta.path();
      const lock = await client.getMailboxLock(metaPath);
      try {
        // The gate's read is bounded, and this is the read that most needed it: it had no ceiling
        // at all, so a folder anyone with APPEND rights can write to decided how much work every
        // election did — and at a large enough count the FETCH times out, read as "the lease
        // could not be read", exempted from the failure counter and retried indefinitely, so the
        // mailbox's MAIL stops moving. A truncated read is refused rather than decided on: the
        // nobody-has-organized arm is reached by seeing no claim, which is exactly what a hidden
        // claim looks like. No claim is appended, nothing is expunged, and the install keeps
        // whatever role it had — `ensureMetaFolder` has already run, so that is the exact
        // guarantee.
        const read = await readMetaFolderWindow(client, metaPath);
        // BESIDE THE RECORDS, INSIDE THE LOCK — see `generationAtLastRead`. Sampled before the
        // truncation throw as well, because the gate acts on that window too.
        sampleGeneration();
        if (read.truncated) {
          throw new MetaFolderTruncatedError(
            read.records.length, read.total, read.records, read.truncatedBy,
          );
        }
        return read.records;
      } finally {
        lock.release();
      }
    },

    uidValidity(): number | bigint | null {
      return generationAtLastRead;
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
       * unverifiable anchor is worse than none, because none simply falls back to the walk. */
      if (typeof uid === "number" && Number.isFinite(uid) && uid > 0 && generation !== null) {
        writeMemo(identity, generation, { claimUid: uid });
      } else {
        forgetMemo(identity, "claimUid");
      }
    },

    async findOwnRecords(_installId: string): Promise<RawClaimMessage[] | null> {
      /**
       * A current folder read, not a server search. This was a windowed `UID SEARCH HEADER
       * X-Ohmail-Install-Id`, and a real provider refused it on every poll while a plain
       * current-folder delete succeeded every time; "stop organizing here" must always be able to
       * finish. The locate is now the bounded read the gate decides from ({@link
       * readMetaFolderWindow}), under the caller's lock and the current UIDVALIDITY, selection
       * client-side. A window covering the folder whole is complete; one that could not is
       * refused with a code, never sliced. Given up: residue buried under more than a window
       * refuses `over_ceiling` — the caller's lapse bound ends that.
       */
      const metaPath = await meta.path();
      const lock = await client.getMailboxLock(metaPath);
      try {
        let read: MetaFolderRead;
        try {
          read = await readMetaFolderWindow(client, metaPath);
        } catch (err) {
          /* The read itself died — the connection, the SELECT, the FETCH. The provider's failure
           * rides in `cause`, where the logger reduces it to class + code and never its text. */
          throw new ClaimReleaseError(
            "unreadable",
            `the records in ${META_FOLDER} could not be read on this connection, so a complete `
            + "release cannot be told from a partial one and nothing was removed",
            { cause: err },
          );
        }
        /* Beside the records, inside the lock — the refs below are facts only under THIS
         * generation, and `removeClaims` refuses refs from another one. */
        sampleGeneration();
        if (read.truncated) {
          throw new ClaimReleaseError(
            "over_ceiling",
            `${META_FOLDER} holds ${read.total ?? "more"} records where one read may take `
            + `${META_RECORDS_MAX_PER_FETCH}, so a complete release cannot be told from a partial `
            + "one and nothing was removed",
          );
        }
        return read.records.map((m) => ({ ...m }));
      } finally {
        lock.release();
      }
    },

    /**
     * EVERY CLAIM IN THE FOLDER, wherever it sits — what the election reads when the window could
     * not cover the folder.
     *
     * Only claims carry `X-Ohmail-Lease`: a settings document carries `X-Ohmail-Profile`, a request
     * `X-Ohmail-Request`, an ack `X-Ohmail-Ack`. A MALFORMED claim still carries the discriminator
     * and still matches, which is deliberate — arm 4 distinguishes "nobody has ever organized this"
     * from "there is evidence here I cannot read", and that evidence must survive the search.
     */
    async listClaimRecords(): Promise<RawClaimMessage[] | null> {
      const claimPath = await meta.path();
      const lock = await client.getMailboxLock(claimPath);
      try {
        /* ── AN ANCHOR FROM ANOTHER GENERATION IS NOT AN ANCHOR ──────────────────────────────
         *
         * Checked BEFORE it is allowed to bound anything. The previous version checked only
         * afterwards, whether the anchored record had come back — by which point the stale number
         * had already set the floor of the gap read, so the reply omitted everything beneath it
         * and still looked like a complete claim set. */
        const generation = currentGeneration();
        const remembered = readMemo(identity, generation);
        let ownUid: number | null = null;
        if (remembered.kind === "memo" && typeof remembered.memo.claimUid === "number") {
          ownUid = remembered.memo.claimUid;
        } else if (remembered.kind === "invalidated") {
          /* The folder was replaced under us. Nothing remembered about the old numbering may bound
           * this read — a uid from it can sit above every record now present, including a rival's,
           * and the search would come back short while looking complete. */
          lastClaimReadFact = { fact: "lease_memo_invalidated", depth: 0, floor: 0, ownUid: null };
        }
        const invalidated = lastClaimReadFact;
        let gapWasRead = false;
        const set = await searchHeaders(client, claimPath, { header: { [H.lease]: true } }, {
          gapDownTo: ownUid,
          onGapRead: () => { gapWasRead = true; },
          onShortfall: (fact) => {
            /* A WALK THAT WAS SHORT BECAUSE ITS ANCHOR WAS DISCARDED should report the discard:
             * "the folder is deeper than one pass" is true but downstream of the reason, and the
             * reason is the one an operator can act on. The cause keeps precedence. */
            if (invalidated !== null) return;
            lastClaimReadFact = {
              fact: fact.closed ? "lease_gap_too_deep" : "lease_walk_short",
              depth: Math.max(0, fact.floor - (fact.ownUid ?? fact.floor)),
              floor: fact.floor,
              ownUid: fact.ownUid,
            };
          },
        });
        if (set === null) return null;
        lastClaimReadFact = invalidated;
        /* ── THE REMEMBERED UID IS CHECKED AGAINST WHAT CAME BACK ────────────────────────────
         *
         * Uids are never reused inside a UIDVALIDITY, so the record at ours cannot become someone
         * else's — but "cannot" is the kind of premise this module has been wrong about before,
         * and the cost of being wrong here is renewing against a stranger's claim. If our uid is
         * remembered and a record came back at it, it has to be a record we would recognise; if
         * it is absent, our claim is simply gone, which is a legitimate answer an election is
         * entitled to see. Either way the memory stops being trusted the moment it disagrees. */
        if (ownUid !== null && !set.some((m) => m.ref === ownUid)) {
          forgetMemo(identity, "claimUid");
          lastClaimReadFact = { fact: "lease_own_record_absent", depth: 0, floor: 0, ownUid };
          /* ── AND IF THAT NUMBER BOUNDED THE READ, THE READ IS NOT AN ANSWER ────────────────
           *
           * Where the walk covered the folder on its own, our claim being gone is a real answer
           * and the election is entitled to it. Where the GAP read ran, the set's completeness
           * rested on this uid being ours — and it is not, so the floor it set was arbitrary and
           * anything below it went unread. Handing that to an election is handing it a partial
           * claim set, which is the one input this module never accepts. */
          if (gapWasRead) return null;
        }
        return set;
      } finally {
        lock.release();
      }
    },

    claimReadFact(): ClaimReadFact | null {
      return lastClaimReadFact;
    },

    async removeClaims(refs: readonly unknown[]): Promise<void> {
      const uids = refs.filter((r): r is number => typeof r === "number");
      if (uids.length === 0) return;
      const lock = await client.getMailboxLock(await meta.path());
      try {
        /**
         * A uid is a fact only under the numbering it was read under. Every ref here came from a
         * read that sampled the folder's generation beside the records; if the folder was
         * replaced between that read and this lock, the numbering restarts and these uids name
         * whatever sits at them — another install's live claim, or the settings document.
         * Expunging by them would be deleting strangers on a stale map. Only a PROVEN mismatch
         * refuses — both generations known and different; an unknowable one proceeds, with the
         * confirm-by-re-read as backstop. `String(…)` because one side may be a bigint.
         */
        const gen = currentGeneration();
        if (generationAtLastRead !== null && gen !== null && String(gen) !== String(generationAtLastRead)) {
          throw new ClaimReleaseError(
            "renumbered",
            `${META_FOLDER} was renumbered between the read that named these ${uids.length} `
            + "record(s) and the delete, so the refs cannot be trusted and nothing was expunged",
          );
        }
        // imapflow's `messageDelete` RESOLVES `false` when the server refuses the STORE/EXPUNGE
        // — it does not reject. Swallowing that made a refused removal indistinguishable from a
        // done one, and the gate's takeover path is now load-bearing on the difference: a
        // handover whose displacement silently did not land returns `organize`, spends the
        // caller's one-shot authorization, and leaves the beaten claim standing to win the next
        // election. A refusal is a failure here, exactly as a rejection is.
        const done = await client.messageDelete(uids, { uid: true });
        if (done === false) {
          throw new Error(`the server refused to expunge ${uids.length} claim message(s) from ${META_FOLDER}`);
        }
        /**
         * And a `true` proves only that an expunge RAN, not that these messages went:
         * `messageDelete`'s STORE result is not propagated, so a refused STORE under an accepted
         * EXPUNGE resolves `true` having removed nothing, and the refusal check above cannot see
         * it. Custody is read back instead — the uids must be GONE. On the release path this is
         * the difference between reporting a claim removed and leaving it live while saying
         * otherwise. {@link proveGone} holds the rule for all three deletion paths, including the
         * late half: a read that could not RUN establishes nothing and must not return normally.
         */
        await proveGone(client, uids, "claim message(s)", "remove_claims");
      } finally {
        lock.release();
      }
    },
  };
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
}

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
/** One of the gate's three reads of the folder, and whether it covered the whole of it. */
interface GateRead {
  records: RawClaimMessage[];
  truncated: boolean;
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

export async function runLeaseGate(input: LeaseGateInput): Promise<LeaseGateResult> {
  const { io, self, now } = input;
  const log = input.log ?? ((): void => undefined);
  /* `randomUUID` from the MODULE, never the global `crypto`. The phone runs this file out of a
     bundle on Hermes, which has no global `crypto` at all, and the nonce is the clone defence —
     so reading a global meant a phone that could not claim its own mailbox, measured on a device.
     The import is substituted for the platform's crypto module in that bundle and is Node's here. */
  const newNonce = input.newNonce ?? ((): string => randomUUID());

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
   * A folder too full to read is reported and then WORKED WITH, not refused. The gate is the one
   * reader of `ohmail/_meta` that must not answer a full folder by refusing:
   * `LeaseUnavailableError` is exempted by class and answered by not syncing the mailbox, so a
   * refusal here would let one record over the ceiling — in a folder anyone with APPEND rights
   * can write to — stop a customer's mail with no self-healing path. The truncation is LOGGED
   * once per read with the counts (the one fault in this family that does not clear on its own),
   * and the newest records the window covered are used. Every other failure still refuses.
   */
  const readClaims = async (op: () => Promise<RawClaimMessage[]>): Promise<GateRead> => {
    try {
      const records = await op();
      return { records, truncated: false, uidValidity: io.uidValidity?.() ?? null };
    } catch (err) {
      if (err instanceof MetaFolderTruncatedError) {
        log("lease_meta_truncated", { read: err.read, limit: err.limit, total: err.total });
        return { records: [...err.records], truncated: true, uidValidity: io.uidValidity?.() ?? null };
      }
      throw err;
    }
  };

  /**
   * The election's read — neither the window nor a refusal; both obvious answers are wrong.
   * Acting on the window reads a newest-first slice as the folder: an incumbent renewed just
   * before five hundred appends is exactly an old record, so the election sees no claim, takes
   * arm 4, and appends — two organizers. Refusing outright is `LeaseUnavailableError` every
   * cycle, exempted by class: the mail stops and nothing quarantines. So the election asks the
   * server: only claims carry `X-Ohmail-Lease`, so the reply is complete for claims regardless of
   * position — the property an `organize` verdict needs. It refuses only when it cannot know.
   * `err.records` stays on the error for the release path, its only consumer.
   */
  const electionRead = async (windowed: GateRead): Promise<GateRead> => {
    if (!windowed.truncated) return windowed;

    const set = await io.listClaimRecords?.();
    if (set === null || set === undefined) {
      /**
       * Why it could not be read, where somebody will see it. The refusal below says the folder
       * holds more than one read may take — the common cause, not always the real one: a read can
       * also refuse because the folder was renumbered under a remembered uid, or the stretch
       * below that uid is past the budget, and those do not heal by waiting, unlike a full folder
       * the sweep eventually trims. Reporting them all as one thing is how a mailbox stuck for
       * good looks merely busy. The adapter records which it was; this is the only reader.
       */
      const why = io.claimReadFact?.();
      if (why) {
        log("lease_claim_read_refused", {
          fact: why.fact, depth: why.depth, floor: why.floor, ownUid: why.ownUid,
        });
      }
      throw new LeaseUnavailableError(
        `${META_FOLDER} holds more records than one read may take, and the claims in it could not `
        + "be asked for by header — this install cannot prove no other organizer holds this mailbox",
        { op: "meta_folder_full" },
      );
    }

    if (set.length > META_RECORDS_MAX_PER_FETCH) {
      /* A claim set over the ceiling is not something an honest folder produces by itself: the only
       * install that can legitimately have hundreds of claims here is THIS one, left by a writer
       * whose expunge kept failing (a refused STORE with an accepted EXPUNGE resolves `true`). The
       * protocol licenses an install to remove what it wrote, so its own residue is pruned to the
       * newest and the cycle refuses; next cycle the set is smaller. Nothing another install wrote
       * is touched — the folder is the customer's. */
      const ours = set
        .map((m) => ({ ref: m.ref, claim: parseClaim(m.raw, m.ref) }))
        .filter((c): c is { ref: unknown; claim: OrganizerClaim } =>
          c.claim !== null && !isMalformed(c.claim) && c.claim.installId === self.installId);
      /**
       * "Newest" means what `coalesce` means by it, and this used to mean something else:
       * comparing heartbeats alone with a strict `>` kept whichever copy the read yielded first
       * among equals — input order deciding which of this install's own records survives.
       * `coalesce` breaks the tie on the NONCE, and the record this prune keeps is the one the
       * next gate reads back as ours: drop the copy carrying `self.lastNonce` and keep a sibling,
       * and the next cycle finds a live claim under our own id it cannot account for — the clone
       * defence's exact trigger, aimed at ourselves. Equal heartbeats are ordinary here: a renew
       * and its residue are written in the same pass, stamped to the millisecond.
       */
      const newest = ours.reduce<{ ref: unknown; claim: OrganizerClaim } | null>(
        (best, c) => (best === null || compareRecency(c.claim, best.claim) < 0 ? c : best),
        null);
      const residue = ours
        .filter((c) => c !== newest)
        .map((c) => c.ref)
        .filter((r): r is unknown => r !== undefined);
      log("lease_claim_set_overflow", { claims: set.length, pruning: residue.length });
      if (residue.length > 0) {
        // Best effort: a refusal to prune is not a reason to fail differently. The cycle refuses
        // either way, and the next one tries again.
        await io.removeClaims(residue).catch(() => undefined);
      }
      throw new LeaseUnavailableError(
        `${META_FOLDER} holds ${set.length} claims, more than one read may take`,
        { op: "meta_folder_full" },
      );
    }

    log("lease_claim_set_searched", { claims: set.length });
    return { records: set, truncated: false, uidValidity: windowed.uidValidity };
  };

  let messages: RawClaimMessage[];
  /** The UID generation the ELECTION saw — the confirm compares refs against this. See there. */
  let electionUidValidity: number | bigint | null = null;
  try {
    const first = await electionRead(await readClaims(() => io.listClaims()));
    messages = first.records;
    electionUidValidity = first.uidValidity;
  } catch (err) {
    /* A REFUSAL THAT ALREADY SAYS WHY KEEPS ITS OWN WORDS. The election's `meta_folder_full` names a
     * condition this wrapper cannot: the folder is over the ceiling AND the claims in it could not
     * be asked for. Re-wrapping it as `list_claims` would erase the one field that tells an operator
     * which provider refused the header search, which is what the `op` is carried for. Same CLASS
     * either way, so every host's exemption is unaffected. */
    if (err instanceof LeaseUnavailableError) throw err;
    throw new LeaseUnavailableError(
      `the organizer lease in ${META_FOLDER} could not be read; this mailbox cannot be organized safely`,
      { op: "list_claims", cause: err },
    );
  }

  /**
   * The writer's own clock, before any append — read from the election's records (our own claim
   * carries both stamps for one instant), so it costs no round trip and is judged before this
   * gate can write. A refusal is `LeaseUnavailableError`, deliberately not a stand-down: both
   * hosts exempt the class, the mailbox does not sync and is not quarantined, our claim ages out
   * un-renewed — while a stand-down would void a one-shot press this pass could never have
   * honoured. One-cycle residual, stated: an install that has never written a claim has no pair
   * to measure, so its first gate run is unchecked; its own append supplies the pair and the next
   * cycle refuses.
   */
  const staleWindowMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  if (staleWindowMs > MAX_FUTURE_SKEW_MS) {
    // The honest interim for a window above the cutoff: the cutoff is fixed, so a
    // longer configured window is silently the smaller of the two. Said out loud, never widened.
    log("lease_window_above_skew_cutoff", { staleAfterMs: staleWindowMs, effectiveMs: MAX_FUTURE_SKEW_MS });
  }
  const skew = clockSkewRefusal({
    skewMs: ownClockSkewMs(messages, self.installId), staleAfterMs: staleWindowMs,
  });
  if (skew !== null) {
    log("lease_clock_skew_refused", { skewMs: skew.skewMs, bound: skew.bound, boundMs: skew.boundMs });
    throw new LeaseUnavailableError(
      `this computer's clock is ${Math.round(Math.abs(skew.skewMs) / 1000)}s ` +
      `${skew.bound === "ahead" ? "ahead of" : "behind"} the mail server's, which is more than the ` +
      `${Math.round(skew.boundMs / 1000)}s the organizer lease can tolerate; no claim is written ` +
      `until the clock is corrected`,
      { op: "clock_skew" },
    );
  }

  const claims = messages
    .map((m) => parseClaim(m.raw, m.ref))
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
        // only cost is the winner waiting out the staleness window. Logged, never thrown. A bare
        // string under `err` is safe here, and not by accident — do not "fix" it: `log.ts`'s
        // redactor special-cases the `err` key through `describeError`, which reads `name` and
        // `code`; a string has neither, so this reduces to `errorClass: "String"` and the message
        // is discarded before anything is written. Passing `err` whole survives no better and
        // costs the one property this line has: an IMAP driver's error carries the failing
        // command and, on a login path, the credential — reducing to a string HERE means there is
        // no object for a future redactor bug to walk. `op` rides along because this catch wraps
        // ONE operation, and the literal keeps that true.
        log("lease_release_failed", {
          op: "remove_claims" satisfies LeaseOp,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    log("lease_stand_down", { verdict: verdict.verdict });
    return { verdict, nonce: null, uidValidity: electionUidValidity };
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
    .sort(compareRecency)[0];
  const authorizedAt = verdict.authorized
    ? (input.takeover?.authorizedAt ?? null)
    : (newestOwn?.authorizedAt ?? null);

  const nonce = newNonce();
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
    /**
     * Through `readClaims` for the election's reason: a full folder must not turn a landed renew
     * into a mailbox that stops syncing. The old argument — everything the verify could newly
     * need is inside a newest-first window by construction — was false: a window is bounded by
     * COUNT, not time. A rival renews, a ceiling's worth of appends arrive, then we append: the
     * rival is more than a ceiling back, `ownSurvived` passes, and the rival goes on organizing
     * from the other side — two organizers without a lost write. So a verify over a TRUNCATED
     * folder asks the server for the claim set, exactly as the election does; below the ceiling
     * no search is issued; an unobtainable set refuses.
     */
    const after = (await electionRead(await readClaims(() => io.listClaims()))).records;
    verifyClaims = after
      .map((m) => parseClaim(m.raw, m.ref))
      .filter((c): c is ClaimRecord => c !== null);
  } catch (err) {
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
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return { verdict: survivors, nonce: null, uidValidity: electionUidValidity };
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
  const confirmed = decideLease({
    self: { ...self, lastNonce: nonce },
    claims: verifyClaims.filter((c) => c.ref === undefined || !displacedRefs.has(c.ref)),
    now,
    ...(input.staleAfterMs !== undefined ? { staleAfterMs: input.staleAfterMs } : {}),
  });

  if (confirmed.verdict !== "organize") {
    const ours = verifyClaims
      .filter((c): c is OrganizerClaim => !isMalformed(c) && c.installId === self.installId)
      .map((c) => c.ref)
      .filter((r): r is unknown => r !== undefined);
    if (ours.length > 0) {
      try {
        await io.removeClaims(ours);
      } catch (err) {
        log("lease_release_failed", {
          op: "remove_claims" satisfies LeaseOp,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    log("lease_lost_race", { verdict: confirmed.verdict });
    return { verdict: confirmed, nonce: null, uidValidity: electionUidValidity };
  }

  // WHAT THIS WIN DISPLACED, plus our own older copies. One expunge, so a takeover cannot land
  // half-applied — leaving the beaten claim behind is what made a takeover reverse itself on the
  // next cycle, and leaving our own older copies behind is the append-then-expunge residue readers
  // coalesce away.
  // A best-effort release of a set of refs — the failure mode of every release: logged, never
  // thrown, because a cleanup must not convert the state it is cleaning into a fault.
  const releaseRefs = async (refs: readonly unknown[]): Promise<void> => {
    if (refs.length === 0) return;
    try {
      await io.removeClaims(refs);
    } catch (releaseErr) {
      log("lease_release_failed", {
        op: "remove_claims" satisfies LeaseOp,
        err: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
      });
    }
  };

  const toRemove = [...ourRefs, ...verdict.displace];
  if (toRemove.length > 0) {
    let removalErr: unknown = null;
    try {
      await io.removeClaims(toRemove);
    } catch (err) {
      if (verdict.displace.length === 0) {
        // An ORDINARY renew's failed cleanup is harmless: the folder holds our new claim plus
        // our own older copies, and readers coalesce by newest heartbeat. The next renew tries
        // again.
        //
        // The bare string under `err` is deliberate, for the reason spelled out at
        // `lease_release_failed` above: `log.ts` special-cases `err` into `describeError`, a
        // string has no `name`/`code`, so this emits `errorClass: "String"` and nothing else.
        // Passing the error object instead would hand a redactor an IMAP driver error that can
        // carry the failing command and the credential.
        log("lease_cleanup_failed", {
          op: "remove_claims" satisfies LeaseOp,
          err: err instanceof Error ? err.message : String(err),
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
    // keeps trusting the resolve: its leftovers are our own duplicates, not worth a FETCH per
    // cycle. The re-read has its own failure path: a FETCH rejecting after a removal that may
    // have landed is a READ fault — rolling back could leave no claim at all — so it throws
    // `list_claims` and rolls nothing back.
    if (verdict.displace.length > 0) {
      let read: GateRead;
      try {
        read = await readClaims(() => io.listClaims());
      } catch (err) {
        throw new LeaseUnavailableError(
          `the organizer lease in ${META_FOLDER} could not be re-read after the handover was ` +
          `recorded, so the takeover cannot be confirmed this cycle`,
          { op: "list_claims", cause: err },
        );
      }
      const after = read.records;
      const afterClaims = after
        .map((m) => parseClaim(m.raw, m.ref))
        .filter((c): c is ClaimRecord => c !== null);
      const ownStanding = afterClaims
        .filter((c): c is OrganizerClaim => !isMalformed(c) && c.installId === self.installId && c.nonce === nonce);
      const stillRefs = new Set(after.map((m) => m.ref));
      /**
       * An absence is only evidence for a ref the window actually covered. A custody check — is
       * the claim I displaced really gone — is the one place a truncated read cannot be worked
       * with: old is exactly what a newest-first window drops, so a displaced claim outside the
       * window is absent for the same reason an expunged one is, and reading that as success
       * confirms a handover that never landed. UIDs ascend with arrival, so a ref below the
       * window's floor is one this read could not have seen: treated exactly as a SURVIVOR,
       * because "still there" and "I could not look" have the same correct answer here.
       */
      /**
       * And a UIDVALIDITY change makes the comparison meaningless altogether: refs are UIDs, and
       * after a renumbering `stillRefs.has(r)` compares two numbering schemes — it can answer
       * "gone" for a claim sitting there under a new uid, the same false confirmation by another
       * route. Treated exactly as a truncated read, because it is the same fact: this read cannot
       * speak about those refs. `null` on either side means the connection does not report the
       * generation, which resolves to "no change detected" and leaves the gate as it was.
       */
      const renumbered = read.uidValidity !== null
        && electionUidValidity !== null
        && read.uidValidity !== electionUidValidity;
      /* An absence is only evidence for a ref the window COVERED — and the check is gated on
       * `truncated` so the floor is a real observation rather than a sentinel doing the work. On a
       * complete read there is nothing to prove: every ref that exists is in `after`. */
      const unprovable = read.truncated || renumbered
        ? verdict.displace.find((r) => {
          if (stillRefs.has(r)) return false;
          if (renumbered) return true;
          const floor = after.reduce<number>(
            (lo, m) => (typeof m.ref === "number" && m.ref < lo ? m.ref : lo), Infinity,
          );
          return !(typeof r === "number" && Number.isFinite(floor) && r >= floor);
        })
        : undefined;
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
          return { verdict: survivors, nonce: null, uidValidity: electionUidValidity };
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
        return { verdict: finalElection, nonce: null, uidValidity: electionUidValidity };
      }

      // Custody holds: the displaced are gone and our claim stands — the handover landed,
      // whatever the driver reported on the way. A held removal error is downgraded to the
      // renew-cleanup log line: it described a write whose effect the re-read has now seen.
      if (removalErr !== null) {
        log("lease_cleanup_failed", {
          op: "remove_claims" satisfies LeaseOp,
          err: removalErr instanceof Error ? removalErr.message : String(removalErr),
        });
      }
    }
  }
  return { verdict, nonce, uidValidity: electionUidValidity };
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
   * WHICH MAILBOX THE DECISION IS ABOUT, and it is inside the signed body deliberately. An
   * organizer applies a record only when this equals the mailbox whose folder it
   * read the record FROM — so a record lifted out of one mailbox's `_meta` and appended to
   * another's is refused rather than applied to whichever mailbox happened to be draining.
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

  /* The claim arm's set, spelled once more because the request header is a second door onto the
     same vocabulary — widening one and not the other refuses a phone's requests alone. */
  const organizerKindRaw = (get(RH.organizerKind) ?? "").toLowerCase();
  const organizerKind: OrganizerKind | "unknown" =
    organizerKindRaw === "local" || organizerKindRaw === "cloud" || organizerKindRaw === "mobile"
      ? organizerKindRaw : "unknown";

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
  /** The record names a mailbox other than the one whose folder it was read from. */
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
  | "no_request_io";

export class RequestUnavailableError extends Error {
  readonly op: RequestOp;
  constructor(message: string, options: { op: RequestOp; cause?: unknown }) {
    super(message, options);
    this.name = "RequestUnavailableError";
    this.op = options.op;
  }
}

/**
 * The folder, read once — and the two ROLES that read it. One FETCH, three parsers: {@link
 * listMetaRecords} sorts one read into its kinds, so a fourth record type costs no round trip.
 * The loop underneath is shared too — three separate `FETCH 1:*` loops once stood here, each with
 * its own ceiling and empty-folder defence, two keeping the OLDEST records when the ceiling bit;
 * they are one function now ({@link readMetaFolderWindow}), census-pinned. And two objects,
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
 * The ceiling on one folder read. Every legitimate population of `ohmail/_meta` is tiny — one
 * claim per install, one ack per decision in flight, the decisions themselves — and this is far
 * above all of it: its job is to stop anyone with APPEND rights choosing how much work a cycle
 * does, not to be tight. It bounds ONE READ and is not a filter: passing it makes the read
 * REFUSE, never drop records — {@link readMetaFolderWindow} explains why a ceiling that silently
 * keeps a subset makes a partial view indistinguishable from a complete one, and every decision
 * taken from this folder is wrong on a partial view.
 */
export const META_RECORDS_MAX_PER_FETCH = 500;

/* `SEARCH_UIDS_MAX` is declared far above, beside the search it bounds, and must stay one past
 * this ceiling. Spelled as a literal there because this constant is declared later in the file;
 * pinned here so the two cannot drift apart silently — a cap BELOW the ceiling would make an
 * exactly-at-the-ceiling claim set look oversized, and one far above would put the bound back
 * where it cannot do its job. */
const _searchCapMatchesCeiling: SEARCH_UIDS_MAX_IS_CEILING_PLUS_ONE = true;
type SEARCH_UIDS_MAX_IS_CEILING_PLUS_ONE = typeof SEARCH_UIDS_MAX extends 501 ? true : never;
void _searchCapMatchesCeiling;

/** The shared read: the folder's headers, unfiltered and bounded — the parsers sort it out. */
export interface MetaRecordsIo {
  /**
   * The newest records in `ohmail/_meta` — or, given `beforeUid`, the newest BELOW that uid, which
   * is the next page down. See {@link readMetaFolderWindow}.
   */
  listMetaRecords(beforeUid?: number): Promise<RawMetaMessage[]>;
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
   * Expunge every ack older than `before`, WITHOUT reading the folder first. The ack sweep is the
   * only thing that ever makes `ohmail/_meta` smaller, and it sat behind the bounded read — which
   * refuses a folder over the ceiling — so a folder that crossed the ceiling BY ACKS could never
   * come back down: the read refuses, the sweep never runs, every drain refuses for ever. The
   * compactor was locked behind the thing it exists to fix. Asked of the server by header and
   * date — integers in, an expunge out, no FETCH, bounded by construction; INTERNALDATE of an ack
   * this organizer appended is its `ackedAt` to the day. Optional: a client that cannot search
   * does not sweep. Returns how many were removed.
   */
  sweepStaleAcks?(before: Date): Promise<number>;
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
 * The shared read — one `FETCH 1:*` of `ohmail/_meta`'s headers, unfiltered on purpose: the three
 * record kinds are told apart by a header the caller's own parser reads, and filtering here would
 * mean a second round trip the moment a caller wants two of them; {@link requestEnvelopesIn} and
 * {@link acksIn} sort one read into its kinds. An absent folder THROWS, and that is a correctness
 * fix: answering `[]` was harmless for the organizer's drain and wrong for the READER, whose
 * state machine reads "my record is not in the folder" as "the organizer took it" — an absent
 * folder told a person every decision was applied at the exact moment the evidence said nobody
 * was organizing at all. {@link RequestUnavailableError}, and the reader transitions nothing.
 */
function makeMetaRecordsList(
  client: LeaseImapClient,
  meta: MetaFolderRef,
  op: RequestOp,
  /**
   * REPORTS THE GENERATION OF THE FOLDER THIS READ ACTUALLY OPENED, sampled while it is still
   * selected.
   *
   * A caller that samples `client.mailbox` on its own gets whatever folder the surrounding cycle
   * last selected — the INBOX, in the worker's case — and pairs its position with a number
   * belonging to a different mailbox entirely. That is not a stale generation, it is somebody
   * else's, and it made every comparison meaningless in both directions.
   */
  onGeneration?: (generation: Generation) => void,
): (beforeUid?: number) => Promise<RawMetaMessage[]> {
  return async (beforeUid?: number): Promise<RawMetaMessage[]> => {
    let at: MetaFolderLocation;
    try {
      at = await meta.locate();
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
      const lock = await client.getMailboxLock(at.path);
      try {
        // The shared bounded read — see {@link readMetaFolderWindow}. An empty folder is a real
        // answer and comes back as one; a folder too full for a single window is not, and falls
        // into the refusal below for the same reason an ABSENT folder does.
        const read = await readMetaFolderWindow(client, at.path, beforeUid);
        // Inside the lock, with `_meta` open: this is the only place the right folder is
        // guaranteed to be the selected one.
        onGeneration?.(generationOf(client));
        if (read.truncated) {
          throw new MetaFolderTruncatedError(
            read.records.length, read.total, read.records, read.truncatedBy,
          );
        }
        return read.records;
      } finally {
        lock.release();
      }
    } catch (err) {
      if (err instanceof RequestUnavailableError) throw err;
      // NAMED, not folded into the generic sentence: the count is the only thing that tells whoever
      // reads the line what is wrong, and the two drains log this message verbatim. A caller that
      // saw only "could not be read" would go looking at the mail server for a fault that is a full
      // folder.
      if (err instanceof MetaFolderTruncatedError) {
        throw new RequestUnavailableError(err.message, { op, cause: err });
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
export function makeRequestOrganizerIo(
  client: LeaseImapClient,
  toServerPath: (canonical: string) => string,
  identity: MetaIdentity,
): RequestOrganizerIo {
  assertMetaIdentity("makeRequestOrganizerIo", identity);
  const meta = makeMetaFolderRef(client, toServerPath);
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
     * See {@link RequestOrganizerIo.sweepStaleAcks}. Only acks match — a request carries
     * `X-Ohmail-Request` and a claim `X-Ohmail-Lease` — so nothing else can be caught by it, and
     * `before` is compared against INTERNALDATE by the server rather than by a parse here.
     */
    async sweepStaleAcks(before: Date): Promise<number> {
      const metaPath = await meta.path();
      const lock = await client.getMailboxLock(metaPath);
      try {
        if (typeof client.search !== "function") {
          throw new RequestUnavailableError(
            `${META_FOLDER} cannot be searched by this connection, so stale acknowledgements `
            + "cannot be identified and none were removed",
            { op: "sweep_acks" },
          );
        }
        /**
         * The cutoff is floored to a day boundary, and that is not rounding. IMAP's SEARCH BEFORE
         * takes a DATE; without `WITHIN` the library widens a time-of-day cutoff by one day so a
         * caller is never given less than it asked for — right for a reader, exactly wrong here,
         * because this call DELETES and the widened term reaches records filed on the cutoff's
         * own day: an acknowledgement half a day old removed as though a day past its life.
         * Flooring makes the term one the library sends unchanged and moves the only error to the
         * safe side: keeping a record too long costs one row in a folder swept again next cycle;
         * removing a live one loses an answer somebody is waiting for.
         */
        const floored = ackSweepCutoff(before);
        /* ── WINDOWED, LIKE EVERY OTHER READ HERE ────────────────────────────────────────────
         *
         * The ceiling comes from the server rather than the connection's cached mailbox object,
         * for the reason the claim search states: a stale ceiling puts every window below the
         * records that matter. Without one there is no window to ask in, and this module has one
         * answer for "I cannot ask in a way I can bound". */
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
        const found: number[] = [];
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
          const page = await client.search(
            { header: { [AH.ack]: true }, before: floored, uid: `${lo}:${hi}` }, { uid: true },
          );
          /* A REFUSED SEARCH IS NOT AN EXHAUSTED BUDGET. The library resolves `false` rather
           * than rejecting, and treating that as "stop looking" reports a sweep that never ran —
           * the caller reads 0 stale and concludes there is nothing to compact, which is the one
           * conclusion that keeps a full folder full. Running out of WINDOWS is a smaller day's
           * work and breaks; being refused is a fault and throws. */
          if (!Array.isArray(page)) {
            throw new RequestUnavailableError(
              `the search for stale acknowledgements in ${META_FOLDER} was refused, so none were `
              + "removed and the folder was not compacted",
              { op: "sweep_acks" },
            );
          }
          found.push(...page);
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
        /* A REFUSED SEARCH IS NOT AN EMPTY FOLDER — the library resolves `false` rather than
         * rejecting. Returning 0 for it reported a sweep that had not happened, and the sweep is
         * the only thing that ever makes this folder smaller: a caller told "0 stale" concludes
         * there is nothing to compact. The drain already logs a failed sweep and carries on, which
         * is what it should do with this. */
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
        for (let i = 0; i < budget; i += SWEEP_DELETE_BATCH) {
          const batch = found.slice(i, Math.min(i + SWEEP_DELETE_BATCH, budget));
          const done = await client.messageDelete(batch, { uid: true });
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
          await proveGone(client, batch, "stale acknowledgement(s)", "sweep_acks");
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
        throw new RequestUnavailableError(
          `${uids.length} message(s) in ${META_FOLDER} could not be removed`,
          { op: "remove_requests", cause: err },
        );
      }
    },
  };
}
