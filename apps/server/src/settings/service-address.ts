/**
 * The address of a service this program calls with a bearer (the entitlements program).
 *
 * The rule: the bearer must not cross a public network unencrypted. `https:` is always admitted.
 * Plain `http:` is admitted only for a name that is private by its SHAPE ({@link isPrivateServiceName}),
 * and every dial then checks that the name resolves to private addresses only and pins the socket
 * to them (`private-network-fetch.ts`). No setting widens this: the operator names the service in
 * the address itself, and the code decides whether that name is private.
 */

export type ServiceTransport = "https" | "http-private";

export interface ServiceAddress {
  /** `scheme://host[:port]`, canonical: no path, query, fragment or credentials. */
  origin: string;
  hostname: string;
  transport: ServiceTransport;
}

/** Suffixes no public resolver answers for: the same names the public-address gate refuses. */
const PRIVATE_SUFFIXES = [".localhost", ".internal", ".home.arpa"] as const;

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Is `hostname` a private service name by shape? True for a single label that is no address
 * (`plane`, a compose or platform service name), `localhost` and `*.localhost`, a last label
 * `internal`, and a `.home.arpa` suffix. False for every IP literal (v4, v6, bracketed, mapped)
 * and every other name, `.local`, `.lan`, `.test` and `.corp` included.
 */
export function isPrivateServiceName(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (host === "") return false;
  // Any colon or bracket is an IPv6 literal; four dotted numbers, or one bare number, an IPv4 one.
  if (host.includes(":") || host.includes("[") || IPV4_LITERAL.test(host) || /^\d+$/.test(host)) return false;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) return false;
  if (!host.includes(".")) return true;
  return PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Parse `raw`, the value of `varName`, as a service address, or throw naming the variable and the
 * rule and never the value.
 */
export function parseServiceAddress(varName: string, raw: string): ServiceAddress {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${varName} must be an absolute https URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${varName} must be an absolute https URL`);
  }
  if (url.username || url.password) throw new Error(`${varName} must not embed credentials`);
  if (url.search || url.hash) throw new Error(`${varName} must not carry a query string or fragment`);
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error(
      `${varName} must be a bare origin with no path — the client appends /v1/…, ` +
        "so a path would be silently doubled",
    );
  }
  if (url.protocol === "http:" && !isPrivateServiceName(url.hostname)) {
    throw new Error(
      `${varName} must use https — the bearer rides every request. Plain http is admitted only ` +
        "for a private service name (a single label, or a name ending in .internal, .localhost " +
        "or .home.arpa), never for an address or a public name",
    );
  }
  return {
    origin: url.origin,
    hostname: url.hostname,
    transport: url.protocol === "https:" ? "https" : "http-private",
  };
}
