/** @vitest-environment jsdom */
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OhmailEngine, type EngineAdapter, type SyncChange } from "@ohmail/client-engine";
import type { EngineMessage } from "@ohmail/wire";
import { act, message, mountShell, NOW, press, storeWith, stubDom, unmountAll, waitFor } from "../_draft-shell.js";
import { mountSeat, unmountSeat } from "../_ohbox-1-seat.js";
import { typeInto } from "../fixtures/rich-editor-driver";

beforeEach(() => {
  stubDom();
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
});
afterEach(async () => {
  unmountSeat();
  await unmountAll();
  vi.restoreAllMocks();
});

it("an older Screener hit opens that held letter within Search", async () => {
  const common = {folder:"ohmail/Screener", unread:true} as const;
  const before = message("found-earlier", {...common, subject:"Unique ceramic invoice", date:"2026-09-25T08:00:00Z"});
  const after = message("newest", {...common,subject:"A different newer subject", date:"2026-09-27T08:00:00Z"});
  await mountShell("#/search",[before,after]);
  const field = await screen.findByRole("textbox", { name: "Search" });
  await act(async () => { fireEvent.change(field, {target: {value:"ceramic"}}); });
  const row = () => document.querySelector<HTMLElement>('[data-hit="found-earlier"]');
  await waitFor(() => row() !== null, "the older held letter in Search");
  await act(async () => { within(row()!).getAllByRole("button")[0]!.click(); });
  await waitFor(() => window.location.hash === "#/search/m/found-earlier?q=ceramic", "the held result in Search");
  const reading = screen.getByRole("region", { name: "Reading" });
  expect(reading.querySelector('[data-conv-id="found-earlier"]')).not.toBeNull();
  expect(reading.querySelector('[data-conv-id="newest"]')).toBeNull();
  expect(row()?.querySelector(".oh-row[data-open]")).not.toBeNull();
}, 60_000);

it("holds the Search reader filing controls after the reply it sent is confirmed", async () => {
  const source = message("source", { subject: "Kiln delivery", threadId: "shared", unread: false });
  const s = await mountShell("#/search/m/source?q=kiln", [source]);
  const pane = within(await within(s.el).findByRole("region", { name: "Open message" }));
  await press(pane.getByRole("button", { name: "Reply" }), "Reply");
  const editor = await pane.findByRole("textbox", { name: "Reply body" });
  await act(async () => {
    typeInto(editor, "The clay is ready.");
  });
  const send = pane.getByRole("button", { name: "Send" });
  await waitFor(() => send.getAttribute("aria-disabled") !== "true", "Send is ready");
  Object.assign(s.sentCopy, { providerMessageId: "<confirmed-copy>" });
  await press(send, "Send");
  await waitFor(
    () =>
      s.engine
        .read()
        .list<{ local?: boolean }>("message")
        .some((m) => m.local === true),
    "the confirmed provisional Sent row",
  );
  await waitFor(
    () => pane.queryByRole("textbox", { name: "Reply body" }) === null,
    "the reply editor closes",
  );
  const park = pane.getByRole<HTMLButtonElement>("button", { name: "Park" });
  const later = pane.getByRole<HTMLButtonElement>("button", { name: "Later" });
  const snapshot = {
    parkDisabled: park.disabled,
    laterDisabled: later.disabled,
    sending: pane.queryByText("Sending…") !== null,
  };
  await press(park, "Park");
  expect({
    ...snapshot,
    writes: s.sent.flatMap((m) => (m.kind === "triage_set" ? [m.messageId] : [])),
  }).toEqual({ parkDisabled: true, laterDisabled: true, sending: true, writes: [] });
}, 20_000);

it.each([false, true])("restores Park and Later on the selected Search reply after sync (restart: %s)", async (restart) => {
  const source = message("source", { subject: "Kiln delivery", threadId: "shared", unread: false });
  const header = "<confirmed-copy>";
  const store = await storeWith([source], []);
  const remote: SyncChange[] = [];
  const adapter = {
    mutate: async () => ({ changes: [], seq: null, providerMessageId: header }),
    sync: async () => ({
      changes: { creates: remote.splice(0), updates: [], moves: [], deletes: [] },
      cursor: "mailbox-cursor", hasMore: false, serverTime: NOW.toISOString(),
    }),
  } as unknown as EngineAdapter;
  const before = new OhmailEngine({ adapter, store, now: () => NOW });
  const after = restart ? new OhmailEngine({ adapter, store, now: () => NOW }) : before;
  try {
    await before.start();
    expect((await before.mutate({ kind: "mail_send", inReplyTo: source.id, body: "The clay is ready." })).status)
      .toBe("confirmed");
    const provisional = before.read().list<EngineMessage>("message").find((m) => m.local === true)!;
    const address = `#/search/m/${provisional.id}?q=kiln`;
    const park = (root: HTMLElement) => within(root).queryByRole<HTMLButtonElement>("button", { name: "Park" });
    let view = mountSeat(before, { first: address });
    await waitFor(() => park(view.container)?.disabled === true, "Park held before sync", 32);
    // Finish the send's background drain before offering the mailbox copy on the next one.
    await act(async () => { await before.syncOnce(); });
    if (restart) {
      unmountSeat();
      before.dispose();
      await after.hydrate();
      view = mountSeat(after, { first: address });
      await waitFor(() => park(view.container)?.disabled === true, "Park held after reload", 32);
    }
    expect(within(view.container).getByText("Sending…")).toBeTruthy();
    const stored = message("mailbox-copy", {
      subject: "Re: Kiln delivery", threadId: "shared", folder: "Sent" as EngineMessage["folder"], messageIdHeader: header,
    });
    remote.push({
      type: "message", op: "create", id: stored.id, entity: stored, seq: store.maxSeq() + 1, updatedAt: stored.updatedAt,
    });
    await act(async () => { await after.syncOnce(); });
    expect(after.read().get<EngineMessage>("message", stored.id)?.id).toBe(stored.id);
    await waitFor(() => park(view.container)?.disabled === false, "Park released on the mailbox copy", 32);
    expect(within(view.container).getByRole<HTMLButtonElement>("button", { name: "Later" }).disabled).toBe(false);
    expect(view.address.read()).toBe("#/search/m/mailbox-copy?q=kiln");
  } finally {
    unmountSeat();
    before.dispose();
    after.dispose();
  }
}, 8_000);

it("holds filing after replying from a News item with no conversation ID", async () => {
  const source = message("workshop", { folder: "ohmail/News", subject: "Workshop notes", threadId: null, unread: false });
  const s = await mountShell("#/reads", [source]);
  const news = within(s.el).getByRole("region", { name: "News stream" });
  const pane = within(news);
  await press(pane.getByRole("heading", { name: "Workshop notes" }), "the News letter");
  await press(pane.getByRole("button", { name: "Reply" }), "Reply to the News letter");
  const editor = await pane.findByRole("textbox", { name: "Reply body" });
  await act(async () => { typeInto(editor, "This is my reply."); });
  await waitFor(() => pane.getByRole("button", { name: "Send" }).getAttribute("aria-disabled") !== "true", "Send is ready", 32);
  const send = pane.getByRole("button", { name: "Send" });
  Object.assign(s.sentCopy, { providerMessageId: "<confirmed-copy>" });
  await press(send, "Send");
  await waitFor(
    () => s.engine.read().list<{ local?: boolean }>("message").some((m) => m.local === true),
    "the confirmed provisional Sent row", 32,
  );
  await waitFor(() => pane.queryByRole("textbox", { name: "Reply body" }) === null, "the reply editor closes", 32);
  expect({
    laterDisabled: pane.getByRole<HTMLButtonElement>("button", { name: "Later" }).disabled,
    sending: pane.queryByText("Sending…") !== null,
  }).toEqual({ laterDisabled: true, sending: true });
}, 20_000);

it("keeps the sending Search reader held when it reloads before the mailbox copy", async () => {
  const source = message("source", { subject: "Kiln delivery", threadId: "shared", unread: false });
  const address = "#/search/m/source?q=kiln";
  const before = await mountShell(address, [source]);
  const pane = within(await within(before.el).findByRole("region", { name: "Open message" }));
  await press(pane.getByRole("button", { name: "Reply" }), "Reply");
  const editor = await pane.findByRole("textbox", { name: "Reply body" });
  await act(async () => { typeInto(editor, "The clay is ready."); });
  const send = pane.getByRole("button", { name: "Send" });
  await waitFor(() => send.getAttribute("aria-disabled") !== "true", "Send is ready", 32);
  Object.assign(before.sentCopy, { providerMessageId: "<confirmed-copy>" });
  await press(send, "Send");
  await waitFor(() => pane.queryByRole("textbox", { name: "Reply body" }) === null, "the editor closes", 32);
  await waitFor(() => pane.queryByText("Sending…") !== null, "the sending reader is held", 32);
  expect(pane.getByRole<HTMLButtonElement>("button", { name: "Park" }).disabled).toBe(true);
  await act(async () => { await before.engine.syncOnce(); });
  const remote: SyncChange[] = [];
  const after = new OhmailEngine({
    store: before.store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: remote.splice(0), updates: [], moves: [], deletes: [] },
        cursor: "after-reload", hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async () => ({ changes: [], seq: null }),
      fetchBody: async () => null,
      withdrawSend: async () => ({ outcome: "unsupported" }),
    },
  });
  try {
    await unmountAll();
    before.engine.dispose();
    stubDom();
    await after.hydrate();
    const view = mountSeat(after, { first: address });
    const next = within(await within(view.container).findByRole("region", { name: "Open message" }));
    expect({
      parkDisabled: next.getByRole<HTMLButtonElement>("button", { name: "Park" }).disabled,
      laterDisabled: next.getByRole<HTMLButtonElement>("button", { name: "Later" }).disabled,
      sending: next.queryByText("Sending…") !== null,
    }).toEqual({ parkDisabled: true, laterDisabled: true, sending: true });
    const copy = message("mailbox-copy", {
      folder: "Sent" as EngineMessage["folder"],
      messageIdHeader: "<confirmed-copy>",
      subject: "Re: Kiln delivery",
    });
    remote.push({
      type: "message", op: "create", id: copy.id, entity: copy, seq: before.store.maxSeq() + 1, updatedAt: copy.updatedAt,
    });
    await act(async () => { await after.syncOnce(); });
    const park = () => next.getByRole<HTMLButtonElement>("button", { name: "Park" });
    await waitFor(() => !park().disabled, "Park restored on the original", 32);
    expect(next.getByRole<HTMLButtonElement>("button", { name: "Later" }).disabled).toBe(false);
    expect(next.queryByText("Sending…")).toBeNull();
    expect(view.address.read()).toBe(address);
    expect(next.getByRole("heading", { name: source.subject })).toBeTruthy();
  } finally {
    before.engine.dispose();
    after.dispose();
  }
}, 20_000);

it.each(["t", "m"])("holds Park and Later when a conversation reply targets another member (%s)", async (scope) => {
  const source = message("source", { subject: "Kiln delivery", threadId: "shared", unread: false });
  const latest = message("latest", {
    subject: "Re: Kiln delivery", threadId: "shared", unread: false,
    date: new Date(Date.parse(source.date!) + 1000).toISOString(),
  });
  const s = await mountShell(`#/ohbox/${scope}/source`, [source, latest]);
  const pane = within(await within(s.el).findByRole("region", { name: "Open message" }));
  await press(pane.getByRole("button", { name: "Reply" }), "Reply");
  const editor = await pane.findByRole("textbox", { name: "Reply body" });
  await act(async () => {
    typeInto(editor, "The clay is ready.");
  });
  const send = pane.getByRole("button", { name: "Send" });
  await waitFor(() => send.getAttribute("aria-disabled") !== "true", "Send is ready");
  Object.assign(s.sentCopy, { providerMessageId: "<confirmed-copy>" });
  await press(send, "Send");
  await waitFor(
    () =>
      s.engine
        .read()
        .list<{ local?: boolean }>("message")
        .some((m) => m.local === true),
    "the confirmed provisional Sent row",
  );
  await waitFor(
    () => pane.queryByRole("textbox", { name: "Reply body" }) === null,
    "the reply editor closes",
  );
  const park = pane.getByRole<HTMLButtonElement>("button", { name: "Park" });
  const later = pane.getByRole<HTMLButtonElement>("button", { name: "Later" });
  const snapshot = {
    parkDisabled: park.disabled,
    laterDisabled: later.disabled,
    sending: pane.queryByText("Sending…") !== null,
  };
  expect(s.sent.find((m) => m.kind === "mail_send")).toMatchObject({ inReplyTo: latest.id });
  await press(park, "Park");
  expect({
    ...snapshot,
    writes: s.sent.flatMap((m) => (m.kind === "triage_set" ? [m.messageId] : [])),
  }).toEqual({ parkDisabled: true, laterDisabled: true, sending: true, writes: [] });
}, 20_000);
