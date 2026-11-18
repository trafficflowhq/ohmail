import type { EngineMessage } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { MemoryMirrorStore, OhmailEngine, type EngineAdapter, type SyncChange } from "@ohmail/client-engine";
import { liveActions, liveFiles, liveMessage, openOffMirror, screeningAnswered, type WorldView } from "../src/state/live";

/**
 * The same fix on the phone (it was first read on the desktops): the reader's one door,
 * `openMessage`, asks for the list of a mirror row that carries files, so a plain-text message
 * with a file lists it. A row the mirror does not hold (a History or Search hit read from the
 * store) was never asked and its row carried no files; that half is the phone's fix.
 */

const NOW = new Date("2026-09-11T12:00:00.000Z");
const ISO = "2026-09-10T08:00:00.000Z";
const view: WorldView = {
  now: NOW, zone: "UTC",
  screening: screeningAnswered({ dormancyDays: 60, baselineAt: "2026-08-12T01:21:58.372Z", scope: "window" }),
};

/** The list route's wire, as the adapter's own contract types it. */
type AttachmentWire = Awaited<ReturnType<NonNullable<EngineAdapter["listAttachments"]>>>[number];
const FILES: Record<string, AttachmentWire[]> = {
  t1: [{ id: "a-t1", filename: "notes.txt", contentType: "text/plain", sizeBytes: 39, inline: false, contentId: null, messageId: "t1" }],
  p1: [{ id: "a-p1", filename: "scan.png", contentType: "image/png", sizeBytes: 1485, inline: false, contentId: null, messageId: "p1" }],
  s9: [{ id: "a-s9", filename: "invoice.pdf", contentType: "application/pdf", sizeBytes: 2000, inline: false, contentId: null, messageId: "s9" }],
  // A PDF the html names by `cid:`: the store keeps it inline, and the row's flag reads false.
  h2: [{ id: "a-h2", filename: "Rechnung.pdf", contentType: "application/pdf", sizeBytes: 2000, inline: true, contentId: "rechnung@example.invalid", messageId: "h2" }],
  s8: [{ id: "a-s8", filename: "Rechnung.pdf", contentType: "application/pdf", sizeBytes: 2000, inline: true, contentId: "rechnung@example.invalid", messageId: "s8" }],
};

const entity = (id: string, over: Partial<EngineMessage> = {}): EngineMessage => ({
  id, accountId: "acct-1", mailboxId: "mb-1", threadId: `th-${id}`, messageIdHeader: null,
  subject: `subject of ${id}`, from: { name: `Sender ${id}`, address: `${id}@example.invalid` },
  to: [], cc: [], date: ISO, folder: "INBOX", snippet: "Here is the file you asked for.",
  unread: false, hasAttachments: true, attachmentCount: 1, sensitivity: {}, triage: null, labels: [],
  remoteContent: "none", updatedAt: ISO, ...over,
} as unknown as EngineMessage);

async function world(ids: string[], over: Partial<EngineMessage> = {}): Promise<{ engine: OhmailEngine; listed: string[] }> {
  const listed: string[] = [];
  const store = new MemoryMirrorStore();
  await store.load();
  let seq = 0;
  for (const id of ids) {
    const m = entity(id, over);
    await store.applyChanges([
      { type: "message", op: "create", id, seq: ++seq, updatedAt: ISO, entity: m },
      { type: "rule", op: "create", id: `r-${id}`, seq: ++seq, updatedAt: ISO, entity: {
        id: `r-${id}`, kind: "sender", match: m.from.address, destination: "INBOX", enabled: true, createdAt: ISO } },
    ] as SyncChange[]);
  }
  const engine = new OhmailEngine({
    store, now: () => NOW,
    adapter: {
      sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString() }),
      mutate: async () => ({ changes: [], seq: null }),
      fetchBody: async () => ({ text: "Here is the file you asked for.", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }),
      listAttachments: async (id: string) => { listed.push(id); return FILES[id] ?? []; },
      fetchAttachment: async () => new Blob(["x"]),
    },
  } as never);
  return { engine, listed };
}

const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
const actionsOver = (engine: OhmailEngine) =>
  liveActions({ engine, toast: () => undefined, uuid: () => "00000000-0000-4000-8000-000000000001", zone: "UTC" });

describe("the phone's reader lists a file whatever the body's type", () => {
  for (const [id, name] of [["t1", "notes.txt"], ["p1", "scan.png"]] as const) {
    it(`${id}: a mirror row's file is asked for on open and listed`, async () => {
      const { engine, listed } = await world([id]);
      await actionsOver(engine).openMessage(id);
      await settle();
      expect(listed).toEqual([id]);
      const row = liveMessage(engine, id, view);
      expect(row?.attachments?.map((a) => a.filename), `the ${id} reader shows no file`).toEqual([name]);
      expect(row?.attachments?.[0]?.size).toMatch(/\d/);
    });
  }

  it("a row the mirror does not hold (a History or Search hit) lists its file too", async () => {
    const { engine, listed } = await world(["t1"]);
    openOffMirror(entity("s9"));
    await actionsOver(engine).openMessage("s9");
    await settle();
    expect(listed, "the off-mirror row's list was never asked").toContain("s9");
    const row = liveMessage(engine, "s9", view);
    expect(row, "the off-mirror row did not open").toBeDefined();
    expect(row?.attachments?.map((a) => a.filename), "the off-mirror row shows no file").toEqual(["invoice.pdf"]);
  });
});

describe("the phone asks for the opened message's list whatever its flag says", () => {
  it("a mirror row whose PDF is named by cid: (flag false) lists it, and a press reaches the bytes", async () => {
    const { engine, listed } = await world(["h2"], { hasAttachments: false, attachmentCount: 0 });
    const acts = actionsOver(engine);
    await acts.openMessage("h2");
    await settle();
    expect(listed, "the opened message's list was never asked").toEqual(["h2"]);
    const row = liveMessage(engine, "h2", view);
    expect(row?.attachments?.map((a) => [a.filename, a.inline]), "the reader shows no file").toEqual([["Rechnung.pdf", true]]);
    expect((await acts.openAttachmentBytes("h2", "a-h2")).state, "a press did not reach the bytes").toBe("ready");
  });

  it("an open News card whose PDF is named by cid: (flag false) lists it", async () => {
    const { engine, listed } = await world(["h2"], { hasAttachments: false, attachmentCount: 0 });
    actionsOver(engine).holdFiles(["h2"]);
    await settle();
    expect(listed, "the open card's list was never asked").toEqual(["h2"]);
    expect(liveFiles(engine, "h2")?.map((a) => a.filename)).toEqual(["Rechnung.pdf"]);
  });

  it("a Search or History row the mirror does not hold, flag false, lists its PDF", async () => {
    const { engine, listed } = await world(["t1"]);
    openOffMirror(entity("s8", { hasAttachments: false, attachmentCount: 0 }));
    await actionsOver(engine).openMessage("s8");
    await settle();
    expect(listed, "the off-mirror row's list was never asked").toContain("s8");
    expect(liveMessage(engine, "s8", view)?.attachments?.map((a) => a.filename)).toEqual(["Rechnung.pdf"]);
  });
});
