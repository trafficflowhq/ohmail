import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  KEK_RETIRED_REFUSED, PROXY_PEER_HEADER, TLS_TERMINATOR_GATEWAY, TLS_TERMINATOR_UNSET_REFUSED, loadServerConfig,
} from "../src/config.js";
import { KEY_RING_RETIRED, KEY_RING_V1, keyRingVar } from "../../../test/support/key-ring-env.js";

/**
 * `TF_TRUSTED_PROXIES` in the server's own config. Unset and empty both trust NO peer: there
 * is no default in the code, because the default lives in the bundled compose file where the
 * proxy is named. An address or CIDR that does not parse refuses the boot naming the entry's
 * position, never its text; a host name is kept as a name and never refuses, because the proxy it
 * names may start after this server.
 */
/* The compose service's role, interpolated: a whole credentialed URL literal is a credential to the push gate. */
const DB_ROLE = "ohmail";
const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  OHMAIL_ORIGIN: "https://mail.example.com",
  DATABASE_URL: `postgres://${DB_ROLE}:pw@db:5432/ohmail`,
  [KEY_RING_V1]: "ab".repeat(32),
  ...over,
} as NodeJS.ProcessEnv);

describe("TF_TRUSTED_PROXIES", () => {
  it("unset or empty: no set, and no default naming a proxy", () => {
    expect(loadServerConfig(env()).trustedProxies).toEqual([]);
    expect(loadServerConfig(env({ TF_TRUSTED_PROXIES: "" })).trustedProxies).toEqual([]);
    expect(loadServerConfig(env({ TF_TRUSTED_PROXIES: "   " })).trustedProxies).toEqual([]);
  });

  it("names, addresses and CIDRs, separated by commas or spaces", () => {
    expect(loadServerConfig(env({ TF_TRUSTED_PROXIES: "proxy, 172.16.0.0/12 10.0.0.5" })).trustedProxies)
      .toEqual(["proxy", "172.16.0.0/12", "10.0.0.5"]);
    expect(loadServerConfig(env({ TF_TRUSTED_PROXIES: "ohmail_proxy_1" })).trustedProxies).toEqual(["ohmail_proxy_1"]);
  });

  it("a malformed address or CIDR refuses the boot by position, never echoing the value", () => {
    for (const [value, position] of [["300.1.1.1", 1], ["proxy, 172.16.0.0/33", 2], ["proxy 10.0.0.1 1.2.3", 3]] as const) {
      let message = "";
      try { loadServerConfig(env({ TF_TRUSTED_PROXIES: value })); } catch (e) { message = (e as Error).message; }
      expect(message, value).toMatch(new RegExp(`^TF_TRUSTED_PROXIES entry ${position} is not usable`));
      expect(message).not.toContain(value.split(/[\s,]+/).at(-1)!);
    }
  });

  it("a host name that nothing resolves is accepted: resolution is later, never at boot", () => {
    expect(loadServerConfig(env({ TF_TRUSTED_PROXIES: "a-proxy-that-is-not-up-yet" })).trustedProxies)
      .toEqual(["a-proxy-that-is-not-up-yet"]);
  });
});

/**
 * OHMAIL_EXTERNAL_TLS and OHMAIL_TLS_TERMINATOR, the external door's two inputs. The proxy decides
 * whose X-Forwarded-For it believes; this server refuses to start on a terminator list the proxy
 * would read differently, and on none at all. Every refusal names the variable and the fix, never the value.
 */
describe("OHMAIL_TLS_TERMINATOR on the external door", () => {
  const refusal = (over: Record<string, string>): string => {
    try { loadServerConfig(env({ OHMAIL_EXTERNAL_TLS: "1", ...over })); } catch (e) { return (e as Error).message; }
    return "";
  };

  it("the TLS door ignores the value, even one the external door refuses", () => {
    expect(loadServerConfig(env()).externalDoor).toEqual({ door: "tls" });
    expect(loadServerConfig(env({ OHMAIL_EXTERNAL_TLS: "", OHMAIL_TLS_TERMINATOR: "::ffff:172.16.0.0/108,x" })).externalDoor)
      .toEqual({ door: "tls" });
  });

  it("unset refuses, absent or empty: nothing says whose X-Forwarded-For to believe", () => {
    expect(refusal({})).toBe(TLS_TERMINATOR_UNSET_REFUSED);
    expect(refusal({ OHMAIL_TLS_TERMINATOR: "" })).toBe(TLS_TERMINATOR_UNSET_REFUSED);
    // Set is compose's non-empty, so a space still opens the external door.
    expect(refusal({ OHMAIL_EXTERNAL_TLS: " " })).toBe(TLS_TERMINATOR_UNSET_REFUSED);
    expect(TLS_TERMINATOR_UNSET_REFUSED).toMatch(/set it to gateway .*, to your terminator's addresses or CIDRs .*, or to 0\.0\.0\.0\/32/);
  });

  it("a value of nothing but whitespace is unset and refuses, as the entrypoint reads it", () => {
    for (const v of [" ", "\n \n", "\u00a0"]) expect(refusal({ OHMAIL_TLS_TERMINATOR: v }), JSON.stringify(v)).toBe(TLS_TERMINATOR_UNSET_REFUSED);
  });

  it("gateway, the whole value as written, names the proxy's network gateway; a list is kept as written", () => {
    expect(TLS_TERMINATOR_GATEWAY).toBe("gateway");
    expect(loadServerConfig(env({ OHMAIL_EXTERNAL_TLS: "1", OHMAIL_TLS_TERMINATOR: "gateway" })).externalDoor)
      .toEqual({ door: "external", raw: "gateway", entries: [] });
    expect(loadServerConfig(env({ OHMAIL_EXTERNAL_TLS: "1", OHMAIL_TLS_TERMINATOR: "10.0.0.0/8 192.168.1.5" })).externalDoor)
      .toEqual({ door: "external", raw: "10.0.0.0/8 192.168.1.5", entries: ["10.0.0.0/8", "192.168.1.5"] });
    expect(refusal({ OHMAIL_TLS_TERMINATOR: " gateway" })).toMatch(/^OHMAIL_TLS_TERMINATOR uses whitespace other than single spaces/);
  });

  it("gateway inside a list refuses at its position: the list names the gateway's address instead", () => {
    expect(refusal({ OHMAIL_TLS_TERMINATOR: "gateway 10.0.0.1" })).toMatch(/^OHMAIL_TLS_TERMINATOR entry 1 is gateway, .* write the gateway's address/);
    expect(refusal({ OHMAIL_TLS_TERMINATOR: "10.0.0.1 gateway" })).toMatch(/^OHMAIL_TLS_TERMINATOR entry 2 is gateway, /);
  });

  it("the value is checked untrimmed, as the proxy reads it: a leading line break or space refuses", () => {
    expect(refusal({ OHMAIL_TLS_TERMINATOR: "\n203.0.113.9" })).toMatch(/^OHMAIL_TLS_TERMINATOR spans more than one line/);
    expect(refusal({ OHMAIL_TLS_TERMINATOR: "203.0.113.9\n" })).toMatch(/^OHMAIL_TLS_TERMINATOR spans more than one line/);
    for (const v of [" 203.0.113.9", "203.0.113.9 ", "10.0.0.0/8  192.168.1.5", "10.0.0.0/8\t192.168.1.5"]) {
      const m = refusal({ OHMAIL_TLS_TERMINATOR: v });
      expect(m, JSON.stringify(v)).toBe(
        "OHMAIL_TLS_TERMINATOR uses whitespace other than single spaces between entries — write the entries on one line, separated by single spaces",
      );
    }
  });

  it("a mapped address names the IPv4 form, at its position", () => {
    const m = refusal({ OHMAIL_TLS_TERMINATOR: "10.0.0.1 ::ffff:172.16.0.0/108" });
    expect(m).toMatch(/^OHMAIL_TLS_TERMINATOR entry 2 is an IPv4 address written in IPv6 form: .* write the IPv4 form$/);
    expect(m).not.toContain("172.16");
  });

  it("a keyword names Caddy, and a host name is refused the same way", () => {
    for (const v of ["link_local", "terminator.example"]) {
      const m = refusal({ OHMAIL_TLS_TERMINATOR: v });
      expect(m, v).toMatch(/^OHMAIL_TLS_TERMINATOR entry 1 is a word, not an address: a Caddy keyword .* the proxy takes no host names/);
      expect(m, v).not.toContain(v);
    }
  });

  it("the header this server reads the proxy's peer from is the one the bundled proxy writes", () => {
    const routes = readFileSync(fileURLToPath(new URL("../../../deploy/selfhost/proxy/routes.caddy", import.meta.url)), "utf8");
    const written = [...routes.matchAll(/header_up (\S+) \{http\.request\.remote\.host\}/g)].map((m) => m[1]!.toLowerCase());
    expect(written).toEqual([PROXY_PEER_HEADER, PROXY_PEER_HEADER]);
  });

  it("a comma names spaces; a line break names one line; anything else names addresses or CIDRs", () => {
    expect(refusal({ OHMAIL_TLS_TERMINATOR: "10.0.0.0/8,192.168.1.5" }))
      .toBe("OHMAIL_TLS_TERMINATOR separates entries with a comma: separate them with single spaces — a comma stops the proxy");
    expect(refusal({ OHMAIL_TLS_TERMINATOR: "10.0.0.0/8\n192.168.1.5" })).toMatch(/^OHMAIL_TLS_TERMINATOR spans more than one line/);
    const m = refusal({ OHMAIL_TLS_TERMINATOR: "10.0.0.1 300.1.1.1" });
    expect(m).toMatch(/^OHMAIL_TLS_TERMINATOR entry 2 is not an address or a CIDR/);
    expect(m).not.toContain("300.1.1.1");
  });
});

/**
 * The key-retirement variable. Cloud checks at boot and on /health that no stored secret still needs a
 * retired key version; this server has neither check yet, so it refuses the variable before anything
 * migrates or listens, with its own sentence: the shared loader's would advise removing a key still set.
 */
describe("the key-retirement variable on this server", () => {
  const KEY = "cd".repeat(32);
  const refused = (over: Record<string, string>): string => {
    try { loadServerConfig(env(over)); } catch (e) { return (e as Error).message; }
    return "";
  };

  it("refuses a ring whose oldest versions were retired, naming the variable and nothing it holds", () => {
    const m = refused({ [KEY_RING_V1]: "", [keyRingVar(8)]: KEY, [KEY_RING_RETIRED]: "7" });
    expect(m).toBe(KEK_RETIRED_REFUSED);
    expect(m).toContain(KEY_RING_RETIRED);
    for (const leak of ["7", KEY, "remove"]) expect(m).not.toContain(leak);
  });

  it("refuses before the shared loader reads the ring, so its advice to remove a key never shows", () => {
    expect(refused({ [keyRingVar(2)]: KEY, [KEY_RING_RETIRED]: "1" })).toBe(KEK_RETIRED_REFUSED);
    expect(refused({ [KEY_RING_RETIRED]: "abc" })).toBe(KEK_RETIRED_REFUSED);
  });

  it("empty or whitespace is unset: the ring loads", () => {
    for (const v of ["", "  "]) {
      const cfg = loadServerConfig(env({ [KEY_RING_RETIRED]: v }));
      expect(cfg.kekError, JSON.stringify(v)).toBeNull();
      expect(cfg.kek?.active).toBe(1);
    }
  });
});
