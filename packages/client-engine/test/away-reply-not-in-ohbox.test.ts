import type { EngineMessage, Folder, RuleEntity as RuleDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  consentPartition,
  ohboxView,
  presentationReader,
  type SyncChange,
} from "@ohmail/client-engine";

/**
 * ═══ AN AUTO-REPLY BY THE AWAY RESPONDER IS NOT IN THE OHBOX ═════════════════════════════
 *
 * The reported shape, in the reporter's words: "when it responds to Reads emails it puts them in my
 * ohbox, basically spamming my ohbox with reads screener messages".
 *
 * The mechanism is entirely here, in `ohboxView`: it unions the account's own sent mail into
 * "Earlier", because writing a message is finishing with it. An automatic reply is the one kind
 * of own-sent mail nobody finished with — and it is worse than merely present, because an
 * own-sent row sits at its own SEND instant, so every fresh auto-reply lands at the TOP of
 * the pile the person reads. One row per answered message,
 * wearing the bulk message's subject as "Re: …".
 *
 * Measured on the account that reported it, before this landed: such rows every day, most
 * of them threaded to a `ohmail/News` or `ohmail/Receipts` original, arriving several a
 * day for as long as the responder stayed on.
 *
 * ── WHAT THE FIX IS, AND THE THREE THINGS IT MUST NOT DO ────────────────────────────────────
 *
 * One term in the sent union: `m.autoReplyByUs !== true`. The three controls that bound it:
 *
 *   · a reply THE PERSON WROTE is still in Earlier (`!== true` is not `=== false`);
 *   · a row from a server or mirror that predates the field — `undefined` — is still in Earlier,
 *     which is the behaviour every mirror had before the flag existed;
 *   · the ORIGINAL is untouched. This lane moves no message; the Reads row stays in Reads.
 *
 * And nothing is hidden: an auto-reply is still in the Sent folder view, which is where sent mail
 * lives. That is the whole of the hotfix's user-visible promise.
 */

const NOW = new Date("2026-09-09T12:00:00.000Z");
const RECENT = "2026-09-08T09:00:00.000Z";
const OLD = "2024-03-02T09:00:00.000Z";
const OWN = "me@example.com";

let seq = 0;

function msg(o: {
  id: string;
  folder: string;
  from?: string;
  date?: string;
  unread?: boolean;
  lastReadAt?: string | null;
  threadId?: string | null;
  autoReplyByUs?: boolean;
}): EngineMessage {
  const m: EngineMessage = {
    id: o.id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: o.threadId ?? null,
    messageIdHeader: null,
    subject: `Subject ${o.id}`,
    from: { name: null, address: o.from ?? `${o.id}@example.com` },
    to: [],
    cc: [],
    date: o.date ?? RECENT,
    folder: o.folder as Folder,
    snippet: `snippet ${o.id}`,
    unread: o.unread ?? false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: o.date ?? RECENT,
  };
  if ("lastReadAt" in o) m.lastReadAt = o.lastReadAt;
  // `in` and not `?? false`: the ABSENT case is a distinct fixture — a mirror older than the
  // field — and writing `false` there would test the wrong one of the two.
  if ("autoReplyByUs" in o) m.autoReplyByUs = o.autoReplyByUs;
  return m;
}

function consentRule(address: string): RuleDTO {
  return {
    id: `rule-${address}`,
    kind: "sender",
    match: address,
    destination: "INBOX",
    priority: 0,
    provenance: "promoted",
    enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: OLD,
    updatedAt: OLD,
  };
}

/** The Ohbox exactly as the shell reads it: piles over the PRESENTED mirror. */
async function presentedOhbox(messages: EngineMessage[]): Promise<{ earlier: string[]; newForYou: string[] }> {
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
  return {
    earlier: view.previouslySeen.map((m) => m.id),
    newForYou: view.newForYou.map((m) => m.id),
  };
}

describe("the away responder's replies are not in the Ohbox", () => {
  /** THE HEADLINE, in the reported shape: a Reads message answered automatically. */
  it("keeps an auto-reply to a Reads message OUT of Earlier", async () => {
    const { earlier } = await presentedOhbox([
      // The bulk message, filed to Reads. It stays where it is — this lane moves nothing.
      msg({ id: "reads-original", folder: "ohmail/News", threadId: "t1", from: "news@sender.test" }),
      // The responder's answer: own-sent, threaded to it, dated later — so its send instant
      // would otherwise put it at the very top.
      msg({
        id: "auto-reply", folder: "Sent", from: OWN, threadId: "t1",
        date: "2026-09-09T11:59:00.000Z", autoReplyByUs: true,
      }),
    ]);
    expect(earlier).not.toContain("auto-reply");
    expect(earlier).toEqual([]);
  });

  /**
   * THE POSITIVE CONTROL, and the one that matters most: a guard whose every case asserts an
   * absence has no evidence it admits the right row. A reply the PERSON wrote is still there,
   * still at the top, exactly as before this change.
   */
  it("still shows a reply the PERSON wrote, at the top of Earlier", async () => {
    const { earlier } = await presentedOhbox([
      msg({ id: "read-earlier", folder: "INBOX", lastReadAt: "2026-09-09T10:00:00.000Z", from: "a@sender.test" }),
      msg({
        id: "human-reply", folder: "Sent", from: OWN, threadId: "t2",
        date: "2026-09-09T11:59:00.000Z", autoReplyByUs: false,
      }),
    ]);
    expect(earlier).toEqual(["human-reply", "read-earlier"]);
  });

  /**
   * THE COMPATIBILITY CONTROL. `undefined` is BOTH "this mirror predates the field" and "this
   * server predates it", and it has to keep the old behaviour — otherwise the first deploy of
   * this change empties the Sent half of Earlier for every client that has not resynced.
   */
  it("treats an ABSENT flag as the person's mail — the pre-field behaviour, unchanged", async () => {
    const { earlier } = await presentedOhbox([
      msg({ id: "legacy-sent", folder: "Sent", from: OWN, date: "2026-09-09T11:00:00.000Z" }),
    ]);
    expect(earlier).toEqual(["legacy-sent"]);
  });

  /** Both kinds in one mirror: the person's reply survives the same pass that drops the machine's. */
  it("separates the two in one pile rather than emptying it", async () => {
    const { earlier } = await presentedOhbox([
      msg({ id: "reads-original", folder: "ohmail/News", threadId: "t1", from: "news@sender.test" }),
      msg({ id: "auto-1", folder: "Sent", from: OWN, threadId: "t1", date: "2026-09-09T11:50:00.000Z", autoReplyByUs: true }),
      msg({ id: "auto-2", folder: "Sent Items", from: OWN, threadId: "t3", date: "2026-09-09T11:55:00.000Z", autoReplyByUs: true }),
      msg({ id: "mine", folder: "INBOX/Sent", from: OWN, threadId: "t2", date: "2026-09-09T11:58:00.000Z", autoReplyByUs: false }),
      msg({ id: "legacy", folder: "Sent Messages", from: OWN, date: "2026-09-09T11:40:00.000Z" }),
    ]);
    expect(earlier).toEqual(["mine", "legacy"]);
  });

  /**
   * THE ORIGINAL IS NOT MOVED, and it is not promoted into the Ohbox either — the hard stop this
   * lane was given. An unread Reads message stays a Reads message; it is not in "New for you".
   */
  it("leaves the ANSWERED original in its own pile, unread and all", async () => {
    const { earlier, newForYou } = await presentedOhbox([
      msg({
        id: "reads-original", folder: "ohmail/News", threadId: "t1",
        from: "news@sender.test", unread: true,
      }),
      msg({ id: "auto-reply", folder: "Sent", from: OWN, threadId: "t1", date: RECENT, autoReplyByUs: true }),
    ]);
    expect(newForYou).toEqual([]);
    expect(earlier).toEqual([]);
  });
});
