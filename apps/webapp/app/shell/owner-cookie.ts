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
 * asks the server whose mailbox this is, and a mismatch or a refusal tears the engine down. A
 * forged value gets whoever forged it the name of an empty local database on their own machine.
 *
 * "Before anything can be acted on" is how that sentence used to end, and it was not true. The
 * warm engine is SCHEDULED from the render after hydration, so between the optimistic open and
 * the server's answer it was already draining `/sync` into the mirror this cookie names — under
 * whatever session the jar held. The teardown was the last word, not the only one. What makes
 * the claim true now is that the mirror's sync gate stays closed until `GET /auth/session`
 * names an account equal to this value: the engine paints from the device, and merges nothing,
 * until then. This value is also read by that gate on every request, so a cookie that later
 * names somebody else stops the loop rather than redirecting it.
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
 * ═══ "A SIGN-OUT WAS ASKED FOR AND THE SERVER DID NOT CONFIRM IT" ══════════════════════════
 *
 * A reserved value this CLIENT writes. The API never sends it, and it is not an account id — no
 * mirror is ever named for it and no storage key ever carries it, which is why
 * {@link readOwner} answers `null` for it like any other value that cannot name an account.
 *
 * ── THE SEQUENCE IT EXISTS FOR ─────────────────────────────────────────────────────────────
 *
 * Sign-out does its local half whatever the server said, on purpose: somebody on a borrowed
 * machine asking to be signed out is asking whether or not the network answers. Part of that
 * half was clearing this cookie — and when the server call had FAILED, that left the browser in
 * the one state nothing could reason about: an HttpOnly session still live on the server, and
 * no readable marker saying whose it is.
 *
 * Absence used to be read as silence ("a legitimate session whose marker was dropped"), so a
 * mailbox window still open for a DIFFERENT account read that silence as permission and went on
 * syncing, reading and mutating through the session the failed sign-out had left behind. The
 * marker was the only thing that could have contradicted it, and the sign-out had just erased
 * it.
 *
 * So the failed half writes a value instead of erasing one. Absence still means silence; THIS
 * means "a session may still exist and it is not this browser's to use", which is evidence, and
 * the mirror's sync gate treats it as a contradiction until a fresh check names an owner.
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

/**
 * SAY THAT A SIGN-OUT WAS ASKED FOR AND NOT CONFIRMED — see {@link OWNER_SIGNED_OUT}.
 *
 * Written INSTEAD of clearing, and only on that one path: erasing the marker while the server
 * may still hold a live session is what let a window for another account go on using it. The
 * cookie is a session cookie here rather than an expired one, so closing the browser forgets it,
 * which is the right lifetime for a claim about a request that may yet be retried.
 *
 * `Secure` on a secure page only, for {@link forgetOwner}'s reason: a plain-http development
 * origin DISCARDS a `Secure` write silently, and a write that vanishes would leave the previous
 * account's id in place — the worst of the three states.
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
