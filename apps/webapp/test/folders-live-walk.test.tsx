/** @vitest-environment jsdom */
import { getByRole, getByTitle, queryByRole, within } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ISO, act, answerConsentWith, answerSyncWith, installShellEnv, mailbox, mountShell,
  teardownShellEnv, textOf, tick,
} from "./fixtures/live-walk-shell";

/**
 * FOLDERS, WALKED THROUGH THE SHIPPED SHELL — the foundation stage end to end
 * (FOLDERS-SPEC.md; owner decisions 1, 3 and 7):
 *
 *  1. FLAG OFF IS TODAY, RENDERED: an account whose `/sync` already carries `folder` entities
 *     (a mirror that heard them before the flag went off) still shows the pre-feature rail —
 *     no Folders group, nothing to collapse. The flag is the authority; entities are data.
 *  2. FLAG ON: the rail grows the Folders group under Tags, with the folder and its unread
 *     count; pressing the row routes to `#/folder/<id>` and the view lists the folder's mail
 *     in the standard New / Earlier grouping, read in place.
 *  3. HISTORY IS A LENS: an old, read message from an unscreened sender that lives in a user
 *     folder appears in History wearing its folder as the place badge — and it is still in its
 *     folder's own list, because a lens never empties the place it looks at.
 */

const message = (
  o: {
    id: string; from: string; folder?: string; date?: string; unread?: boolean;
    subject?: string;
  },
  seq: number,
) => ({
  type: "message", op: "create", id: o.id, seq, updatedAt: o.date ?? ISO,
  entity: {
    id: o.id, accountId: "acct_live_1", mailboxId: "mb_1",
    threadId: null, messageIdHeader: null,
    subject: o.subject ?? `subject of ${o.id}`,
    from: { name: `Sender ${o.id}`, address: o.from },
    to: [], cc: [], date: o.date ?? ISO, folder: o.folder ?? "INBOX",
    snippet: `snippet of ${o.id}`, unread: o.unread ?? false,
    hasAttachments: false, attachmentCount: 0, sensitivity: {},
    triage: null, labels: [], remoteContent: "none", updatedAt: o.date ?? ISO,
  },
});

const folderEntity = (id: string, name: string, seq: number) => ({
  type: "folder", op: "create", id, seq, updatedAt: ISO,
  entity: { id, name, mailboxId: "mb_1", mailbox: "live@example.invalid", updatedAt: ISO },
});

/** Comfortably before the 60-day window measured from the fixture clock. */
const OLD = "2024-03-02T09:00:00.000Z";

const world = (): Response =>
  new Response(
    JSON.stringify({
      changes: {
        creates: [
          folderEntity("fd1", "Projects/Acme", 1),
          // Recent, unread, folder-filed: the rail badge's source.
          message({ id: "fm-new", from: "acme@example.invalid", folder: "Projects/Acme", unread: true }, 2),
          // Old + read + unscreened: the History lens row.
          message({ id: "fm-old", from: "acme@example.invalid", folder: "Projects/Acme", date: OLD }, 3),
          // An ordinary Ohbox arrival, so the shell has a pile to stand on.
          message({ id: "inbox-1", from: "acme@example.invalid" }, 4),
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
});
afterEach(async () => {
  await teardownShellEnv();
});

const goHash = async (hash: string): Promise<void> => {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new Event("hashchange"));
    await Promise.resolve();
  });
  await tick(0);
};

describe("flag off — the pre-feature rail, rendered", () => {
  it("folder entities in the mirror grow NO rail group while the flag is off", async () => {
    answerSyncWith(world);
    const el = await mountShell([mailbox()]);
    await tick(30_000);
    expect(queryByRole(el, "button", { name: "Folders" })).toBeNull();
    expect(queryByRole(el, "button", { name: /^Acme/ })).toBeNull();
    // A deep link cannot open a Folder when consent is off.
    await goHash("#/folder/fd1");
    expect(queryByRole(el, "heading", { name: "Acme" })).toBeNull();
  });
});

describe("flag on — the rail group, the view, the lens", () => {
  beforeEach(() => {
    answerConsentWith({ foldersEnabledAt: ISO });
    answerSyncWith(world);
  });

  it("the rail grows Folders under Tags, badged; the row opens the folder's own list", async () => {
    const el = await mountShell([mailbox()]);
    await tick(30_000);

    const tags = getByRole(el, "button", { name: "Tags" });
    const folders = getByRole(el, "button", { name: "Folders" });
    expect(tags.compareDocumentPosition(folders) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const row = getByRole(el, "button", { name: "Acme, 1 unread" });
    expect(textOf(row)).toContain("1");

    await act(async () => { row.click(); });
    await tick(0);
    expect(window.location.hash).toBe("#/folder/fd1");
    expect(getByRole(el, "heading", { name: "Acme" })).toBeDefined();
    expect(getByTitle(el, /Projects \/ Acme$/)).toBeDefined();
    const fresh = getByRole(el, "region", { name: "New" });
    const earlier = getByRole(el, "region", { name: "Earlier" });
    expect(within(fresh).getByRole("option", { name: /subject of fm-new/ })).toBeDefined();
    expect(within(earlier).getByRole("option", { name: /subject of fm-old/ })).toBeDefined();
  });

  it("History shows the folder-filed old read mail, badged with its folder — and the folder keeps it", async () => {
    const el = await mountShell([mailbox()]);
    await tick(30_000);

    await goHash("#/history");
    const history = getByRole(el, "listbox", { name: "History" });
    const row = within(history).getByRole("option", { name: /subject of fm-old/ });

    // The lens never empties the place it looks at: the folder's list still holds the row.
    await goHash("#/folder/fd1");
    expect(within(getByRole(el, "region", { name: "Earlier" }))
      .getByRole("option", { name: /subject of fm-old/ })).toBeDefined();
    expect(textOf(row)).toContain("Projects/Acme");
  });
});
