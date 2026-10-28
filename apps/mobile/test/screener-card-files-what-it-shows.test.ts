import { describe, expect, it } from "vitest";
import { MemoryMirrorStore, type DecideIntent, type EngineMessage, type SyncChange } from "@ohmail/client-engine";
import { planDecideCommit } from "../src/state/live";

/**
 * Ruled, the phone's card: its decision files what the card shows. The commit asks no
 * past-mail answer (the server's pass moved 42 earlier letters out of News under a card saying
 * "1 held message"), and the INBOX letters the card listed move by id beside it.
 */

const AT = "2026-10-09T09:00:00.000Z";
const FROM = "s@letters.example";

function msg(id: string, folder: EngineMessage["folder"], from = FROM, over: Partial<EngineMessage> = {}): EngineMessage {
  return {
    ...over,
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [], date: AT, folder,
    snippet: "s", unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: AT,
  };
}

async function reader(...ms: EngineMessage[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(ms.map((m, i): SyncChange => ({ type: "message", op: "create", id: m.id, seq: i + 1, updatedAt: AT, entity: m })));
  return store;
}

const intent = (seedId: string, messageIds: string[]): DecideIntent => ({
  v: 3, verb: "decide", id: "d1", seedId, address: FROM, scope: "sender", dest: "reads", read: false, messageIds, at: 0,
});

describe("the phone card's decision files what the card shows", () => {
  it("a held representative: the decide asks no past-mail answer, and the card's INBOX letter moves", async () => {
    const out = planDecideCommit(await reader(msg("h1", "ohmail/Screener"), msg("i1", "INBOX")), intent("h1", ["h1", "i1"]));
    expect(out.find((m) => m.kind === "screener_decide")).toMatchObject({ senderId: "h1", dest: "reads", applyRetro: false });
    expect(out.filter((m) => m.kind === "move")).toEqual([{ kind: "move", messageId: "i1", folder: "ohmail/News", from: "INBOX", pressRule: true }]);
  });

  it("a representative past the gate: the rule asks no past-mail answer either, and the letter moves", async () => {
    const out = planDecideCommit(await reader(msg("i2", "INBOX")), intent("i2", ["i2"]));
    const rule = out.find((m) => m.kind === "rule_create");
    expect(rule).toMatchObject({ applyRetro: false });
    expect(out.filter((m) => m.kind === "move")).toEqual([{ kind: "move", messageId: "i2", folder: "ohmail/News", from: "INBOX", pressRule: true }]);
  });

  it("an Ohbox decision plans no move for a letter already in the INBOX", async () => {
    const out = planDecideCommit(await reader(msg("h1", "ohmail/Screener"), msg("i1", "INBOX")), { ...intent("h1", ["h1", "i1"]), dest: "ohbox" });
    expect(out.filter((m) => m.kind === "move")).toEqual([]);
  });

  it("the ✓ beside Screen out and Spam reads the card's letters; the plain press only files", async () => {
    const r = await reader(msg("h1", "ohmail/Screener"), msg("h2", "ohmail/Screener"));
    for (const dest of ["screened", "spam"] as const) {
      const read = planDecideCommit(r, { ...intent("h1", ["h1", "h2"]), dest, read: true });
      expect(read.find((m) => m.kind === "screener_decide")).not.toHaveProperty("read");
      expect(read.filter((m) => m.kind === "mark_seen")).toEqual([{ kind: "mark_seen", messageIds: ["h1", "h2"], unread: false }]);
      const plain = planDecideCommit(r, { ...intent("h1", ["h1", "h2"]), dest });
      expect(plain.filter((m) => m.kind === "mark_seen")).toEqual([]);
    }
  });

  it("CONTROL: a card of held letters alone moves nothing by id", async () => {
    const out = planDecideCommit(await reader(msg("h1", "ohmail/Screener")), intent("h1", ["h1"]));
    expect(out.filter((m) => m.kind === "move")).toEqual([]);
  });
});

describe("the phone's whole-domain card files every waiting letter it named", () => {
  it("the other senders' INBOX letters move beside the decision; an admitted answer among them does not", async () => {
    const r = await reader(
      msg("h1", "ohmail/Screener"), msg("a1", "INBOX"),
      msg("b1", "INBOX", "b@letters.example"),
      msg("c1", "INBOX", "c@letters.example", { placeDecided: true }),
    );
    const out = planDecideCommit(r, { ...intent("h1", ["h1", "a1"]), scope: "domain", alsoIds: ["b1", "c1"] });
    expect(out.find((m) => m.kind === "screener_decide")).toMatchObject({ scope: "domain", applyRetro: false });
    const moved = out.filter((m) => m.kind === "move").map((m) => (m.kind === "move" ? m.messageId : ""));
    expect(moved.sort()).toEqual(["a1", "b1"]);
  });
});
