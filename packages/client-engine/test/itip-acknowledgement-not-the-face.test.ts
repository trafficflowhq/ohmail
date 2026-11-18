import type { EngineMessage, Folder, RuleEntity as RuleDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  consentPartition,
  isItipAcknowledgement,
  ohboxView,
  presentationReader,
  type SyncChange,
} from "@ohmail/client-engine";

/**
 * ═══ A CALENDAR CLIENT'S ACKNOWLEDGEMENT IS NOT A CONVERSATION'S LATEST WORD ═══════════════
 *
 * The 2026-09-16 shape: a user accepted an invitation in the Mac's Calendar and a second later
 * the Ohbox row read "Accepted: …", "Me → the colleague". No person wrote that.
 * `ohboxView` already holds our own AUTOMATIC replies out of "Earlier" — "nobody finished with
 * anything" — and a calendar acknowledgement is the same class. Two arms mark it, since only one
 * of its two homes is mirrored: the top-level `method=REPLY` header, and the subject, trusted
 * ONLY on own-sent mail.
 */

const NOW = new Date("2026-09-16T12:00:00.000Z");
const RECENT = "2026-09-16T08:29:52.000Z";
const LATER = "2026-09-16T08:36:58.000Z";
const OLD = "2024-03-02T09:00:00.000Z";
const OWN = "me@example.com";

let seq = 0;

function msg(o: {
  id: string;
  folder: string;
  subject?: string;
  from?: string;
  date?: string;
  threadId?: string | null;
  itipReplyHeader?: boolean;
}): EngineMessage {
  const m: EngineMessage = {
    id: o.id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: o.threadId ?? null,
    messageIdHeader: null,
    subject: o.subject ?? `Subject ${o.id}`,
    from: { name: null, address: o.from ?? `${o.id}@example.com` },
    to: [],
    cc: [],
    date: o.date ?? RECENT,
    folder: o.folder as Folder,
    snippet: `snippet ${o.id}`,
    unread: false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: o.date ?? RECENT,
  };
  // `in` and not `?? false`: ABSENT is a distinct fixture — a mirror or a server older than the
  // field — and writing `false` there would test the wrong one of the two.
  if ("itipReplyHeader" in o) m.itipReplyHeader = o.itipReplyHeader;
  return m;
}

function consentRule(address: string): RuleDTO {
  return {
    id: `rule-${address}`, kind: "sender", match: address, destination: "INBOX", priority: 0,
    provenance: "promoted", enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: OLD, updatedAt: OLD,
  };
}

/** The Ohbox exactly as the shell reads it: piles over the PRESENTED mirror. */
async function presentedOhbox(messages: EngineMessage[]): Promise<{ earlier: string[] }> {
  const rules = [...new Set(
    messages.filter((m) => m.folder === "INBOX" || m.folder.startsWith("ohmail/")).map((m) => m.from.address),
  )].map(consentRule);
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...messages.map((m) => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })),
    ...rules.map((r) => ({
      type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r,
    })),
  ] as SyncChange[]);
  const part = consentPartition(store, { now: NOW, ownAddresses: [OWN] });
  const view = ohboxView(presentationReader(store, part));
  return { earlier: view.previouslySeen.map((m) => m.id) };
}

describe("isItipAcknowledgement — the two arms and what each refuses", () => {
  it("is TRUE on the header arm, wherever the message sits", () => {
    expect(isItipAcknowledgement(
      msg({ id: "a", folder: "Sent", subject: "anything at all", itipReplyHeader: true }),
    )).toBe(true);
  });

  /** THE OWNER'S SHAPE: an Exchange Sent copy with no calendar part, recognised by its subject. */
  it("is TRUE for own-sent mail whose subject opens with an acknowledgement token", () => {
    expect(isItipAcknowledgement(msg({ id: "b", folder: "Sent Items", subject: 'Accepted: Austausch "SSOT"' }))).toBe(true);
    expect(isItipAcknowledgement(msg({ id: "c", folder: "Sent Items", subject: "Angenommen: Team sync" }))).toBe(true);
  });

  /** THE REFUSAL THAT MATTERS: a person telling you something keeps an ordinary face. */
  it("is FALSE for a RECEIVED message carrying the same prefix", () => {
    expect(isItipAcknowledgement(msg({ id: "d", folder: "INBOX", subject: "Accepted: your offer" }))).toBe(false);
  });

  it("is FALSE for own-sent mail that merely contains the word", () => {
    expect(isItipAcknowledgement(msg({ id: "e", folder: "Sent", subject: "Accepted payment terms" }))).toBe(false);
    expect(isItipAcknowledgement(msg({ id: "f", folder: "Sent", subject: "Tentative agenda: Q3" }))).toBe(false);
  });

  it("is FALSE when the field is ABSENT and the subject is ordinary — an older mirror says nothing", () => {
    expect(isItipAcknowledgement(msg({ id: "g", folder: "Sent", subject: "Re: lunch" }))).toBe(false);
  });
});

describe("the acknowledgement is not in the Ohbox's Earlier block", () => {
  /** THE HEADLINE, in the reported shape — and the human message it acknowledges is untouched. */
  it("keeps an own-sent 'Accepted: …' OUT of Earlier while the invitation stays", async () => {
    const { earlier } = await presentedOhbox([
      msg({ id: "invite", folder: "INBOX", from: "colleague@sender.test", date: RECENT, subject: "Austausch" }),
      // Own-sent, dated LATER, so by send time alone it would sit at the very top of Earlier.
      msg({ id: "accepted", folder: "Sent Items", from: OWN, date: LATER, subject: "Accepted: Austausch" }),
    ]);
    expect(earlier).not.toContain("accepted");
  });

  it("keeps the header-arm acknowledgement out too", async () => {
    const { earlier } = await presentedOhbox([
      msg({ id: "accepted-hdr", folder: "Sent Items", from: OWN, date: LATER, subject: "anything", itipReplyHeader: true }),
    ]);
    expect(earlier).not.toContain("accepted-hdr");
  });

  /** THE POSITIVE CONTROL: ordinary own-sent mail still joins Earlier, which is the whole rule. */
  it("still admits ordinary own-sent mail", async () => {
    const { earlier } = await presentedOhbox([
      msg({ id: "mine", folder: "Sent Items", from: OWN, date: LATER, subject: "Thoughts on the doc" }),
    ]);
    expect(earlier).toContain("mine");
  });
});
