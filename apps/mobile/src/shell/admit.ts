/**
 * The second key on the bridge. The native module admits a message only from the main frame of the
 * shell's origin, as the platform names them; this re-reads what it passed before anything parses
 * the message. A letter's frame shares the page's origin, so the frame fact is the one that tells
 * them apart, and a native half that stopped reading it would show up here as a refusal.
 */

/** The page's origin on each platform, as scheme and host: the asset loader's, and iOS's own scheme. */
const SHELL_ORIGINS: readonly { readonly scheme: string; readonly host: string }[] = [
  { scheme: "https", host: "appassets.androidplatform.net" },
  { scheme: "ohmail-shell", host: "app" },
];

export function admitBridgeMessage(facts: { readonly origin: string; readonly mainFrame: boolean }): boolean {
  if (facts.mainFrame !== true) return false;
  const at = facts.origin.indexOf("://");
  if (at < 0) return false;
  const scheme = facts.origin.slice(0, at);
  const host = facts.origin.slice(at + 3);
  return SHELL_ORIGINS.some((o) => o.scheme === scheme && o.host === host);
}
