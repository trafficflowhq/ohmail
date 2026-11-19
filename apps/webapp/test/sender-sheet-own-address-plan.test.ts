import type { EngineMessage, EngineMutation, Folder } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { MemoryMirrorStore, type SyncChange } from "@ohmail/client-engine";
import { dispatchScreeningChange, isOwnSubject, planScreeningChange, senderScreening } from "@ohmail/app-logic/press/sender-screening";

/**
 * THE ACCOUNT'S OWN MAIL, IN THE SCREENING PLANNER (moved word for word out of `sender-sheet-own-address.test.tsx`,
 * whose other cases draw today's sender sheet, `app/shell/SenderMenu.tsx`, which no host's entry reaches): what is
 * ours, what a press the server refuses as `own_address` says, and the web's own addresses as the server answers
 * them. These cases render nothing; they hold over the planner and the web's mapper, which stay.
 */
const ME = "me@trafficflow.example";
const NOW = "2026-10-06T21:00:00.000Z";
let seq = 0;

function msg(id: string, folder: Folder, from: string, to: string[] = []): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: `Note ${id}`,
    from: { name: null, address: from }, to: to.map((address) => ({ name: null, address })), cc: [], date: NOW, folder,
    snippet: "", unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW,
  };
}

async function mirror() {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    msg("sent-1", "Sent" as Folder, "alias@trafficflow.example", ["friend@example.com"]),
    msg("note-1", "INBOX", ME),
    msg("friend-1", "INBOX", "friend@example.com"),
    // A letter claiming our address that its provider failed, held at the gate.
    { ...msg("forged-1", "ohmail/Screener", ME), authVerdict: "fail" as const },
  ].map((m): SyncChange => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: NOW, entity: m })) as SyncChange[]);
  return store;
}

describe("the sender sheet on the account's own mail", () => {
  it("the subject is ours on our Sent copy and from our own address; a chip or a stranger is not", async () => {
    const r = await mirror();
    expect(isOwnSubject(r, "sent-1", undefined, [ME])).toBe(true);
    expect(isOwnSubject(r, "note-1", undefined, [ME])).toBe(true);
    expect(isOwnSubject(r, "sent-1", "friend@example.com", [ME])).toBe(false);
    expect(isOwnSubject(r, "friend-1", undefined, [ME])).toBe(false);
  });

  it("a press the server refuses as own_address says that sentence, any other refusal its own", async () => {
    const r = await mirror();
    const plan = planScreeningChange(senderScreening(r, "friend-1")!, "screened", "sender", true, true);
    const refusing = (code: string) => async (_m: EngineMutation) => ({ status: "rolled_back" as const, error: { code } });
    expect(await dispatchScreeningChange(plan, [], refusing("own_address"))).toBe("toastOwnAddress");
    expect(await dispatchScreeningChange(plan, [], refusing("validation_failed"))).toBe("toastRuleFailed");
  });

  it("a refusal beside moves already made keeps the sentence that says what moved", async () => {
    const r = await mirror();
    const plan = planScreeningChange(senderScreening(r, "friend-1")!, "screened", "sender", true, true);
    const moved = { kind: "move" as const, messageId: "friend-1", folder: "ohmail/Screened" as Folder };
    const mutate = async (m: EngineMutation) => (m.kind === "move"
      ? { status: "confirmed" as const }
      : { status: "rolled_back" as const, error: { code: "own_address" } });
    expect(await dispatchScreeningChange(plan, [moved], mutate)).toBe("toastRuleFailed");
  });
});

describe("the web's own addresses are the server's", () => {
  it("leave out a mailbox the server does not count as own; a row without the field counts", async () => {
    const { ownAddressesOf } = await import("@ohmail/app-logic/mail-state/mail-state");
    expect(ownAddressesOf([
      { address: "live@own.invalid", addressIsOwn: true },
      { address: "removed@own.invalid", addressIsOwn: false },
      { address: "older@own.invalid" },
    ])).toEqual(["live@own.invalid", "older@own.invalid"]);
  });
});

describe("the hosted mapper carries the server's own-address answer", () => {
  it("`false` survives the narrowing, and an absent field stays absent", async () => {
    const { toMailboxFacts } = await import("../app/(product)/mailbox/mailbox-facts");
    const row = { id: "mb", address: "removed@own.invalid", status: "disabled", errorCode: null, disabledReason: null } as never;
    expect(toMailboxFacts({ ...(row as object), addressIsOwn: false } as never).addressIsOwn).toBe(false);
    expect("addressIsOwn" in toMailboxFacts(row)).toBe(false);
  });
});
