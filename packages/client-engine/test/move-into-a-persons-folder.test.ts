import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  MutationRejectedError,
  OhmailEngine,
  OUTBOX_TYPE,
  type EngineAdapter,
  type EngineMessage,
  type EngineMutation,
  type FolderEntity,
  type SyncChange,
} from "@ohmail/client-engine";

/**
 * A MOVE INTO ONE OF THE PERSON'S OWN FOLDERS, through the engine's front door. The act is the move
 * the six places already take, naming the folder by its listed path, so it is painted, kept and
 * replaced exactly as a move is. What is new is where it may go: only into a folder this mirror lists
 * for the letter's own mailbox with no command standing on it. Anything else the server refuses, so
 * the engine refuses it before the wire, and nothing is painted, sent or kept.
 */
const AT = "2026-11-15T09:00:00.000Z";
const LETTER: EngineMessage = {
  id: "m1", accountId: "a", mailboxId: "mb1", threadId: null, messageIdHeader: null, subject: "Offer",
  from: { name: null, address: "sales@acme.example" }, to: [], cc: [], date: AT, arrivedAt: AT, folder: "INBOX",
  snippet: "", unread: false, hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: AT,
};
const ACME: FolderEntity = { id: "f-acme", name: "Clients/Acme", mailboxId: "mb1", mailbox: "me@example.test", updatedAt: AT };

const network = () => new MutationRejectedError("network failure", { code: "network", retryable: true });

async function world() {
  const sent: EngineMutation[] = [];
  let failing = false;
  let first = true;
  const create = (type: string, id: string, seq: number, entity: unknown): SyncChange =>
    ({ type, op: "create", id, seq, updatedAt: AT, entity }) as SyncChange;
  const adapter: EngineAdapter = {
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
    async sync() {
      const creates = first ? [create("message", LETTER.id, 1, LETTER), create("folder", ACME.id, 2, ACME)] : [];
      first = false;
      return { changes: { creates, updates: [], moves: [], deletes: [] }, cursor: "2", hasMore: false, serverTime: AT };
    },
    async mutate(m) {
      sent.push(m);
      if (failing) throw network();
      return { changes: [], seq: null };
    },
  };
  const store = new MemoryMirrorStore();
  const engine = new OhmailEngine({ adapter, store, now: () => new Date(AT) });
  await engine.start();
  return {
    engine, store, sent,
    offline: (on: boolean) => { failing = on; },
    folderOf: (id: string) => engine.read().get<EngineMessage>("message", id)?.folder,
  };
}

describe("a move into a person's own folder", () => {
  it("is painted at the press and sent as the folder's listed path", async () => {
    const w = await world();
    const pending = w.engine.mutate({ kind: "move", messageId: "m1", folder: "Clients/Acme" });
    expect(w.folderOf("m1"), "the overlay did not move the letter in the press's own tick").toBe("Clients/Acme");
    expect((await pending).status).toBe("confirmed");
    expect(w.sent).toEqual([{ kind: "move", messageId: "m1", folder: "Clients/Acme" }]);
  });

  it("is refused before the wire where this mirror lists no such folder: nothing painted, sent or kept", async () => {
    const w = await world();
    const res = await w.engine.mutate({ kind: "move", messageId: "m1", folder: "Clients/Gone" });
    expect(res.status).toBe("rolled_back");
    expect(res.error?.code).toBe("not_found");
    expect(w.sent).toEqual([]);
    expect(w.store.entries(OUTBOX_TYPE)).toHaveLength(0);
    expect(w.folderOf("m1")).toBe("INBOX");
  });

  it("is refused before the wire into a folder the person's own rename still stands on", async () => {
    const w = await world();
    w.offline(true);
    expect((await w.engine.mutate({ kind: "folder_rename", folderId: ACME.id, name: "Kunden/Acme" })).status).toBe("queued");
    const res = await w.engine.mutate({ kind: "move", messageId: "m1", folder: "Clients/Acme" });
    expect(res.status).toBe("rolled_back");
    expect(w.engine.pendingMutations().map((p) => p.mutation.kind)).toEqual(["folder_rename"]);
  });
});

describe("one decision about a letter's placement, a person's folder or a place alike", () => {
  it("a later move to one of the six replaces a queued move into a person's folder", async () => {
    const w = await world();
    w.offline(true);
    expect((await w.engine.mutate({ kind: "move", messageId: "m1", folder: "Clients/Acme" })).status).toBe("queued");
    expect((await w.engine.mutate({ kind: "move", messageId: "m1", folder: "ohmail/News" })).status).toBe("queued");
    expect(w.engine.pendingMutations().map((p) => p.mutation)).toEqual([{ kind: "move", messageId: "m1", folder: "ohmail/News" }]);
    w.offline(false);
    w.sent.length = 0;
    await w.engine.syncOnce();
    expect(w.sent).toEqual([{ kind: "move", messageId: "m1", folder: "ohmail/News" }]);
  });

  it("a later move into a person's folder replaces a queued move to one of the six", async () => {
    const w = await world();
    w.offline(true);
    await w.engine.mutate({ kind: "move", messageId: "m1", folder: "ohmail/News" });
    await w.engine.mutate({ kind: "move", messageId: "m1", folder: "Clients/Acme" });
    expect(w.engine.pendingMutations().map((p) => p.mutation)).toEqual([{ kind: "move", messageId: "m1", folder: "Clients/Acme" }]);
    expect(w.folderOf("m1")).toBe("Clients/Acme");
  });

  it("a later delete replaces a queued move into a person's folder", async () => {
    const w = await world();
    w.offline(true);
    await w.engine.mutate({ kind: "move", messageId: "m1", folder: "Clients/Acme" });
    await w.engine.mutate({ kind: "message_delete", messageId: "m1" });
    expect(w.engine.pendingMutations().map((p) => p.mutation.kind)).toEqual(["message_delete"]);
    expect(w.engine.read().get("message", "m1")).toBeUndefined();
  });
});
