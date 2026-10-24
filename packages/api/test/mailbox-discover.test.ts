/**
 * `POST /mailboxes/discover` — WHERE A DOMAIN'S MAIL IS HOSTED, FROM DNS ALONE.
 *
 * The connect forms asked for a provider before they had an address, so a domain on Google
 * Workspace was steered to "your own server" and asked for host names. This route reads the
 * domain's MX and RFC 6186 SRV records and answers one fixed shape the form may prefill from.
 * Driven through the real pipeline with an injected resolver: the suite makes no DNS query.
 */
import { inspect } from "node:util";
import { sql } from "drizzle-orm";
import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps, type MailDnsResolver } from "@trafficflow/api";
import type { Logger } from "@trafficflow/core";
import { DISCOVER_BUDGET_MS, DISCOVER_PER_ACCOUNT } from "../src/routes/mailbox-discover.js";
import { makeDeps, seedSession, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

const post = (token: string, body: unknown): Request =>
  req("POST", "/mailboxes/discover", { bearer: token, body: typeof body === "string" ? body : JSON.stringify(body) });

const NOTHING = { preset: null, proton: false, imap: null, smtp: null };

interface Zone {
  mx?: ReadonlyArray<readonly [number, string]>;
  srv?: Readonly<Record<string, ReadonlyArray<{ name: string; port: number; priority?: number; weight?: number }>>>;
  a?: Readonly<Record<string, readonly string[]>>;
}

/** A resolver over one zone, recording every question and the signal it came with. */
function fakeDns(zone: Zone, o: { hang?: boolean; fault?: string } = {}): MailDnsResolver & {
  asked: string[]; signals: AbortSignal[];
} {
  const asked: string[] = [];
  const signals: AbortSignal[] = [];
  const answer = async <T>(q: string, signal: AbortSignal | undefined, value: T | undefined): Promise<T> => {
    asked.push(q);
    if (signal) signals.push(signal);
    if (o.hang) {
      return new Promise<T>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("cancelled"))));
    }
    // A Node resolver's own fault names the domain it was asked about, in the message and a field.
    if (o.fault) throw Object.assign(new Error(`queryMx ESERVFAIL ${o.fault}`), { code: "ESERVFAIL", hostname: o.fault });
    if (value === undefined) throw Object.assign(new Error("no data"), { code: "ENODATA" });
    return value;
  };
  return {
    asked, signals,
    resolveMx: (domain, signal) =>
      answer(`MX ${domain}`, signal, zone.mx?.map(([priority, exchange]) => ({ priority, exchange }))),
    resolveSrv: (name, signal) => answer(`SRV ${name}`, signal, zone.srv?.[name]?.map((r) => ({
      priority: r.priority ?? 0, weight: r.weight ?? 0, port: r.port, name: r.name,
    }))),
    resolve: (host, signal) => answer(`A ${host}`, signal, zone.a?.[host] ? [...zone.a[host]!] : undefined),
  };
}

/** Every call the logger receives, as text, with thrown values printed whole. */
function recordingLogger(): { logger: Logger; seen: () => string; calls: () => number } {
  const calls: unknown[][] = [];
  const make = (): Logger => ({
    level: "debug",
    child: (fields) => { calls.push(["child", fields]); return make(); },
    debug: (e, f) => { calls.push([e, f]); },
    info: (e, f) => { calls.push([e, f]); },
    warn: (e, f) => { calls.push([e, f]); },
    error: (e, f) => { calls.push([e, f]); },
  });
  return {
    logger: make(),
    seen: () => calls.map((c) => inspect(c, { depth: 10, showHidden: true })).join("\n").toLowerCase(),
    calls: () => calls.length,
  };
}

async function harness(dns: MailDnsResolver | undefined, o: { verified?: boolean } = {}) {
  const { db, deps, clock } = await makeDeps();
  const log = recordingLogger();
  const s = await seedSession(db, { now: FIXED_NOW, emailVerified: o.verified ?? true });
  const d: ApiDeps = { ...deps, logger: log.logger, ...(dns ? { mailDns: dns } : {}) };
  return { db, deps: d, clock, log, token: s.token };
}

async function ask(h: Awaited<ReturnType<typeof harness>>, body: unknown): Promise<Response> {
  return H(post(h.token, body), h.deps);
}

const rowsOf = <T>(result: unknown): T[] =>
  Array.isArray(result) ? result as T[] : ((result as { rows?: T[] }).rows ?? []);

/** Row counts of every table but the session's own, which resolving a bearer may touch. */
async function tableCounts(db: Awaited<ReturnType<typeof makeDeps>>["db"]): Promise<Record<string, number>> {
  const tables = rowsOf<{ t: string }>(await db.execute(sql`
    select table_name as t from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE' and table_name <> 'sessions'`));
  const out: Record<string, number> = {};
  for (const { t } of tables) {
    out[t] = Number(rowsOf<{ n: number }>(await db.execute(sql.raw(`select count(*)::int as n from "${t}"`)))[0]?.n ?? 0);
  }
  return out;
}

describe("the answer: one fixed shape, from MX and SRV records only", () => {
  it("a domain whose mail Google hosts suggests the Gmail preset, and claims nothing else", async () => {
    const dns = fakeDns({ mx: [[1, "smtp.google.com."]] });
    const h = await harness(dns);
    const before = await tableCounts(h.db);

    const res = await ask(h, { domain: "praxis-sonnhalde.ch" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...NOTHING, preset: "gmail" });
    // DNS only, and only about the domain it was given.
    expect(dns.asked.every((q) => q.endsWith("praxis-sonnhalde.ch"))).toBe(true);
    // Nothing stored: no table gained or lost a row.
    expect(await tableCounts(h.db)).toEqual(before);
    expect(h.log.seen()).not.toContain("praxis-sonnhalde");
  });

  it("Microsoft 365, by either of its MX families", async () => {
    for (const exchange of ["kanzlei-brunner-ch.mail.protection.outlook.com", "kanzlei-brunner-ch.l-v1.mx.microsoft"]) {
      const h = await harness(fakeDns({ mx: [[0, exchange]] }));
      expect(await (await ask(h, { domain: "kanzlei-brunner.ch" })).json()).toEqual({ ...NOTHING, preset: "microsoft" });
    }
  });

  it("the most-preferred exchanges decide: a filter in front of Google suggests nothing", async () => {
    const h = await harness(fakeDns({ mx: [[20, "aspmx.l.google.com"], [10, "mx1.filter-dienst.net"]] }));
    expect(await (await ask(h, { domain: "praxis-sonnhalde.ch" })).json()).toEqual(NOTHING);
  });

  it("a domain on Proton says so, and names no preset", async () => {
    const h = await harness(fakeDns({ mx: [[10, "mail.protonmail.ch"], [20, "mailsec.protonmail.ch"]] }));
    expect(await (await ask(h, { domain: "verein-alpenblick.ch" })).json()).toEqual({ ...NOTHING, proton: true });
  });

  it("RFC 6186: implicit TLS is preferred, and each server is named only once its addresses are public", async () => {
    const dns = fakeDns({
      srv: {
        "_imaps._tcp.atelier-vogel.ch": [{ name: "mail.atelier-vogel.ch.", port: 993 }],
        "_imap._tcp.atelier-vogel.ch": [{ name: "mail.atelier-vogel.ch", port: 143 }],
        "_submission._tcp.atelier-vogel.ch": [
          { name: "smtp2.atelier-vogel.ch", port: 587, priority: 20 },
          { name: "smtp.atelier-vogel.ch", port: 587, priority: 10 },
        ],
      },
      a: { "mail.atelier-vogel.ch": ["185.31.4.10"], "smtp.atelier-vogel.ch": ["185.31.4.11", "2a00:1450:4001::1"] },
    });
    const h = await harness(dns);

    expect(await (await ask(h, { domain: "atelier-vogel.ch" })).json()).toEqual({
      ...NOTHING,
      imap: { host: "mail.atelier-vogel.ch", port: 993, secure: true },
      smtp: { host: "smtp.atelier-vogel.ch", port: 587, secure: false },
    });
    expect(dns.asked).not.toContain("A smtp2.atelier-vogel.ch");
  });

  it("an SRV target that resolves to any private address, a non-mail port, '.' or a special-use name is dropped", async () => {
    const dns = fakeDns({
      srv: {
        "_imaps._tcp.atelier-vogel.ch": [{ name: "intern.atelier-vogel.ch", port: 993 }],
        "_imap._tcp.atelier-vogel.ch": [{ name: "mail.atelier-vogel.ch", port: 8143 }],
        "_submissions._tcp.atelier-vogel.ch": [{ name: ".", port: 465 }],
        "_submission._tcp.atelier-vogel.ch": [{ name: "smtp.atelier.corp", port: 587 }],
      },
      a: {
        "intern.atelier-vogel.ch": ["185.31.4.10", "10.0.0.5"],
        "mail.atelier-vogel.ch": ["185.31.4.10"],
        "smtp.atelier.corp": ["185.31.4.11"],
      },
    });
    const h = await harness(dns);

    expect(await (await ask(h, { domain: "atelier-vogel.ch" })).json()).toEqual(NOTHING);
    // Neither the port nor the name was worth a lookup.
    expect(dns.asked).not.toContain("A mail.atelier-vogel.ch");
    expect(dns.asked).not.toContain("A smtp.atelier.corp");
  });

  it("a domain with no records, and a resolver that fails, both answer the empty shape", async () => {
    const quiet = await harness(fakeDns({}));
    expect(await (await ask(quiet, { domain: "metzgerei-huber.ch" })).json()).toEqual(NOTHING);

    const broken = await harness(fakeDns({}, { fault: "metzgerei-huber.ch" }));
    const res = await ask(broken, { domain: "metzgerei-huber.ch" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(NOTHING);
    expect(broken.log.seen()).not.toContain("metzgerei-huber");
  });

  it("an IDN is looked up in its ASCII form", async () => {
    const dns = fakeDns({ mx: [[5, "in1-smtp.messagingengine.com"]] });
    const h = await harness(dns);
    expect(await (await ask(h, { domain: "Bücher-Stube.CH." })).json()).toEqual({ ...NOTHING, preset: "fastmail" });
    expect(dns.asked).toContain("MX xn--bcher-stube-thb.ch");
  });
});

describe("the bounds of one lookup", () => {
  it(`answers within the ${DISCOVER_BUDGET_MS} ms budget when DNS never does, and cancels what is left`, async () => {
    const dns = fakeDns({}, { hang: true });
    const h = await harness(dns);
    const started = performance.now();

    const res = await ask(h, { domain: "praxis-sonnhalde.ch" });

    const took = performance.now() - started;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(NOTHING);
    expect(took).toBeGreaterThanOrEqual(DISCOVER_BUDGET_MS - 50);
    expect(took).toBeLessThan(DISCOVER_BUDGET_MS + 1_500);
    expect(dns.signals.length).toBeGreaterThan(0);
    expect(dns.signals.every((s) => s.aborted)).toBe(true);
    expect(h.log.seen()).not.toContain("praxis-sonnhalde");
  }, 15_000);

  it("reads at most a bounded number of records from an answer somebody else controls", async () => {
    const many = Array.from({ length: 500 }, (_, i) => [1, `mx${i}.filter-dienst.net`] as const);
    const dns = fakeDns({
      mx: [...many, [1, "aspmx.l.google.com"]],
      srv: {
        "_imaps._tcp.atelier-vogel.ch": Array.from({ length: 500 }, (_, i) => ({ name: `m${i}.atelier-vogel.ch`, port: 993, priority: 1 })),
      },
      a: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`m${i}.atelier-vogel.ch`, ["10.0.0.1"]])),
    });
    const h = await harness(dns);
    expect(await (await ask(h, { domain: "atelier-vogel.ch" })).json()).toEqual(NOTHING);
    // Only a service's best record is resolved, however many came back.
    expect(dns.asked.filter((q) => q.startsWith("A "))).toEqual(["A m0.atelier-vogel.ch"]);
  });
});

describe("what it refuses before any lookup", () => {
  const SPECIAL = [
    "router.home.arpa", "app.localhost", "mail.test", "x.invalid", "mail.example", "abc.onion",
    "nas.lan", "dc1.corp", "portal.intranet", "printer.local", "db.internal", "localhost", "intranet",
  ];

  it("special-use and private names, each one, with no question asked", async () => {
    const dns = fakeDns({ mx: [[1, "aspmx.l.google.com"]] });
    const h = await harness(dns);
    for (const domain of SPECIAL) {
      const res = await ask(h, { domain });
      expect(res.status, domain).toBe(400);
      expect((await res.json()).error.code, domain).toBe("validation_failed");
    }
    expect(dns.asked).toEqual([]);
  });

  it("anything that is not a domain after IDNA normalisation, and IP literals", async () => {
    const dns = fakeDns({});
    const h = await harness(dns);
    const long = `${"a".repeat(63)}.`.repeat(4) + "ch";
    for (const domain of [
      "", " ", "a..b.ch", "-bad.ch", "bad-.ch", "exa mple.ch", "mail_box.ch", "xn--.ch", `${"a".repeat(64)}.ch`, long,
      "192.0.2.1", "127.0.0.1", "[::1]", "2001:db8::1", "1.2.3.4.5", "example.123",
    ]) {
      expect((await ask(h, { domain })).status, JSON.stringify(domain)).toBe(400);
    }
    for (const domain of [42, null, ["praxis-sonnhalde.ch"], { d: 1 }]) {
      expect((await ask(h, { domain })).status, JSON.stringify(domain)).toBe(400);
    }
    expect(dns.asked).toEqual([]);
  });

  it("the body carries the domain only: an address, or any second field, is refused and never echoed", async () => {
    const dns = fakeDns({ mx: [[1, "aspmx.l.google.com"]] });
    const h = await harness(dns);

    const whole = await ask(h, { domain: "lena.meier@praxis-sonnhalde.ch" });
    expect(whole.status).toBe(400);
    expect(await whole.text()).not.toContain("lena.meier");

    expect((await ask(h, { domain: "praxis-sonnhalde.ch", address: "lena.meier@praxis-sonnhalde.ch" })).status).toBe(400);
    expect((await ask(h, ["praxis-sonnhalde.ch"])).status).toBe(400);
    expect((await ask(h, "praxis-sonnhalde.ch")).status).toBe(400);
    expect(dns.asked).toEqual([]);
    expect(h.log.seen()).not.toContain("lena.meier");
    expect(h.log.seen()).not.toContain("praxis-sonnhalde");
  });
});

describe("who may ask, and how often", () => {
  it("an account whose address is not verified is refused before any lookup", async () => {
    const dns = fakeDns({ mx: [[1, "aspmx.l.google.com"]] });
    const h = await harness(dns, { verified: false });
    const res = await ask(h, { domain: "praxis-sonnhalde.ch" });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("email_unverified");
    expect(dns.asked).toEqual([]);
  });

  it("no session, no lookup", async () => {
    const dns = fakeDns({ mx: [[1, "aspmx.l.google.com"]] });
    const h = await harness(dns);
    const res = await H(req("POST", "/mailboxes/discover", { body: JSON.stringify({ domain: "praxis-sonnhalde.ch" }) }), h.deps);
    expect(res.status).toBe(401);
    expect(dns.asked).toEqual([]);
  });

  it(`at most ${DISCOVER_PER_ACCOUNT.max} lookups per account in the window; another account is not held back`, async () => {
    const dns = fakeDns({ mx: [[1, "aspmx.l.google.com"]] });
    const h = await harness(dns);
    for (let i = 0; i < DISCOVER_PER_ACCOUNT.max; i++) {
      expect((await ask(h, { domain: "praxis-sonnhalde.ch" })).status, `lookup ${i + 1}`).toBe(200);
    }
    const asked = dns.asked.length;

    const refused = await ask(h, { domain: "praxis-sonnhalde.ch" });
    expect(refused.status).toBe(429);
    expect((await refused.json()).error.code).toBe("rate_limited");
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(dns.asked.length, "a refused lookup asked DNS anyway").toBe(asked);

    const other = await seedSession(h.db, { now: FIXED_NOW });
    expect((await H(post(other.token, { domain: "praxis-sonnhalde.ch" }), h.deps)).status).toBe(200);

    h.clock.advance(DISCOVER_PER_ACCOUNT.windowMs);
    expect((await ask(h, { domain: "praxis-sonnhalde.ch" })).status).toBe(200);
    expect(h.log.seen()).not.toContain("praxis-sonnhalde");
  });

  it("a host that wired no resolver says so, and the domain still reaches no log", async () => {
    const h = await harness(undefined);
    const res = await ask(h, { domain: "praxis-sonnhalde.ch" });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("discover_unconfigured");
    // The refusal is logged, so the capture is live — and the domain is not in it.
    expect(h.log.calls()).toBeGreaterThan(0);
    expect(h.log.seen()).not.toContain("praxis-sonnhalde");
  });
});
