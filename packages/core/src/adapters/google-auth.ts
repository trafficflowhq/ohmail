/**
 * WHY GOOGLE REFUSED A SIGN-IN, as a closed set, and the one password rule Gmail needs.
 *
 * Gmail takes nothing but an App Password over IMAP, and its refusals all arrive as a failed LOGIN.
 * One generic "the server refused this password" sent people back to retype a Google password that
 * can never work, and was false where the password was fine (a web sign-in to confirm, IMAP turned
 * off). The hint is chosen from the response code and Google's known phrases; the server's text is
 * never echoed. Pure, no imports: the API, the sidecar and the phone's engine read it alike.
 */

const GOOGLE_MAIL_HOSTS: ReadonlySet<string> = new Set([
  "imap.gmail.com", "imap.googlemail.com", "smtp.gmail.com", "smtp.googlemail.com",
]);

/** Is this one of Google's mail hosts? Trimmed, lower-cased, a trailing dot removed. */
export function isGoogleMailHost(host: string | null | undefined): boolean {
  if (typeof host !== "string") return false;
  return GOOGLE_MAIL_HOSTS.has(host.trim().toLowerCase().replace(/\.$/, ""));
}

/** The four refusals, in no order. `invalid` is the fallback: any other Google NO to a login. */
export const GOOGLE_AUTH_HINTS = ["app_password_required", "web_login", "imap_disabled", "invalid"] as const;
export type GoogleAuthHint = (typeof GOOGLE_AUTH_HINTS)[number];

/** Codes that say "the login itself was refused"; anything else named (THROTTLED, …) is not ours to word. */
const LOGIN_REFUSED_CODES: ReadonlySet<string> = new Set(["", "ALERT", "WEBALERT", "AUTHENTICATIONFAILED", "AUTHORIZATIONFAILED"]);

/**
 * The hint for a refused sign-in on a Google host, or `null`. Walks `cause` to the first error that
 * carries imapflow's `authenticationFailed`, then reads its `serverResponseCode` and `responseText`.
 */
export function googleAuthHint(err: unknown, host: string | null | undefined): GoogleAuthHint | null {
  if (!isGoogleMailHost(host)) return null;
  let refused: Record<string, unknown> | null = null;
  for (let e: unknown = err, hops = 0; e !== null && typeof e === "object" && hops < 8; hops++) {
    if ((e as Record<string, unknown>).authenticationFailed === true) { refused = e as Record<string, unknown>; break; }
    e = (e as { cause?: unknown }).cause;
  }
  if (refused === null) return null;
  const code = typeof refused.serverResponseCode === "string" ? refused.serverResponseCode.toUpperCase() : "";
  if (!LOGIN_REFUSED_CODES.has(code)) return null;
  const text = typeof refused.responseText === "string" ? refused.responseText : "";
  if (/\bIMAP\b.*\bnot\s+enabled\b|\bnot\s+enabled\s+for\s+IMAP\b|\bIMAP\b.*\b(disabled|turned\s+off|off)\b/i.test(text)) {
    return "imap_disabled";
  }
  if (code === "WEBALERT" || /\bweb\s*browser\b|\bweb\s+login\b/i.test(text)) return "web_login";
  if (/application-specific\s+password|\bapp\s+password\b/i.test(text)) return "app_password_required";
  return "invalid";
}

/**
 * The password to dial a Google host with. Google shows an App Password as four groups of four
 * letters; pasted with its spaces (or non-breaking ones) a strict server refuses it. Only when the
 * host is Google's and removing every whitespace leaves exactly 16 letters is the joined form
 * returned; anything else is `pass` itself. Never changes a letter's case.
 */
export function googleAppPassword(host: string | null | undefined, pass: string): string {
  if (!isGoogleMailHost(host)) return pass;
  const joined = pass.replace(/\s+/g, "");
  return joined !== pass && /^[A-Za-z]{16}$/.test(joined) ? joined : pass;
}
