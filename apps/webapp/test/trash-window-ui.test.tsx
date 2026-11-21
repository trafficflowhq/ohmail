/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryMirrorStore, OhmailEngine, type EngineAdapter, type TrashRowWire } from "@ohmail/client-engine";
import type { TrashLiveWire, TrashWindowItemWire, TrashWindowPageWire } from "@ohmail/app-logic/trash";
import { Frame } from "@ohmail/app/frame";
import { NONE, type ConsentWire } from "@ohmail/app/host";
import { MailGround, mailPlaces } from "@ohmail/app/mail";
import { TextProvider, type Messages } from "@ohmail/app/text";
import { letter } from "../../../packages/app/test/reader/support/mail.js";
import { fakeHost } from "../../../packages/app/test/support/fake-host.js";
import { fakeAddress, fakeWindow } from "../../../packages/app/test/support/fake-window.js";
import en from "../messages/en.json";
import de from "../messages/de.json";

const TIME = "2026-09-09T10:00:00.000Z";
const okBox = { id: "mb1", address: "mailbox@example.invalid", window: "ok" } as const;
const body = { subject: "Live 1", text: "the live body text" };
const folders: ConsentWire = {
  state: async () => ({
    seedConfirmedAt: null,
    screeningResetAt: null,
    dormancyDays: 45,
    foldersEnabledAt: TIME,
  }),
} as ConsentWire;

function mirrored(id: string): TrashRowWire {
  return {
    ...letter(id, { subject: `Mirrored ${id}`, unread: false }),
    trashedAt: TIME,
    restoreTo: "ohmail/News",
  };
}

function liveRow(uid: number): TrashWindowItemWire {
  return {
    mailboxId: "mb1", uid, uidValidity: "77",
    subject: `Live ${uid}`, from: { name: `Name ${uid}`, address: `sender${uid}@example.invalid` },
    date: new Date(Date.UTC(2026, 8, uid, 10)).toISOString(), messageIdHeader: null,
    seen: false, origin: "provider",
  };
}

function page(fields: Partial<TrashWindowPageWire> = {}): TrashWindowPageWire {
  return { items: [], mailboxes: [okBox], nextCursor: null, ...fields };
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  Element.prototype.animate ??= () =>
    ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  Element.prototype.scrollIntoView ??= () => undefined;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function settle() {
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
}

async function mount({
  rows = [],
  live,
  mirroredAvailable = true,
  locale = "en",
  viewport = "desktop",
}: {
  rows?: TrashRowWire[];
  live?: TrashLiveWire["list"];
  mirroredAvailable?: boolean;
  locale?: "en" | "de";
  viewport?: "desktop" | "phone";
} = {}) {
  const adapter: EngineAdapter = {
    sync: async () => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "0", hasMore: false, serverTime: TIME,
    }),
    mutate: async () => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" }),
    fetchBody: async () => null,
  };
  const store = new MemoryMirrorStore();
  await store.load();
  const engine = new OhmailEngine({
    store,
    adapter: mirroredAvailable ? Object.assign(adapter, {
      listTrash: async () => ({ items: rows, nextCursor: null }),
      restoreFromTrash: async () => ({ restoreTo: "ohmail/News", pending: false }),
    }) : adapter,
  });
  const list = live ? vi.fn(live) : undefined;
  const { host } = fakeHost({
    engine, service: "self", scope: "account-trash",
    places: mailPlaces(), above: MailGround,
    address: fakeAddress("#/trash"), window: fakeWindow(viewport),
    wires: { consent: folders, trash: list ? { list, body: async () => body } : NONE },
  });
  render(
    <TextProvider locale={locale} messages={(locale === "de" ? de : en) as unknown as Messages} timeZone="UTC">
      <Frame host={host} />
    </TextProvider>,
  );
  await settle();
  return list;
}

const liveSection = (title = en.trash.liveHead) => screen.getByRole("region", { name: title });
const listRows = () => within(liveSection()).queryAllByRole("option");
const liveNames = () => listRows().map((row) => row.getAttribute("aria-label")?.match(/Live \d+/)?.[0]);
const liveSheet = () => screen.queryByRole("dialog", { name: "Reading" });

describe("the live section's states", () => {
  it("ROWS: every live row is listed, with where it is named on it", async () => {
    await mount({ live: async () => page({ items: [liveRow(2), liveRow(1)] }) });
    expect(within(liveSection()).getByRole("heading", { name: new RegExp(en.trash.liveHead) })).toBeTruthy();
    expect(liveNames()).toEqual(["Live 2", "Live 1"]);
    for (const row of listRows()) expect(row.textContent).toContain(en.trash.liveOrigin);
    expect(liveSection().textContent).not.toContain(en.trash.liveEmpty);
  });

  it("ROWS: newest first by the message's own date, whatever order the page arrived in", async () => {
    await mount({ live: async () => page({ items: [liveRow(1), liveRow(3), liveRow(2)] }) });
    expect(liveNames()).toEqual(["Live 3", "Live 2", "Live 1"]);
  });

  it("UNAVAILABLE: no Trash folder on the server is said, not shown as an empty folder", async () => {
    await mount({ live: async () => page({ mailboxes: [{ ...okBox, window: "no_trash_folder" }] }) });
    expect(liveSection().textContent).toContain(en.trash.liveUnavailable);
    expect(liveSection().textContent).not.toContain(en.trash.liveEmpty);
    expect(listRows()).toHaveLength(0);
  });

  it("READ-LIMITED: a read the server did not finish says so, and never says empty", async () => {
    await mount({ live: async () => page({ mailboxes: [{ ...okBox, window: "unreachable" }] }) });
    expect(liveSection().textContent).toContain(en.trash.liveReadLimited);
    expect(liveSection().textContent).not.toContain(en.trash.liveEmpty);
    expect(liveSection().textContent).not.toContain(en.trash.liveUnavailable);
  });

  it("a per-mailbox degrade is named under whatever DID load", async () => {
    await mount({ live: async () => page({
      items: [liveRow(1)],
      mailboxes: [okBox, { id: "mb2", address: "other@example.invalid", window: "unreachable" }],
    }) });
    expect(listRows()).toHaveLength(1);
    expect(liveSection().textContent).toContain("other@example.invalid");
  });

  it("SHOW OLDER is a press, and it is the only way the section pages", async () => {
    const list = await mount({
      live: async (opts) => opts?.cursor === "c1"
        ? page({ items: [liveRow(1)] })
        : page({ items: [liveRow(2)], nextCursor: "c1" }),
    });
    expect(list?.mock.calls).toEqual([[]]);
    fireEvent.click(within(liveSection()).getByRole("button", { name: en.trash.liveOlder }));
    await settle();
    expect(list?.mock.calls).toEqual([[], [{ cursor: "c1" }]]);
    expect(liveNames()).toEqual(["Live 2", "Live 1"]);
  });
});

describe("a failing live read", () => {
  it("says so in its own section and leaves the mirrored list exactly as it was", async () => {
    const list = await mount({
      rows: [mirrored("m1"), mirrored("m2")],
      live: async () => { throw new Error("mail server unavailable"); },
    });
    const rows = within(screen.getByRole("listbox", { name: en.trash.title })).getAllByRole("option");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Mirrored m1"),
      expect.stringContaining("Mirrored m2"),
    ]);
    for (const row of rows) expect(row.textContent).toContain("← News");
    expect(liveSection().textContent).toContain(en.trash.liveFailed);
    expect(liveSection().textContent).not.toContain(en.trash.liveEmpty);
    expect(list?.mock.calls).toEqual([[]]);
    fireEvent.click(within(liveSection()).getByRole("button", { name: en.trash.liveRetry }));
    await settle();
    expect(list?.mock.calls).toEqual([[], []]);
    expect(document.body.textContent).toContain(en.trash.footLive);
  });

  it("and the mirrored section's own unavailable state does not hide the live one", async () => {
    await mount({ mirroredAvailable: false, live: async () => page({ items: [liveRow(1)] }) });
    expect(document.body.textContent).toContain(en.trash.unavailable);
    expect(listRows()).toHaveLength(1);
  });
});

describe("without a live window", () => {
  it("the view is what it was, and the foot names the mirror alone", async () => {
    await mount({ rows: [mirrored("m1")] });
    expect(screen.queryByRole("region", { name: en.trash.liveHead })).toBeNull();
    expect(document.body.textContent).toContain(en.trash.foot);
    expect(document.body.textContent).not.toContain(en.trash.footLive);
  });

  it("and with one, the foot says both populations and that the second is read-only", async () => {
    await mount({ rows: [mirrored("m1")], live: async () => page() });
    expect(document.body.textContent).toContain(en.trash.footLive);
  });
});

describe("in German", () => {
  it("renders the section, its heading and its states from the same keys", async () => {
    await mount({ rows: [mirrored("m1")], live: async () => page({ items: [liveRow(1)] }), locale: "de" });
    const section = liveSection(de.trash.liveHead);
    expect(section.textContent).toContain(de.trash.liveHead);
    expect(section.textContent).toContain(de.trash.liveOrigin);
    expect(document.body.textContent).toContain(de.trash.footLive);
  });
});

describe("a live row at phone width opens in Trash's own sheet", () => {
  it("the press opens the sheet with the live read, and Escape closes it", async () => {
    await mount({ live: async () => page({ items: [liveRow(1)] }), viewport: "phone" });
    expect(liveSheet()).toBeNull();
    fireEvent.click(within(liveSection()).getByRole("option", { name: /Live 1/ }));
    await settle();
    expect(liveSheet()?.textContent).toContain(body.text);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await settle();
    expect(liveSheet()).toBeNull();
  });

  it("control: at a desktop width the column reads it and no sheet opens", async () => {
    await mount({ live: async () => page({ items: [liveRow(1)] }) });
    fireEvent.click(within(liveSection()).getByRole("option", { name: /Live 1/ }));
    await settle();
    expect(liveSheet()).toBeNull();
    expect(screen.getByRole("region", { name: "Reading" }).textContent).toContain(body.text);
  });
});
