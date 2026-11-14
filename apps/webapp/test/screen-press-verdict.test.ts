import { describe, expect, it } from "vitest";
import {
  OhmailEngine,
  consentPartition,
  presentationReader,
  type EngineAdapter,
  type EngineMessage,
  type EngineMutation,
  type Folder,
  type MutationOutcome,
  type RuleDTO,
  type SyncResponse,
} from "@ohmail/client-engine";
import { shellConsentOptions } from "@ohmail/app-logic/press/consent-options";
import { screeningVerdict, verdictAction } from "@ohmail/app-logic/press/press-verdict";
import {
  dispatchScreeningChange,
  planScreeningChange,
  senderScreening,
} from "@ohmail/app-logic/press/sender-screening";

/**
 * THE SENDER SHEET'S PRESS, READ BACK FROM THE LIST. A person pressed
 * "Ohbox" for a sender carrying an older bare rule and a newer subject rule into News; the sheet
 * said "now in Ohbox" from the filed folder. Here the press runs through a real engine, and what
 * may be said is read from the presented list afterwards: the subject's rows are named with their
 * count and the rule, a higher-priority domain rule no longer keeps anything, and a 202 is a wait.
 */

const NOW = new Date("2026-09-25T13:10:00.000Z");
const ADDR = "info@shop.example";
const TERM = "[Weekly-Digest]";
const OWN = ["owner@home.example"];
/** The shell's cutline facts for a signed-in account whose `GET /consent` has answered. */
const FACTS = { known: true, standalone: false, dormancyDays: 60, screeningBaselineAt: null, screeningScope: "window" as const, foldersEnabled: false };

function rule(o: Partial<RuleDTO> & Pick<RuleDTO, "id" | "destination">): RuleDTO {
  return {
    kind: "sender", match: ADDR, priority: 0, provenance: "manual", enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-08-05T08:00:00.000Z", updatedAt: "2026-08-05T08:00:00.000Z",
    subjectContains: null, bodyContains: null, ...o,
  } as RuleDTO;
}

function message(id: string, subject: string, folder: Folder = "INBOX"): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject, from: { name: null, address: ADDR }, to: [], cc: [],
    date: "2026-09-20T09:00:00.000Z", folder, snippet: "", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-20T09:00:00.000Z",
  } as EngineMessage;
}

/** A server that stores what the wire carried and echoes it, or records it for another organizer. */
async function world(rules: RuleDTO[], mail: EngineMessage[], answer: "applied" | "organizer" = "applied") {
  let served = false;
  let n = 0;
  const sent: EngineMutation[] = [];
  const adapter: EngineAdapter = {
    async sync(): Promise<SyncResponse> {
      const creates = served ? [] : [
        ...rules.map((r, i) => ({ type: "rule" as const, op: "create" as const, id: r.id, seq: i + 1, updatedAt: r.updatedAt, entity: r })),
        ...mail.map((m, i) => ({ type: "message" as const, op: "create" as const, id: m.id, seq: 100 + i, updatedAt: m.updatedAt, entity: m })),
      ];
      served = true;
      return { changes: { creates, updates: [], moves: [], deletes: [] }, cursor: "200", hasMore: false, serverTime: NOW.toISOString() };
    },
    async mutate(m): Promise<MutationOutcome> {
      sent.push(m);
      if (answer === "organizer" && (m.kind === "rule_create" || m.kind === "rule_update")) {
        return { changes: [], seq: null, settlement: "queued", queuedWith: { kind: "local", name: "Studio laptop" }, requestId: null } as unknown as MutationOutcome;
      }
      if (m.kind === "rule_create") {
        const entity = rule({ id: `srv-${++n}`, kind: m.ruleKind, match: m.match, destination: m.destination, priority: m.priority ?? 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
        return { changes: [{ type: "rule", op: "create", id: entity.id, seq: 300 + n, updatedAt: entity.updatedAt, entity }], seq: 300 + n } as MutationOutcome;
      }
      return { changes: [], seq: null };
    },
    async withdrawSend() { return { outcome: "unsupported" as const }; },
    async fetchBody() { return null; },
  };
  const engine = new OhmailEngine({ adapter, now: () => NOW });
  await engine.start();
  return { engine, sent };
}

async function press(engine: OhmailEngine, seed: string) {
  const s = senderScreening(engine.verbRead(), seed)!;
  const plan = planScreeningChange(s, "ohbox", "sender", true, true);
  const key = await dispatchScreeningChange(plan, [], (m) => engine.mutate(m));
  return { key, plan, verdict: screeningVerdict(engine.verbRead(), seed, undefined, "ohbox", "sender", { consent: FACTS, now: NOW, ownAddresses: OWN, retro: plan.retro }) };
}

/** Where the shell's lists show a row — the same options builder the shell partitions with. */
const shown = (engine: OhmailEngine, id: string) => {
  const read = engine.verbRead();
  return presentationReader(read, consentPartition(read, shellConsentOptions(FACTS, NOW, OWN))).get<EngineMessage>("message", id)?.folder;
};

describe("the reported press into the Ohbox is read back from the list", () => {
  it.each(["ohmail/Reads", "ohmail/News"] as Folder[])("News spelled %s: the subject rule's rows are named, the rest are in the Ohbox", async (news) => {
    const rules = [
      rule({ id: "bare", destination: "INBOX", provenance: "seeded-from-sent" }),
      rule({ id: "split", destination: news, subjectContains: TERM, createdAt: "2026-08-12T17:00:00.000Z" }),
      rule({ id: "domain", kind: "domain", match: "shop.example", destination: "INBOX" }),
    ];
    const mail = [message("in-1", "Order fulfilled"), message("in-2", "Order received"), message("in-term", `${TERM} week 38`)];
    const { engine } = await world(rules, mail);
    const { verdict } = await press(engine, "in-1");
    // INVERTED by ARCH-R902: `in-term` was never filed, so it is in the Ohbox with
    // the rest; this named it "kept in News" while the subject rule presented it there.
    expect(shown(engine, "in-1")).toBe("INBOX");
    expect(shown(engine, "in-term")).toBe("INBOX");
    expect(verdict).toEqual({ key: "none" });
  });

  it("a higher-priority domain rule into News: the press's rule carries its priority and every row is in the Ohbox", async () => {
    const rules = [rule({ id: "dom-5", kind: "domain", match: "shop.example", destination: "ohmail/News", priority: 5 })];
    const mail = [message("in-1", "Order fulfilled"), message("in-2", "Order received")];
    const { engine, sent } = await world(rules, mail);
    const { verdict } = await press(engine, "in-1");
    expect(sent.find((m) => m.kind === "rule_create")).toMatchObject({ ruleKind: "sender", priority: 5 });
    expect(shown(engine, "in-1")).toBe("INBOX");
    expect(verdict).toEqual({ key: "none" });
  });

  it("another install organizes the mailbox: the press answers the organizer's wait, and no count is claimed", async () => {
    const rules = [rule({ id: "news", destination: "ohmail/News" })];
    const mail = [message("in-1", "Order fulfilled")];
    const { engine } = await world(rules, mail, "organizer");
    const { key } = await press(engine, "in-1");
    expect(key).toBe("toastRuleOrganizer");
    const en = (await import("../messages/en.json")).default as unknown as { screening: Record<string, string> };
    expect(en.screening.toastRuleOrganizer).not.toMatch(/\{count/);
  });

  it("a clean press reads success (the positive control)", async () => {
    const mail = [message("in-1", "Order fulfilled")];
    const { engine } = await world([], mail);
    const { verdict } = await press(engine, "in-1");
    expect(shown(engine, "in-1")).toBe("INBOX");
    expect(verdict).toEqual({ key: "none" });
  });

  it("mail already filed elsewhere is the pass's to move: the press says the rule is being applied", async () => {
    // THE-CLIENTS-FIFTY: the press moves none of a rule's backlog, so the row stays where it was
    // filed until the pass reaches it, and the sentence is the pass's, not a count of moves.
    const mail = [message("in-1", "Order fulfilled", "ohmail/News")];
    const { engine } = await world([], mail);
    const { verdict } = await press(engine, "in-1");
    expect(shown(engine, "in-1")).toBe("ohmail/News");
    expect(verdict).toEqual({ key: "applying", count: 0 });
  });

  it("the read-back places a row as the lists do: a dormant ruled sender's held mail is at the gate", async () => {
    // INVERTED by ARCH-R902: this showed it at the rule's place with nothing moved;
    // the list keeps it at the gate where it sits, and the read-back says the rule is being applied.
    const old = { ...message("held", "Order from March", "ohmail/Screener"), date: "2026-03-01T09:00:00.000Z", updatedAt: "2026-03-01T09:00:00.000Z" };
    const { engine } = await world([rule({ id: "bare", destination: "INBOX" })], [old]);
    expect(shown(engine, "held")).toBe("ohmail/Screener");
    const v = screeningVerdict(engine.verbRead(), "held", undefined, "ohbox", "sender", { consent: FACTS, now: NOW, ownAddresses: OWN, retro: true });
    expect(v).toEqual({ key: "applying", count: 0 });
  });

  it("a domain press over a subject rule for everyone at the domain: named, and no press deletes it", async () => {
    // A subject rule outranks a bare rule of its own kind, so under a domain press it keeps its mail.
    const rules = [rule({ id: "wide", kind: "domain", match: "shop.example", destination: "ohmail/News", subjectContains: TERM })];
    const { engine } = await world(rules, [message("in-1", "Order fulfilled", "ohmail/News"), message("in-term", `${TERM} week 38`)]);
    const s = senderScreening(engine.verbRead(), "in-1")!;
    const plan = planScreeningChange(s, "ohbox", "domain", true, true);
    await dispatchScreeningChange(plan, [], (m) => engine.mutate(m));
    const verdict = screeningVerdict(engine.verbRead(), "in-1", undefined, "ohbox", "domain", { consent: FACTS, now: NOW, ownAddresses: OWN, retro: plan.retro });
    // INVERTED by ARCH-R902: the unfiled `in-term` is in the Ohbox, so nothing is
    // kept elsewhere; this named the domain subject rule while it presented the row in News. And
    // THE-CLIENTS-FIFTY: the press moves none of the rule's backlog, so `in-1` is the pass's.
    expect(verdict).toMatchObject({ key: "applying" });
    expect(verdictAction(verdict, { scope: "domain", address: ADDR })).toBeNull();
    expect(verdictAction(verdict, { scope: "sender", address: ADDR })).toBeNull();
  });
});
