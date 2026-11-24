/** @vitest-environment jsdom */
import { fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ISO, act, answerConsentWith, answerSyncWith, installShellEnv, mailbox, mountShell,
  teardownShellEnv, tick,
} from "./fixtures/live-walk-shell";
import en from "../messages/en.json";

const message = (
  o: { id: string; from: string; folder?: string; date?: string; unread?: boolean;
       labels?: string[] },
  seq: number,
) => ({
  type: "message", op: "create", id: o.id, seq, updatedAt: o.date ?? ISO,
  entity: {
    id: o.id, accountId: "acct_live_1", mailboxId: "mb_1",
    threadId: null, messageIdHeader: null,
    subject: `subject of ${o.id}`,
    from: { name: `Sender ${o.id}`, address: o.from },
    to: [], cc: [], date: o.date ?? ISO, folder: o.folder ?? "INBOX",
    snippet: `snippet of ${o.id}`, unread: o.unread ?? false,
    hasAttachments: false, attachmentCount: 0, sensitivity: {},
    triage: null, labels: o.labels ?? [], remoteContent: "none", updatedAt: o.date ?? ISO,
  },
});

const folderEntity = (id: string, name: string, seq: number) => ({
  type: "folder", op: "create", id, seq, updatedAt: ISO,
  entity: { id, name, mailboxId: "mb_1", mailbox: "live@example.invalid", updatedAt: ISO },
});

const tagEntity = (id: string, name: string, seq: number) => ({
  type: "tag", op: "create", id, seq, updatedAt: ISO,
  entity: { id, name, hue: "blue", createdAt: ISO, updatedAt: ISO },
});

/** Comfortably past the History window measured from the fixture clock. */
const OLD = "2024-03-02T09:00:00.000Z";

const world = (): Response =>
  new Response(
    JSON.stringify({
      changes: {
        creates: [
          folderEntity("fd1", "Projects/Acme", 1),
          tagEntity("tg1", "Invoices", 2),
          // In the folder, and tagged — one message reachable from Folder and from Tag.
          message({
            id: "sv-1", from: "acme@example.invalid", folder: "Projects/Acme", labels: ["tg1"],
          }, 3),
          // Old, read, and from a sender who has NOT written since — History is "mail from
          // people you never screened, who haven't written in a while", so the quiet sender has
          // to be a different one from the folder's or their recent arrival disqualifies it.
          message({ id: "sv-old", from: "quiet@example.invalid", date: OLD }, 4),
          // An ordinary arrival so the shell has a pile to stand on.
          message({ id: "inbox-1", from: "acme@example.invalid" }, 5),
        ],
        updates: [], moves: [], deletes: [],
      },
      cursor: "c1", hasMore: false, serverTime: ISO,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

beforeEach(() => {
  installShellEnv();
  window.localStorage.clear();
  /* The Folders RAIL's gate — the Folder view below is reachable only with it on. It is no
     longer `d`'s gate; the folders-off describe at the bottom of this file is that control. */
  answerConsentWith({ foldersEnabledAt: ISO });
  answerSyncWith(world);
});
afterEach(async () => { await teardownShellEnv(); });

const goHash = async (hash: string): Promise<void> => {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new Event("hashchange"));
    await Promise.resolve();
  });
  await tick(0);
};

const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }),
    );
  });
  await tick(0);
};

const VIEWS = [
  { name: "Folder", hash: "#/folder/fd1", subject: "subject of sv-1" },
  { name: "Tag", hash: "#/tag/tg1", subject: "subject of sv-1" },
  { name: "History", hash: "#/history", subject: "subject of sv-old" },
];

async function openLetter(view: (typeof VIEWS)[number]) {
  const shell = await mountShell([mailbox()]);
  await tick(30_000);
  await goHash(view.hash);
  const queries = within(shell);
  const row = queries.getByRole("option", { name: new RegExp(view.subject) });
  await act(async () => { fireEvent.click(row); });
  await tick(100);
  expect(queries.getByRole("region", { name: "Reading" }).textContent).toContain(view.subject);
  return queries;
}

async function advertised(queries: Awaited<ReturnType<typeof openLetter>>, label: string, cap: string) {
  await key("?");
  const sheet = within(queries.getByRole("dialog", { name: en.shortcuts.title }));
  const group = sheet.getByRole("heading", { name: en.shortcuts.group.message });
  const rows: Element[] = [];
  for (let row = group.nextElementSibling; row?.tagName === "P"; row = row.nextElementSibling) rows.push(row);
  const matching = rows.filter((row) => within(row as HTMLElement).queryByText(label) !== null);
  expect(matching).toHaveLength(1);
  expect(matching[0]!.querySelector("kbd")?.textContent).toBe(cap);
  await key("Escape");
}

const outgoingDeletes = () => vi.mocked(fetch).mock.calls.filter(([input, init]) => {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const url = input instanceof Request ? input.url : String(input);
  return method === "DELETE" && /\/messages\//.test(url);
});

function deleteIsOffered(queries: Awaited<ReturnType<typeof openLetter>>) {
  const more = queries.getByRole("menu", { name: "More" });
  expect(within(more).getByRole("menuitem", { name: "Delete" })).toBeTruthy();
}

describe("a printed keycap acts, in every split view", () => {
  for (const v of VIEWS) {
    describe(v.name, () => {
      it("prints the Move cap AND `m` opens the destination strip on the shown message", async () => {
        const queries = await openLetter(v);
        await advertised(queries, en.reader.key.move, "m");
        expect(queries.queryByRole("menu", { name: "Move" })).toBeNull();
        await key("m");
        expect(queries.getByRole("menu", { name: "Move" })).toBeTruthy();
      }, 30_000);

      it("prints the Delete cap AND `d` opens the ask — never deleting on one press", async () => {
        const queries = await openLetter(v);
        await advertised(queries, en.reader.key.deleteAsk, "d");
        expect(queries.queryByRole("menu", { name: "More" })).toBeNull();
        const writesBefore = outgoingDeletes();
        await key("d");
        deleteIsOffered(queries);
        await tick(30_000);
        expect(outgoingDeletes()).toEqual(writesBefore);
      }, 30_000);

      it("a HELD `d` cannot walk the ceremony — repeat is not a second press", async () => {
        const queries = await openLetter(v);
        const writesBefore = outgoingDeletes();
        await key("d");
        deleteIsOffered(queries);
        await key("d", { repeat: true });
        await tick(30_000);
        deleteIsOffered(queries);
        expect(outgoingDeletes()).toEqual(writesBefore);
      }, 30_000);
    });
  }
});

describe("the borrowed delete gate with the folders switch OFF", () => {
  beforeEach(() => { answerConsentWith({ foldersEnabledAt: null }); });

  for (const v of VIEWS.filter((view) => view.name !== "Folder")) {
    it(`${v.name}: \`d\` still opens the ask — never deleting on one press`, async () => {
      const queries = await openLetter(v);
      const writesBefore = outgoingDeletes();
      await key("d");
      deleteIsOffered(queries);
      await tick(30_000);
      expect(outgoingDeletes()).toEqual(writesBefore);
    }, 30_000);
  }

  it("Folder is unreachable with the flag off — the foundation it DOES need", async () => {
    const shell = await mountShell([mailbox()]);
    await tick(30_000);
    await goHash("#/folder/fd1");
    const queries = within(shell);
    expect(queries.queryByRole("button", { name: "Acme" })).toBeNull();
    expect(queries.queryByRole("option", { name: /subject of sv-1/ })).toBeNull();
  }, 30_000);
});
