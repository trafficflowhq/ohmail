/** @vitest-environment jsdom */
/**
 * THE LIST PLACES OVER THE WEB'S REAL ENTRY. `CloudShell` itself is mounted, as the page mounts it, over a session the
 * server confirms; the account uses folders, its mailbox's folders and one letter arrive over `/sync`. Nothing here
 * is a tests' door: what a person presses is the real frame over the real mail ground, and what leaves is read off the
 * browser's own wire.
 *
 * FOLDER's MOVE (an act that is never left red): a letter moved from a folder by its row's menu goes to the folder
 * picked, once, and nowhere else; the folder it is in is not offered.
 */
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetSessionTruthForTests } from "@ohmail/app-logic/session/session-truth";
import { resetStorageOwnerForTest } from "@ohmail/app-logic/storage/storage-owner";
import { UNDO_MS } from "@ohmail/app-logic/press/delete-undo";
import {
  ACCOUNT, act, installConfirmEnv, ISO, mountCloudShell, refresh204, rememberOwner, scriptRefresh, scriptSession,
  scriptSync, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "../fixtures/cloud-confirm-shell";

const SENDER = "potter@example.invalid";
const folder = (id: string, name: string) => ({
  type: "folder", op: "create", id, seq: 1, updatedAt: ISO,
  entity: { id, name, mailboxId: "mb_1", mailbox: "me@example.invalid", updatedAt: ISO },
});
/** One `/sync` page with a tagged letter in Projects/Clay and its sender's rule. */
const PAGE = () =>
  new Response(JSON.stringify({
    changes: {
      creates: [
        folder("f1", "Projects/Clay"),
        folder("f2", "Archive"),
        {
          type: "tag", op: "create", id: "tag_clay", seq: 1, updatedAt: ISO,
          entity: { id: "tag_clay", name: "Pottery", hue: "blue", createdAt: ISO, updatedAt: ISO },
        },
        {
          type: "message", op: "create", id: "m_clay", seq: 2, updatedAt: ISO,
          entity: {
            id: "m_clay", accountId: ACCOUNT, mailboxId: "mb_1", threadId: null, messageIdHeader: null,
            subject: "New glaze", from: { name: "The Potter", address: SENDER },
            to: [], cc: [], date: ISO, folder: "Projects/Clay", snippet: "snippet of New glaze",
            unread: false, hasAttachments: false, attachmentCount: 0, sensitivity: {},
            triage: null, labels: ["tag_clay"], remoteContent: "none", updatedAt: ISO,
          },
        },
        {
          type: "rule", op: "create", id: "rule_potter", seq: 3, updatedAt: ISO,
          entity: {
            id: "rule_potter", kind: "sender", match: SENDER, destination: "INBOX",
            priority: 0, provenance: "manual", enabled: true,
            stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
          },
        },
      ],
      updates: [], moves: [], deletes: [],
    },
    cursor: "c1", hasMore: false, serverTime: ISO,
  }), { status: 200, headers: { "content-type": "application/json" } });

const json = (body: unknown): Response =>
  Response.json(body, { headers: { "X-Ohmail-Account": ACCOUNT } });

/** Every request the page sent with a method other than GET: where to, and its body as the server would read it. */
let wrote: { url: string; method: string; body: string; intent: string | null }[] = [];
const trashed = (id: string, subject: string) => ({
  id, accountId: ACCOUNT, mailboxId: "mb_1", threadId: null, folder: "Trash", subject,
  from: { name: "The Potter", address: SENDER }, to: [], cc: [], date: ISO, updatedAt: ISO,
  unread: false, trashedAt: ISO, restoreTo: "Projects/Clay", labels: [],
});
let trashRows = [trashed("first_deleted", "First deleted letter"), trashed("second_deleted", "Second deleted letter")];

/** The account's answers the fixture's wire does not hold: it uses folders, and its one mailbox at rest. */
function answerFolders(): void {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      wrote.push({ url, method, body: typeof init?.body === "string" ? init.body : "",
        intent: new Headers(init?.headers).get("Idempotency-Key") });
    }
    if (method === "GET" && url.includes("/messages?") && url.includes("view=trash")) {
      return json({ items: trashRows, nextCursor: null });
    }
    const restore = /\/messages\/([^/?]+)\/restore$/.exec(url);
    if (method === "POST" && restore) {
      trashRows = trashRows.filter((letter) => letter.id !== restore[1]);
      return json({ restoreTo: "Projects/Clay", pending: false });
    }
    if (url.includes("/trash/window")) return json({ items: [], mailboxes: [], nextCursor: null });
    if (url.includes("/consent") && (init?.method ?? "GET") === "GET") {
      return json({
        seedConfirmedAt: ISO, screeningResetAt: null, dormancyDays: 60, foldersEnabledAt: ISO,
        counts: { decidedSenders: 1, activeUndecidedSenders: 0, dormantUndecidedSenders: 0 },
      });
    }
    if (url.includes("/mailboxes")) {
      return json({
        items: [{
          id: "mb_1", address: "me@example.invalid", status: "active", errorCode: null, disabledReason: null,
          syncBlockedReason: null, syncBlockedSince: null, lastSyncAt: ISO, junkFolder: "Junk",
          createdAt: ISO,
        }],
      });
    }
    return inner(input as RequestInfo, init);
  }) as typeof globalThis.fetch;
}

const row = (subject: string): HTMLElement | null =>
  screen.queryAllByRole("option").find((r) => (r.textContent ?? "").includes(subject)) ?? null;
/** Each move the page sent, as the server's route reads it: the letter its address names, and the folder asked. */
const moves = (): [string, unknown][] =>
  wrote.flatMap(({ url, body }) => {
    const hit = /\/api\/messages\/([^/?]+)\/move$/.exec(url);
    return hit ? [[decodeURIComponent(hit[1]!), (JSON.parse(body) as { folder?: unknown }).folder] as [string, unknown]] : [];
  });

const rail = (): HTMLElement => screen.getByRole("navigation", { name: "Places" });
/** What the frame's one report slot says now. */
const said = (): string => screen.queryAllByRole("status").map((el) => el.textContent ?? "").join(" ");
const key = async (k: string): Promise<void> => {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }),
    );
  });
  await tick(100);
};
const visit = async (hash: string): Promise<void> => {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await tick(800);
};

beforeAll(warmCloudShell);
beforeEach(() => {
  resetSessionTruthForTests();
  wrote = [];
  trashRows = [trashed("first_deleted", "First deleted letter"), trashed("second_deleted", "Second deleted letter")];
  installConfirmEnv();
  resetStorageOwnerForTest();
  localStorage.clear();
  /* A live session renews: the fixture's default refresh answer is a revocation. */
  scriptRefresh(refresh204);
  answerFolders();
  scriptSession(() => sessionFull());
  scriptSync(PAGE);
  rememberOwner();
});
afterEach(async () => {
  window.history.replaceState(null, "", "/");
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  resetStorageOwnerForTest();
  await teardownConfirmEnv();
});

describe("a folder over the web's real entry", () => {
  it("a row's menu moves its letter into the folder picked: one move, to that folder and nowhere else", async () => {
    window.location.hash = "#/ohbox";
    await mountCloudShell();
    await tick(2500);
    await act(async () => { fireEvent.click(within(rail()).getByRole("button", { name: "Clay" })); });
    await tick(500);
    expect(window.location.hash).toBe("#/folder/f1");
    expect(row("New glaze"), "the folder lists its letter").not.toBeNull();
    await act(async () => {
      fireEvent.contextMenu(row("New glaze")!);
    });
    const menu = screen.getByRole("menu", { name: "Move" });
    /* The folder it is in is not offered. */
    expect(within(menu).queryByRole("menuitem", { name: /Clay/ })).toBeNull();
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: /Archive/ }));
    });
    await tick(1500);
    expect(moves()).toEqual([["m_clay", "Archive"]]);
    expect(said(), "its sentence, in the frame's slot").toContain("Moved to Archive");
  }, 30_000);
});

describe("navigating mail lists from the web app", () => {
  it("a tag opens from the sidebar and a contact leads to the address's mail", async () => {
    window.location.hash = "#/ohbox";
    await mountCloudShell();
    await tick(2500);
    await act(async () => { fireEvent.click(within(rail()).getByRole("button", { name: "Tags", expanded: false })); });
    await act(async () => { fireEvent.click(within(rail()).getByRole("button", { name: "Pottery 1" })); });
    await tick(500);
    expect(window.location.hash).toMatch(/^#\/tag\/tag_clay/);
    expect(row("New glaze")).not.toBeNull();
    const reading = screen.getByRole("region", { name: "Reading" });
    await act(async () => { fireEvent.click(within(reading).getAllByRole("button", { name: /The Potter/ })[0]!); });
    await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "Everything from and to this address" })); });
    await tick(500);
    expect(window.location.hash).toMatch(/^#\/address\//);
    expect(row("New glaze")).not.toBeNull();
    await key("Escape");
    expect(window.location.hash).toMatch(/^#\/tag\/tag_clay/);
  }, 30_000);

  it("Trash restores only the selected letter, with one intent after Undo expires", async () => {
    window.location.hash = "#/ohbox";
    await mountCloudShell();
    await tick(2500);
    expect(within(rail()).queryByRole("button", { name: "Trash" })).toBeNull();
    await key("g");
    await key("t");
    await tick(500);
    expect(within(rail()).getByRole("button", { name: "Trash" }).getAttribute("aria-current")).toBe("page");
    expect(row("First deleted letter")).not.toBeNull();
    await act(async () => { fireEvent.click(row("Second deleted letter")!); });
    await tick(500);
    expect(window.location.hash).toBe("#/trash/m/second_deleted");
    const messageWrites = () => wrote.filter(({ url }) => /\/messages\//.test(url));
    await key("Backspace");
    await key("Delete");
    expect(messageWrites()).toEqual([]);
    expect(row("Second deleted letter")).not.toBeNull();
    const restore = async () => {
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Restore" })); });
      await tick(100);
    };
    await restore();
    expect(row("Second deleted letter")).toBeNull();
    expect(messageWrites()).toEqual([]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Undo" })); });
    await tick(100);
    expect(row("Second deleted letter")).not.toBeNull();
    await act(async () => { fireEvent.click(row("Second deleted letter")!); });
    await tick(500);
    await restore();
    await tick(UNDO_MS + 100);
    expect(messageWrites().map(({ method, url }) => [method, new URL(url, window.location.href).pathname])).toEqual([
      ["POST", "/api/messages/second_deleted/restore"],
    ]);
    expect(messageWrites()[0]?.intent).toBeTruthy();
    expect(row("First deleted letter")).not.toBeNull();
    expect(row("Second deleted letter")).toBeNull();
  }, 30_000);
});

describe("History over the web's real entry", () => {
  it("its rail entry, its address and g h each reach it", async () => {
    window.location.hash = "#/ohbox";
    await mountCloudShell();
    await tick(2500);
    await key("g");
    await key("h");
    await tick(500);
    expect(window.location.hash, "g h").toMatch(/^#\/history/);
    expect(row("New glaze"), "History lists the letter").not.toBeNull();
    await act(async () => {
      fireEvent.click(within(rail()).getByRole("button", { name: /^Ohbox/ }));
    });
    await tick(500);
    expect(window.location.hash).toBe("#/ohbox");
    await act(async () => {
      fireEvent.click(within(rail()).getByRole("button", { name: /^History/ }));
    });
    await tick(500);
    expect(window.location.hash, "the rail's entry").toMatch(/^#\/history/);
    await visit("#/ohbox");
    await visit("#/history");
    expect(row("New glaze"), "the address").not.toBeNull();
    /* What the journeys find History by (their vocabulary's rows): its heading, and its list inside the page's one
       main landmark, by role and name. */
    const main = screen.getByRole("main");
    expect(within(main).getByRole("heading", { name: "History" })).toBeTruthy();
    expect(within(main).getByRole("listbox", { name: "History" })).toBeTruthy();
    expect(within(rail()).getByRole("button", { name: "History" })).toBeTruthy();
  }, 30_000);

  it("h walks the keys into the rail and l walks them back onto the list's cursor row", async () => {
    window.location.hash = "#/history";
    await mountCloudShell();
    await tick(2500);
    await key("j");
    const cursor = screen.queryAllByRole("option", { selected: true })[0];
    expect(cursor, "j put the cursor on a row").toBeTruthy();
    await act(async () => {
      cursor!.focus();
    });
    await key("h");
    expect(rail().contains(document.activeElement), "h walked into the rail").toBe(true);
    await key("l");
    await tick(200);
    expect(document.activeElement, "the keyboard is on the cursor's row").toBe(
      screen.queryAllByRole("option", { selected: true })[0],
    );
  }, 30_000);
});
