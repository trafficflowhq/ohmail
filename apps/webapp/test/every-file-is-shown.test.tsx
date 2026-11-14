/** @vitest-environment jsdom */
import { getByRole, queryByRole } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ISO, act, answerConsentWith, answerSyncWith, installShellEnv, mailbox, mountShell,
  teardownShellEnv, tick,
} from "./fixtures/live-walk-shell";

/**
 * FIX-025: a message with a plain-text body and a file showed no file, while an
 * html message with an inline picture listed all of its parts. The shell asked for the list of
 * the Ohbox selection only; every other pane read a list nobody had asked for, which renders as
 * silence, and an html body asked by a second path (its `cid:` pictures). This mounts the
 * shipped shell over the live engine, so every list is a real `GET /messages/:id/attachments`.
 * The route's own read over the same three shapes is `packages/services/test/every-file-listed.test.ts`.
 */

const FILES: Record<string, Array<Record<string, unknown>>> = {
  t1: [{ id: "a-t1", filename: "notes.txt", contentType: "text/plain", sizeBytes: 39, inline: false, contentId: null, messageId: "t1" }],
  p1: [{ id: "a-p1", filename: "scan.png", contentType: "image/png", sizeBytes: 1485, inline: false, contentId: null, messageId: "p1" }],
  h1: [
    { id: "a-h1-logo", filename: "logo.png", contentType: "image/png", sizeBytes: 900, inline: true, contentId: "logo1@example.test", messageId: "h1" },
    { id: "a-h1-a", filename: "invoice.pdf", contentType: "application/pdf", sizeBytes: 2000, inline: false, contentId: null, messageId: "h1" },
    { id: "a-h1-b", filename: "terms.txt", contentType: "text/plain", sizeBytes: 300, inline: false, contentId: null, messageId: "h1" },
  ],
  f1: [{ id: "a-f1", filename: "report.txt", contentType: "text/plain", sizeBytes: 64, inline: false, contentId: null, messageId: "f1" }],
  q1: [{ id: "a-q1", filename: "draft.png", contentType: "image/png", sizeBytes: 700, inline: false, contentId: null, messageId: "q1" }],
  q2: [{ id: "a-q2", filename: "final.png", contentType: "image/png", sizeBytes: 800, inline: false, contentId: null, messageId: "q2" }],
};
const HTML: Record<string, string> = {
  h1: '<html><body><p>See attached.</p><img src="cid:logo1@example.test"></body></html>',
};

/** Every list the shell asked for, by message id — the ask this fix is about. */
let listed: string[] = [];
/** Every byte fetch, by attachment id — what a press on a tile reaches. */
let fetched: string[] = [];

const message = (id: string, n: number, over: Record<string, unknown> = {}) => ({
  type: "message", op: "create", id, seq: n, updatedAt: ISO,
  entity: {
    id, accountId: "acct_live_1", mailboxId: "mb_1", threadId: `th-${id}`, messageIdHeader: null,
    subject: `subject of ${id}`, from: { name: `Sender ${id}`, address: `${id}@example.invalid` },
    to: [], cc: [], date: ISO, folder: "INBOX", snippet: "Here is the file you asked for.",
    unread: false, hasAttachments: true, attachmentCount: FILES[id]!.filter((f) => !f.inline).length,
    sensitivity: {}, triage: null, labels: [], remoteContent: "none", updatedAt: ISO, ...over,
  },
});
const rule = (address: string, n: number) => ({
  type: "rule", op: "create", id: `rule_${address}`, seq: n, updatedAt: ISO,
  entity: {
    id: `rule_${address}`, kind: "sender", match: address, destination: "INBOX", priority: 0,
    provenance: "seeded-from-sent", enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: ISO, updatedAt: ISO,
  },
});

const world = (): Response => new Response(JSON.stringify({
  changes: {
    creates: [
      { type: "folder", op: "create", id: "fd1", seq: 1, updatedAt: ISO, entity: { id: "fd1", name: "Projects/Acme", mailboxId: "mb_1", mailbox: "live@example.invalid", updatedAt: ISO } },
      { type: "tag", op: "create", id: "tg1", seq: 2, updatedAt: ISO, entity: { id: "tg1", name: "Invoices", color: null, updatedAt: ISO } },
      message("t1", 3, { labels: ["tg1"] }), rule("t1@example.invalid", 4),
      message("p1", 5), rule("p1@example.invalid", 6),
      message("h1", 7), rule("h1@example.invalid", 8),
      message("f1", 9, { folder: "Projects/Acme" }), rule("f1@example.invalid", 10),
      // One conversation of two, both with a file: the older one is the sibling panel.
      message("q1", 11, { threadId: "th-q", date: "2026-08-04T08:00:00.000Z", from: { name: "Sender q", address: "q@example.invalid" } }),
      message("q2", 12, { threadId: "th-q", from: { name: "Sender q", address: "q@example.invalid" } }),
      rule("q@example.invalid", 13),
    ],
    updates: [], moves: [], deletes: [],
  },
  cursor: "c13", hasMore: false, serverTime: ISO,
}), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => {
  installShellEnv();
  window.localStorage.clear();
  answerConsentWith({ foldersEnabledAt: ISO });
  answerSyncWith(world);
  listed = [];
  fetched = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const inner = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: unknown) => {
    const url = String(input);
    const list = /\/messages\/([^/?]+)\/attachments(?:$|\?)/.exec(url);
    if (list) {
      const id = decodeURIComponent(list[1]!);
      listed.push(id);
      return json({ items: FILES[id] ?? [] });
    }
    const body = /\/messages\/([^/?]+)\/body/.exec(url);
    if (body && FILES[decodeURIComponent(body[1]!)]) {
      const id = decodeURIComponent(body[1]!);
      return json({ text: "Here is the file you asked for.", html: HTML[id] ?? null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null });
    }
    const bytes = /\/attachments\/([^/?]+)$/.exec(url);
    if (bytes) {
      fetched.push(decodeURIComponent(bytes[1]!));
      return new Response(new Blob(["x"]), { status: 200, headers: { "content-type": "application/octet-stream" } });
    }
    return (inner as (i: unknown, n?: unknown) => Promise<Response>)(input, init);
  }) as unknown as typeof globalThis.fetch;
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:harness/1";
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
});
afterEach(async () => { await teardownShellEnv(); });

const goHash = async (hash: string): Promise<void> => {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new Event("hashchange"));
    await Promise.resolve();
  });
  await tick(0);
  await tick(500);
};
/** The frame's reading column, where the new shell reads an open letter. */
const READING = '[role="region"][aria-label="Open message"]';
const scopeOf = (sel: string): Element => {
  const el = document.querySelector(sel);
  expect(el, `${sel} is not on screen`).not.toBeNull();
  return el!;
};
/** A button's accessible name: its label, else its words. */
const nameOf = (b: Element): string => b.getAttribute("aria-label") ?? (b.textContent ?? "").trim();
/** The file names one surface's letter files show, in their order: each ready file offers its own "Download <name>"
 *  (the set's own "Download all" is no file). */
const tilesIn = (scope: Element): string[] => {
  const names: string[] = [];
  for (const b of scope.querySelectorAll("button")) {
    if (nameOf(b) === "Download all") continue;
    const m = /^Download (.+)$/.exec(nameOf(b));
    if (m && !names.includes(m[1]!)) names.push(m[1]!);
  }
  return names;
};

async function open(): Promise<void> {
  await mountShell([mailbox()]);
  await tick(30_000);
}

/** A tile a person can use: its name, its size, and a press that fetches the bytes. */
async function expectUsableTile(scope: Element, filename: string, attachmentId: string): Promise<void> {
  const named = (want: string): HTMLButtonElement[] =>
    [...scope.querySelectorAll<HTMLButtonElement>("button")].filter((b) => nameOf(b) === want);
  /* The tile: the press on the file itself (a look where the file has one, else its download), its face its name and size. */
  const tile = named(`Preview ${filename}`)[0] ?? named(`Download ${filename}`)[0];
  expect(tile, `no tile for ${filename}`).toBeTruthy();
  expect((tile!.textContent ?? "").replace(filename, ""), `${filename} states no size`).toMatch(/\d/);
  /* Its save: the file's own Download beside the tile (the last control so named). */
  const save = named(`Download ${filename}`).at(-1);
  expect(save, `${filename} has nothing to press`).toBeTruthy();
  await act(async () => { save!.click(); });
  await tick(500);
  expect(fetched, `pressing ${filename}'s save fetched nothing`).toContain(attachmentId);
}

describe("a file is listed on the open message, whatever the body's type", () => {
  const SHAPES: Array<{ id: string; names: string[] }> = [
    { id: "t1", names: ["notes.txt"] },
    { id: "p1", names: ["scan.png"] },
    { id: "h1", names: ["invoice.pdf", "terms.txt", "logo.png"] },
  ];
  /* History reads a routed letter in its own column, Search in the reader over it. */
  const READERS = ["history", "search"];

  for (const s of SHAPES) {
    it(`${s.id}: the Ohbox column lists it (the control, green before the fix)`, async () => {
      await open();
      await goHash(`#/ohbox/m/${s.id}`);
      expect(tilesIn(document.body)).toEqual(s.names);
      await expectUsableTile(document.body, s.names[0]!, FILES[s.id]!.find((f) => f.filename === s.names[0])!.id as string);
    }, 30_000);

    for (const view of READERS) {
      it(`${s.id}: the reading on ${view} lists it, asked once`, async () => {
        await open();
        await goHash(`#/${view}/m/${s.id}`);
        const reader = scopeOf(READING);
        expect(tilesIn(reader), `the reader over ${view} shows no file for ${s.id}`).toEqual(s.names);
        expect(listed.filter((id) => id === s.id), "the list was asked more than once").toHaveLength(1);
        await expectUsableTile(reader, s.names[0]!, FILES[s.id]!.find((f) => f.filename === s.names[0])!.id as string);
      }, 30_000);
    }
  }

  it("a view's own column lists it: Tag, on its own cursor", async () => {
    await open();
    await goHash("#/tag/tg1");
    await act(async () => getByRole(document.body, "option", { name: /subject of t1/ }).click());
    await tick(500);
    const view = scopeOf(READING);
    expect(tilesIn(view), "the Tag column shows no file").toEqual(["notes.txt"]);
  }, 30_000);

  it("a view's own column lists it: Folder, on its own cursor", async () => {
    await open();
    await goHash("#/folder/fd1");
    await act(async () => getByRole(document.body, "option", { name: /subject of f1/ }).click());
    await tick(500);
    const view = scopeOf(READING);
    expect(tilesIn(view), "the Folder column shows no file").toEqual(["report.txt"]);
  }, 30_000);

  it("a message already in the mirror lists its file on every open, the list asked again after a close", async () => {
    await open();
    /* Opened where the new shell reads a letter, the Ohbox's reading column (Search is not mounted yet). */
    await goHash("#/ohbox/m/t1");
    expect(tilesIn(scopeOf(READING))).toEqual(["notes.txt"]);
    // Write shows no message, so nothing holds `t1` there and its list is let go.
    await goHash("#/write");
    expect(tilesIn(document.body), "a strip outlived every pane").toEqual([]);
    await goHash("#/ohbox/m/t1");
    expect(tilesIn(scopeOf(READING)), "a re-open shows no file").toEqual(["notes.txt"]);
    expect(listed.filter((id) => id === "t1"), "the close did not let the list go, or the re-open did not ask").toHaveLength(2);
  }, 30_000);
});

describe("a preview belongs to the pane that shows its message", () => {
  it("the look opened in the reader stands, and goes when the reader closes", async () => {
    await open();
    await goHash("#/search/m/p1");
    const tile = getByRole(scopeOf(READING) as HTMLElement, "button", { name: "Preview scan.png" });
    expect(tile, "the reader shows no tile").toBeTruthy();
    await act(async () => { tile!.click(); });
    await tick(500);
    expect(queryByRole(document.body, "dialog", { name: "Attachment preview" }), "the look closed itself as it opened").not.toBeNull();
    await goHash("#/ohbox");
    expect(queryByRole(document.body, "dialog", { name: "Attachment preview" }), "the look outlived the reader it was opened in").toBeNull();
    // Closed, not merely undrawn: a look left standing over a released list comes back on a re-open.
    await goHash("#/search/m/p1");
    expect(tilesIn(scopeOf(READING))).toEqual(["scan.png"]);
    expect(queryByRole(document.body, "dialog", { name: "Attachment preview" }), "a closed look came back when the message was opened again").toBeNull();
  }, 30_000);

  it("a move inside one conversation closes the look and keeps both files listed", async () => {
    await open();
    await goHash("#/ohbox/m/q2");
    expect(tilesIn(document.body), "the conversation does not show both files").toEqual(["draft.png", "final.png"]);
    const sibling = getByRole(document.body, "button", { name: "Preview draft.png" });
    await act(async () => { sibling!.click(); });
    await tick(500);
    expect(queryByRole(document.body, "dialog", { name: "Attachment preview" }), "the sibling's look did not open").not.toBeNull();
    await goHash("#/ohbox/m/q1");
    expect(queryByRole(document.body, "dialog", { name: "Attachment preview" }), "a selection move left the look standing").toBeNull();
    expect(tilesIn(document.body), "a move inside the conversation lost a file").toEqual(["draft.png", "final.png"]);
  }, 30_000);

  it("the Ohbox's own look still closes on a selection move (the control)", async () => {
    await open();
    await goHash("#/ohbox/m/p1");
    const tile = getByRole(document.body, "button", { name: "Preview scan.png" });
    await act(async () => { tile!.click(); });
    await tick(500);
    expect(queryByRole(document.body, "dialog", { name: "Attachment preview" })).not.toBeNull();
    await goHash("#/ohbox/m/t1");
    expect(queryByRole(document.body, "dialog", { name: "Attachment preview" }), "a selection move left the look standing").toBeNull();
  }, 30_000);
});
