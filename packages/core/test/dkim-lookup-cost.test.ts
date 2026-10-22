import { describe, it, expect } from "vitest";
import { planChange, signaturesForCycle, type CycleSignatures, type PlanSignatures } from "../src/pipeline.js";
import { FakeRepo } from "./fakes.js";
import type { Change } from "../src/ports.js";
import { providerAuthservIds } from "../src/authserv-ids.js";
import { makeSignatureCheck } from "../src/adapters/dkim.js";
import { makeDnsDkimKeys, type TxtResolver } from "../src/adapters/dkim-keys.js";
import { letter, rsaKey, testSign } from "./fixtures/dkim-signed.js";

/**
 * WHAT A SENDER'S NAME SERVER CAN COST THE PLAN STEP. The check runs inline, and the sender chooses
 * the selector, the signing domain and whether its name server answers. Through the real
 * `planChange`, `makeSignatureCheck` and `makeDnsDkimKeys`, over a resolver that never answers (the
 * suite's network guard refuses every real query): the failed domain, kept by the lookup and by the
 * letter's other signature, bounds a sender who varies the selector; the cycle's budget bounds one
 * who varies the domain.
 */

const FASTMAIL = providerAuthservIds("imap.fastmail.com");
const DEADLINE_MS = 250;
const KEY = rsaKey(1024);

/** A stranger's one-click letter carrying two aligned signatures at `domain`, each under a selector of its own. */
async function strangerLetter(domain: string, n: number): Promise<Buffer> {
  const base = letter({
    from: `News <news@${domain}>`, messageId: `<m${n}@${domain}>`, subject: `Issue ${n}`,
    extra: [`List-Unsubscribe: <https://${domain}/u/${n}>`, "List-Unsubscribe-Post: List-Unsubscribe=One-Click"],
  });
  const once = await testSign(base, { domain, selector: `a${n}x`, key: KEY });
  return Buffer.from(await testSign(once, { domain, selector: `b${n}y`, key: KEY }), "latin1");
}

/** A resolver that never answers, as a name server that drops every query looks from here. */
function blackHole(): { asked: string[]; resolver: () => TxtResolver } {
  const asked: string[] = [];
  return {
    asked,
    resolver: () => ({ resolveTxt: (name: string) => { asked.push(name); return new Promise<string[][]>(() => undefined); } }),
  };
}

const keysOver = (dns: ReturnType<typeof blackHole>) => makeDnsDkimKeys({ resolver: dns.resolver, timeoutMs: DEADLINE_MS });

async function plan(signatures: CycleSignatures | null, raw: Buffer, n: number) {
  const change: Change = { type: "create", locator: { folder: "INBOX", ref: `1:${10 + n}` }, raw };
  return planChange(change, {
    repo: new FakeRepo(), accountId: "acct-1", mailboxId: "mb-1", readerMode: false, trustedAuthservIds: FASTMAIL, signatures,
  });
}

describe("what a sender's name server can cost the plan step", () => {
  it("three letters with two fresh selectors each at one domain cost one deadline in all", async () => {
    const dns = blackHole();
    // No budget to speak of: the failed domain alone has to hold this.
    const signatures = { ...makeSignatureCheck({ keys: keysOver(dns) }), listLetters: true, budget: { remainingMs: Infinity } };
    const letters = await Promise.all([0, 1, 2].map((n) => strangerLetter("slowdns.example", n)));
    const started = performance.now();
    for (const [n, raw] of letters.entries()) expect((await plan(signatures, raw, n)).new?.authVerdict).toBe("unavailable");
    expect(dns.asked).toEqual(["b0y._domainkey.slowdns.example"]);
    expect(performance.now() - started).toBeLessThan(2 * DEADLINE_MS);
  });

  it("letters at as many domains cost the cycle its budget and no more; the next cycle has its own", async () => {
    const dns = blackHole();
    const source: PlanSignatures = {
      ...makeSignatureCheck({ keys: keysOver(dns), cycleLookupMs: 2.5 * DEADLINE_MS }), listLetters: true,
    };
    const letters = await Promise.all(Array.from({ length: 8 }, (_, n) => strangerLetter(`d${n}.example`, n)));
    const cycle = signaturesForCycle(source);
    const started = performance.now();
    for (const [n, raw] of letters.entries()) expect((await plan(cycle, raw, n)).new?.authVerdict).toBe("unavailable");
    const took = performance.now() - started;
    // Two deadlines, then what was left of the budget: never a lookup per letter.
    expect(dns.asked.length).toBeLessThanOrEqual(3);
    expect(took).toBeLessThan(3.5 * DEADLINE_MS);
    const asked = dns.asked.length;
    expect((await plan(signaturesForCycle(source), await strangerLetter("d9.example", 9), 9)).new?.authVerdict).toBe("unavailable");
    expect(dns.asked, "the next cycle began with this one's spent budget").toHaveLength(asked + 1);
  });

  it("no check, no budget: a mailbox without the check plans as before", () => {
    expect(signaturesForCycle(null)).toBeNull();
    expect(signaturesForCycle(undefined)).toBeNull();
  });
});
