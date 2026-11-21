/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import en from "../messages/en.json";
import {
  ISO, act, answerConsentWith, answerSyncWith, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
  liveAccountResponse,
} from "./fixtures/live-walk-shell";
import {
  EMBEDDED_CALENDAR, EXCHANGE_ICAL, GOOGLE, HOSTILE_DURATION, TWO_EVENTS, type InviteShape,
} from "../../../packages/core/test/fixtures/invite-shapes";
import { OWA_STUB } from "../../../packages/core/test/fixtures/owa-invitation-stub";

/**
 * EVERY INVITATION SHOWS ITS EVENT ONCE, AT THE TOP OF THE MESSAGE (owner report 2026-10-22: "here
 * I still see no calendar preview.. and sometimes I see the same one double"). The card lived in
 * the attachment strip under the body, one per calendar part: Google's invitation drew two, an
 * Outlook or Teams invitation's card sat under a long html body out of view, and an embedded
 * calendar part drew none. Each case serves the parts ingest stores for a real invitation shape.
 */

const EN_BODY = (en as unknown as Record<string, Record<string, string>>).body!;

/* ── the live shell: the Ohbox reader and an open News card ────────────── */

let shapes: InviteShape[] = [];
let stubLetter = false;
let folder = "INBOX";
const idOf = (shape: InviteShape): string => `msg-${shape.name}`;
const STUB_ID = "msg-owa-stub";
const REPLY_ID = "msg-invitation-reply";

const letter = (id: string, subject: string) => ({
  id, accountId: "acct_live_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
  subject, from: { name: "Ada Organizer", address: "ada@example.test" },
  to: [], cc: [], date: ISO, folder, snippet: subject, unread: true,
  hasAttachments: true, attachmentCount: 1, sensitivity: {}, triage: null, labels: [],
  remoteContent: "none", updatedAt: ISO,
});
const adaRule = () => ({
  id: "rule_ada", kind: "sender", match: "ada@example.test", destination: folder, priority: 0,
  provenance: "manual", enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
});

beforeEach(() => {
  installShellEnv();
  window.localStorage.clear();
  answerConsentWith({ foldersEnabledAt: ISO });
  shapes = [];
  stubLetter = false;
  folder = "INBOX";
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const inner = globalThis.fetch;
  const respond = async (input: unknown, init?: unknown) => {
    const url = String(input);
    const list = /\/messages\/([^/?]+)\/attachments(?:$|\?)/.exec(url);
    if (list) {
      const shape = shapes.find((s) => idOf(s) === decodeURIComponent(list[1]!));
      return json({ items: (shape?.parts ?? []).map((p) => ({
        id: p.id, filename: p.filename, contentType: p.contentType, sizeBytes: p.bytes.length,
        inline: p.inline, contentId: p.contentId, messageId: idOf(shape!),
      })) });
    }
    const body = /\/messages\/([^/?]+)\/body/.exec(url);
    if (body) {
      const id = decodeURIComponent(body[1]!);
      const shape = shapes.find((s) => idOf(s) === id);
      return json({
        text: id === STUB_ID ? OWA_STUB : shape?.text ?? "", html: shape?.html ?? null,
        loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
      });
    }
    const bytes = /\/attachments\/([^/?]+)$/.exec(url);
    if (bytes) {
      const id = decodeURIComponent(bytes[1]!);
      const part = shapes.flatMap((s) => s.parts).find((p) => p.id === id);
      // Served untyped, so the bytes stay the runtime's own Blob (jsdom's has no `text()`).
      return new Response(part?.bytes ?? "", { status: 200, headers: { "content-type": "application/octet-stream" } });
    }
    return (inner as (i: unknown, n?: unknown) => Promise<Response>)(input, init);
  };
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: unknown) =>
    liveAccountResponse(await respond(input, init)));
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:harness/1";
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
});
afterEach(async () => { await teardownShellEnv(); });

async function mountWith(served: InviteShape[], opts: { stub?: boolean; thread?: boolean } = {}): Promise<void> {
  shapes = served;
  stubLetter = opts.stub === true;
  let seq = 1;
  const creates = [
    { type: "rule", op: "create", id: "rule_ada", seq: seq++, updatedAt: ISO, entity: adaRule() },
    ...served.map((s) => ({
      type: "message", op: "create", id: idOf(s), seq: seq++, updatedAt: ISO,
      entity: { ...letter(idOf(s), s.name), threadId: opts.thread ? "invitation-thread" : null },
    })),
    ...(opts.thread ? [{
      type: "message", op: "create", id: REPLY_ID, seq: seq++, updatedAt: ISO,
      entity: { ...letter(REPLY_ID, "Thanks for the invitation"), threadId: "invitation-thread", hasAttachments: false, attachmentCount: 0 },
    }] : []),
    ...(stubLetter ? [{ type: "message", op: "create", id: STUB_ID, seq: seq++, updatedAt: ISO, entity: { ...letter(STUB_ID, "Think tank"), hasAttachments: false, attachmentCount: 0 } }] : []),
  ];
  answerSyncWith(() => new Response(JSON.stringify({
    changes: { creates, updates: [], moves: [], deletes: [] }, cursor: "c2", hasMore: false, serverTime: ISO,
  }), { status: 200, headers: { "content-type": "application/json" } }));
  await mountShell([mailbox({ lastSyncAt: ISO, id: "mb_1" })]);
  await tick(30_000);
}

const goHash = async (hash: string): Promise<void> => {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new Event("hashchange"));
    await Promise.resolve();
  });
};

/** Let the list, the calendar pass and the redraw land. */
async function settleCards(): Promise<void> {
  for (let i = 0; i < 40; i++) await tick(50);
}

async function openInReader(id: string): Promise<HTMLElement> {
  await goHash(`#/ohbox/m/${id}`);
  await settleCards();
  const reader = screen.getByRole("region", { name: "Open message" });
  const body = reader.querySelector("[data-read-body]");
  expect(body, "the reader shows no body").not.toBeNull();
  return reader;
}

/** The card stands before the mail and outside it. */
function expectAbove(card: Element | null, mail: Element | null): void {
  expect(card, "no event card").not.toBeNull();
  expect(mail, "the premise: the mail element").not.toBeNull();
  expect(mail!.contains(card!), "the card is inside the mail").toBe(false);
  expect(card!.compareDocumentPosition(mail!) & Node.DOCUMENT_POSITION_FOLLOWING, "the card is under the mail").toBeTruthy();
}

describe("the reader shows one card per event, above the mail", () => {
  it("Google's invitation (alternative + invite.ics) shows one card", async () => {
    await mountWith([GOOGLE]);
    const page = await openInReader(idOf(GOOGLE));
    expect(page.querySelectorAll(".ics-card")).toHaveLength(1);
    expect(page.querySelector(".ics-card .ics-summary")?.textContent).toBe("Quarterly planning");
  }, 60_000);

  it("the strip lists Google's invite.ics once, as a plain tile, and draws no card", async () => {
    await mountWith([GOOGLE]);
    const page = await openInReader(idOf(GOOGLE));
    // The nameless alternative is the body the card reads, not a second invite.ics.
    const files = page.querySelector(".oh-files");
    expect(files).not.toBeNull();
    expect(files!.querySelectorAll(".oh-file")).toHaveLength(1);
    expect(files!.querySelector(".ics-card")).toBeNull();
    expect(within(files as HTMLElement).queryByRole("button", { name: "Download all" })).toBeNull();
    expect(files!.querySelector(".oh-files-head")).toBeNull();
  }, 60_000);

  it("an Exchange invitation's card comes before its long html body, not under it", async () => {
    await mountWith([EXCHANGE_ICAL]);
    const page = await openInReader(idOf(EXCHANGE_ICAL));
    expect(page.querySelectorAll(".ics-card")).toHaveLength(1);
    expectAbove(page.querySelector(".ics-card"), page.querySelector("[data-read-body]"));
  }, 60_000);

  it("an embedded calendar part (inline, under multipart/related) shows its card", async () => {
    await mountWith([EMBEDDED_CALENDAR]);
    const page = await openInReader(idOf(EMBEDDED_CALENDAR));
    expect(page.querySelectorAll(".ics-card")).toHaveLength(1);
    expect(page.querySelector(".ics-card .ics-summary")?.textContent).toBe("Site visit");
  }, 60_000);

  it("two different events show two cards (control)", async () => {
    await mountWith([TWO_EVENTS]);
    const page = await openInReader(idOf(TWO_EVENTS));
    expect([...page.querySelectorAll(".ics-card .ics-summary")].map((n) => n.textContent))
      .toEqual(["Workshop day one", "Workshop day two"]);
  }, 60_000);

  it("a crafted DURATION past the range of a Date: one card, and the reader stays", async () => {
    await mountWith([HOSTILE_DURATION]);
    const page = await openInReader(idOf(HOSTILE_DURATION));
    expect(page.querySelectorAll(".ics-card")).toHaveLength(1);
    expectAbove(page.querySelector(".ics-card"), page.querySelector("[data-read-body]"));
  }, 60_000);

  it("an Outlook Web App stub shows the note and no card (control)", async () => {
    await mountWith([], { stub: true });
    const page = await openInReader(STUB_ID);
    expect(page.textContent).toContain(EN_BODY.invitationOwaLink);
    expect(page.querySelector(".ics-card")).toBeNull();
  }, 60_000);

  it("the card is text only: no link, no button", async () => {
    await mountWith([GOOGLE]);
    const page = await openInReader(idOf(GOOGLE));
    const events = page.querySelector(".msg-events");
    expect(events, "no event block").not.toBeNull();
    expect(events!.querySelectorAll("a, button")).toHaveLength(0);
  }, 60_000);
});

describe("an open News card shows the event above the issue", () => {
  it("one card, before the card's text", async () => {
    folder = "ohmail/News";
    await mountWith([GOOGLE]);
    await goHash("#/reads");
    await tick(1_000);
    const news = screen.getByRole("region", { name: "News stream" });
    await act(async () => { within(news).getByRole("button", { name: /^Expand/ }).click(); });
    await settleCards();
    const card = within(news).getByRole("article");
    expect(card.querySelectorAll(".ics-card")).toHaveLength(1);
    expectAbove(card.querySelector(".ics-card"), card.querySelector("[data-read-body]"));
  }, 60_000);
});

describe("a conversation panel and the Screener preview show the event above the mail", () => {
  it("a conversation panel: one card for Google's pair, before .pm-body", async () => {
    await mountWith([GOOGLE], { thread: true });
    const reader = await openInReader(REPLY_ID);
    const invitation = reader.querySelector(`[data-conv-id="${idOf(GOOGLE)}"]`);
    expect(invitation, "the other letter in the conversation is present").not.toBeNull();
    expect(reader.querySelectorAll(".ics-card")).toHaveLength(1);
    expectAbove(invitation!.querySelector(".ics-card"), invitation!.querySelector("[data-read-body]"));
  }, 60_000);
});
