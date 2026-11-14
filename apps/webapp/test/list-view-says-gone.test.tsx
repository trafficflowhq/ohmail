/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import type { SyncChange, TrashRowWire } from "@ohmail/client-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import messages from "../messages/en.json";
import { cursorRow, ohboxRow as row, ohboxRows as rows, readingColumn } from "./ohbox/_finders.js";
import { NOW, S, act, click, engineOver, msg, setup, shell, storeWith, teardown, tombstone, waitFor } from "./_view-shell";

const GONE = messages.reader.goneShort;
const column = (el: HTMLElement) => readingColumn(el)?.textContent ?? "";

beforeEach(setup);
afterEach(teardown);

const TAG = { type: "tag", op: "create", id: "tg1", seq: 900, updatedAt: NOW.toISOString(),
  entity: { id: "tg1", name: "Invoices", hue: "moss", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() } } as unknown as SyncChange;
const tagged = () => [msg("m1", { labels: ["tg1"] }), msg("m2", { labels: ["tg1"], date: "2026-09-16T08:00:00.000Z" })];

describe("the shell's list views say a picked message is gone", () => {
  for (const [hash, view] of [["#/tag/tg1", "tag"], ["#/history", "history"]] as const) {
    it(`the ${view} column says it, and shows no other message in its place`, async () => {
      const s = await storeWith(tagged(), [TAG]);
      const el = await shell(s, engineOver(s), hash);
      await waitFor(() => row(el, "m1") !== null, `${view} rows`);
      await click(row(el, "m1"), "row m1");
      await tombstone("m1");
      const col = column(el);
      expect(col, `the ${view} column reads: ${col.slice(0, 120)}`).toContain(GONE);
      expect(col).not.toContain("Subject m2");
      expect(col).not.toContain("Subject m1");
    });
  }

  it("a message tagged later lists on top, and the tag's column keeps the row it showed", async () => {
    const s = await storeWith(tagged(), [TAG]);
    const el = await shell(s, engineOver(s), "#/tag/tg1");
    await waitFor(() => row(el, "m1") !== null, "tag rows");
    const cursor = () => cursorRow(el)?.dataset.id;
    expect(cursor()).toBe("m1");
    S.pending = [{ type: "message", op: "create", id: "m0", seq: ++S.seq, updatedAt: NOW.toISOString(),
      entity: msg("m0", { labels: ["tg1"], date: "2026-09-16T08:50:00.000Z" }) } as unknown as SyncChange];
    await act(async () => { await S.engine!.syncOnce(); });
    await waitFor(() => row(el, "m0") !== null, "m0 tagged");
    expect(rows(el)[0]?.dataset.id, "m0 listed on top").toBe("m0");
    expect(cursor()).toBe("m1");
    expect(column(el)).toContain("Subject m1");
  });

  it("another tag opens on its own first row, never on the row the last tag showed", async () => {
    const TAG2 = { ...TAG, id: "tg2", entity: { ...(TAG as unknown as { entity: object }).entity, id: "tg2", name: "Travel" } } as unknown as SyncChange;
    const s = await storeWith([...tagged().map((m) => (m.id === "m1" ? { ...m, labels: ["tg1", "tg2"] } : m)),
      msg("m9", { labels: ["tg2"], date: "2026-09-16T08:50:00.000Z" }), msg("m5", { labels: ["tg2"], date: "2026-09-16T08:40:00.000Z" })], [TAG, TAG2]);
    const el = await shell(s, engineOver(s), "#/tag/tg1");
    await waitFor(() => row(el, "m1") !== null, "tag rows");
    const cursor = () => cursorRow(el)?.dataset.id;
    expect(cursor()).toBe("m1");
    await act(async () => {
      window.location.hash = "#/tag/tg2";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() => row(el, "m9") !== null, "tg2 rows");
    expect(cursor()).toBe("m9");
    expect(column(el)).toContain("Subject m9");
  });

  it("an untagged letter stays open without a gone notice", async () => {
    const s = await storeWith(tagged(), [TAG]);
    const el = await shell(s, engineOver(s), "#/tag/tg1");
    await waitFor(() => row(el, "m1") !== null, "tag rows");
    await click(row(el, "m1"), "tag row m1");
    S.pending = [{ type: "message", op: "update", id: "m1", seq: ++S.seq, updatedAt: NOW.toISOString(),
      entity: msg("m1", { labels: [] }) } as unknown as SyncChange];
    await act(async () => { await S.engine!.syncOnce(); });
    await waitFor(() => row(el, "m1") === null, "m1 out of the tag");
    const col = column(el);
    expect(col).not.toContain(GONE);
    expect(col).toContain("Subject m1");
    expect(col).not.toContain("Subject m2");
  });
});

const VIEWS = ["triage", "folder", "trash"] as const;
type View = (typeof VIEWS)[number];

function record(type: SyncChange["type"], id: string, entity: object): SyncChange {
  return { type, id, entity, op: "create", seq: ++S.seq, updatedAt: NOW.toISOString() } as SyncChange;
}

async function mountView(view: View, letters: EngineMessage[]) {
  const inView = (letter: EngineMessage): EngineMessage => ({
    ...letter,
    folder: view === "folder" ? "Projects" as EngineMessage["folder"] : letter.folder,
    triage: view === "triage" ? {
      messageId: letter.id, state: "reply_later",
      bubbleUpAt: null, setAt: letter.date ?? NOW.toISOString(), updatedAt: NOW.toISOString(),
    } : null,
  });
  const extras = view === "folder" ? [record("folder", "fd1", {
    id: "fd1", name: "Projects", mailboxId: "mb1", mailbox: "me@example.invalid", updatedAt: NOW.toISOString(),
  })] : [];
  const trashed = (letter: EngineMessage): TrashRowWire => ({
    ...letter, trashedAt: letter.date ?? NOW.toISOString(), restoreTo: "INBOX",
  });
  let trash = letters.map(trashed);
  const store = await storeWith(view === "trash" ? [] : letters.map(inView), extras);
  const engine = engineOver(store);
  if (view === "trash") {
    vi.spyOn(engine, "trashAvailable").mockReturnValue(true);
    vi.spyOn(engine, "listTrash").mockImplementation(async () => ({ state: "ready", items: trash, nextCursor: null }));
  }
  const host = await shell(store, engine, view === "folder" ? "#/folder/fd1" : "#/" + view);
  await waitFor(() => row(host, letters[0]!.id) !== null, view + " rows");
  return {
    host,
    async remove(id: string) {
      trash = trash.filter((letter) => letter.id !== id);
      await tombstone(id);
    },
    async add(letter: EngineMessage) {
      S.pending = [record("message", letter.id, inView(letter))];
      await act(async () => { await engine.syncOnce(); });
    },
  };
}

const listed = () => [msg("m1"), msg("m2", { date: "2026-09-16T08:00:00.000Z" })];

describe("Triage, a folder and Trash say it too", () => {
  for (const view of VIEWS) {
    it(`the ${view} column says a picked message is gone`, async () => {
      const { host, remove } = await mountView(view, listed());
      await click(row(host, "m1"), view + " row m1");
      expect(column(host)).toContain("Subject m1");
      await remove("m1");
      expect(column(host)).toContain(GONE);
      expect(column(host)).not.toContain("Subject m2");
    });
  }
});

describe("a row listed late never takes the cursor or the column", () => {
  // Trash's held-delete arrival is exercised in trash-restore-selection.test.tsx.
  for (const view of ["triage", "folder"] as const) {
    it(`the ${view} view keeps the row it shows when a newer one lists above it`, async () => {
      const incoming = msg("m0", { date: "2026-09-16T08:50:00.000Z" });
      const { host, add } = await mountView(view, listed());
      const cursor = () => cursorRow(host)?.dataset.id;
      if (cursor() !== "m1") await click(row(host, "m1"), view + " row m1");
      expect(cursor()).toBe("m1");
      expect(column(host)).toContain("Subject m1");
      expect(row(host, "m0")).toBeNull();
      await add(incoming);
      await waitFor(() => row(host, "m0") !== null, "new row");
      expect(rows(host)[0]?.dataset.id, "m0 listed on top").toBe("m0");
      expect(cursor()).toBe("m1");
      expect(column(host)).toContain("Subject m1");
      expect(column(host)).not.toContain("Subject m0");
    });
  }
});

describe("a pile row the column shows is followed, not its message", () => {
  it("a late arrival lists above the shown row, then a newer member joins that row: the cursor stays on the row", async () => {
    const reply = (id: string, date: string) => msg(id, { threadId: "reply-thread", date });
    const { host, add } = await mountView("triage", [reply("r1", "2026-09-16T08:20:00.000Z"),
      msg("s1", { date: "2026-09-16T08:10:00.000Z" })]);
    const cursor = () => cursorRow(host)?.dataset.id;
    await click(row(host, "r1"), "reply row r1");
    expect(cursor()).toBe("r1");
    await add(msg("n1", { date: "2026-09-16T08:40:00.000Z" }));
    await waitFor(() => rows(host)[0]?.dataset.id === "n1", "late arrival above the reply row");
    expect(cursor()).toBe("r1");
    await add(reply("r2", "2026-09-16T08:30:00.000Z"));
    await waitFor(() => row(host, "r2") !== null, "newer member of the reply row");
    expect(cursor(), "the row's newer member, never the late arrival above it").toBe("r2");
    expect(column(host)).toContain("Subject r2");
  });
});
