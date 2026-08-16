import { WATCHED_FOLDERS } from "./imap-types.js";

/**
 * THE ORGANIZER LEASE — how two databases that can never see each other agree on who organizes
 * a mailbox.
 *
 * A LOCAL desktop install runs on its own on-disk PGlite and structurally cannot query the hosted
 * cloud database; Cloud runs on that database and cannot see the desktop's PGlite. The mailbox is
 * the only medium they share, so the claim lives **in the mailbox**: one message per organizer in
 * an unsubscribed `ohmail/_meta` folder.
 *
 * ── IT IS A LEASE, NOT A MUTEX, AND THAT IS NOT A HEDGE ───────────────────────────────────
 *
 * IMAP has no compare-and-swap. Two installs can APPEND in the same instant and both succeed.
 * What this buys is conflict DETECTION with every-cycle re-verification, and that is enough for
 * the actual requirement: a transient one-cycle overlap is idempotent-safe, while steady-state dual
 * organizing becomes impossible because the loser's next gate refuses. Do not upgrade the naming or
 * the comments to "lock" — the word would be a claim the mechanism cannot make.
 *
 * **The REASON for that idempotence changed under this comment.** It used
 * to read "the pipeline dedups by Message-ID"; that is no longer true — `dedup_key` is
 * `fp1:<sha256>` over every field a sender chooses, and the Message-ID is one input among ten. The
 * conclusion survives for a BETTER reason: the fingerprint is a strictly finer identity, so two
 * engines ingesting the same bytes still resolve to the same row, and the second engine's
 * observation of a locator the first already recorded is now an `external_copy` — which writes one
 * instance row and changes no placement — rather than an adoption. A transient overlap therefore
 * costs a duplicate fetch, not a fought-over `desired_folder`.
 *
 * Why two organizers must never coexist, concretely: `runSyncCycle` ingests *through* the
 * pipeline, so syncing and organizing are one loop. Two organizers means two engines classifying
 * the same new message and issuing competing moves — and `adopt_external` ("reality changed in a
 * way we did not cause, so the user wins") was written for a HUMAN in another mail client, not
 * for a second ohmail fighting the first. `adopt_external` is explicitly
 * NOT load-bearing here.
 *
 * ── THREE LAYERS, AND THE SPLIT IS THE POINT ──────────────────────────────────────────────
 *
 *   1. FORMAT  — {@link formatClaim} / {@link parseClaim}. Pure string work.
 *   2. DECISION — {@link decideLease}. A pure function over parsed claims, so the whole table is
 *      unit-testable without a server and every arm can be watched fail.
 *   3. IO — {@link LeaseIo} and {@link runLeaseGate}. The only part that needs a connection.
 *
 * The decision layer never touches IO and the IO layer never decides. That is what makes the
 * priority table checkable at all: a decision function that could also fail to read is a
 * function whose "stand down" and "could not look" are the same code path, and §3.4 exists
 * because those two must never be reachable from one another.
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

/** Who is holding a claim. A closed set — an unrecognised value is foreign-and-unknown. */
export type OrganizerKind = "local" | "cloud";

/** Whether a human has authorized THIS organizer to become the organizer of this mailbox. */
export type TakeoverAuthorization = "authorized" | "none";

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
 * Who we are, for the gate.
 *
 * ── THE CLONE DEFENCE, AND WHY `lastNonce` IS MEMORY-ONLY ─────────────────────────────────
 *
 * Restore-from-backup clones the install id. Two machines then both believe every claim carrying
 * that id is their own, and identity matching — which is what makes own-role resumption work —
 * silently permits exactly the dual organizing it was written to prevent.
 *
 * So every write carries a fresh nonce and the writer remembers the last one it wrote. An "own"
 * claim whose nonce is NOT the one we wrote, and whose heartbeat is NEWER than ours, is somebody
 * else with our id: treat it as foreign.
 *
 * `lastNonce` is held IN MEMORY ONLY and deliberately forgotten on restart. Persisting it would
 * break own-role resumption — after a crash we would not recognise our own claim and would stand
 * down from a mailbox nobody else wants. Forgetting it means a fresh process trusts any claim
 * bearing its id exactly once, which is the correct trade: the clone case needs two LIVE writers
 * to be dangerous, and two live writers is exactly the case a null nonce cannot reach.
 */
export interface LeaseSelf {
  installId: string;
  kind: OrganizerKind;
  displayName: string;
  /** The nonce of our last write this process, or `null` on a fresh start. */
  lastNonce: string | null;
  protocol?: number;
}

export type StandDownReason =
  | "organized_elsewhere:cloud"
  | "organized_elsewhere:local"
  | "organized_elsewhere:unknown";

/** Organize this mailbox, and renew our claim while doing so. */
export interface OrganizeVerdict {
  verdict: "organize";
  renew: true;
  /**
   * REFS OF THE FOREIGN CLAIMS THIS WIN DISPLACED, for the IO layer to expunge.
   *
   * ── WHY A TAKEOVER MUST CHANGE THE FOLDER, AND NOT JUST OUR MIND ───────────────────────────
   *
   * Populated only on an AUTHORIZED takeover — never on an ordinary renew, and never on
   * own-role resumption. It is the mechanism that makes a handover converge, and without it the
   * whole arbitration below is undone one cycle after it runs.
   *
   * The sequence it closes, measured rather than imagined: a human authorizes install B over
   * install A's claim. B wins and appends. On the NEXT cycle both sides election over `{A, B}`
   * and A wins on incumbency — so B stands down again, and the takeover the user asked for is
   * quietly reversed. A permanent state, because nothing else ever changes.
   *
   * The folder is the only medium the two installs share, so the decision has to be recorded
   * THERE. Once A's claim is gone, A's own next read finds its claim missing and another live
   * claim present, and A stands down — which is the correct outcome reached from the shared
   * medium rather than from either side's opinion about the other's clock.
   *
   * Expunging somebody else's bookkeeping is a real side effect and it is deliberately narrow:
   * it happens only when a human explicitly asked this install to take this mailbox, and its
   * worst case if the peer is alive is that the peer stands down — the SAFE direction, fewer
   * organizers and never more.
   */
  displace: readonly unknown[];
}

/** Somebody else is organizing this mailbox right now. Stop, and release our own claim. */
export interface StandDownVerdict {
  verdict: "stand_down";
  reason: StandDownReason;
  /** The winning claim, so a UI can name the machine. `null` when it was malformed. */
  by: OrganizerClaim | null;
}

/**
 * Nobody is organizing this mailbox, but somebody WAS.
 *
 * The third verdict, and the one a two-verdict table gets wrong. "No fresh foreign claim ⇒
 * organize" is precisely §4's forbidden auto-resume: a Cloud subscription lapses, and a
 * forgotten install on an office machine silently becomes the thing that moves someone's mail,
 * triggered by a billing event, with a rules store frozen at stand-down.
 *
 * §4's governing principle is that **ceasing to organize is always automatic; BECOMING an
 * organizer always requires an explicit human action** — including for Cloud. `available` is
 * that principle with a name. It converts to `organize` only when the caller passes
 * `takeover: "authorized"`, which means a human clicked something.
 *
 * Zero claims is NOT this. A mailbox nobody has ever organized has nobody to take over from.
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
} as const;

/** Strip CR/LF so a display name can never inject a header. */
function headerSafe(v: string): string {
  return v.replace(/[\r\n]+/g, " ").trim();
}

export interface ClaimInput {
  installId: string;
  kind: OrganizerKind;
  displayName: string;
  heartbeat: Date;
  claimedAt: Date;
  nonce: string;
  protocol?: number;
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
  const lines = [
    `${H.lease}: 1`,
    `${H.kind}: ${c.kind}`,
    `${H.installId}: ${headerSafe(c.installId)}`,
    `${H.protocol}: ${protocol}`,
    `${H.heartbeat}: ${c.heartbeat.toISOString()}`,
    `${H.claimedAt}: ${c.claimedAt.toISOString()}`,
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

  // ── A RECORD THAT SAYS `X-Ohmail-Lease: 1` ANYWHERE IS NEVER INVISIBLE ────────────────────
  //
  // The discriminator used to be read with last-value-wins, so a record whose headers were
  // `X-Ohmail-Lease: 1` … `X-Ohmail-Lease: 0` parsed as NOT A CLAIM AT ALL — `null`, which the
  // gate drops entirely. An incumbent's only claim could therefore be erased from every reader's
  // view by one duplicated header, and the next install to look would find an empty folder and
  // start organizing beside it. Reproduced against the parser, not inferred.
  //
  // So the DUPLICATE is what is refused, and it is refused as `malformed` rather than as `null`:
  // "a message that announces itself and cannot be read" is evidence somebody claimed, and
  // evidence produces `available` at worst. `null` is reserved for a record that never claimed
  // anything — a stray note, or a future meta record type this build does not know.
  if (count(H.lease) > 1) return malformed("duplicate lease header");
  if (get(H.lease) !== "1") return null; // not a claim — a stray, or a future meta record type
  // Every field the decision reads gets the same treatment, for the same reason: a duplicated
  // `X-Ohmail-Install-Id` or `X-Ohmail-Heartbeat` would let a crafted record present one identity
  // to a reader that takes the first value and another to one that takes the last.
  for (const field of [H.kind, H.installId, H.protocol, H.heartbeat, H.claimedAt, H.nonce]) {
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

  const kindRaw = (get(H.kind) ?? "").toLowerCase();
  const kind: OrganizerKind | "unknown" = kindRaw === "local" || kindRaw === "cloud" ? kindRaw : "unknown";

  const claim: OrganizerClaim = {
    installId,
    kind,
    protocol,
    heartbeat,
    claimedAt: Number.isNaN(claimedAt.getTime()) ? heartbeat : claimedAt,
    displayName: get(H.displayName) ?? "",
    nonce: get(H.nonce) ?? "",
  };
  return ref === undefined ? claim : { ...claim, ref };
}

// ── LAYER 2: THE DECISION ───────────────────────────────────────────────────────────────────

export interface DecideLeaseInput {
  self: LeaseSelf;
  claims: readonly ClaimRecord[];
  now: Date;
  staleAfterMs?: number;
  /** `"authorized"` iff a human explicitly asked THIS organizer to take this mailbox. */
  takeover?: TakeoverAuthorization;
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
 * HOW FAR INTO THE FUTURE A PEER'S CLOCK IS BELIEVED.
 *
 * A heartbeat later than our own clock is normal and must be tolerated — two machines have two
 * clocks, and treating a slightly-ahead peer as gone is how both sides conclude they are the
 * organizer. But the tolerance has to have an END, and it did not: a claim dated 2099 by a machine
 * with a dead clock battery stayed "fresh" for seventy-three years, and no authorization could
 * take the mailbox back from it. Measured against the decision function, not inferred: a `cloud`
 * claim dated `2099-01-01` produced `stand_down` for an authorized local, indefinitely.
 *
 * One staleness window, so a peer may be believed up to twice the window ahead of reality and no
 * further. Beyond that the heartbeat is CLAMPED rather than rejected — the claim still counts as a
 * claim, it simply stops being able to look newer than now.
 */
export const MAX_FUTURE_SKEW_MS = DEFAULT_STALE_AFTER_MS;

/**
 * THE ELECTION. **A pure function of the folder's contents — never of the reader's clock.**
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE RULE THAT MATTERS, AND THE FAMILY OF BUGS IT REPLACES
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The previous table asked "is this peer's claim fresh?" as `now(mine) - heartbeat(theirs) <
 * staleAfterMs`. That question mixes two clocks, and **two readers of the same folder could answer
 * it differently** — which is the whole bug family, because two readers that disagree about the
 * candidate set can each conclude they won.
 *
 * Three split-brains were reproduced by execution against the old function, and every one of them
 * is this single mistake:
 *
 *  · **A laptop that slept.** NO CLOCK SKEW REQUIRED, and this is the most reachable of the
 *    three. Install A sleeps past the window; B is active. B sees A as stale, so A is not in B's
 *    candidate set and B continues on its own claim. A wakes, sees B as fresh, and beats B on
 *    incumbency because A's `claimedAt` is older — so A organizes too. Both write, indefinitely.
 *  · **Five minutes of clock skew.** B's clock runs ahead, so A's claim reads as stale to B and
 *    the surface actively OFFERS a takeover. B takes it; A then reads B's future-dated claim as
 *    fresh (correctly) but wins incumbency, so A keeps organizing. No convergence: A is stale to B
 *    forever.
 *  · **Two clouds.** `freshCloud` was computed and then consulted only when `self.kind ===
 *    "local"`, so two cloud organizers each fell through to "I hold a fresh claim, therefore
 *    organize" for ever. The leader lock masks it in one deployment; the lease provided no
 *    protection at all, and the leader lock is not the lease.
 *
 * So freshness is redefined **relative to the folder**: the newest heartbeat present is the
 * reference, and a claim more than one window older than it has LAPSED. Every reader computes the
 * same reference from the same messages, so every reader computes the same candidate set and the
 * same winner. Agreement is now structural rather than probable.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHERE THE READER'S CLOCK IS STILL USED, AND WHY NEITHER USE IS THE ARBITER
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 *  1. **As a CEILING on a future heartbeat** ({@link MAX_FUTURE_SKEW_MS}). An upper bound cannot
 *     change the order of two honestly-clocked claims; it can only stop a broken clock from
 *     outranking everything for ever.
 *  2. **To decide whether the whole folder has gone QUIET** — `now - newest >= staleAfterMs`, which
 *     is what makes a mailbox OFFERABLE for takeover. This is single-sided and can only ever lead
 *     to a human being asked a question. Getting it wrong in the permissive direction produces an
 *     authorized takeover that displaces a live install, which is one organizer — the safe
 *     direction — and is exactly what an authorized takeover is defined to do.
 *
 * Nothing else. **A reader's clock can no longer decide who organizes a mailbox.**
 */
interface Election {
  /** Claims present in the folder, coalesced, with a clamped heartbeat. */
  candidates: readonly OrganizerClaim[];
  /** Not lapsed relative to the newest heartbeat in the folder. */
  live: readonly OrganizerClaim[];
  /** The strongest live candidate, or `null` when the folder holds no readable claim. */
  winner: OrganizerClaim | null;
  /**
   * Claims whose heartbeat is NOT implausibly far in the future, keyed by the object identity of
   * the clamped candidate.
   *
   * A claim dated 2099 by a machine with a dead clock battery is a claim, and it must still be
   * RANKED (or two readers would disagree about the candidate set and both organize — see
   * {@link runElection}). What it must not do is grant its writer the protections reserved for an
   * organizer that is demonstrably alive. So implausibility is tracked separately from the
   * election rather than by removing the claim from it.
   */
  plausible: ReadonlySet<OrganizerClaim>;
  /** Nothing PLAUSIBLE in the folder has been renewed within one window of the READER's now. */
  quiet: boolean;
  /** Claims that announce themselves and cannot be read. Evidence, never nothing. */
  malformed: readonly MalformedClaim[];
}

/** `min(heartbeat, now + MAX_FUTURE_SKEW_MS)` — see {@link MAX_FUTURE_SKEW_MS}. */
function clampHeartbeat(c: OrganizerClaim, now: Date): OrganizerClaim {
  const ceiling = now.getTime() + MAX_FUTURE_SKEW_MS;
  if (c.heartbeat.getTime() <= ceiling) return c;
  return { ...c, heartbeat: new Date(ceiling) };
}

/**
 * Strongest first.
 *
 *  1. `cloud` outranks `local` — §4's "a fresh cloud lease outranks local for CONTINUING
 *     coverage". A cloud claim is only ever IN the folder because a cloud won a gate, and winning
 *     one over a live local already required a human, so presence is the proof of continuation.
 *  2. Then INCUMBENCY: the oldest `claimedAt`. Nobody self-promotes by arriving.
 *  3. Then `installId`, then `nonce` — a TOTAL order, so no two readers can break a tie
 *     differently. The nonce is what closes the restored-clone case, where two live processes
 *     share an install id AND a `claimedAt`: `compareIncumbency` returned 0, `Array.sort` is not
 *     required to be stable across differing input orders, and two clones reading the same folder
 *     in different orders each elected themselves. Measured, not theorised.
 */
function compareStrength(a: OrganizerClaim, b: OrganizerClaim): number {
  const kindRank = (k: OrganizerClaim["kind"]): number => (k === "cloud" ? 2 : k === "local" ? 1 : 0);
  const byKind = kindRank(b.kind) - kindRank(a.kind);
  if (byKind !== 0) return byKind;
  const byClaimed = a.claimedAt.getTime() - b.claimedAt.getTime();
  if (byClaimed !== 0) return byClaimed;
  if (a.installId !== b.installId) return a.installId < b.installId ? -1 : 1;
  return a.nonce < b.nonce ? -1 : a.nonce > b.nonce ? 1 : 0;
}

function runElection(claims: readonly ClaimRecord[], now: Date, staleAfterMs: number): Election {
  const { valid, malformed } = coalesce(claims);
  const ceiling = now.getTime() + MAX_FUTURE_SKEW_MS;
  const plausible = new Set<OrganizerClaim>();
  const candidates = valid.map((raw) => {
    const c = clampHeartbeat(raw, now);
    if (raw.heartbeat.getTime() <= ceiling) plausible.add(c);
    return c;
  });

  // THE REFERENCE IS IN THE FOLDER, not on this machine. Clamped, so a broken clock cannot lapse
  // every honest claim in the folder by more than one window.
  const newest = candidates.reduce<number>((m, c) => Math.max(m, c.heartbeat.getTime()), -Infinity);
  const live = candidates.filter((c) => newest - c.heartbeat.getTime() < staleAfterMs);
  const winner = [...live].sort(compareStrength)[0] ?? null;

  // The one place the reader's clock decides anything, and it decides only whether to ASK a human.
  // Computed over PLAUSIBLE heartbeats only: a folder holding nothing but a claim dated 2099 has
  // gone quiet, and reading it as busy is what let one dead machine hold a mailbox for seventy-three
  // years with no way out short of a person deleting the message by hand.
  const newestPlausible = candidates
    .filter((c) => plausible.has(c))
    .reduce<number>((m, c) => Math.max(m, c.heartbeat.getTime()), -Infinity);
  const quiet = !Number.isFinite(newestPlausible) || now.getTime() - newestPlausible >= staleAfterMs;

  return { candidates, live, winner, plausible, quiet, malformed };
}

/**
 * WHO MAY ORGANIZE THIS MAILBOX. Pure — no clock of its own, no IO, no side effects.
 *
 * The order below is the order of the reasons, and each traces to a ruling rather than a
 * preference:
 *
 *  1. **A live claim in a protocol we do not understand ⇒ stand down.** Never "unparseable, so
 *     ignore": a future format that older installs skipped would silently re-enable dual
 *     organizing against every one of them. No authorization overrides this — we cannot rank what
 *     we cannot read.
 *  2. **A live claim of an unrecognised KIND ⇒ stand down.** Same reasoning. The one thing we know
 *     is that something is organizing this mailbox and we cannot place it.
 *  3. **We hold the strongest live claim ⇒ organize.** This is continuation, and it covers
 *     own-role resumption after a crash, a restore or a long sleep: if the folder holds only our
 *     own claims, however old, we are the newest thing in it and we win. §4: "Continuing is not
 *     becoming."
 *  4. **The folder holds no readable claim at all ⇒ organize.** Nobody has ever organized this
 *     mailbox, so there is nobody to take over from. A transient double-append here is the
 *     designed handover window, and {@link runLeaseGate}'s append-then-verify is what bounds it to
 *     the cycle in which it happens.
 *  5. **We lost, and the winner is a LIVE claim of a kind that outranks ours ⇒ stand down, even
 *     with authorization.** §4 gives a local install no path over a live Cloud: the honest action
 *     there is `Remove from this Mac`, and the Cloud side is where a mailbox is given up. The
 *     asymmetry is deliberate and is not a missing feature.
 *  6. **We lost, and a human authorized THIS install ⇒ organize, and DISPLACE what we beat.** §4's
 *     "adding a mailbox to Cloud IS the explicit action, so this informs and proceeds". The
 *     displacement is what records the handover in the shared medium; see {@link OrganizeVerdict}.
 *  7. **We lost, and the folder is still being renewed ⇒ stand down.** Somebody is organizing it.
 *  8. **We lost, and the folder has gone quiet ⇒ `available`.** Somebody WAS organizing and
 *     nothing has renewed since. Offerable, never taken: BECOMING an organizer always requires an
 *     explicit human action, including for Cloud.
 */
export function decideLease(input: DecideLeaseInput): LeaseVerdict {
  const { self, now } = input;
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const takeover = input.takeover ?? "none";
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

  // 1 / 2 — a live peer we cannot rank. Checked first, and no authorization overrides them.
  const unrankable = election.live.find((c) => !isOurs(c) && (c.protocol > ourProtocol || c.kind === "unknown"));
  if (unrankable) return { verdict: "stand_down", reason: "organized_elsewhere:unknown", by: unrankable };

  const { winner } = election;

  // 3 — we hold the strongest live claim. Continuation.
  if (winner && isOurs(winner)) return { verdict: "organize", renew: true, displace: [] };

  // 4 — an EMPTY folder. Nobody has ever organized this mailbox, so there is nobody to take over
  // from. Emptiness is the whole condition, and "no winner" is deliberately not the test: a folder
  // that holds only unreadable claims, or only a claim dated 2099, has evidence in it and belongs
  // to the arms below.
  if (election.candidates.length === 0 && election.malformed.length === 0) {
    return { verdict: "organize", renew: true, displace: [] };
  }

  // 5 — a live organizer of a kind that outranks us is never taken, authorized or not. §4 gives a
  // local install no path over a live Cloud.
  //
  // GATED ON TWO THINGS, and both were learned by watching this arm misfire.
  //
  //  · **The folder must not be QUIET.** §4's rule is that a *fresh* cloud lease outranks local for
  //    continuing coverage — the protection belongs to an organizer that is demonstrably still
  //    there. Without this clause a Cloud subscription that lapsed months ago still refused
  //    `Organize from this Mac`, which is precisely the transition §4 spells out as one line and
  //    one click.
  //  · **The claim must be PLAUSIBLE.** Otherwise one machine with a broken clock writing a `cloud`
  //    claim dated 2099 refuses every authorized local takeover for ever, and the only cure is a
  //    person finding and deleting the bookkeeping message by hand.
  const ourKindRank = self.kind === "cloud" ? 2 : 1;
  const winnerKindRank = winner === null ? 0 : winner.kind === "cloud" ? 2 : 1;
  if (
    winner !== null && winnerKindRank > ourKindRank
    && !election.quiet && election.plausible.has(winner)
  ) {
    return { verdict: "stand_down", reason: reasonFor(winner), by: winner };
  }

  // 6 — a human asked for this mailbox. Take it, and record the handover in the folder.
  if (takeover === "authorized") {
    const displaced = [...election.candidates, ...election.malformed]
      .filter((c) => (isMalformed(c) ? true : !isOurs(c)))
      .map((c) => c.ref)
      .filter((r): r is unknown => r !== undefined);
    return { verdict: "organize", renew: true, displace: displaced };
  }

  // 7 / 8 — we lost. Whether it is offerable is the only thing left to say.
  if (!election.quiet && winner !== null) {
    return { verdict: "stand_down", reason: reasonFor(winner), by: winner };
  }
  return { verdict: "available", by: winner };
}

/** The winning claim's kind, as the closed reason set spells it. */
function reasonFor(c: OrganizerClaim): StandDownReason {
  return c.kind === "cloud" ? "organized_elsewhere:cloud"
    : c.kind === "local" ? "organized_elsewhere:local"
      : "organized_elsewhere:unknown";
}



// ── LAYER 2b: LOOKING WITHOUT DECIDING ──────────────────────────────────────────────────────

/**
 * WHO HOLDS THIS MAILBOX, REPORTED RATHER THAN RULED ON.
 *
 * ── WHY THIS IS NOT `decideLease` WITH THE WRITES TURNED OFF ────────────────────────────────
 *
 * A caller that wants to SHOW a person who is organizing their mailbox — before asking them
 * whether to take it over — needs a different thing from what the gate produces. The gate answers
 * "may *I* organize?", and to answer it needs an identity: {@link LeaseSelf}, with an install id
 * and a nonce. A surface that merely reports has no such identity, and giving it a fabricated one
 * is how a read becomes a write. Two concrete failures, both reachable from one fabricated id:
 *
 *  · Against an EMPTY `ohmail/_meta`, arm 7 answers `organize`, and {@link runLeaseGate} then
 *    APPENDS a claim. A preview would have made the previewer the organizer, and every other
 *    install would stand down for the whole staleness window on the strength of somebody opening
 *    a settings pane.
 *  · Against a live claim carrying the same id, {@link runLeaseGate}'s renew expunges the older
 *    claims matching that id — so a preview sharing the worker's id can delete the worker's own
 *    fresh claim out from under it.
 *
 * So this layer takes no `self`, returns no verdict, and cannot write: {@link LeasePeekIo} has
 * exactly one method and it is a read. The confirm step that follows a preview does not consult
 * this result — it stamps an authorization, and the GATE decides, later, in the process that is
 * actually going to do the organizing. A preview that decided would be a second decision site,
 * and §3.4's "exactly one path to stand-down" is the same argument in the other direction.
 */
export interface LeaseHolder {
  kind: OrganizerKind | "unknown";
  /** `X-Ohmail-Display-Name` — the machine, for a human. May be empty. */
  displayName: string;
  /** Last renew, by the WRITER's clock. */
  heartbeat: Date;
  /** When this organizer became the organizer, as distinct from last seen. */
  claimedAt: Date;
  /** Still being renewed, judged against the same window the gate judges against. */
  fresh: boolean;
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

  const holders: LeaseHolder[] = valid
    .map((c) => ({
      kind: c.kind,
      displayName: c.displayName,
      heartbeat: c.heartbeat,
      claimedAt: c.claimedAt,
      fresh: isFresh(c.heartbeat, input.now, staleAfterMs),
    }))
    .sort((a, b) => b.heartbeat.getTime() - a.heartbeat.getTime());

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
 * A {@link LeasePeekIo} bound to a live connection. LIST, SELECT, FETCH. Nothing else.
 *
 * **It does not create `ohmail/_meta`.** {@link makeLeaseIo} does, because an organizer that is
 * about to write a claim needs somewhere to write it. A reader does not, and creating a folder in
 * somebody's mailbox to answer a question about it is a side effect no read should have — it also
 * changes the answer for the next reader, from "no folder" to "empty folder". An absent folder is
 * reported as zero claims, which is the truth: nobody has ever organized this mailbox.
 */
export function makeLeasePeekIo(client: LeaseImapClient, toServerPath: (canonical: string) => string): LeasePeekIo {
  return {
    async listClaims(): Promise<RawClaimMessage[]> {
      const p = toServerPath(META_FOLDER);
      const list = await client.list();
      if (!list.some((f) => f.path === p)) return [];

      const lock = await client.getMailboxLock(p);
      try {
        const out: RawClaimMessage[] = [];
        // The same defensive read `makeLeaseIo.listClaims` documents at length: `1:*` is not a
        // valid messageset against an empty mailbox and Dovecot refuses the command outright,
        // while GreenMail tolerates it. Only a POSITIVELY KNOWN zero skips the fetch.
        const selected = client.mailbox;
        const count = typeof selected === "object" && selected !== null ? selected.exists : undefined;
        if (count === 0) return out;
        for await (const m of client.fetch("1:*", { uid: true, headers: true }, { uid: false })) {
          if (!m.headers) continue;
          out.push({ ref: m.uid, raw: m.headers.toString("utf8") });
        }
        return out;
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
    throw new LeaseUnavailableError(
      `the organizer lease in ${META_FOLDER} could not be read`,
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
 * A LEASE IO FAILURE IS A MAILBOX FAULT, NEVER A STAND-DOWN.
 *
 * §3.4: a mailbox whose `_meta` cannot be read is a mailbox we cannot safely organize, and
 * reading that as "no claim, so organize" is the dual-organizer bug through the back door.
 * Reading it as "stand down" would be almost as wrong in the other direction: stand-down is
 * sticky caller-side, so a transient network error would permanently disable a mailbox nobody
 * else wants.
 *
 * So it is its own class, and callers exempt it BY CLASS — the pattern the worker's sync loop
 * already uses for `ClassifierFaultError`, where exempting by class
 * rather than by threshold arithmetic is what keeps "a model outage can never quarantine a
 * mailbox" true at every tuning of `maxSyncFailures`.
 */
/**
 * WHICH LEASE OPERATION FAILED. A closed set of literals, chosen at COMPILE TIME.
 *
 * ── THE GENERAL RULE THIS EXISTS TO STATE ──────────────────────────────────────────────────
 *
 * **A catch that wraps more than one operation must name which one threw.** `runLeaseGate` used to
 * wrap `ensureMetaFolder()` and `listClaims()` in ONE try and report neither, and that once
 * cost half an hour of diagnosis: "the organizer lease could not be read" is the same sentence whether the
 * folder could not be CREATED (a permissions or namespace problem — our path is wrong) or could not
 * be LISTED (the folder exists and the FETCH was refused — which is what actually happened, a
 * `FETCH 1:*` against an empty mailbox that Dovecot rejects and GreenMail tolerates). One literal
 * collapses that ambiguity to one line.
 *
 * ── AND WHY IT COSTS NOTHING TO LOG ────────────────────────────────────────────────────────
 *
 * Every member is a string WE wrote in THIS file. No server, no mailbox and no user chooses it,
 * so it carries exactly zero privacy cost — which is what makes it emittable where the thing an
 * operator actually wants (`err.message`, `responseText`) is not. The same rule governs
 * `serverResponseCode` in the worker's mailbox-error classifier: a value the server chose is a
 * value the server chose, whatever grammar it happens to satisfy.
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
  | "no_lease_io";

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
}

/**
 * The minimum an IMAP client has to be for {@link makeLeaseIo} to drive it.
 *
 * Structural, not `ImapFlow`, so the whole IO layer is testable against a fake without a server
 * and so this module does not import the client library at all — `organizer-lease.ts` needs only
 * `imap-types.ts`, which is what keeps `imap.ts → organizer-lease.ts` a one-way edge with no
 * cycle.
 */
export interface LeaseImapClient {
  /**
   * The SELECTED mailbox, which `getMailboxLock` sets, and whose `exists` is its message count.
   *
   * Optional, and read defensively in {@link makeLeaseIo}, because it is the one field here that
   * is a client-library convenience rather than a command: a fake that omits it must behave
   * exactly as before, so absence means "unknown", never "empty".
   */
  readonly mailbox?: { exists?: number } | false;
  list(): Promise<Array<{ path: string; subscribed?: boolean }>>;
  mailboxCreate(path: string): Promise<unknown>;
  mailboxUnsubscribe(path: string): Promise<unknown>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  fetch(
    range: string,
    query: { uid?: boolean; headers?: boolean | string[] },
    options?: { uid?: boolean },
  ): AsyncIterableIterator<{ uid: number; headers?: Buffer }>;
  append(path: string, content: string | Buffer, flags?: string[]): Promise<unknown>;
  messageDelete(range: number[], options?: { uid?: boolean }): Promise<unknown>;
}

/**
 * A {@link LeaseIo} bound to a LIVE connection.
 *
 * `toServerPath` is passed in rather than recomputed, because the delimiter is discovered at
 * login and is private to the adapter. `ohmail/_meta` has to survive a server whose delimiter is
 * `.` (GreenMail) as well as one whose delimiter is `/` (Dovecot), and hand-writing that mapping
 * a second time here is how the two spellings drift.
 *
 * The claim is APPENDED with `\Seen` so a user who does subscribe to the folder in another
 * client is not shown an unread count for our bookkeeping.
 */
export function makeLeaseIo(client: LeaseImapClient, toServerPath: (canonical: string) => string): LeaseIo {
  const path = (): string => toServerPath(META_FOLDER);

  return {
    async ensureMetaFolder(): Promise<void> {
      const p = path();
      const list = await client.list();
      const found = list.find((f) => f.path === p);
      if (!found) {
        try {
          await client.mailboxCreate(p);
        } catch (err) {
          if (!/already exists/i.test(String((err as Error).message))) throw err;
        }
      }
      // UNSUBSCRIBED, always — a subscribed `_meta` shows up in every other mail client the user
      // owns, as a folder of machine bookkeeping they did not ask for. `ListResponse.subscribed`
      // means this is assertable against a real server rather than merely requested.
      if (!found || found.subscribed) await client.mailboxUnsubscribe(p);
    },

    async listClaims(): Promise<RawClaimMessage[]> {
      const lock = await client.getMailboxLock(path());
      try {
        const out: RawClaimMessage[] = [];
        // AN EMPTY `_meta` IS THE NORMAL STATE OF A FRESH MAILBOX, AND `1:*` IS NOT A VALID
        // MESSAGESET WHEN A MAILBOX HOLDS NOTHING.
        //
        // The failure: every genuinely fresh mailbox was unorganizable, and the product showed
        // "waiting for first sync" for ever. `ensureMetaFolder()` creates the folder one line
        // earlier, so on a first attach this FETCH always ran against zero messages. GreenMail
        // tolerates that and answers an empty set; Dovecot refuses the command outright —
        // measured against a real Dovecot server:
        //
        //     Error in IMAP command FETCH: Invalid messageset
        //
        // which `runLeaseGate` turns into `LeaseUnavailableError`, which the worker exempts BY
        // CLASS from `maxSyncFailures` — so it retried every thirty seconds for ever, wrote
        // nothing to the mailbox row, and quarantined nothing. Correct behaviour at every layer,
        // composing into a mailbox that can never be adopted. The whole test suite was green
        // because the only server it ever ran against was the tolerant one.
        //
        // Read DEFENSIVELY: only a POSITIVELY KNOWN zero skips the fetch. An `exists` we cannot
        // see means "unknown", so the fetch still runs and every existing caller — including
        // every fake in the tests — behaves exactly as it did before.
        const selected = client.mailbox;
        const count = typeof selected === "object" && selected !== null ? selected.exists : undefined;
        if (count === 0) return out;
        // HEADERS ONLY. A claim's body is one sentence for a human, and fetching sources here
        // would make the gate's cost scale with whatever else ends up in this folder.
        for await (const m of client.fetch("1:*", { uid: true, headers: true }, { uid: false })) {
          if (!m.headers) continue;
          out.push({ ref: m.uid, raw: m.headers.toString("utf8") });
        }
        return out;
      } finally {
        lock.release();
      }
    },

    async appendClaim(raw: string): Promise<void> {
      await client.append(path(), raw, ["\\Seen"]);
    },

    async removeClaims(refs: readonly unknown[]): Promise<void> {
      const uids = refs.filter((r): r is number => typeof r === "number");
      if (uids.length === 0) return;
      const lock = await client.getMailboxLock(path());
      try {
        await client.messageDelete(uids, { uid: true });
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
  takeover?: TakeoverAuthorization;
  /** Injected for tests; production uses `crypto.randomUUID()`. */
  newNonce?: () => string;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export interface LeaseGateResult {
  verdict: LeaseVerdict;
  /** The nonce written this cycle, to be held in memory as the next `self.lastNonce`. */
  nonce: string | null;
}

/**
 * READ, DECIDE, THEN WRITE — the whole gate, in that order.
 *
 * Reconnect is learn-then-act: the LOCAL sidecar reads the organizer lease BEFORE its
 * first move. Reconnect-after-sleep is exactly when a mailbox is
 * most likely to have changed hands, so writing first — even a renew — would be self-promotion
 * dressed as bookkeeping.
 *
 * On `organize` it renews: append the new claim, then expunge our older ones. **That order is
 * load-bearing.** IMAP has no in-place update, and expunging first means a crash in between
 * leaves the mailbox with NO claim of ours at all — which reads to every other install as a
 * mailbox that became available. Appending first leaves two, which is the harmless direction
 * and which {@link decideLease} coalesces.
 *
 * On `stand_down` it RELEASES: our own claims are expunged. Otherwise the winner has to wait out
 * the whole staleness window before its own gate is clean, and a released claim is what makes
 * "Cloud lapsed" legible to a desktop install at all.
 *
 * Every IO failure becomes {@link LeaseUnavailableError}. There is exactly one place a
 * `stand_down` can be constructed and it is {@link decideLease}, from a parsed fresh foreign
 * claim — §3.4's "exactly one path to stand-down".
 */
export async function runLeaseGate(input: LeaseGateInput): Promise<LeaseGateResult> {
  const { io, self, now } = input;
  const log = input.log ?? ((): void => undefined);
  const newNonce = input.newNonce ?? ((): string => crypto.randomUUID());

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
  let messages: RawClaimMessage[];
  try {
    messages = await io.listClaims();
  } catch (err) {
    throw new LeaseUnavailableError(
      `the organizer lease in ${META_FOLDER} could not be read; this mailbox cannot be organized safely`,
      { op: "list_claims", cause: err },
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
    if (ourRefs.length > 0) {
      try {
        await io.removeClaims(ourRefs);
      } catch (err) {
        // Failing to release is not failing to stand down. We are already not organizing; the
        // only cost is that the winner waits out the staleness window. Logged, never thrown —
        // throwing here would turn a clean stand-down into a mailbox fault.
        //
        // ── A BARE STRING UNDER `err` IS SAFE HERE, AND NOT BY ACCIDENT. DO NOT "FIX" IT. ──
        //
        // `log` is an injected `(event, detail) => void`, and the worker routes it into
        // `packages/core/src/log.ts`, whose redactor SPECIAL-CASES the `err` key: it hands the
        // value to `describeError` and emits only `errorClass` + `errorCode`. `describeError`
        // reads `name` and `code`, and a `string` has neither — so this reduces to
        // `errorClass: "String"` and the message is DISCARDED before anything is written. That
        // is the same guarantee an `Error` gets, reached by the same code path.
        //
        // The tempting edit is to pass `err` whole "so the class survives". It does not survive
        // any better, and it costs the one property this line has: an IMAP driver's error object
        // carries the failing command and, on a login path, the credential — `log.ts`'s header
        // records a driver message with `host=…&user=…` reaching a log drain. Reducing to a
        // string HERE means there is no object for a future redactor bug to walk.
        //
        // `op` rides along for the reason the throwing sites carry it: this catch wraps ONE
        // operation today, and the literal is what keeps that true — a second call added inside
        // this try would have to choose between two ops and the choice would be visible.
        log("lease_release_failed", {
          op: "remove_claims" satisfies LeaseOp,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    log("lease_stand_down", { verdict: verdict.verdict });
    return { verdict, nonce: null };
  }

  // The incumbency clock. Renewing must NOT restart it, or two installs that both renew every
  // cycle would each keep looking like the newest arrival and the election would never settle.
  const priorOwn = claims
    .filter((c): c is OrganizerClaim => !isMalformed(c) && c.installId === self.installId)
    .sort((a, b) => a.claimedAt.getTime() - b.claimedAt.getTime())[0];
  const claimedAt = priorOwn?.claimedAt ?? now;

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
      }),
    );
  } catch (err) {
    throw new LeaseUnavailableError(
      `the organizer claim in ${META_FOLDER} could not be renewed`,
      { op: "renew_claim", cause: err },
    );
  }

  /**
   * ── APPEND, THEN LOOK AGAIN BEFORE TOUCHING ANY MAIL ────────────────────────────────────────
   *
   * IMAP has no compare-and-swap, so two installs reading the same folder in the same instant can
   * both decide to organize and both append. The election above makes that impossible to SUSTAIN —
   * one cycle later both compute the same winner — but "one cycle" was an unbounded promise: the
   * gate returned `organize` the moment its own APPEND succeeded and never looked at what else had
   * landed. Every simultaneous start was therefore a real dual-write window a full poll interval
   * wide, and it was the missing ceiling under every split-brain reproduced above.
   *
   * So the claim we just wrote is read back WITH ITS NEIGHBOURS, and the election is re-run over
   * what is actually in the folder. Two things make this the right shape rather than a retry loop:
   *
   *  · `takeover` is deliberately NOT passed. The authorization was spent on the first decision;
   *    re-offering it here would let one click win an unbounded number of contests.
   *  · `lastNonce` is set to the nonce we just wrote, so our own new claim is recognised as ours
   *    and the clone defence is armed against anything else bearing our id.
   *
   * If we lost, we release and report the stand-down — the mailbox has changed hands between our
   * read and our write, which is exactly the case this exists to catch. A verify that cannot be
   * READ is not a loss: it is a mailbox fault, and it throws like every other one, because
   * "somebody else holds this" and "I could not look" must never be reachable from one another.
   */
  let verifyClaims: readonly ClaimRecord[];
  try {
    const after = await io.listClaims();
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

  const confirmed = decideLease({
    self: { ...self, lastNonce: nonce },
    claims: verifyClaims,
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
    return { verdict: confirmed, nonce: null };
  }

  // WHAT THIS WIN DISPLACED, plus our own older copies. One expunge, so a takeover cannot land
  // half-applied — leaving the beaten claim behind is what made a takeover reverse itself on the
  // next cycle, and leaving our own older copies behind is the append-then-expunge residue readers
  // coalesce away.
  const toRemove = [...ourRefs, ...verdict.displace];
  if (toRemove.length > 0) {
    try {
      await io.removeClaims(toRemove);
    } catch (err) {
      // Harmless: the folder now holds our new claim plus one or more older ones, and readers
      // coalesce by newest heartbeat. The next renew tries again.
      //
      // The bare string under `err` is deliberate, for the reason spelled out at
      // `lease_release_failed` above: `log.ts` special-cases `err` into `describeError`, a string
      // has no `name`/`code`, so this emits `errorClass: "String"` and nothing else. Passing the
      // error object instead would hand a redactor an IMAP driver error that can carry the
      // failing command and the credential.
      log("lease_cleanup_failed", {
        op: "remove_claims" satisfies LeaseOp,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { verdict, nonce };
}
