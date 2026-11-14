/**
 * WHO IS ASKING: every ohmail client names its kind and its release on every request it makes to an
 * ohmail server, in one header, `x-ohmail-client: <kind>/<release>`. A header of its own and not
 * `User-Agent`, which a browser's `fetch` may not set. It carries nothing else: no install, no
 * account. A server may count it and may choose an answer's shape by it; it is never a credential.
 * Each host sets it at its own transport, once, and nowhere else.
 */
export const CLIENT_HEADER = "x-ohmail-client";

/** THE CLOSED SET of clients. A relayed request is the relaying client's: one hop, one name. */
export const CLIENT_KINDS = ["web", "desktop-window", "desktop-engine", "phone", "paired-page"] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

/** A build that states no release says this in its place, so the value keeps one form. */
export const CLIENT_RELEASE_UNSTATED = "dev";

/** A release as the version bump writes it: three numbers and nothing after them. */
const RELEASE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

/** The header's value. Anything that is not a release reads as unstated, never as text of its own. */
export function clientHeaderValue(kind: ClientKind, release: string | null | undefined): string {
  const stated = typeof release === "string" ? release.trim() : "";
  return `${kind}/${RELEASE.test(stated) ? stated : CLIENT_RELEASE_UNSTATED}`;
}

/** The header as the one pair a transport spreads into its own. */
export function clientHeaders(kind: ClientKind, release: string | null | undefined): Readonly<Record<string, string>> {
  return { [CLIENT_HEADER]: clientHeaderValue(kind, release) };
}
