/**
 * THE ONE STALENESS DECISION about a `402 subscription_required`. After the service's fresh open
 * verdict, another API instance may hold the old refusal for its verdict cache's life
 * (`ACCESS_TTL_MS`, `packages/db/src/entitlements-client.ts`). Inside that window a 402 raises no
 * wall AND stands no drain loop down — the loop retries it without counting it — so a wall that has
 * just lifted cannot be re-raised, and a loop cannot stand down with no wall left to revive it.
 * Every reader asks {@link refusalIsStale}; every open or refused answer is recorded here.
 *
 * WHOSE ANSWER A READER GETS is the reader's own to say: each hands in whom it asks for (the
 * account of its request, the mailbox its window mounts, the scope of its mount). Nothing here looks
 * an owner up, and nothing is stored: this is one document's memory.
 */
export const STALE_REFUSAL_MS = 60_000;

let openFor: { owner: string | null; at: number } | null = null;
let liftedFor: { owner: string | null; at: number } | null = null;

/**
 * Was an owner handed in at all? `null` is one: the window that serves no account. An owner nobody
 * handed in (`undefined`, an empty one) is asked about nothing and answered on the side that raises
 * the wall again and withholds no date; nothing throws in a drain loop or in a client's refusal path.
 */
function handedIn(owner: string | null): boolean {
  return owner !== undefined && owner !== "";
}

/**
 * The service answered open for `owner` (the account the request was made for). `lifted` when this
 * device last knew the account refused: that instant is {@link liftedAt}.
 */
export function markOpenVerdict(owner: string | null, now = Date.now(), lifted = false): void {
  openFor = { owner, at: now };
  if (lifted) liftedFor = { owner, at: now };
}

/** The wall of `owner`'s window came down on the service's open word (`useWallLift`); its host says whose it is. */
export function markWallLifted(owner: string | null, now = Date.now()): void {
  if (!handedIn(owner)) return;
  liftedFor = { owner, at: now };
}

/** The service answered refused, or this client forgot what it heard: no window, no reopening. */
export function forgetOpenVerdict(): void {
  openFor = null;
  liftedFor = null;
}

/** Is a 402 arriving now, for `owner` (the account the caller asks for), a stale one? */
export function refusalIsStale(owner: string | null, now = Date.now()): boolean {
  return handedIn(owner) && openFor !== null && openFor.owner === owner && now - openFor.at >= 0
    && now - openFor.at < STALE_REFUSAL_MS;
}

/**
 * When `owner`'s account last opened after a refusal, or `null`. The mail state withholds a date
 * older than it (mail 0135): the mirror's age then dates the closure.
 */
export function liftedAt(owner: string | null): number | null {
  return handedIn(owner) && liftedFor !== null && liftedFor.owner === owner ? liftedFor.at : null;
}
