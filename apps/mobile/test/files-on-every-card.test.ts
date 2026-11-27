import type { EngineMessage } from "@ohmail/wire";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MemoryMirrorStore, OhmailEngine, type EngineAdapter, type SyncChange } from "@ohmail/client-engine";
import { liveActions, liveFiles, liveMessage, screeningAnswered, type WorldView } from "../src/state/live";

/**
 * FIX-025 (PHONE-THREAD-SIBLINGS-SHOW-NO-FILES): the phone's reader asked for the opened
 * message's file list only, so the earlier messages of a conversation and the Screener's held
 * mail showed no file. Each screen's open now holds the list of every message it shows that has
 * files, draws their tiles through the reader's one strip, and its release lets them go — unless
 * another screen still shows that message.
 */

/* @reads: apps/mobile/src/ui/MessageReader.tsx apps/mobile/src/ui/SenderDetail.tsx apps/mobile/app/(tabs)/reads.tsx */
const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const READER = readFileSync(join(APP, "src/ui/MessageReader.tsx"), "utf8");
const SENDER = readFileSync(join(APP, "src/ui/SenderDetail.tsx"), "utf8");
const READS = readFileSync(join(APP, "app/(tabs)/reads.tsx"), "utf8");

const NOW = new Date("2026-09-11T12:00:00.000Z");
const view: WorldView = {
  now: NOW, zone: "UTC",
  screening: screeningAnswered({ dormancyDays: 60, baselineAt: "2026-08-12T01:21:58.372Z", scope: "window" }),
};

type AttachmentWire = Awaited<ReturnType<NonNullable<EngineAdapter["listAttachments"]>>>[number];
const file = (messageId: string, filename: string, contentType: string, sizeBytes: number): AttachmentWire =>
  ({ id: `a-${messageId}`, filename, contentType, sizeBytes, inline: false, contentId: null, messageId });
/** q0 plain text and q1 html, both earlier; q2 is the one opened; q3 has no file. */
const FILES: Record<string, AttachmentWire[]> = {
  q0: [file("q0", "notes.txt", "text/plain", 39)],
  q1: [file("q1", "draft.png", "image/png", 1485)],
  q2: [file("q2", "final.pdf", "application/pdf", 2000)],
};
const HTML: Record<string, string> = { q1: "<html><body><p>The draft.</p></body></html>" };

const member = (id: string, hour: number, hasFile: boolean): EngineMessage => ({
  id, accountId: "acct-1", mailboxId: "mb-1", threadId: "th-q", messageIdHeader: null,
  subject: "the poster", from: { name: "Ida", address: "ida@example.invalid" },
  to: [], cc: [], date: `2026-09-10T0${hour}:00:00.000Z`, folder: "INBOX", snippet: `text of ${id}`,
  unread: false, hasAttachments: hasFile, attachmentCount: hasFile ? 1 : 0, sensitivity: {}, triage: null,
  labels: [], remoteContent: "none", updatedAt: "2026-09-10T09:00:00.000Z",
} as unknown as EngineMessage);

async function world(): Promise<{ engine: OhmailEngine; listed: string[] }> {
  const listed: string[] = [];
  const store = new MemoryMirrorStore();
  await store.load();
  const rows = [member("q0", 5, true), member("q1", 6, true), member("q3", 7, false), member("q2", 8, true)];
  let seq = 0;
  await store.applyChanges([
    ...rows.map((m): SyncChange => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
    { type: "rule", op: "create", id: "r-ida", seq: ++seq, updatedAt: "2026-09-10T09:00:00.000Z", entity: {
      id: "r-ida", kind: "sender", match: "ida@example.invalid", destination: "INBOX", enabled: true, createdAt: "2026-09-10T09:00:00.000Z" } },
  ] as SyncChange[]);
  const engine = new OhmailEngine({
    store, now: () => NOW,
    adapter: {
      sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString() }),
      mutate: async () => ({ changes: [], seq: null }),
      fetchBody: async (id: string) => ({ text: `text of ${id}`, html: HTML[id] ?? null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }),
      listAttachments: async (id: string) => { listed.push(id); return FILES[id] ?? []; },
      fetchAttachment: async () => new Blob(["x"]),
    },
  } as never);
  return { engine, listed };
}

const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
const actionsOver = (engine: OhmailEngine) =>
  liveActions({ engine, toast: () => undefined, uuid: () => "00000000-0000-4000-8000-000000000001", zone: "UTC" });
const readyIds = (engine: OhmailEngine, ids: string[]): string[] =>
  ids.filter((id) => engine.attachmentsOf(id).state === "ready");

describe("the phone's thread: every earlier message shows its own files", () => {
  it("a plain-text and an html member each list their file, with a size, and a press reaches its bytes", async () => {
    const { engine, listed } = await world();
    const acts = actionsOver(engine);
    await acts.openMessage("q2");
    await settle();
    expect([...listed].sort(), "the open did not ask every member's list that has files").toEqual(["q0", "q1", "q2"]);
    const row = liveMessage(engine, "q2", view);
    expect(row?.attachments?.map((a) => a.filename), "the opened message lost its file").toEqual(["final.pdf"]);
    const earlier = row?.earlier ?? [];
    expect(earlier.map((h) => h.id), "the premise: the conversation's members stand under it").toEqual(["q0", "q1", "q3"]);
    expect(earlier.map((h) => h.attachments?.map((a) => a.filename) ?? []), "an earlier message shows no file")
      .toEqual([["notes.txt"], ["draft.png"], []]);
    for (const h of earlier.slice(0, 2)) expect(h.attachments?.[0]?.size, `${h.id} states no size`).toMatch(/\d/);
    const bytes = await acts.openAttachmentBytes("q1", "a-q1");
    expect(bytes.state, "a press on an earlier message's file did not reach its bytes").toBe("ready");
  });

  it("a member without a file is not asked (the budget control)", async () => {
    const { engine, listed } = await world();
    await actionsOver(engine).openMessage("q2");
    await settle();
    expect(listed).not.toContain("q3");
  });

  it("the reader's release lets every list it asked for go", async () => {
    const { engine } = await world();
    const acts = actionsOver(engine);
    await acts.openMessage("q2");
    await settle();
    expect(readyIds(engine, ["q0", "q1", "q2"])).toEqual(["q0", "q1", "q2"]);
    acts.releaseAttachments("q2");
    expect(readyIds(engine, ["q0", "q1", "q2"]), "a member's list outlived the reader").toEqual([]);
  });

  it("a list that lands after its reader closed is let go, not kept", async () => {
    const { engine } = await world();
    const acts = actionsOver(engine);
    void acts.openMessage("q2");
    acts.releaseAttachments("q2");
    await settle();
    expect(readyIds(engine, ["q0", "q1", "q2"]), "a list answered after the close stayed held").toEqual([]);
  });

  it("a list another reader still shows is kept until that reader lets it go", async () => {
    const { engine } = await world();
    const acts = actionsOver(engine);
    await acts.openMessage("q2");
    await acts.openMessage("q1");
    await settle();
    acts.releaseAttachments("q2");
    expect(readyIds(engine, ["q0", "q1", "q2"]), "closing one reader dropped a list the other shows").toEqual(["q0", "q1", "q2"]);
    acts.releaseAttachments("q1");
    expect(readyIds(engine, ["q0", "q1", "q2"])).toEqual([]);
  });

  it("the reader draws each member's tiles through the one tile renderer", () => {
    const earlierBlock = READER.slice(READER.indexOf("m.earlier.map("), READER.indexOf("function AttachmentTiles"));
    expect(earlierBlock, "the premise: the earlier block was found").toContain("<Panel key={h.id}");
    expect(earlierBlock, "an earlier panel renders no tiles").toContain("<AttachmentTiles m={h} />");
    expect(READER, "the opened message's tiles moved").toContain("<AttachmentTiles m={m} />");
  });
});

describe("the phone's Screener: every held message shows its files", () => {
  it("the sender screen's open holds each held list that has files, and its release lets them go", async () => {
    const { engine, listed } = await world();
    const acts = actionsOver(engine);
    const bag = ["q0", "q1", "q3"];
    acts.holdFiles(bag);
    await settle();
    expect([...listed].sort(), "the held lists were not asked, or a file-less one was").toEqual(["q0", "q1"]);
    expect(liveFiles(engine, "q0")?.map((a) => a.filename)).toEqual(["notes.txt"]);
    expect(liveFiles(engine, "q1")?.map((a) => a.filename)).toEqual(["draft.png"]);
    expect(liveFiles(engine, "q1")?.[0]?.size).toMatch(/\d/);
    acts.releaseFiles(bag);
    expect(readyIds(engine, bag), "a held list outlived the sender screen").toEqual([]);
  });

  it("a held message open in the reader keeps its list past the sender screen's release", async () => {
    const { engine } = await world();
    const acts = actionsOver(engine);
    acts.holdFiles(["q0", "q1"]);
    await acts.openMessage("q1");
    await settle();
    acts.releaseFiles(["q0", "q1"]);
    expect(readyIds(engine, ["q1"]), "the sender screen took the reader's list").toEqual(["q1"]);
  });

  it("the sender screen draws each held message's tiles through the reader's strip, and releases on leaving", () => {
    const panel = SENDER.slice(SENDER.indexOf("<Panel key={h.id}"), SENDER.indexOf("</Panel>"));
    expect(panel, "a held panel renders no tiles").toContain("<AttachmentTiles m={{ id: h.id, attachments: w.filesOf(h.id) }} />");
    expect(SENDER).toMatch(/holdFiles\(ids\);\s*return \(\) => releaseFiles\(ids\);/);
  });
});

describe("the phone's News: an open card shows its issue's files", () => {
  it("the open is the ask and the close lets it go; a closed card draws and asks nothing", () => {
    expect(READS).toMatch(/if \(!open\) return;\s*holdFiles\(\[m\.id\]\);\s*return \(\) => releaseFiles\(\[m\.id\]\);/);
    const expandable = READS.slice(READS.indexOf("function ExpandableStreamCard("));
    const drawn = expandable.slice(expandable.indexOf("{open ? ("), expandable.indexOf("</Panel>"));
    expect(drawn, "the open card draws no tiles").toContain("<AttachmentTiles m={{ id: m.id, attachments: w.filesOf(m.id) }} />");
  });
});
