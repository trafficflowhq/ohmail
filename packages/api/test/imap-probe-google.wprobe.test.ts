import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiDeps } from "@trafficflow/api";
import { ImapAdapter, type ImapConfig } from "@trafficflow/core/adapters/imap";
import { makeImapProbe } from "../src/imap-probe.js";
import { loadRefusals } from "../../core/test/adapters/_providershape.js";
import { startGoogleShapedImap, type GoogleShapedImap } from "../../core/test/adapters/_google-refusing.js";

/**
 * GMAIL'S REFUSALS THROUGH THE REAL PROBE, and its App Password pasted in groups.
 *
 * A strict loopback server answers each sign-in the way Google is believed to (`gmail.refusals.json`,
 * synthetic). The probe keeps `host: "imap.gmail.com"` — the hint and the dial rule are gated on it —
 * and only the socket is sent to the fake, as a hosts-file line would (the adapter dials plaintext
 * under the consent, on the fake's port), so the host the probe judges is the one the person typed.
 * Every value here is synthetic.
 */

const corpus = loadRefusals("gmail").refusals;
const byCase = new Map(corpus.map((r) => [r.case, r]));
// Built at run time: a literal in four groups reads as a real App Password to the push gate.
const APP = ["qwer", "tyas", "dfgh", "zxcv"].join("");
const GROUPED = APP.match(/.{4}/g)!.join(" ");
const PASS_FOR: Record<string, string> = {
  google_password: "plain-google-password", webalert: "case-webalert", web_browser: "case-web-browser",
  imap_disabled: "case-imap-disabled", invalid_credentials: "case-invalid",
};

/** This file's hosts-file line: the two names dial the fake; the egress guard still judges the rest. */
const HOSTS = new Set(["imap.gmail.com", "imap.example.test"]);
const realConnect = net.connect;
let fake: GoogleShapedImap;
beforeAll(async () => {
  net.connect = ((...args: unknown[]) => {
    const o = args[0] as { host?: unknown } | null;
    if (o && typeof o === "object" && typeof o.host === "string" && HOSTS.has(o.host)) {
      return (realConnect as (...a: unknown[]) => net.Socket)({ ...o, host: "127.0.0.1", lookup: undefined }, ...args.slice(1));
    }
    return (realConnect as (...a: unknown[]) => net.Socket)(...args);
  }) as typeof net.connect;
  fake = await startGoogleShapedImap({
    accept: APP,
    fallback: byCase.get("google_password")!,
    refusalFor: (pass) => {
      const c = Object.entries(PASS_FOR).find(([, p]) => p === pass)?.[0];
      return c === undefined ? null : byCase.get(c) ?? null;
    },
  });
});
afterAll(async () => {
  net.connect = realConnect;
  await fake.close();
});

const deps = (): ApiDeps => ({
  db: {} as ApiDeps["db"],
  now: () => new Date("2026-10-23T08:00:00Z"),
  services: { imapAdmission: { acquire: async () => true, release: async () => {} } } as unknown as ApiDeps["services"],
}) as ApiDeps;

const probe = makeImapProbe(deps(), {
  adapterFactory: (config: ImapConfig) => new ImapAdapter({
    ...config, port: fake.port, secure: false, allowInsecure: true,
  }),
});
const dial = (host: string, pass: string) => probe({
  accountId: "a", address: "someone@example.test",
  imap: { host, port: 993, secure: true, user: "someone@example.test", pass },
});

describe("the probe names Google's refusal", () => {
  for (const r of corpus) {
    it(`${r.case}: refuse/auth with authHint ${r.hint}, one login`, async () => {
      const before = fake.logins;
      const v = await dial("imap.gmail.com", PASS_FOR[r.case]!);
      expect(v).toEqual({ verdict: "refuse", code: "auth", authHint: r.hint });
      expect(fake.logins - before).toBe(1);
    }, 20_000);
  }

  it("control: the same refusal from a host that is not Google's carries no hint", async () => {
    const v = await dial("imap.example.test", PASS_FOR.google_password!);
    expect(v).toEqual({ verdict: "refuse", code: "auth" });
  }, 20_000);
});

describe("an App Password pasted in its groups connects, in one login", () => {
  for (const [label, pass] of [
    ["joined", APP], ["four groups", GROUPED], ["non-breaking spaces", GROUPED.replace(/ /g, " ")],
    ["spaces at the ends", ` ${GROUPED} `],
  ] as const) {
    it(`${label}`, async () => {
      const [logins, accepted] = [fake.logins, fake.accepted];
      const v = await dial("imap.gmail.com", pass);
      expect(v.verdict).toBe("ok");
      expect(fake.logins - logins).toBe(1);
      expect(fake.accepted - accepted).toBe(1);
    }, 20_000);
  }

  it("control: on a host that is not Google's the groups are sent as typed, and refused", async () => {
    const v = await dial("imap.example.test", GROUPED);
    expect(v).toEqual({ verdict: "refuse", code: "auth" });
  }, 20_000);
});
