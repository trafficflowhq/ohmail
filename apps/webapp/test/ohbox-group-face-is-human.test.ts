import type { EngineMessage } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { foldOhboxRows, type OhboxRow } from "@ohmail/client-engine";

/** One section's rows through the ENGINE's fold — the one the web and the phone both draw. */
const groupSection = (members: EngineMessage[]): OhboxRow[] =>
  foldOhboxRows({ resurfaced: [], new: [], earlier: members }, []).earlier;

/**
 * ═══ A FOLDED CONVERSATION'S FACE IS WHAT A HUMAN SAID ═══════════════════════════════════════
 *
 * A row shows its NEWEST member's snippet and time, so unheld a calendar acknowledgement takes the
 * face and the row reads "Accepted: …" over what somebody wrote — the 2026-09-16 report. The fold's
 * `face` (`packages/client-engine/src/ohbox-rows.ts`) changes the FACE only: the member, the count
 * and the history are untouched, and an all-acknowledgement conversation still gets a face.
 */

const T = (h: number, m: number) => `2026-09-16T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

function msg(o: {
  id: string;
  subject: string;
  folder: string;
  date: string;
  threadId?: string | null;
  itipReplyHeader?: boolean;
}): EngineMessage {
  const m = {
    id: o.id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: o.threadId ?? null,
    messageIdHeader: null,
    subject: o.subject,
    from: { name: null, address: `${o.id}@example.com` },
    to: [],
    cc: [],
    date: o.date,
    folder: o.folder,
    snippet: `snippet ${o.id}`,
    unread: false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: o.date,
  } as unknown as EngineMessage;
  if ("itipReplyHeader" in o) (m as { itipReplyHeader?: boolean }).itipReplyHeader = o.itipReplyHeader;
  return m;
}

describe("a conversation's face is the newest thing a person said", () => {
  /** THE REPORTED SHAPE: the invitation and the Mac's acknowledgement in ONE conversation. */
  it("shows the human message, and keeps the acknowledgement as a member", () => {
    const invite = msg({ id: "invite", subject: "Austausch", folder: "INBOX", date: T(8, 29), threadId: "t1" });
    const accepted = msg({
      id: "accepted", subject: "Accepted: Austausch", folder: "Sent Items", date: T(8, 36), threadId: "t1",
    });
    const [group] = groupSection([invite, accepted]);
    expect(group!.members.map((m) => m.id).sort()).toEqual(["accepted", "invite"]);
    expect(group!.face.id, "the acknowledgement took the conversation's face").toBe("invite");
  });

  /** The header arm reaches the face too — a subject the table does not know is no escape. */
  it("holds out the header-arm acknowledgement whatever its subject says", () => {
    const human = msg({ id: "human", subject: "Austausch", folder: "INBOX", date: T(8, 29), threadId: "t1" });
    const ack = msg({
      id: "ack", subject: "a subject no table knows", folder: "Sent Items", date: T(8, 36),
      threadId: "t1", itipReplyHeader: true,
    });
    expect(groupSection([human, ack])[0]!.face.id).toBe("human");
  });

  /** THE POSITIVE CONTROL: an ordinary own-sent reply IS the latest word and keeps the face. */
  it("still gives the face to ordinary own-sent mail", () => {
    const theirs = msg({ id: "theirs", subject: "Austausch", folder: "INBOX", date: T(8, 29), threadId: "t1" });
    const mine = msg({ id: "mine", subject: "Re: Austausch", folder: "Sent Items", date: T(8, 36), threadId: "t1" });
    expect(groupSection([theirs, mine])[0]!.face.id).toBe("mine");
  });

  /** A received "Accepted: …" is a person telling you something — it keeps the face. */
  it("gives the face to a RECEIVED message carrying the same prefix", () => {
    const old = msg({ id: "old", subject: "Offer", folder: "INBOX", date: T(8, 29), threadId: "t1" });
    const reply = msg({ id: "reply", subject: "Accepted: your offer", folder: "INBOX", date: T(8, 36), threadId: "t1" });
    expect(groupSection([old, reply])[0]!.face.id).toBe("reply");
  });

  /** A face is owed whatever the members are — a row with no face is not a row. */
  it("falls back to the newest member when every member is an acknowledgement", () => {
    const a = msg({ id: "a", subject: "Accepted: X", folder: "Sent Items", date: T(8, 29), threadId: "t1" });
    const b = msg({ id: "b", subject: "Declined: X", folder: "Sent Items", date: T(8, 36), threadId: "t1" });
    expect(groupSection([a, b])[0]!.face.id).toBe("b");
  });

  /** The un-joined case the incident actually produced: its own row, by its own time. */
  it("leaves a threadless acknowledgement as its own row", () => {
    const ack = msg({ id: "ack", subject: "Accepted: Austausch", folder: "Sent Items", date: T(8, 36) });
    const groups = groupSection([ack]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.face.id).toBe("ack");
  });
});
