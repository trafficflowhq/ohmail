/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { FolderView } from "../app/views/FolderView";
import { TrashView } from "../app/views/TrashView";
import { KeymapProvider } from "../app/shell/keymap";
import { WithListGone } from "./_list-gone";
import { ESTIMATED_ROW_PX, MEASURED_FULL_RANGE_MAX_ROWS } from "../app/shell/list-window";

/**
 * ↓ TO A ROW THE WINDOW HAS NOT MOUNTED. A folder or Trash of a few hundred rows is a window now,
 * so the next row can be off the mounted slice when the reader has scrolled away from the
 * selection. The press reaches it through its slot — the scroller moves there, which mounts it —
 * rather than selecting a row that is not on screen.
 */

const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ISO = "2026-08-01T09:00:00.000Z";
const COUNT = 120;
const rows = Array.from({ length: COUNT }, (_, i) => ({
  id: `m${i}`, accountId: "acct", mailboxId: "mb1", threadId: null, messageIdHeader: null,
  subject: `Subject ${i}`, from: { name: null, address: `s${i}@example.com` }, to: [], cc: [],
  date: new Date(Date.parse(ISO) - i * 60_000).toISOString(), folder: "Projects", snippet: "…",
  unread: false, hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: ISO, trashedAt: ISO, restoreTo: "INBOX",
}));
const none = () => {};

let host: HTMLDivElement | null = null;
let root: Root | null = null;
/* jsdom has no `CSS` object, and both views find the row to scroll to with `CSS.escape`. */
const hadCss = typeof (globalThis as unknown as { CSS?: unknown }).CSS !== "undefined";
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  if (!hadCss) (globalThis as unknown as { CSS: unknown }).CSS = { escape: (s: string) => s.replace(/["\\]/g, "\\$&") };
});
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  host?.remove();
  host = null;
  root = null;
  if (!hadCss) (globalThis as unknown as { CSS?: unknown }).CSS = undefined;
  vi.restoreAllMocks();
});

async function mount(view: React.ReactElement): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(() => root!.render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC" now={new Date(ISO)}>
      <KeymapProvider><WithListGone>{view}</WithListGone></KeymapProvider>
    </NextIntlClientProvider>,
  ));
  return host.querySelector(".scroller") as HTMLElement;
}

const frame = () => act(async () => { await new Promise((r) => setTimeout(r, 40)); });
const ids = () => [...host!.querySelectorAll(".row[data-id]")].map((n) => n.getAttribute("data-id"));
const chosen = () => host!.querySelector('.row[data-id][aria-selected="true"]')?.getAttribute("data-id") ?? null;

async function walkPastTheSlice(scroller: HTMLElement): Promise<void> {
  (host!.querySelector('.row[data-id="m0"]') as HTMLElement).click();
  await frame();
  expect(chosen()).toBe("m0");
  scroller.scrollTop = 90 * ESTIMATED_ROW_PX;
  await act(async () => { scroller.dispatchEvent(new Event("scroll")); });
  await frame();
  expect(ids(), "the window did not move off the selection").not.toContain("m1");
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  await frame();
  await frame();
}

describe("↓ reaches the next row through its slot", () => {
  it(`in a folder of ${COUNT} rows — past the measured floor, a window`, async () => {
    expect(COUNT).toBeGreaterThan(MEASURED_FULL_RANGE_MAX_ROWS);
    const scroller = await mount(
      <FolderView onMarkSeen={() => {}}
        folder={{ id: "fd1", name: "Projects", mailboxId: "mb1", mailbox: "a@example.com" }}
        messages={rows as never[]}
        older={{ available: false, items: [], loading: false, error: null, exhausted: true, loadMore: none }}
        tags={[]} now={new Date(ISO)} onOpen={none} hydrateBody={none} onAction={none} onAddTag={none}
        onScreen={none} canDelete={() => true} canReplyAll={() => true}
      />,
    );
    await walkPastTheSlice(scroller);
    expect(ids()).toContain("m1");
    expect(chosen()).toBe("m1");
  });

  it(`in a Trash of ${COUNT} rows`, async () => {
    const scroller = await mount(
      <TrashView
        page={{ available: true, items: rows as never[], loading: false, error: null, exhausted: true, loadMore: none }}
        tags={[]} now={new Date(ISO)} onOpen={none} hydrateBody={none} onAction={none} onAddTag={none}
        {...({} as Record<string, never>)}
      />,
    );
    await walkPastTheSlice(scroller);
    expect(ids()).toContain("m1");
    expect(chosen()).toBe("m1");
  });
});
