/**
 * Whose mailbox this browser last held — a name, and never a credential. The mirror persists into
 * IndexedDB and must be NAMED for the account it holds (one shared database name is how a second
 * person on a shared browser saw the first one's mail), and the name must be an id the server
 * confirmed — `engine.tsx` used to render nothing until `GET /auth/session` answered, a round trip
 * ahead of a mirror already on the device. The API sets this beside the session cookies; readable
 * by script ON PURPOSE, so the shell opens the mirror during its first render. It authorises
 * nothing: the sync gate stays closed until the session check names an account equal to this value.
 * Script on this origin could already enumerate the databases and read the mail inside them.
 */

/**
 * The name is spelled out here because this directory is shared with the standalone desktop, which
 * cannot import the API package that defines it; a test reads both files. On the desktop there is no
 * such cookie and `readOwner` answers `null` — and "nothing here changes anything" was false in the
 * direction that costs a user: four `localStorage` keys are built as
 * `` `<prefix>${owner ?? "local"}` ``, so a `null` owner is every mailbox on the install sharing
 * ONE key. {@link ./storage-owner} composes this reader with an identity the HOST supplies;
 * reading the cookie is all this file does.
 */

/** The cookie the API sets beside the session. Kept identical to the API's own constant. */
export const OWNER_COOKIE = "tf_owner";

/**
 * "A sign-out was asked for and the server did not confirm it" — a reserved value this CLIENT writes. The API never
 * sends it and it is not an account id: no mirror is named for it, and {@link readOwner} answers `null` for it.
 * Sign-out does its local half whatever the server said — a borrowed machine's sign-out must work offline — and
 * clearing this cookie on a FAILED server call left the one state nothing could reason about: an HttpOnly session
 * live on the server and no readable marker saying whose. Absence read as silence, so a mailbox window open for a
 * different account went on syncing through the leftover session. So the failed half writes a value instead of
 * erasing one: absence still means silence; this means "a session may still exist and it is not this browser's to
 * use", and the sync gate treats it as a contradiction until a fresh check names an owner.
 */
export const OWNER_SIGNED_OUT = "signed_out_pending";

/**
 * WHAT THE MARKER SAYS, in the three forms anything reading it has to tell apart.
 *
 * `readOwner` collapses two of these to `null` because its callers ask "which account is this
 * browser's?", and both a missing cookie and a pending sign-out answer "none". The sync gate
 * asks a different question — "may this mirror still be trusted?" — and for that the difference
 * between silence and a refused sign-out is the whole answer.
 */
export type OwnerMarker =
  | { kind: "account"; id: string }
  | { kind: "signed-out" }
  | { kind: "absent" };

/**
 * Read the marker without collapsing it. Synchronous and side-effect-free, like {@link readOwner},
 * and `jar` is injectable for the same reason.
 *
 * A malformed value is `absent`: it can name no account and it is not the reserved word, so the
 * only honest reading is that nothing was said. See {@link OWNER_SHAPE}.
 */
export function readOwnerMarker(jar?: string): OwnerMarker {
  const raw = rawOwnerCookie(jar);
  if (raw === null) return { kind: "absent" };
  if (raw === OWNER_SIGNED_OUT) return { kind: "signed-out" };
  return OWNER_SHAPE.test(raw) ? { kind: "account", id: raw } : { kind: "absent" };
}

/**
 * The characters an account id may have, and nothing else.
 *
 * A value that fails this is treated as absent rather than repaired. It is about to name a
 * database and be compared against a server-issued id; a value that is not id-shaped can do
 * neither, and guessing at what was meant is how a malformed cookie becomes a mirror nobody can
 * find again. `null` is always safe — it is exactly the state every client was in before this
 * cookie existed, and the shell falls back to asking first and painting second.
 */
const OWNER_SHAPE = /^[A-Za-z0-9._~-]{1,128}$/;

/**
 * Does this string name an account the way an id does?
 *
 * Exported because the cookie is no longer the only source of an owner: a host-supplied identity
 * (`storage-owner.ts`) is about to become part of a `localStorage` key and has to pass the SAME
 * test, from the SAME regex. Two spellings of "id-shaped" is how one door ends up scoping and
 * another silently does not.
 */
export function isOwnerShaped(value: string): boolean {
  return OWNER_SHAPE.test(value);
}

/**
 * The account this browser last signed in as, or `null`.
 *
 * SYNCHRONOUS AND SIDE-EFFECT-FREE, because it is called from a render. `jar` is injectable so a
 * test can drive it without a document; on the server (and in any environment with no `document`)
 * it reads as absent, which is the correct answer there — nothing may paint from a mirror the
 * server cannot see.
 */
export function readOwner(jar?: string): string | null {
  const value = rawOwnerCookie(jar);
  // The reserved sign-out marker is NOT an account id, and this is the function everything that
  // names a mirror or a storage key goes through — so it must never hand the word back as one.
  if (value === null || value === OWNER_SIGNED_OUT) return null;
  return OWNER_SHAPE.test(value) ? value : null;
}

/** The cookie's raw value, or `null` when it is not in the jar. Shared by both readers. */
function rawOwnerCookie(jar?: string): string | null {
  const raw = jar ?? (typeof document === "undefined" ? "" : document.cookie);
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== OWNER_COOKIE) continue;
    return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Forget the name, from the browser, now. The server clears this cookie on sign-out — the
 * authoritative clear; this is the half that runs even when the server could not be reached, which
 * is the case that matters: a person on a borrowed machine asking to be signed out is asking
 * whether or not the network answers. Called in the same act as the mirror wipe, so the name and
 * the mail it names go together. `Secure` is added only on a secure page: on plain-http development
 * the browser silently DISCARDS a `Secure` write, which would leave the cookie in place with
 * nothing reporting a failure. `write` is injectable for the same reason `readOwner`'s jar is.
 */
export function forgetOwner(write?: (cookie: string) => void): void {
  const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
  const expired = `${OWNER_COOKIE}=; Path=/; Max-Age=0; SameSite=Strict${secure}`;
  if (write) {
    write(expired);
    return;
  }
  if (typeof document === "undefined") return;
  document.cookie = expired;
}

/**
 * SAY THAT A SIGN-OUT WAS ASKED FOR AND NOT CONFIRMED — see {@link OWNER_SIGNED_OUT}. Written INSTEAD of clearing,
 * and only on that one path: erasing the marker while the server may still hold a live session is what let a window
 * for another account go on using it. The cookie is a session cookie here rather than an expired one, so closing the
 * browser forgets it, which is the right lifetime for a claim about a request that may yet be retried. `Secure` on a
 * secure page only, for {@link forgetOwner}'s reason: a plain-http development origin DISCARDS a `Secure` write
 * silently, and a write that vanishes would leave the previous account's id in place — the worst of the three states.
 */
export function markSignedOutPending(write?: (cookie: string) => void): void {
  const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
  const cookie = `${OWNER_COOKIE}=${OWNER_SIGNED_OUT}; Path=/; SameSite=Strict${secure}`;
  if (write) {
    write(cookie);
    return;
  }
  if (typeof document === "undefined") return;
  document.cookie = cookie;
}

/**
 * WRITE THE MARKER FROM WHAT THE SERVER SAID — the one client-side write of an account name, and it relays a server
 * statement rather than inventing one. The marker is otherwise the server's to set, which is what makes it evidence.
 * This exists for one shape: the sign-in and token routes answer with `X-Ohmail-Account` naming the account THE
 * CREDENTIAL resolved to, and on those routes a header disagreeing with the cookie is the new owner rather than a
 * leak — the server refuses (`409 session_conflict`) any request where a live session and a credential disagree, so a
 * disagreement that came back 2xx is a sign-in that succeeded. The value written is the header's, never a query
 * parameter, a body field or anything this client decided.
 */

/**
 * Paired with `bindApiOwner` at the one call site, and it has to be: binding without writing leaves a client that has
 * been told there is an account here and cannot see it named, which fails closed on every subsequent request — the
 * enrolment session sets no marker of its own.
 */
export function rememberOwner(accountId: string, write?: (cookie: string) => void): void {
  if (!isOwnerShaped(accountId)) return;
  const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
  const cookie = `${OWNER_COOKIE}=${accountId}; Path=/; SameSite=Strict${secure}`;
  if (write) {
    write(cookie);
    return;
  }
  if (typeof document === "undefined") return;
  document.cookie = cookie;
}
