import { describe, it, expect } from "vitest";
import { makeDnsDkimKeys, type TxtResolver } from "../src/adapters/dkim-keys.js";

/**
 * THE KEY LOOKUP — `adapters/dkim-keys.ts`, over a fake resolver: the suite's network guard refuses
 * every real query. One process cache of public DNS answers (an hour for a key, five minutes for a
 * miss), a deadline, at most eight queries in flight, and a name checked before anything is asked.
 */

const NAME = "s1._domainkey.paypal.com";

function resolverOf(answer: (name: string) => Promise<string[][]>) {
  const asked: string[] = [];
  let open = 0;
  let peak = 0;
  const resolver: TxtResolver = {
    async resolveTxt(name: string) {
      asked.push(name);
      open++;
      peak = Math.max(peak, open);
      try {
        return await answer(name);
      } finally {
        open--;
      }
    },
  };
  return { resolver, asked, peak: () => peak };
}

const dnsError = (code: string) => Object.assign(new Error(code), { code });

describe("the lookup's answers", () => {
  it("a record's chunks are joined, and the answer is kept an hour", async () => {
    let t = 0;
    const r = resolverOf(async () => [["v=DKIM1; k=rsa; ", "p=AAAA"]]);
    const keys = makeDnsDkimKeys({ resolver: () => r.resolver, now: () => t });
    expect(await keys.lookup(NAME)).toEqual({ kind: "records", records: ["v=DKIM1; k=rsa; p=AAAA"] });
    t += 59 * 60_000;
    await keys.lookup(NAME);
    expect(r.asked).toHaveLength(1);
    t += 2 * 60_000;
    await keys.lookup(NAME);
    expect(r.asked).toHaveLength(2);
  });

  it("no record is a miss, kept five minutes; so is an error", async () => {
    let t = 0;
    const answers: Record<string, () => Promise<string[][]>> = {
      "a._domainkey.none.example": async () => { throw dnsError("ENOTFOUND"); },
      "a._domainkey.empty.example": async () => { throw dnsError("ENODATA"); },
      "a._domainkey.zero.example": async () => [],
      "a._domainkey.fail.example": async () => { throw dnsError("ESERVFAIL"); },
    };
    const r = resolverOf((name) => answers[name]!());
    const keys = makeDnsDkimKeys({ resolver: () => r.resolver, now: () => t });
    expect(await keys.lookup("a._domainkey.none.example")).toEqual({ kind: "none" });
    expect(await keys.lookup("a._domainkey.empty.example")).toEqual({ kind: "none" });
    expect(await keys.lookup("a._domainkey.zero.example")).toEqual({ kind: "none" });
    expect(await keys.lookup("a._domainkey.fail.example")).toEqual({ kind: "error" });
    t += 4 * 60_000;
    for (const n of Object.keys(answers)) await keys.lookup(n);
    expect(r.asked).toHaveLength(4);
    t += 2 * 60_000;
    for (const n of Object.keys(answers)) await keys.lookup(n);
    expect(r.asked).toHaveLength(8);
  });

  it("a query that does not answer in time is an error", async () => {
    const r = resolverOf(() => new Promise(() => undefined));
    const keys = makeDnsDkimKeys({ resolver: () => r.resolver, timeoutMs: 20 });
    expect(await keys.lookup(NAME)).toEqual({ kind: "error" });
  });

  it("the default deadline is two seconds", async () => {
    const started = Date.now();
    const r = resolverOf(() => new Promise(() => undefined));
    const keys = makeDnsDkimKeys({ resolver: () => r.resolver });
    expect(await keys.lookup(NAME)).toEqual({ kind: "error" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
    expect(Date.now() - started).toBeLessThan(4_000);
  }, 10_000);
});

describe("a signing domain whose name servers fail", () => {
  /* The sender chooses the selector, so a miss kept per name is dodged by a fresh one per letter:
     the failure is kept for the signing domain too. */
  it("a query that fails or does not answer marks its domain: no other selector there is asked for five minutes", async () => {
    let t = 0;
    const r = resolverOf((name) => {
      if (name.endsWith(".silent.example")) return new Promise(() => undefined);
      if (name.endsWith(".servfail.example")) return Promise.reject(dnsError("ESERVFAIL"));
      return Promise.resolve([["v=DKIM1; p=AAAA"]]);
    });
    const keys = makeDnsDkimKeys({ resolver: () => r.resolver, now: () => t, timeoutMs: 20 });
    for (const name of ["a1._domainkey.silent.example", "b2._domainkey.silent.example",
      "c1._domainkey.servfail.example", "d2._domainkey.servfail.example"]) {
      expect(await keys.lookup(name), name).toEqual({ kind: "error" });
    }
    expect(r.asked).toEqual(["a1._domainkey.silent.example", "c1._domainkey.servfail.example"]);
    // Another signer is asked as before, a child of a failed domain included.
    expect(await keys.lookup(NAME)).toMatchObject({ kind: "records" });
    expect(await keys.lookup("s1._domainkey.mail.servfail.example")).toEqual({ kind: "error" });
    expect(r.asked).toHaveLength(4);
    t += 4 * 60_000;
    expect(await keys.lookup("e3._domainkey.silent.example")).toEqual({ kind: "error" });
    expect(r.asked).toHaveLength(4);
    t += 2 * 60_000;
    await keys.lookup("f4._domainkey.silent.example");
    expect(r.asked, "the mark outlived its five minutes").toHaveLength(5);
  });

  it("CONTROL: no record at one selector says nothing about another", async () => {
    const r = resolverOf(async (name) => {
      if (name.startsWith("old.")) throw dnsError("ENOTFOUND");
      return [["v=DKIM1; p=AAAA"]];
    });
    const keys = makeDnsDkimKeys({ resolver: () => r.resolver });
    expect(await keys.lookup("old._domainkey.paypal.com")).toEqual({ kind: "none" });
    expect(await keys.lookup("new._domainkey.paypal.com")).toMatchObject({ kind: "records" });
    expect(r.asked).toHaveLength(2);
  });

  it("a wait for a free slot that runs out marks no domain: the queue is this process's, not the sender's", async () => {
    // Eight late answers hold every slot; a ninth lookup, at another domain, waits out its deadline queued.
    const r = resolverOf((name) => name.endsWith(".busy.example")
      ? new Promise((res) => setTimeout(() => res([["v=DKIM1; p=AAAA"]]), 60))
      : Promise.resolve([["v=DKIM1; p=AAAA"]]));
    const keys = makeDnsDkimKeys({ resolver: () => r.resolver, timeoutMs: 20 });
    const held = Array.from({ length: 8 }, (_, i) => keys.lookup(`s${i}._domainkey.busy.example`));
    expect(await keys.lookup("q1._domainkey.paypal.com")).toEqual({ kind: "error" });
    expect(r.asked).not.toContain("q1._domainkey.paypal.com");
    await Promise.all(held);
    await new Promise((res) => setTimeout(res, 120));
    expect(await keys.lookup("q2._domainkey.paypal.com")).toMatchObject({ kind: "records" });
  });
});

describe("what is asked", () => {
  it("a name that is no DKIM key name is refused before any query", async () => {
    const r = resolverOf(async () => [["v=DKIM1; p=AAAA"]]);
    const keys = makeDnsDkimKeys({ resolver: () => r.resolver });
    const bad = [
      "paypal.com",
      "s1.paypal.com",
      "s1._domainkey.",
      "_domainkey.paypal.com",
      "s 1._domainkey.paypal.com",
      "s1._domainkey.pay..pal.com",
      "s1._domainkey.-paypal.com",
      `${"a".repeat(64)}._domainkey.paypal.com`,
      `s1._domainkey.${Array.from({ length: 30 }, () => "abcdefgh").join(".")}.com`,
      "s1._domainkey.paypal.com/x",
    ];
    for (const n of bad) expect(await keys.lookup(n), n).toEqual({ kind: "error" });
    expect(r.asked).toEqual([]);
    expect(await keys.lookup("S1._DomainKey.PayPal.COM")).toMatchObject({ kind: "records" });
    expect(r.asked).toEqual([NAME]);
  });

  it("at most eight queries are in flight, and one name is asked once at a time", async () => {
    const r = resolverOf(() => new Promise((res) => setTimeout(() => res([["v=DKIM1; p=AAAA"]]), 5)));
    const keys = makeDnsDkimKeys({ resolver: () => r.resolver });
    const names = Array.from({ length: 30 }, (_, i) => `s${i}._domainkey.paypal.com`);
    const answers = await Promise.all([...names, ...names].map((n) => keys.lookup(n)));
    expect(answers.every((a) => a.kind === "records")).toBe(true);
    expect(r.peak()).toBeLessThanOrEqual(8);
    expect(r.peak(), "the cap was never reached, so it was never tested").toBe(8);
    expect(r.asked).toHaveLength(30);
  });

  it("the cache holds 4096 names and lets the oldest go", async () => {
    const r = resolverOf(async () => [["v=DKIM1; p=AAAA"]]);
    const keys = makeDnsDkimKeys({ resolver: () => r.resolver });
    for (let i = 0; i <= 4096; i++) await keys.lookup(`s${i}._domainkey.paypal.com`);
    expect(r.asked).toHaveLength(4097);
    await keys.lookup("s4096._domainkey.paypal.com");
    await keys.lookup("s1._domainkey.paypal.com");
    expect(r.asked).toHaveLength(4097);
    await keys.lookup("s0._domainkey.paypal.com");
    expect(r.asked, "the first name was kept past the bound").toHaveLength(4098);
  });

  it("the resolver is made at the first lookup, not before", async () => {
    let made = 0;
    const r = resolverOf(async () => [["v=DKIM1; p=AAAA"]]);
    const keys = makeDnsDkimKeys({ resolver: () => { made++; return r.resolver; } });
    expect(made).toBe(0);
    await keys.lookup(NAME);
    await keys.lookup("s2._domainkey.paypal.com");
    expect(made).toBe(1);
  });
});
