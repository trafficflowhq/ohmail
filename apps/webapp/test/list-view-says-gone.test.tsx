/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { EngineMessage, SyncChange } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { FolderView } from "../app/views/FolderView";
import { TrashView } from "../app/views/TrashView";
import { TriageView } from "../app/views/TriageView";
import { KeymapProvider } from "../app/shell/keymap";
import { listGoneFacts } from "../app/shell/list-view";
import { WithListGone } from "./_list-gone";
import { GONE, NOW, S, act, click, engineOver, msg, setup, shell, storeWith, teardown, text, tombstone, waitFor } from "./_view-shell";

/**
 * GONE-NOTICE-NOT-ON-THE-OTHER-VIEWS-READING-COLUMNS. A picked message another mail client took
 * away is SAID in every list view's reading column — never swapped for the first row (Tag), never
 * left standing under "Loading the full message…" (History). Any other departure — filed out of
 * the tag, this tab's own verb — keeps the first-row fallback: nobody lost that message.
 */
beforeEach(setup);
afterEach(teardown);

const TAG = { type: "tag", op: "create", id: "tg1", seq: 900, updatedAt: NOW.toISOString(),
  entity: { id: "tg1", name: "Invoices", hue: "moss", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() } } as unknown as SyncChange;
const tagged = () => [msg("m1", { labels: ["tg1"] }), msg("m2", { labels: ["tg1"], date: "2026-09-16T08:00:00.000Z" })];

describe("the shell's list views say a picked message is gone", () => {
  it("control: the Ohbox column says it", async () => {
    const s = await storeWith(tagged(), [TAG]);
    const el = await shell(s, engineOver(s), "#/ohbox");
    await waitFor(() => el.querySelector('.view-ohbox .row[data-id="m1"]') !== null, "ohbox rows");
    await click(el.querySelector('.view-ohbox .row[data-id="m1"]'), "ohbox row m1");
    await tombstone("m1");
    expect(text(el, ".view-ohbox .read-col")).toContain(GONE);
  });

  for (const [hash, view] of [["#/tag/tg1", "tag"], ["#/history", "history"]] as const) {
    it(`the ${view} column says it, and shows no other message in its place`, async () => {
      const s = await storeWith(tagged(), [TAG]);
      const el = await shell(s, engineOver(s), hash);
      await waitFor(() => el.querySelector(`.view-${view} .row[data-id="m1"]`) !== null, `${view} rows`);
      await click(el.querySelector(`.view-${view} .row[data-id="m1"]`), "row m1");
      await tombstone("m1");
      const col = text(el, `.view-${view} .read-col`);
      expect(col, `the ${view} column reads: ${col.slice(0, 120)}`).toContain(GONE);
      expect(col).not.toContain("Subject m2");
      expect(col).not.toContain("Subject m1");
    });
  }

  it("a pick filed out of the tag is not gone: the column falls back to the first row", async () => {
    const s = await storeWith(tagged(), [TAG]);
    const el = await shell(s, engineOver(s), "#/tag/tg1");
    await waitFor(() => el.querySelector('.view-tag .row[data-id="m1"]') !== null, "tag rows");
    await click(el.querySelector('.view-tag .row[data-id="m1"]'), "tag row m1");
    S.pending = [{ type: "message", op: "update", id: "m1", seq: ++S.seq, updatedAt: NOW.toISOString(),
      entity: msg("m1", { labels: [] }) } as unknown as SyncChange];
    await act(async () => { await S.engine!.syncOnce(); });
    await waitFor(() => el.querySelector('.view-tag .row[data-id="m1"]') === null, "m1 out of the tag");
    const col = text(el, ".view-tag .read-col");
    expect(col).not.toContain(GONE);
    expect(col).toContain("Subject m2");
  });
});

/* Triage, a folder and Trash, mounted alone over the list surface's shell half. */
let roots: Root[] = [];
afterEach(async () => {
  for (const r of roots) await act(() => { r.unmount(); });
  roots = [];
});
const none = () => {};

async function mountView(render: (gone: Set<string>) => React.ReactElement, gone: Set<string>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const draw = () => act(() => root.render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC" now={NOW}>
      <KeymapProvider>
        <WithListGone value={listGoneFacts((id) => gone.has(id), new Set(), null)}>{render(gone)}</WithListGone>
      </KeymapProvider>
    </NextIntlClientProvider>,
  ));
  await draw();
  return { host, draw };
}

const rowsOf = (gone: Set<string>) => [msg("m1"), msg("m2", { date: "2026-09-16T08:00:00.000Z" })].filter((m) => !gone.has(m.id));

const VIEWS: Array<[string, (gone: Set<string>) => React.ReactElement]> = [
  ["triage", (gone) => {
    const byId = new Map(rowsOf(gone).map((m) => [m.id, m]));
    return (
      <TriageView onMarkSeen={() => {}} settled owed={false}
        piles={{ replyLater: rowsOf(gone).map((m) => ({ messageId: m.id, title: m.id })), setAside: [], resurface: [] }}
        pile="reply" onPile={none} frDone={new Set()} onStartFR={none}
        messageOf={(id) => byId.get(id) ?? null}
        tags={[]} now={NOW} onOpen={none} hydrateBody={none} onAction={none} onAddTag={none}
      />
    );
  }],
  ["folder", (gone) => (
    <FolderView onMarkSeen={() => {}}
      folder={{ id: "fd1", name: "Projects", mailboxId: "mb1", mailbox: "a@example.com" } as never}
      messages={rowsOf(gone) as EngineMessage[]}
      older={{ available: false, items: [], loading: false, error: null, exhausted: true, loadMore: none } as never}
      tags={[]} now={NOW} onOpen={none} hydrateBody={none} onAction={none} onAddTag={none}
      onScreen={none} canDelete={() => true} canReplyAll={() => true}
    />
  )],
  ["trash", (gone) => (
    <TrashView
      page={{ available: true, items: rowsOf(gone).map((m) => ({ ...m, trashedAt: NOW.toISOString(), restoreTo: "INBOX" })) as never[],
        loading: false, error: null, exhausted: true, loadMore: none } as never}
      tags={[]} now={NOW} onOpen={none} hydrateBody={none} onAction={none} onAddTag={none}
    />
  )],
];

describe("Triage, a folder and Trash say it too", () => {
  for (const [view, render] of VIEWS) {
    it(`the ${view} column says a picked message is gone`, async () => {
      const gone = new Set<string>();
      const { host, draw } = await mountView(render, gone);
      await click(host.querySelector(`.view-${view} .row[data-id="m1"]`), `${view} row m1`);
      expect(text(host, `.view-${view} .read-col`)).toContain("Subject m1");
      gone.add("m1");
      await draw();
      const col = text(host, `.view-${view} .read-col`);
      expect(col, `the ${view} column reads: ${col.slice(0, 120)}`).toContain(GONE);
      expect(col).not.toContain("Subject m2");
    });
  }
});

describe("the shell half: a tombstone this tab's own verb wrote is not 'gone'", () => {
  it("reads a foreign tombstone as gone, and neither an own one nor an absent row", () => {
    const facts = listGoneFacts((id) => id === "t1" || id === "t2", new Set(["t2"]), null);
    expect(facts.isGone("t1")).toBe(true);
    expect(facts.isGone("t2"), "this tab's own delete read as another app's").toBe(false);
    expect(facts.isGone("absent")).toBe(false);
  });
});
