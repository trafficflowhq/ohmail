import net from "node:net";
import tls from "node:tls";
import { createHash } from "node:crypto";

/**
 * The root the managed pooler's certificate chains to, as DER hex: `*.pooler.<provider>` <- the
 * provider's Intermediate 2021 CA <- this, read over a verify-full handshake on 2026-09-26. The
 * provider publishes it; sha256 807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa,
 * valid to 2031-04-26. The system store alone cannot verify that chain. No relative imports in
 * this module: the root scripts import it as source.
 */
const POOLER_ROOT_DER = [
  "308203c4308202aca00302010202146cbc4ca1deb63f692d0a2024c67289c2d13d54f6300d06092a864886f70d01010b",
  "0500306b310b30090603550406130255533110300e06035504080c0744656c776172653113301106035504070c0a4e65",
  "7720436173746c6531153013060355040a0c0c537570616261736520496e63311e301c06035504030c15537570616261",
  "736520526f6f742032303231204341301e170d3231303432383130353635335a170d3331303432363130353635335a30",
  "6b310b30090603550406130255533110300e06035504080c0744656c776172653113301106035504070c0a4e65772043",
  "6173746c6531153013060355040a0c0c537570616261736520496e63311e301c06035504030c15537570616261736520",
  "526f6f74203230323120434130820122300d06092a864886f70d01010105000382010f003082010a0282010100a905d6",
  "4321ce07ea91d862686c2abf081990e341b4a039820b79b35679fcb2fe1735e5ad1395dc10bd2e56287b268e03931d50",
  "0e6187047d730df82cdaa5e22dbeb1a70fc22903f2a595b526cb0e4cc21f429a4d43cecaef961ad29db963778f4b6b76",
  "1adbc7c4d8d457a9233998c49f6c9611c05da4e54251805514134c0786011e43510daffe4b8bb2c00a1a4d69c224b522",
  "72f4e51e6330eb1490427d547d1407939d03302109ec2cb5471ad926b9175d13f72ea40bda28c9e85e3231f87e1b26f8",
  "3b85da8e8563ffe4781b0cb0298aeb4bc3eb48db70c6be52b6540ef33210512322ab6eb033c9a010b1654bfdf651c96d",
  "35a435c41462ce4ce965cb7d0f0203010001a360305e300b0603551d0f040403020106301d0603551d0e04160414a8d7",
  "b97637d82ced9212269e0e3224d52d69462c301f0603551d23041830168014a8d7b97637d82ced9212269e0e3224d52d",
  "69462c300f0603551d130101ff040530030101ff300d06092a864886f70d01010b050003820101001f2ca73367fb8554",
  "b55c5b74c697fb7f59e74b1ceee0139aeb35ea39a61e38481f3fa5ffd1a52792aa00c3b1dba98f6607f31bba2778bd9b",
  "556f968185244d3dd710f1569d3a76449c106a8f3fb583d7584243734595407ae99a758e14a53f77732a060066e72fba",
  "8c1f354d4fd11b6ad57ab3c358ffb530c70d372d38f750932f95d067b25f0c927d08299749db53978b944274aebff431",
  "09e6b5dc15f666025cec0bb7d2f8a12e1b9be760dee0fff88289cab0d1d875b5a383b3962b036fff38ad18354307d636",
  "08c4f264a1b75c4bb91a19752c49c8dd09842aca9a08bbf5d819d58db912799b0c9debc93ecd587ba4e38c9c1d8a4e4f",
  "a3f6ca888cfe16af",
].join("");

/** {@link POOLER_ROOT_DER} as the PEM Node's `ca` option takes. */
export const POOLER_ROOT_CA = `-----BEGIN CERTIFICATE-----\n${
  Buffer.from(POOLER_ROOT_DER, "hex").toString("base64").match(/.{1,64}/g)!.join("\n")
}\n-----END CERTIFICATE-----\n`;

/** What a pool's handshake proves: chain and host name verified, encrypted only, or nothing. */
export type PgTransport = "verified" | "unverified" | "off";

/** A managed provider's URL asked for a mode that lets the connection continue in plaintext. */
export class PgTransportRefusedError extends Error {
  readonly code = "pg_transport_refused";
  readonly reason: string;
  constructor(reason: string) {
    super(`refusing a Postgres connection: ${reason}`);
    this.name = "PgTransportRefusedError";
    this.reason = reason;
  }
}

/** `pinned`: the provider root above verifies the chain; `system`: a public CA does. */
type Family = "pinned" | "system" | null;

function parse(url: string): URL | null {
  try { return new URL(url); } catch { return null; }
}

/** The managed providers' hosts, by the TLS they are dialled with. Tested on the parsed HOSTNAME, never the whole URL. */
function familyOf(host: string): Family {
  if (host.endsWith(".supabase.com") || host.endsWith(".supabase.co")) return "pinned";
  if (host.endsWith(".neon.tech")) return "system";
  return null;
}

/** The URL's TLS mode as postgres.js reads it: `sslmode`, then `ssl`; `sslrootcert=system` is verify-full. */
function modeOf(u: URL): string | null {
  if (u.searchParams.get("sslrootcert") === "system") return "verify-full";
  return (u.searchParams.get("sslmode") ?? u.searchParams.get("ssl"))?.trim().toLowerCase() || null;
}

/** Modes under which postgres.js continues without TLS, or with TLS it never checks against a server refusal. */
const PLAINTEXT_MODES = new Set(["disable", "false", "allow", "prefer"]);
const UNVERIFIED_MODES = new Set(["require", "allow", "prefer", "no-verify", "true"]);

/**
 * Why this URL may not be dialled, or null. Only a managed provider's host is refused, and only for
 * a mode that permits plaintext: an unknown host (a self-hosted Postgres beside the server) keeps
 * its own URL's semantics, on `runtimeUrlReason`'s fail-open terms.
 */
export function pgTransportReason(url: string): string | null {
  const u = parse(url);
  if (!u || familyOf(u.hostname.toLowerCase()) === null) return null;
  const mode = modeOf(u);
  if (mode !== null && PLAINTEXT_MODES.has(mode)) {
    return `the host is a managed provider's and sslmode=${mode} would let the connection continue in plaintext`;
  }
  return null;
}

/** Verified handshakes per connection string, keyed by its digest so no URL is held as a key. */
const verified = new Map<string, number>();
const keyOf = (url: string): string => createHash("sha256").update(url).digest("hex");

/** Node calls this only after the chain verified against `ca`; it counts a handshake whose host name matched. */
function recorder(url: string): (host: string, cert: tls.PeerCertificate) => Error | undefined {
  const key = keyOf(url);
  return (host, cert) => {
    const err = tls.checkServerIdentity(host, cert);
    if (!err) verified.set(key, (verified.get(key) ?? 0) + 1);
    return err;
  };
}

/**
 * The `ssl` option for a postgres.js client of `url`, to spread into its options (an absent key
 * keeps the URL's own mode; a present one overrides it). A `pinned` provider host: TLS verified
 * against {@link POOLER_ROOT_CA} whatever the URL says. A `system` provider host, and any host whose
 * URL asks for verify-full or verify-ca: TLS verified against the system store. Otherwise nothing.
 * Throws {@link PgTransportRefusedError} on {@link pgTransportReason}.
 */
export function pgTlsOptions(url: string): { ssl?: tls.ConnectionOptions } {
  const u = parse(url);
  if (!u) return {};
  const reason = pgTransportReason(url);
  if (reason) throw new PgTransportRefusedError(reason);
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const family = familyOf(host);
  const mode = modeOf(u);
  if (family === null && mode !== "verify-full" && mode !== "verify-ca") return {};
  return {
    ssl: {
      ...(family === "pinned" ? { ca: POOLER_ROOT_CA } : {}),
      rejectUnauthorized: true,
      ...(net.isIP(host) ? {} : { servername: host }),
      checkServerIdentity: recorder(url),
    },
  };
}

/** What {@link pgTlsOptions} makes of `url`, without throwing: a refused URL reads `off`. */
export function pgTransportOf(url: string): PgTransport {
  const u = parse(url);
  if (!u) return "off";
  if (pgTransportReason(url)) return "off";
  if (pgTlsOptions(url).ssl) return "verified";
  const mode = modeOf(u);
  return mode !== null && UNVERIFIED_MODES.has(mode) ? "unverified" : "off";
}

/** Verified handshakes this process has completed on `url`'s pools — the live half of `/health`'s `dbTls`. */
export function verifiedHandshakes(url: string): number {
  return verified.get(keyOf(url)) ?? 0;
}
