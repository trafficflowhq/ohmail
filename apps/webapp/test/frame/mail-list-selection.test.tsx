/** @vitest-environment jsdom */
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import words from "../../messages/en.json";
import {
  ACCOUNT, ISO, act, installScreeningWeb, mountScreeningWeb, syncScreeningWeb, teardownScreeningWeb, tick,
} from "../fixtures/screening-web.js";

const from = { name: "Ada", address: ["ada", "sender.example"].join("@") };
const mailboxId = "mailbox";
const cases = [
  { list: "History", hash: "#/history", folder: "INBOX" },
  { list: "Tags", hash: "#/tag/followup", folder: "INBOX" },
  { list: "Folder", hash: "#/folder/projects", folder: "Projects" },
  { list: "Search", hash: "#/search", folder: "INBOX" },
  { list: "News", hash: "#/reads", folder: "ohmail/News" },
  { list: "Receipts", hash: "#/receipts", folder: "ohmail/Receipts" },
  { list: "Answer Later", hash: "#/triage", folder: "INBOX", state: "reply_later" },
  { list: "Parked", hash: "#/triage/aside", folder: "INBOX", state: "set_aside" },
  { list: "Resurface", hash: "#/triage/resurface", folder: "INBOX", state: "bubbled_up" },
  { list: "Screener", hash: "#/screener", folder: "ohmail/Screener" },
  { list: "Trash", hash: "#/trash", folder: "Trash" },
] as const;

const change = (type: string, id: string, entity: object, seq: number) => ({
  type, id, entity, seq, op: "create", updatedAt: ISO,
});

const reply = (data: unknown) => Response.json(data, { headers: { "X-Ohmail-Account": ACCOUNT } });

async function mount(width: number, place: (typeof cases)[number]) {
  const ids = ["first", "second"];
  const shown = place.list === "Screener" ? [...ids, "other"] : ids;
  const letters = shown.map((id, index) => ({
    id, accountId: ACCOUNT, mailboxId, threadId: null, messageIdHeader: null,
    subject: `Pottery ${id}`, from: place.list === "Screener"
      ? { name: id, address: [id, "sender.example"].join("@") }
      : from, to: [], cc: [], date: new Date(Date.parse(ISO) - index * 86_400_000).toISOString(), folder: place.folder,
    unread: true, placeDecided: place.list !== "Screener", updatedAt: ISO, snippet: "Kiln", labels: ["followup"],
    hasAttachments: false, attachmentCount: 0, sensitivity: {}, remoteContent: "none",
    triage: "state" in place ? {
      messageId: id, state: place.state, setAt: ISO, updatedAt: ISO, bubbleUpAt: "2026-09-06T12:00:00.000Z",
    } : null,
    trashedAt: ISO, restoreTo: "INBOX",
  }));
  const touched = new Set<string>();
  const deleted = place.list === "Trash";
  let listedTrash = false;
  installScreeningWeb(deleted ? "#/ohbox" : place.hash, (path, query, method, init) => {
    const restore = /^\/api\/messages\/([^/]+)\/restore$/.exec(path);
    if (method === "POST" && restore) {
      touched.add(restore[1]!);
      return reply({ restoreTo: "INBOX", pending: false });
    }
    if (method === "POST" && path.startsWith("/api/rules")) {
      const body = JSON.parse(String(init?.body)) as { match: string };
      touched.add(body.match.split("@")[0]!);
      return reply({ ...body, id: body.match.split("@")[0] });
    }
    if (method === "PATCH" && path === "/api/messages") {
      const body = JSON.parse(String(init?.body)) as { ids: string[]; unread: boolean };
      if (!body.unread) for (const id of body.ids) touched.add(id);
      return reply({});
    }
    if (path === "/api/mailboxes") return reply({ items: [{
      id: mailboxId, address: from.address, status: "connected", organizerRole: "organizer",
      organizerChecked: true, createdAt: ISO, lastSyncAt: ISO, organizeConsentedAt: ISO,
    }] });
    if (path === "/api/messages" && query.get("view") === "trash") {
      listedTrash = true;
      return reply({ items: deleted ? letters : [], nextCursor: null });
    }
    if (path === "/api/search") return reply({ items: letters, total: letters.length, totalExact: true });
    if (path === "/api/trash/window") return reply({ items: [], mailboxes: [], nextCursor: null });
    if (path === "/api/sync") {
      if (query.get("types") === "rule") return syncScreeningWeb(place.list === "Screener" ? [] : [
        change("rule", "ada", { id: "ada", kind: "sender", match: from.address,
          destination: place.folder === "Trash" ? "INBOX" : place.folder, enabled: true, createdAt: ISO }, 1),
      ], 1);
      return syncScreeningWeb([
        change("folder", "projects", { id: "projects", name: "Projects", mailboxId, updatedAt: ISO }, 2),
        change("tag", "followup", { id: "followup", name: "Follow up", hue: "blue", createdAt: ISO, updatedAt: ISO }, 3),
        ...(!deleted ? letters.map((letter, index) => change("message", letter.id, letter, index + 4)) : []),
      ], 3 + letters.length);
    }
    return undefined;
  }, true);
  vi.stubGlobal("innerWidth", width);
  await mountScreeningWeb();
  await tick(4500);
  if (deleted) {
    await act(async () => {
      window.location.hash = place.hash;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await tick(1500);
    expect(listedTrash, "the Trash page was read").toBe(true);
  }
  if (place.list === "Search") {
    const field = screen.getByRole("textbox", { name: words.search.aria });
    await act(async () => {
      fireEvent.change(field, { target: { value: "Pottery" } });
    });
    await tick(1500);
  }
  touched.clear();
  return { touched, ids };
}

it("returns from a phone Trash reader to its list", async () => {
  try {
    await mount(390, cases.find(({ list }) => list === "Trash")!);
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: /Pottery first/ }));
    });
    await tick(500);
    expect(window.location.hash).toMatch(/^#\/trash\/m\//);
    const reader = within(screen.getByRole("region", { name: "Pottery first" }));
    await act(async () => { fireEvent.click(reader.getByRole("button", { name: "Trash" })); });
    await tick(500);
    expect(window.location.hash).toBe("#/trash");
    expect(screen.getByRole("option", { name: /Pottery first/ })).toBeTruthy();
  } finally {
    await teardownScreeningWeb();
  }
}, 30_000);

describe.each([1440, 390])("mail lists at %i pixels wide", (width) => {
  const rows = cases.filter(({ list }) => width !== 390 || (list !== "News" && list !== "Receipts"));

  it.each(rows)("$list applies its action to the two selected rows", async (place) => {
    try {
      const { touched, ids } = await mount(width, place);
      const rowFor = (id: string) => {
        const name = new RegExp(`Pottery ${id}`);
        return place.list === "Search"
          ? within(screen.getByRole("list", { name: words.search.aria })).getByRole("button", { name })
          : screen.getByRole("option", { name });
      };
      const circle = (id: string) => {
        const row = rowFor(id);
        return within(row.closest<HTMLElement>(".oh-row-slot") ?? row.parentElement!).getByRole("button", { name: words.ohbox.keyPick });
      };
      const secondRow = () => within(rowFor(ids[1]!));
      const initial = place.list === "Screener" ? "S" : "A";
      const avatar = secondRow().getByText(initial, { exact: true });
      await act(async () => { fireEvent.click(circle(ids[0]!)); });
      expect(secondRow().queryByText(initial, { exact: true })).toBe(avatar);
      await act(async () => { fireEvent.click(circle(ids[1]!), { shiftKey: true }); });
      const bar = within(screen.getByRole("toolbar", { name: words.ohbox.bar.label }));
      expect(bar.getByRole("button", { name: /^2 selected/ })).toBeTruthy();
      const actions = place.list === "Trash"
        ? [words.trash.restore]
        : place.list === "Screener"
          ? [words.screener.pileOhbox, words.screener.pileReads, words.screener.pileReceipts, words.screener.pileScreenOut]
          : [words.ohbox.actionRead, words.ohbox.pickedMarkUnseen, words.ohbox.actionMove,
              words.ohbox.actionTag, words.ohbox.actionLater, words.ohbox.actionDelete,
              ...(place.list === "Resurface" ? [words.ohbox.actionDone] : [])];
      for (const action of actions) expect(bar.getByRole("button", { name: action })).toBeTruthy();
      const name = place.list === "Trash" ? words.trash.restore
        : place.list === "Screener" ? words.screener.pileScreenOut : words.ohbox.actionRead;
      await act(async () => { fireEvent.click(bar.getByRole("button", { name })); });
      if (place.list === "Screener") {
        expect([...touched]).toEqual([]);
        const confirm = within(screen.getByRole("dialog", { name: "Screen out 2 senders?" }));
        await act(async () => { fireEvent.click(confirm.getByRole("button", { name })); });
        await tick(8000);
        expect(screen.queryByRole("option", { name: /Pottery first/ })).toBeNull();
        expect(screen.queryByRole("option", { name: /Pottery second/ })).toBeNull();
        expect(screen.getByRole("option", { name: /Pottery other/ })).toBeTruthy();
      } else {
        await tick(8000);
        expect([...touched].sort()).toEqual(ids);
      }
    } finally {
      await teardownScreeningWeb();
    }
  }, 30_000);

  if (width === 390) {
    it.each(cases.filter(({ list }) => list === "News" || list === "Receipts"))(
      "$list shows the stream in place of its list rows",
      async (place) => {
        try {
          await mount(width, place);
          expect(screen.getAllByText("Pottery first").length).toBeGreaterThan(0);
          expect(screen.queryByRole("option", { name: /Pottery first/ })).toBeNull();
        } finally {
          await teardownScreeningWeb();
        }
      },
    );
  }
});
