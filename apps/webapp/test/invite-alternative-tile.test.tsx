/** @vitest-environment jsdom */
import { createHash } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ISO, act, answerConsentWith, answerSyncWith, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell";
import { normalizeMime } from "../../../packages/core/src/mime.js";
import {
  EXCHANGE_ICAL, GOOGLE, PLAIN_ICS_FILE, type InviteShape,
} from "../../../packages/core/test/fixtures/invite-shapes";

/**
 * AN INVITATION'S CALENDAR ALTERNATIVE IS ITS BODY, NEVER A TILE (found on 0.29.0, where an
 * invitation "showed the same one double"). A Google invitation carries its event twice: as the
 * nameless text/calendar alternative beside the text and html bodies, and as an invite.ics file.
 * The strip drew both as tiles, both named invite.ics, and the alternative's tile was the one that
 * could not be fetched there. The card reads the alternative; the strip lists the file once. An
 * alternative that is the message's only calendar part (Exchange, Outlook) stays a tile: without it
 * a fetch that failed would leave no card, no file and nothing to retry or save.
 *
 * Served through the real parse: every list here is `normalizeMime(eml).attachments`, the rows
 * ingest writes for the raw message, each part's bytes checked against the stored sha256.
 */

interface Served { id: string; filename: string | null; contentType: string; sizeBytes: number; inline: boolean; contentId: string | null; bytes: string }

const idOf = (shape: InviteShape): string => `msg-${shape.name}`;
const parsed = new Map<string, Served[]>();
let shapes: InviteShape[] = [];
let requested: string[] = [];
/** Parts whose bytes the server refuses the way GreenMail's re-read did on 0.29.0 (409 mismatch). */
let refused = new Set<string>();

beforeAll(async () => {
  for (const shape of [GOOGLE, EXCHANGE_ICAL, PLAIN_ICS_FILE]) {
    const msg = await normalizeMime(shape.eml);
    parsed.set(shape.name, msg.attachments.map((a, i) => {
      const bytes = shape.parts[i]!.bytes;
      // The served bytes are this stored part's own: the sha ingest took over the decoded bytes.
      expect(createHash("sha256").update(Buffer.from(bytes, "latin1")).digest("hex")).toBe(a.contentSha256);
      return {
        id: `${shape.name}-${i}`, filename: a.filename, contentType: a.contentType, sizeBytes: a.sizeBytes,
        inline: a.inline, contentId: a.contentId, bytes,
      };
    }));
  }
});

const letter = (id: string, subject: string) => ({
  id, accountId: "acct_live_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
  subject, from: { name: "Ada Organizer", address: "ada@example.test" },
  to: [], cc: [], date: ISO, folder: "INBOX", snippet: subject, unread: true,
  hasAttachments: true, attachmentCount: 1, sensitivity: {}, triage: null, labels: [],
  remoteContent: "none", updatedAt: ISO,
});
const adaRule = () => ({
  id: "rule_ada", kind: "sender", match: "ada@example.test", destination: "INBOX", priority: 0,
  provenance: "manual", enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
});

beforeEach(() => {
  installShellEnv();
  window.localStorage.clear();
  answerConsentWith({ foldersEnabledAt: ISO });
  shapes = [];
  requested = [];
  refused = new Set();
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const inner = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: unknown) => {
    const url = String(input);
    const list = /\/messages\/([^/?]+)\/attachments(?:$|\?)/.exec(url);
    if (list) {
      const id = decodeURIComponent(list[1]!);
      const shape = shapes.find((s) => idOf(s) === id);
      return json({ items: (shape ? parsed.get(shape.name)! : []).map(({ bytes: _bytes, ...row }) => ({ ...row, messageId: id })) });
    }
    const body = /\/messages\/([^/?]+)\/body/.exec(url);
    if (body) {
      const shape = shapes.find((s) => idOf(s) === decodeURIComponent(body[1]!));
      return json({
        text: shape?.text ?? "", html: shape?.html ?? null,
        loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
      });
    }
    const bytes = /\/attachments\/([^/?]+)$/.exec(url);
    if (bytes) {
      const id = decodeURIComponent(bytes[1]!);
      requested.push(id);
      if (refused.has(id)) {
        return new Response(JSON.stringify({ error: { code: "attachment_part_mismatch" } }), { status: 409, headers: { "content-type": "application/json" } });
      }
      const part = [...parsed.values()].flat().find((p) => p.id === id);
      return new Response(part?.bytes ?? "", { status: 200, headers: { "content-type": "application/octet-stream" } });
    }
    return (inner as (i: unknown, n?: unknown) => Promise<Response>)(input, init);
  }) as unknown as typeof globalThis.fetch;
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:harness/1";
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
});
afterEach(async () => { await teardownShellEnv(); });

async function openInReader(shape: InviteShape): Promise<HTMLElement> {
  shapes = [shape];
  let seq = 1;
  const creates = [
    { type: "rule", op: "create", id: "rule_ada", seq: seq++, updatedAt: ISO, entity: adaRule() },
    { type: "message", op: "create", id: idOf(shape), seq: seq++, updatedAt: ISO, entity: letter(idOf(shape), shape.name) },
  ];
  answerSyncWith(() => new Response(JSON.stringify({
    changes: { creates, updates: [], moves: [], deletes: [] }, cursor: "c2", hasMore: false, serverTime: ISO,
  }), { status: 200, headers: { "content-type": "application/json" } }));
  await mountShell([mailbox({ lastSyncAt: ISO, id: "mb_1" })]);
  await tick(30_000);
  await act(async () => {
    window.location.hash = `#/ohbox/m/${idOf(shape)}`;
    window.dispatchEvent(new Event("hashchange"));
    await Promise.resolve();
  });
  for (let i = 0; i < 40; i++) await tick(50);
  expect(document.querySelector(".msg-body"), "the reader shows no body").not.toBeNull();
  return document.body;
}

const tileNames = (page: HTMLElement): string[] =>
  [...page.querySelectorAll(".att-strip .att-tile .att-name")].map((n) => n.textContent ?? "");

const sharedId = (shape: InviteShape, filename: string | null): string =>
  parsed.get(shape.name)!.find((p) => p.filename === filename)!.id;

describe("the strip lists an invitation's calendar alternative as no tile", () => {
  it("Google (alternative + invite.ics): one card, one invite.ics tile, and it opens", async () => {
    const page = await openInReader(GOOGLE);
    expect(page.querySelectorAll(".ics-card"), "the card").toHaveLength(1);
    expect(tileNames(page), "invite.ics listed twice").toEqual(["invite.ics"]);
    // One file: no "2 attachments" head and no Download all.
    expect(page.querySelector(".att-strip .att-head"), "a group head over one file").toBeNull();
    const file = parsed.get(GOOGLE.name)!.find((p) => p.filename === "invite.ics")!;
    const tile = page.querySelector<HTMLButtonElement>(".att-strip button.att-tile");
    expect(tile, "the file's tile is no button").not.toBeNull();
    // The tile is the file's own: its bytes are the ones asked for, and they are in hand.
    expect(requested, "the file was never fetched").toContain(file.id);
    expect(tile!.dataset.state, "the tile is not ready").toBe("ready");
    // application/ics has no viewer, so the press saves: one anchor, the file's name and bytes.
    const saved: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      saved.push(`${this.download}|${this.href}`);
    });
    try {
      await act(async () => { tile!.click(); });
      for (let i = 0; i < 20; i++) await tick(50);
    } finally {
      click.mockRestore();
    }
    expect(saved, "the press saved nothing, or something else").toEqual(["invite.ics|blob:harness/1"]);
    expect(page.querySelector(".att-strip .att-tile[data-state='failed']"), "the tile failed").toBeNull();
  }, 60_000);

  it("Google, the alternative's bytes refused (the 0.29.0 probe): the card, and the file alone", async () => {
    refused = new Set([sharedId(GOOGLE, null)]);
    const page = await openInReader(GOOGLE);
    expect(page.querySelectorAll(".ics-card"), "the card").toHaveLength(1);
    expect(tileNames(page), "the refused alternative is a second invite.ics").toEqual(["invite.ics"]);
    expect(page.querySelector(".att-strip .att-tile[data-state='failed']"), "a tile that cannot be fetched").toBeNull();
  }, 60_000);

  it("Outlook / Exchange (the alternative only): the card and its one tile", async () => {
    const page = await openInReader(EXCHANGE_ICAL);
    expect(page.querySelectorAll(".ics-card"), "the card").toHaveLength(1);
    expect(tileNames(page), "the only copy of the event left the strip").toEqual(["invite.ics"]);
  }, 60_000);

  it("Outlook / Exchange, its bytes refused: no card, and the failed tile stays to retry", async () => {
    refused = new Set([sharedId(EXCHANGE_ICAL, null)]);
    const page = await openInReader(EXCHANGE_ICAL);
    expect(page.querySelectorAll(".ics-card"), "a card from refused bytes").toHaveLength(0);
    expect(tileNames(page), "the invitation shows nothing at all").toEqual(["invite.ics"]);
    expect(page.querySelector(".att-strip .att-tile[data-state='failed']"), "the tile is not the failed one").not.toBeNull();
  }, 60_000);

  it("a plain .ics attachment, no invitation: one tile (control)", async () => {
    const page = await openInReader(PLAIN_ICS_FILE);
    expect(tileNames(page)).toEqual(["holidays.ics"]);
  }, 60_000);
});
