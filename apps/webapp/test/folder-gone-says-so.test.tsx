/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ISO, act, answerConsentWith, answerStoreWith, answerSyncWith, installShellEnv, mailbox, mountShell,
  teardownShellEnv, textOf, tick,
} from "./fixtures/live-walk-shell";
import en from "../messages/en.json";
import folderWords from "../../../packages/app/messages/folder.en.json";
import de from "../messages/de.json";

/**
 * A FOLDER PAGE NEVER CLAIMS THE SERVER HAS A FOLDER, AND ONE THAT LEAVES SAYS SO.
 *
 * The empty folder page said "It exists on your mail server and holds no mail" over folders the
 * server had deleted eleven days before. The folder list follows the server now, so the page
 * states what it knows — no mail — and how the list behaves; and a folder that leaves the list
 * while it is open names itself in a toast instead of the page silently becoming the Ohbox.
 * Against the shipped shell; a folder id nobody opened stays silent (the positive control).
 */

const FOLDER_ID = "fd_clients";
let gone = false;

const json = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

/** The folder entity, then — once `gone` — its delete, as the delta carries a retired row. */
const world = (): Response => json(gone
  ? {
    changes: { creates: [], updates: [], moves: [], deletes: [{ type: "folder", op: "delete", id: FOLDER_ID, seq: 2, updatedAt: ISO, entity: null }] },
    cursor: "c2", hasMore: false, serverTime: ISO,
  }
  : {
    changes: {
      creates: [{
        type: "folder", op: "create", id: FOLDER_ID, seq: 1, updatedAt: ISO,
        entity: { id: FOLDER_ID, name: "INBOX/Clients", mailboxId: "mb_1", mailbox: "walker@example.invalid", updatedAt: ISO },
      }],
      updates: [], moves: [], deletes: [],
    },
    cursor: "c1", hasMore: false, serverTime: ISO,
  });

/** The folder holds nothing past the mirror either, so the empty state can be said. */
function interposeEmptyFolder(): void {
  const base = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    if (String(input).includes("/messages?")) return json({ items: [], nextCursor: null });
    return (base as (i: unknown, o?: unknown) => Promise<Response>)(input, init);
  }) as typeof globalThis.fetch;
}

const goHash = async (hash: string): Promise<void> => {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new Event("hashchange"));
    await Promise.resolve();
  });
  await tick(0);
};

beforeEach(() => {
  installShellEnv();
  window.localStorage.clear();
  gone = false;
  interposeEmptyFolder();
});
afterEach(async () => { await teardownShellEnv(); });

describe("the folder page and a folder that leaves", () => {
  it("the catalogues claim nothing about the server's folders, in either language", () => {
    for (const cat of [en, de]) {
      expect(cat.folder.emptyHint).not.toMatch(/exists on your mail server|existiert auf deinem Mailserver/);
      expect(cat.folder.gone).toContain("{name}");
    }
  });

  /** What a folder with no letter says: today's page's hint, or the seated folder's own words for it. */
  const holdsNone = (el: HTMLElement): string =>
    el.querySelector("section.fr-list") !== null ? folderWords.folder.emptyTitle : en.folder.emptyHint;

  it("an empty folder says it holds no mail, and nothing about existing on the server", async () => {
    answerConsentWith({ foldersEnabledAt: ISO });
    answerSyncWith(world);
    answerStoreWith([]);
    const el = await mountShell([mailbox()]);
    await tick(30_000);
    await goHash(`#/folder/${FOLDER_ID}`);
    await tick(1_000);
    const text = textOf(el);
    expect(text).toContain(holdsNone(el));
    expect(text).not.toContain("exists on your mail server");
  });

  it("a folder deleted on the server while open is named in a toast, once", async () => {
    answerConsentWith({ foldersEnabledAt: ISO });
    answerSyncWith(world);
    answerStoreWith([]);
    const el = await mountShell([mailbox()]);
    await tick(30_000);
    await goHash(`#/folder/${FOLDER_ID}`);
    await tick(1_000);
    const sentence = en.folder.gone.replace("{name}", "Clients").replace(/\.$/, "");
    expect(textOf(el), "the precondition: the folder page is open").toContain(holdsNone(el));
    expect(document.body.textContent ?? "").not.toContain(sentence);

    gone = true;
    // The next poll carries the delete; the toast stands for a few seconds, so it is read as it lands.
    let seenAt = -1;
    let times = 0;
    for (let s = 1; s <= 30; s++) {
      await tick(1_000);
      const body = document.body.textContent ?? "";
      if (body.includes(sentence)) { if (seenAt < 0) seenAt = s; times = Math.max(times, body.split(sentence).length - 1); }
    }
    expect(seenAt, "the folder left the list and nothing said so").toBeGreaterThan(0);
    expect(times, "said more than once").toBe(1);
    expect(textOf(el)).not.toContain(holdsNone(el));
    expect(textOf(el)).toContain(en.reader.blank.none);
  });

  it("positive control: a link to a folder nobody had open stays silent", async () => {
    answerConsentWith({ foldersEnabledAt: ISO });
    answerSyncWith(world);
    answerStoreWith([]);
    await mountShell([mailbox()]);
    await tick(30_000);
    await goHash("#/folder/fd_never_seen");
    await tick(60_000);
    expect(document.body.textContent ?? "").not.toContain("is no longer on your mail server");
  });
});
