/**
 * WHO IS ASKING, as a count and nothing else. Every ohmail client names its kind and release on every
 * request, `x-ohmail-client: <kind>/<release>`. The one reader of it on the server is `GET /hello`
 * (`routes/hello.ts`), which writes the pair on its `hello_served` line: how many people are still on
 * which build. No other line carries it, and nothing reads it to decide anything: no route, gate, rate
 * or answer depends on it, and it reaches no `ApiDeps` field, no service context and no table. A
 * client that lies gets a wrong count and nothing more.
 *
 * Held to a closed form, so a hostile value cannot reach a log line: at most {@link MAX_BYTES} bytes,
 * one value, a kind from {@link CLIENT_KINDS}, a release of three small numbers or `dev`. Anything
 * else is `unknown` and its text is never logged, echoed, stored or compared.
 */

export const CLIENT_HEADER = "x-ohmail-client";

/** The five clients, as the clients name themselves (`@ohmail/client-engine`'s `CLIENT_KINDS`). */
export const CLIENT_KINDS = ["web", "desktop-window", "desktop-engine", "phone", "paired-page"] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

/** The longest value read at all, in bytes: the longest kind, a slash and a twelve-character release. */
export const MAX_BYTES = 40;

const RELEASE = /^(?:\d{1,4}\.\d{1,4}\.\d{1,4}|dev)$/;

export interface ClientIdentity {
  clientKind: ClientKind | "unknown";
  /** Present only with a recognised kind. */
  clientRelease?: string;
}

const UNKNOWN: ClientIdentity = { clientKind: "unknown" };

export function clientIdentityOf(headers: Headers): ClientIdentity {
  const raw = headers.get(CLIENT_HEADER);
  if (raw === null || raw.length > MAX_BYTES || new TextEncoder().encode(raw).length > MAX_BYTES) return UNKNOWN;
  const parts = raw.split("/");
  if (parts.length !== 2) return UNKNOWN;
  const [kind, release] = parts as [string, string];
  if (!(CLIENT_KINDS as readonly string[]).includes(kind) || !RELEASE.test(release)) return UNKNOWN;
  return { clientKind: kind as ClientKind, clientRelease: release };
}
