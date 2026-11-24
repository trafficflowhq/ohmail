import type { EngineMessage, Folder, RuleEntity as RuleDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { effectForDestination, evaluateRules, type NormalizedMessage, type Rule } from "@trafficflow/core/mail";
import {
  MemoryMirrorStore,
  consentIndex,
  consentPartition,
  decidedDestination,
  type SyncChange,
} from "@ohmail/client-engine";

/**
 * A NARROWED RULE PLACES ONLY THE MAIL ITS TERM NAMES.
 * The client places each message where the organizer files it: the router's `evaluateRules` over
 * the same rules and the same message is the oracle. Admission is the sender-level reading: a
 * narrowed rule still decides about the whole sender, whatever mail it claims.
 */

const NOW = new Date("2026-09-24T12:00:00.000Z");
const ADDR = "person@shop.example";
let seq = 0;

type R = Partial<RuleDTO> & Pick<RuleDTO, "id" | "destination">;

function rule(o: R): RuleDTO {
  return {
    kind: "sender", match: ADDR, priority: 0, provenance: "manual", enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-09-01T08:00:00.000Z", updatedAt: "2026-09-01T08:00:00.000Z",
    subjectContains: null, bodyContains: null, ...o,
  };
}

function asCore(r: RuleDTO): Rule {
  return {
    id: r.id, kind: r.kind, match: r.match, destination: r.destination as Rule["destination"],
    effect: effectForDestination(r.destination as Rule["destination"]), priority: r.priority,
    provenance: r.provenance, enabled: r.enabled,
    subjectContains: r.subjectContains ?? null, bodyContains: r.bodyContains ?? null,
  };
}

function message(id: string, subject: string, folder: Folder = "INBOX"): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject, from: { name: null, address: ADDR }, to: [], cc: [],
    date: "2026-09-20T09:00:00.000Z", folder, snippet: "", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-20T09:00:00.000Z",
  };
}

/** Where the organizer files `m` under `rules`; a message it leaves unfiled stays where it is. */
function organizerFiles(rules: RuleDTO[], m: EngineMessage): string {
  const msg: NormalizedMessage = {
    canonical: { messageIdHeader: null, bodyHash: m.id }, subject: m.subject,
    from: { name: null, address: ADDR }, to: [], cc: [], date: null, headers: { from: [ADDR] },
    textBody: "", htmlBody: null, hasAttachments: false, attachments: [],
  };
  const d = evaluateRules({ msg, rules: rules.map(asCore), ownAddresses: new Set<string>(), knownSenders: { addresses: new Set(), inferred: new Set<string>(), lists: new Map() }, auth: "unauthenticated", ohboxPolicy: "people_and_replied", identity: null });
  return d.destination ?? m.folder;
}

async function partitionOf(rules: RuleDTO[], messages: EngineMessage[]) {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...messages.map((m) => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: m })),
    ...rules.map((r) => ({ type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r })),
  ] as SyncChange[]);
  return consentPartition(store, { now: NOW });
}

const MATCH = message("m-alert", "Weekly alert 12");
const OTHER = message("m-other", "Lunch on Friday");

/* `placed` is the partition, `routed` the router. INVERTED by ARCH-R902: an
   admitting split the organizer has not carried out places nothing on the client — its filing
   arrives as the letter's folder — so those shapes name the router apart; a DENY split projects. */
const SHAPES: Array<{ name: string; rules: RuleDTO[]; placed: Record<string, string>; sender: Folder; routed?: Record<string, string> }> = [
  {
    name: "a bare allow into the Ohbox and a subject screen-out: only the alerts are screened out",
    rules: [rule({ id: "1-bare", destination: "INBOX", provenance: "promoted" }), rule({ id: "9-split", destination: "ohmail/Screened", subjectContains: "alert" })],
    placed: { "m-alert": "ohmail/Screened", "m-other": "INBOX" }, sender: "INBOX",
  },
  {
    name: "a bare allow into the Ohbox and a subject split to Receipts: only the matching mail is in Receipts",
    rules: [rule({ id: "1-bare", destination: "INBOX", provenance: "promoted" }), rule({ id: "9-split", destination: "ohmail/Receipts", subjectContains: "alert" })],
    placed: { "m-alert": "INBOX", "m-other": "INBOX" }, sender: "INBOX",
    routed: { "m-alert": "ohmail/Receipts", "m-other": "INBOX" },
  },
  {
    name: "a bare allow into the Ohbox and a subject split to News: only the matching mail is in News",
    rules: [rule({ id: "1-bare", destination: "INBOX", provenance: "seeded-from-sent" }), rule({ id: "9-split", destination: "ohmail/News", subjectContains: "alert" })],
    placed: { "m-alert": "INBOX", "m-other": "INBOX" }, sender: "INBOX",
    routed: { "m-alert": "ohmail/News", "m-other": "INBOX" },
  },
  {
    name: "the same split in the pre-0.22 News spelling: only the matching mail is in News",
    rules: [rule({ id: "1-bare", destination: "INBOX", provenance: "seeded-from-sent" }), rule({ id: "9-split", destination: "ohmail/Reads" as unknown as Folder, subjectContains: "alert" })],
    placed: { "m-alert": "INBOX", "m-other": "INBOX" }, sender: "INBOX",
    routed: { "m-alert": "ohmail/Reads", "m-other": "INBOX" },
  },
  {
    name: "a bare domain allow and an address screen-out narrowed by subject",
    rules: [rule({ id: "1-domain", kind: "domain", match: "shop.example", destination: "INBOX" }), rule({ id: "9-split", destination: "ohmail/Screened", subjectContains: "alert" })],
    placed: { "m-alert": "ohmail/Screened", "m-other": "INBOX" }, sender: "INBOX",
  },
  {
    name: "a narrowed admission alone: the other mail is placed by nothing and the sender stays admitted",
    rules: [rule({ id: "9-split", destination: "ohmail/Receipts", subjectContains: "alert" })],
    placed: { "m-alert": "INBOX", "m-other": "INBOX" }, sender: "ohmail/Receipts",
    routed: { "m-alert": "ohmail/Receipts", "m-other": "INBOX" },
  },
  {
    name: "a narrowed screen-out alone: the organizer carries the standing denial out for all of it",
    rules: [rule({ id: "9-split", destination: "ohmail/Screened", subjectContains: "alert" })],
    placed: { "m-alert": "ohmail/Screened", "m-other": "ohmail/Screened" }, sender: "ohmail/Screened",
  },
];

describe("a sender's narrowed rule places only the mail its term names", () => {
  it.each(SHAPES)("$name", async ({ rules, placed, sender, routed }) => {
    for (const input of [rules, [...rules].reverse()]) {
      const p = await partitionOf(input, [MATCH, OTHER]);
      for (const m of [MATCH, OTHER]) {
        // The router is the oracle, and the fixture pins what it answers.
        expect(organizerFiles(input, m)).toBe((routed ?? placed)[m.id]);
        expect(p.placeOf.get(m.id)).toBe(placed[m.id]);
      }
      // Admission: the sender is decided whatever the terms claim, and never queued or retired.
      expect(decidedDestination(consentIndex(input), ADDR)).toBe(sender);
      expect(p.counts.activeUndecidedSenders).toBe(0);
      expect(p.counts.dormantUndecidedSenders).toBe(0);
      expect(p.counts.consentedSenders).toBe(sender === "ohmail/Screened" ? 0 : 1);
      expect(p.history).toEqual([]);
    }
  });

  it("mail held at the gate: the screened-out subject presents on the shelf, the rest at the gate", async () => {
    const rules = [rule({ id: "1-bare", destination: "INBOX" }), rule({ id: "9-split", destination: "ohmail/Screened", subjectContains: "alert" })];
    const held = [message("h-alert", "Weekly alert 13", "ohmail/Screener"), { ...message("h-other", "Lunch again", "ohmail/Screener"), unread: true }];
    const p = await partitionOf(rules, held);
    expect(p.placeOf.get("h-alert")).toBe("ohmail/Screened");
    expect(p.placeOf.get("h-other")).toBe("ohmail/Screener");
  });
});
