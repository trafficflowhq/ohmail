/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  consentIndex,
  decidedDestination,
  type EngineMessage,
  type Folder,
  type RuleDTO,
  type SyncChange,
} from "@ohmail/client-engine";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEGACY_NEWS_FOLDER } from "@trafficflow/core/folder-name";
import { attributeMessages, ruleMatchesSender } from "@ohmail/app-logic/press/sender-audit";

/**
 * WHY YOUR MAIL WENT WHERE IT WENT — and, mostly, what this refuses to claim.
 *
 * This is the first surface in the product that explains the router to a user, so the tests
 * that matter are the ones asserting SILENCE: a rule that disagrees with the folder is not a
 * cause, a disabled rule is not a cause, a header rule is never even matchable, and mail with
 * no matching rule is reported as "filed on arrival" rather than as unexplained — because the
 * pipeline routes known senders off a `contacts` table the mirror does not carry at all.
 */

let seq = 0;

function msg(id: string, from: string, folder: Folder): EngineMessage {
  return {
    id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: `Subject ${id}`,
    from: { name: null, address: from },
    to: [],
    cc: [],
    date: "2026-08-01T09:00:00.000Z",
    folder,
    snippet: "s",
    unread: false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: "2026-08-01T09:00:00.000Z",
  };
}

function rule(id: string, kind: RuleDTO["kind"], match: string, destination: Folder, enabled = true): RuleDTO {
  return {
    id,
    kind,
    match,
    destination,
    priority: 0,
    provenance: "promoted",
    enabled,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

async function mirror(messages: EngineMessage[], rules: RuleDTO[] = []): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...messages.map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })),
    ...rules.map((r): SyncChange => ({
      type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r,
    })),
  ]);
  return store;
}

const why = async (store: MemoryMirrorStore, m: EngineMessage) =>
  attributeMessages(store, [m])[0]!.attribution;

describe("the rule matcher is core's, character for character", () => {
  /**
   * `core/src/rules.ts#matches` fires a domain rule on
   * `r.match.toLowerCase() === domainOf(author)` — EXACT equality on everything after the
   * FIRST `@`. Loosen this to a suffix test and the panel starts explaining mail with a rule
   * that will never actually fire on it.
   */
  it("matches a domain exactly — not a subdomain, not a lookalike", () => {
    const r = rule("r1", "domain", "corp.example", "INBOX");
    expect(ruleMatchesSender(r, "a@corp.example")).toBe(true);
    expect(ruleMatchesSender(r, "A@CORP.EXAMPLE")).toBe(true);
    expect(ruleMatchesSender(r, "a@mail.corp.example")).toBe(false);
    expect(ruleMatchesSender(r, "a@evil-corp.example")).toBe(false);
    expect(ruleMatchesSender(r, "corp.example")).toBe(false); // no `@` ⇒ no domain
  });

  it("a header rule is never matchable here — the mirror holds no headers", () => {
    // Not "returns false for now": there is no header in `EngineMessage` to test, so a `true`
    // here could only ever come from guessing.
    expect(ruleMatchesSender(rule("r1", "header", "list-id", "ohmail/News"), "a@corp.example")).toBe(false);
  });
});

describe("what the panel is allowed to say", () => {
  it("mail in the Screener is 'at the gate' — the folder, not an inference", async () => {
    const m = msg("a", "x@corp.example", "ohmail/Screener");
    const store = await mirror([m], [rule("r1", "domain", "corp.example", "INBOX")]);
    // Note the rule exists and points at INBOX; the gate answer still wins, because the
    // message is demonstrably still waiting.
    expect(await why(store, m)).toEqual({ kind: "gate", suggestion: null });
  });

  it("names a rule only when it agrees with where the message actually is", async () => {
    const m = msg("a", "x@corp.example", "ohmail/News");
    const store = await mirror([m], [rule("r1", "domain", "corp.example", "ohmail/News")]);
    expect(await why(store, m)).toEqual({ kind: "rule", rule: expect.objectContaining({ id: "r1" }) });
  });

  /**
   * THE ASSERTION THAT KEEPS THIS HONEST. A rule pointing somewhere else did not put the
   * message here — the user may have moved it by hand, or a header rule outranked this one,
   * or the rule was made after the mail arrived. Reporting it anyway is the failure this
   * whole vocabulary exists to prevent. Drop the `r.destination === message.folder` filter
   * in `attributeMessages` and this goes red.
   */
  it("says nothing when the matching rule points somewhere else", async () => {
    const m = msg("a", "x@corp.example", "INBOX");
    const store = await mirror([m], [rule("r1", "domain", "corp.example", "ohmail/News")]);
    expect(await why(store, m)).toEqual({ kind: "arrival" });
  });

  it("a disabled rule explains nothing", async () => {
    const m = msg("a", "x@corp.example", "ohmail/News");
    const store = await mirror([m], [rule("r1", "domain", "corp.example", "ohmail/News", false)]);
    expect(await why(store, m)).toEqual({ kind: "arrival" });
  });

  /**
   * `arrival` is not "we don't know" dressed up — a yes decision writes a `contacts` row and
   * the pipeline routes known senders off it, independently of rules, and `contacts` is not
   * in the mirror's entity vocabulary. So there IS an explanation and this module cannot see
   * it; the copy says that rather than implying the mail is unclassified.
   */
  it("mail with no rule at all is 'filed on arrival', which claims nothing", async () => {
    const m = msg("a", "friend@corp.example", "INBOX");
    const store = await mirror([m]);
    expect(await why(store, m)).toEqual({ kind: "arrival" });
  });

  it("prefers the sender rule over the domain rule when both agree — the more specific truth", async () => {
    const m = msg("a", "x@corp.example", "ohmail/Receipts");
    const store = await mirror([m], [
      rule("r-domain", "domain", "corp.example", "ohmail/Receipts"),
      rule("r-sender", "sender", "x@corp.example", "ohmail/Receipts"),
    ]);
    const a = await why(store, m);
    expect(a.kind).toBe("rule");
    expect(a.kind === "rule" && a.rule.id).toBe("r-sender");
  });

  it("attributes a whole set in one pass, each row on its own merits", async () => {
    const held = msg("a", "one@corp.example", "ohmail/Screener");
    const ruled = msg("b", "two@corp.example", "ohmail/News");
    const plain = msg("c", "three@corp.example", "INBOX");
    const store = await mirror([held, ruled, plain], [rule("r1", "domain", "corp.example", "ohmail/News")]);
    expect(attributeMessages(store, [held, ruled, plain]).map((r) => r.attribution.kind))
      .toEqual(["gate", "rule", "arrival"]);
  });
});

/**
 * THE WHY ROW NAMES THE RULE THE ROUTER CHOSE (`@trafficflow/core/rule-order`'s `compareRules`,
 * the router's `evaluateRules` steps one and two), never the newest rule pointing at the folder.
 * A rule is still only named when it agrees with where the message sits.
 */
describe("the why row names the winning rule", () => {
  const made = (
    id: string, kind: RuleDTO["kind"], match: string, destination: Folder,
    over: Partial<RuleDTO> & { createdAt: string },
  ): RuleDTO => ({ ...rule(id, kind, match, destination), ...over, updatedAt: over.createdAt });
  const OLD = "2026-08-01T00:00:00.000Z";
  const NEW = "2026-08-20T00:00:00.000Z";

  it("allow Inbox and deny Screened for one address: the Inbox copy presents in Screened and names neither", async () => {
    const m = msg("a", "x@corp.example", "INBOX");
    const rules = [
      made("r-allow", "sender", "x@corp.example", "INBOX", { provenance: "manual", createdAt: OLD }),
      made("r-deny", "sender", "x@corp.example", "ohmail/Screened", { provenance: "manual", createdAt: NEW }),
    ];
    expect(decidedDestination(consentIndex(rules), "x@corp.example")).toBe("ohmail/Screened");
    const store = await mirror([m], rules);
    expect(await why(store, m)).toEqual({ kind: "arrival" });
  });

  it("the same two rules: the copy in Screened names the deny rule", async () => {
    const m = msg("a", "x@corp.example", "ohmail/Screened");
    const store = await mirror([m], [
      made("r-allow", "sender", "x@corp.example", "INBOX", { provenance: "manual", createdAt: NEW }),
      made("r-deny", "sender", "x@corp.example", "ohmail/Screened", { provenance: "manual", createdAt: OLD }),
    ]);
    expect(await why(store, m)).toEqual({ kind: "rule", rule: expect.objectContaining({ id: "r-deny" }) });
  });

  it("twins for one address: the manual rule wins over a newer promoted one", async () => {
    const m = msg("a", "x@corp.example", "INBOX");
    const store = await mirror([m], [
      made("r-manual", "sender", "x@corp.example", "INBOX", { provenance: "manual", createdAt: OLD }),
      made("r-promoted", "sender", "x@corp.example", "INBOX", { provenance: "promoted", createdAt: NEW }),
    ]);
    expect(await why(store, m)).toEqual({ kind: "rule", rule: expect.objectContaining({ id: "r-manual" }) });
  });

  it("a subject term outranks a newer body term when both hold", async () => {
    const m = { ...msg("a", "x@corp.example", "ohmail/News"), subject: "nightly report", snippet: "nightly digest" };
    const store = await mirror([m], [
      made("r-subject", "sender", "x@corp.example", "ohmail/News", { subjectContains: "nightly", createdAt: OLD }),
      made("r-body", "sender", "x@corp.example", "ohmail/News", { bodyContains: "digest", createdAt: NEW }),
    ]);
    expect(await why(store, m)).toEqual({ kind: "rule", rule: expect.objectContaining({ id: "r-subject" }) });
  });

  it("a higher-priority domain rule outranks the address rule", async () => {
    const m = msg("a", "x@corp.example", "ohmail/Receipts");
    const store = await mirror([m], [
      made("r-domain", "domain", "corp.example", "ohmail/Receipts", { priority: 5, createdAt: OLD }),
      made("r-sender", "sender", "x@corp.example", "ohmail/Receipts", { createdAt: NEW }),
    ]);
    expect(await why(store, m)).toEqual({ kind: "rule", rule: expect.objectContaining({ id: "r-domain" }) });
  });

  it("a narrowed denial that did not claim this message still stands for the sender", async () => {
    const m = { ...msg("a", "x@corp.example", "ohmail/Screened"), subject: "hello" };
    const store = await mirror([m], [
      made("r-deny", "sender", "x@corp.example", "ohmail/Screened", { subjectContains: "promo", createdAt: OLD }),
    ]);
    expect(await why(store, m)).toEqual({ kind: "rule", rule: expect.objectContaining({ id: "r-deny" }) });
  });

  it("a rule pointing at the Screener is no standing decision", async () => {
    const m = { ...msg("a", "x@corp.example", "ohmail/Screened"), subject: "hello" };
    const store = await mirror([m], [
      made("r-gate", "sender", "x@corp.example", "ohmail/Screener", { subjectContains: "x-", priority: 5, createdAt: NEW }),
      made("r-deny", "sender", "x@corp.example", "ohmail/Screened", { subjectContains: "promo", createdAt: OLD }),
    ]);
    expect(await why(store, m)).toEqual({ kind: "rule", rule: expect.objectContaining({ id: "r-deny" }) });
  });

  it("a narrowed admission that did not claim this message places nothing", async () => {
    const m = { ...msg("a", "x@corp.example", "ohmail/News"), subject: "hello" };
    const store = await mirror([m], [
      made("r-allow", "sender", "x@corp.example", "ohmail/News", { subjectContains: "promo", createdAt: OLD }),
    ]);
    expect(await why(store, m)).toEqual({ kind: "arrival" });
  });
});

/**
 * THE ARRIVAL SENTENCE CLAIMS ONLY WHAT THE MIRROR CAN SEE. "No rule of yours covers it" was false
 * for an Inbox copy whose sender a newer rule screens out, and for mail whose rule files elsewhere:
 * a rule covers that sender. The sentence now says no rule ohmail can see would file it here.
 */
describe("the arrival sentence", () => {
  const whyArrival = (locale: string): string => (JSON.parse(
    readFileSync(join(process.cwd(), `apps/webapp/messages/${locale}.json`), "utf8"),
  ) as { screening: { auditWhyArrival: string } }).screening.auditWhyArrival;

  it("says no rule it can see would file the message here, in both catalogues", () => {
    expect(whyArrival("en")).toBe(
      "Filed when it arrived. ohmail sees no rule of yours that would file it here now — most often it is here because you had already replied to this sender.");
    expect(whyArrival("de")).toBe(
      "Beim Eintreffen einsortiert. ohmail sieht keine Regel von dir, die sie jetzt hierher sortieren würde — meist liegt sie hier, weil du diesem Absender schon geantwortet hattest.");
  });
});

/**
 * The News pile has two spellings (the pre-0.22 `ohmail/Reads` on older rules and on
 * mail in a mailbox not yet renamed), and a rule filing into News explains mail in News whichever side is old.
 */
describe("a News rule explains News mail in either spelling", () => {
  const LEGACY = LEGACY_NEWS_FOLDER as Folder;

  it("a rule stored before the rename explains a message in ohmail/News", async () => {
    const m = msg("n", "lena@x.example", "ohmail/News");
    const store = await mirror([m], [rule("r1", "sender", "lena@x.example", LEGACY)]);
    const said = await why(store, m);
    expect(said.kind).toBe("rule");
    expect(said.kind === "rule" && said.rule.id).toBe("r1");
  });

  it("a rule in the new spelling explains a message still in the old folder", async () => {
    const m = msg("r", "max@x.example", LEGACY);
    const store = await mirror([m], [rule("r2", "sender", "max@x.example", "ohmail/News")]);
    const said = await why(store, m);
    expect(said.kind).toBe("rule");
  });
});
