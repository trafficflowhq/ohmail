import type { EngineMessage, Folder, RuleEntity as RuleDTO } from "@ohmail/wire";
import { MemoryMirrorStore, type SyncChange } from "../../src/index.js";

/**
 * THE ONE MATRIX THE PLACEMENT CENSUS DRIVES — term rules, body terms and the resurfaced pin, read
 * by the client leg (`placement-parity.test.ts`) and the server leg
 * (`packages/services/test/placement-parity.test.ts`), so the two doors are asked about the same
 * mailbox. Fixtures, and the one store builder the fold cases share.
 */

export const SENDER = "person@shop.example";
export const DOMAIN = "shop.example";
export const NOW = new Date("2026-09-24T12:00:00.000Z");

export function rule(o: Partial<RuleDTO> & Pick<RuleDTO, "id" | "destination">): RuleDTO {
  return {
    kind: "sender", match: SENDER, priority: 0, provenance: "manual", enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-09-01T08:00:00.000Z", updatedAt: "2026-09-01T08:00:00.000Z",
    subjectContains: null, bodyContains: null, ...o,
  };
}

const allow = rule({ id: "a-allow", destination: "INBOX" });
/** The rule sets: one sender, each shape a term can take against a bare decision. */
export const RULE_SETS: Record<string, RuleDTO[]> = {
  bareAllow: [allow],
  bareDeny: [rule({ id: "a-deny", destination: "ohmail/Screened" })],
  subjectDeny: [allow, rule({ id: "s-deny", destination: "ohmail/Screened", subjectContains: "alert" })],
  subjectAllow: [allow, rule({ id: "s-allow", destination: "ohmail/Receipts", subjectContains: "invoice" })],
  bodyDeny: [allow, rule({ id: "b-deny", destination: "ohmail/Screened", bodyContains: "unsubscribe" })],
  bodyDenyAlone: [rule({ id: "b-deny", destination: "ohmail/Screened", bodyContains: "unsubscribe" })],
  bodyAllow: [allow, rule({ id: "b-allow", destination: "ohmail/Receipts", bodyContains: "invoice" })],
  bodyAllowOverDomainDeny: [
    rule({ id: "d-deny", kind: "domain", match: DOMAIN, destination: "ohmail/Screened" }),
    rule({ id: "b-news", destination: "ohmail/News", bodyContains: "invoice" }),
  ],
  domainBodyDeny: [
    rule({ id: "d-allow", kind: "domain", match: DOMAIN, destination: "INBOX" }),
    rule({ id: "d-body", kind: "domain", match: DOMAIN, destination: "ohmail/Screened", bodyContains: "unsubscribe" }),
  ],
  bareAllowOutranksBody: [
    rule({ id: "a-allow-5", destination: "INBOX", priority: 5 }),
    rule({ id: "b-deny", destination: "ohmail/Screened", bodyContains: "unsubscribe" }),
  ],
};

/** The messages: a subject term's, a body term's, both, and neither. */
export const MESSAGES: Array<{ key: string; subject: string; text: string }> = [
  { key: "alert", subject: "Weekly alert 12", text: "Nothing to see." },
  { key: "unsub", subject: "Hello", text: "To unsubscribe press the link." },
  { key: "invoice", subject: "Your invoice 42", text: "The invoice is attached." },
  { key: "plain", subject: "Lunch on Friday", text: "Shall we?" },
];

export interface PlacementCase { name: string; set: string; rules: RuleDTO[]; message: EngineMessage; text: string }

export function message(id: string, subject: string, folder: Folder = "INBOX", from = SENDER): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject, from: { name: null, address: from }, to: [], cc: [],
    date: "2026-09-20T09:00:00.000Z", folder, snippet: "", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-20T09:00:00.000Z",
  };
}

/** Every rule set against every message, an INBOX row the organizer has not filed. */
export const PLACEMENT_MATRIX: PlacementCase[] = Object.entries(RULE_SETS).flatMap(([set, rules]) =>
  MESSAGES.map((m) => ({ name: `${set} × ${m.key}`, set, rules, message: message(`m-${m.key}`, m.subject), text: m.text })));

/** One member of a resurfaced-pin case: offsets in minutes past the pin's instant. */
export interface FoldCaseMember {
  /** `Sent` is the mailbox's own sent folder, which the client's `Folder` union does not name. */
  id: string; from: string; folder: Folder | "Sent"; unread: boolean; at: number;
  state?: "resurfaced" | "bubbled_up";
}
export interface FoldCase {
  name: string;
  members: FoldCaseMember[];
  /** The ids "New for you" shows — the INBOX unread members outside every resurfaced row. */
  newForYou: string[];
}

export const PIN_AT = Date.parse("2026-09-24T10:00:00.000Z");
export const OWN = "me@ohmail.test";

/** The resurfaced pin: a row, a pull-forward, a pin nothing wrote into, and our own reply after it. */
export const FOLD_MATRIX: FoldCase[] = [
  {
    name: "a resurfaced pin holds out the unread reply in its conversation",
    members: [
      { id: "p1", from: "friend@example.test", folder: "INBOX", unread: false, at: -600, state: "resurfaced" },
      { id: "r1", from: "other@example.test", folder: "INBOX", unread: true, at: 30 },
    ],
    newForYou: [],
  },
  {
    name: "a bubbled-up pin somebody wrote into is pulled forward, and its reply held out",
    members: [
      { id: "p2", from: "friend@example.test", folder: "INBOX", unread: false, at: -600, state: "bubbled_up" },
      { id: "r2", from: "other@example.test", folder: "INBOX", unread: true, at: 30 },
    ],
    newForYou: [],
  },
  {
    name: "a bubbled-up pin nobody wrote into since is no row: the older unread member is New for you",
    members: [
      { id: "p3", from: "friend@example.test", folder: "INBOX", unread: false, at: -600, state: "bubbled_up" },
      { id: "r3", from: "other@example.test", folder: "INBOX", unread: true, at: -30 },
    ],
    newForYou: ["r3"],
  },
  {
    name: "our own reply after a bubbled-up pin pulls nothing forward",
    members: [
      { id: "p4", from: "friend@example.test", folder: "INBOX", unread: false, at: -600, state: "bubbled_up" },
      { id: "o4", from: OWN, folder: "Sent", unread: false, at: 30 },
      { id: "r4", from: "other@example.test", folder: "INBOX", unread: true, at: -60 },
    ],
    newForYou: ["r4"],
  },
  // A stranger's reply threaded by its headers and held at the gate (or quarantined) is no member:
  // it pulls nothing forward, so the conversation's own unread INBOX member stays New for you.
  ...(["ohmail/Screener", "ohmail/Quarantine"] as const).map((folder, i) => ({
    name: `a reply held at ${folder} pulls a bubbled-up pin nowhere`,
    members: [
      { id: `p${6 + i}`, from: "friend@example.test", folder: "INBOX" as const, unread: false, at: -600, state: "bubbled_up" as const },
      { id: `r${6 + i}`, from: "other@example.test", folder: "INBOX" as const, unread: true, at: -30 },
      { id: `h${6 + i}`, from: "stranger@example.test", folder, unread: true, at: 30 },
    ],
    newForYou: [`r${6 + i}`],
  })),
  {
    // The person's own pin places a message wherever it sits: History pins a gate row in place.
    name: "a pin held at the gate is still a member: its conversation's reply is held out",
    members: [
      { id: "p8", from: "friend@example.test", folder: "ohmail/Screener", unread: false, at: -600, state: "resurfaced" },
      { id: "r8", from: "other@example.test", folder: "INBOX", unread: true, at: 30 },
    ],
    newForYou: [],
  },
  {
    name: "no pin: the unread reply is New for you",
    members: [
      { id: "p5", from: "friend@example.test", folder: "INBOX", unread: false, at: -600 },
      { id: "r5", from: "other@example.test", folder: "INBOX", unread: true, at: 30 },
    ],
    newForYou: ["r5"],
  },
];

/** The fold case as mirror rows: one thread, the pins as `message_state` entities. */
export async function foldStore(c: FoldCase, thread: string) {
  const rows = c.members.map((m) => ({
    ...message(m.id, `Re: plans ${m.id}`, m.folder as Folder, m.from),
    threadId: thread, unread: m.unread, date: new Date(PIN_AT + m.at * 60_000).toISOString(),
  }));
  const store = new MemoryMirrorStore();
  await store.load();
  let seq = 0;
  await store.applyChanges(rows.map((m) => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: m })) as SyncChange[]);
  await store.applyChanges(c.members.filter((m) => m.state).map((m) => ({
    type: "message_state", op: "create", id: `s-${m.id}`, seq: ++seq, updatedAt: NOW.toISOString(),
    entity: {
      messageId: m.id, state: m.state, bubbleUpAt: m.state === "bubbled_up" ? new Date(PIN_AT).toISOString() : null,
      setAt: new Date(PIN_AT).toISOString(), updatedAt: NOW.toISOString(),
    },
  })) as SyncChange[]);
  await store.applyChanges([{ type: "mailbox", op: "create", id: "mb", seq: ++seq, updatedAt: NOW.toISOString(),
    entity: { id: "mb", address: OWN } }] as SyncChange[]);
  return store;
}
