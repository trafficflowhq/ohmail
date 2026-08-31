/**
 * WHOSE MAILBOX THIS BROWSER LAST HELD — a name, and never a credential.
 *
 * ── THE ROUND TRIP THIS EXISTS TO REMOVE ────────────────────────────────────────────────────
 *
 * The web client's mail mirror persists into IndexedDB, and a persistent mirror has to be NAMED
 * for the account it holds — one shared database name is how a second person on a shared browser
 * came to see the first one's mail. The name therefore has to be an id the SERVER confirmed, so
 * `engine.tsx` asked `GET /auth/session` and rendered nothing at all until it answered.
 *
 * That put a network round trip in front of every first paint, ahead of a mirror that was already
 * on the device and already the right one. On a slow link it is the first of two serial round
 * trips before a single row can appear.
 *
 * The API sets this cookie beside the session cookies at sign-in, and re-stamps it when a session
 * is refreshed. It is readable by script on purpose — it is the one cookie in the set that is not
 * HttpOnly — so the shell can read it during its FIRST render and open the mirror straight away,
 * while the session check runs in parallel.
 *
 * ── WHAT IT IS NOT ──────────────────────────────────────────────────────────────────────────
 *
 * It authorises nothing and proves nothing. Reading it is not "being signed in": the shell still
 * asks the server whose mailbox this is, and a mismatch or a refusal tears the engine down before
 * anything can be acted on. A forged value gets whoever forged it the name of an empty local
 * database on their own machine.
 *
 * That it is readable costs nothing that was not already readable. Script on this origin can
 * enumerate the browser's databases, where the same id is half of every mirror's name, and can
 * read the mail inside them.
 *
 * ── WHY THE NAME IS SPELLED OUT HERE ────────────────────────────────────────────────────────
 *
 * This directory is shared with the standalone desktop client, which has no API, no session and
 * no server-side of any kind — so it cannot import the API package that defines the name, and the
 * string is repeated instead. The two are held together by a test that reads both files.
 *
 * ── WHAT THIS MODULE IS NOT, ON THE DESKTOP ─────────────────────────────────────────────────
 *
 * There is no such cookie on the desktop, so `readOwner` answers `null` there. **The sentence
 * that used to stand here — "and nothing here changes anything" — was false, and it was false in
 * the direction that costs a user.** Four `localStorage` keys in this shell are built as
 * `` `<prefix>${owner ?? "local"}` ``, so a `null` owner is not "no scoping needed": it is
 * every mailbox on the install sharing ONE key. The desktop mounts a different engine per
 * mailbox, so that collapsed key carried an unfinished message, a Screener decision and a send
 * lane from whichever mailbox wrote it into whichever mailbox opened next.
 *
 * A cookie is not the only way to know whose storage this is, and this module is not the place
 * that decides — {@link ./storage-owner} is. It composes this reader with an identity the HOST
 * supplies (the desktop's mounted mailbox, the host door's pairing), and the key builders resolve
 * through it. Reading the cookie is still exactly what this file does and all it does.
 */

/** The cookie the API sets beside the session. Kept identical to the API's own constant. */
export const OWNER_COOKIE = "tf_owner";

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
  const raw = jar ?? (typeof document === "undefined" ? "" : document.cookie);
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== OWNER_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return OWNER_SHAPE.test(value) ? value : null;
  }
  return null;
}

/**
 * FORGET THE NAME, from the browser, now.
 *
 * The server clears this cookie on sign-out along with the rest of the set, and that is the
 * authoritative clear. This is the half that runs even when the server could not be reached —
 * which is the case that matters, because a person on a borrowed machine who asks to be signed
 * out is still asking whether or not the network answers. It is called in the same act as the
 * mirror wipe, so the name and the mail it names go together and neither can be left pointing at
 * the other.
 *
 * `Secure` is added only on a secure page. It is what production serves, and it is what the API
 * sets; on a plain-http development origin the browser silently DISCARDS a `Secure` write, which
 * would leave the cookie in place with nothing reporting a failure.
 *
 * `write` is injectable for the same reason `readOwner`'s jar is.
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
