/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryMirrorStore, OhmailEngine } from "@ohmail/client-engine";
import { ISO, act, installShellEnv, mailbox, mountShell, teardownShellEnv, tick } from "./fixtures/live-walk-shell";
import { GOOGLE, type InviteShape } from "../../../packages/core/test/fixtures/invite-shapes";

const idOf = (shape: InviteShape): string => `msg-${shape.name}`;
const folder = "ohmail/Screener";
beforeEach(() => {
  installShellEnv();
  window.localStorage.clear();
});
afterEach(teardownShellEnv);

const letter = (id: string, subject: string) => ({
  id, accountId: "acct_live_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
  subject, from: { name: "Ada Organizer", address: "ada@example.test" },
  to: [], cc: [], date: ISO, folder, snippet: subject, unread: true,
  hasAttachments: true, attachmentCount: 1, sensitivity: {}, triage: null, labels: [],
  remoteContent: "none", updatedAt: ISO,
});
/** Let the list, the calendar pass and the redraw land. */
async function settleCards(): Promise<void> {
  for (let i = 0; i < 40; i++) await tick(50);
}

/** The card stands before the mail and outside it. */
function expectAbove(card: Element | null, mail: Element | null): void {
  expect(card, "no event card").not.toBeNull();
  expect(mail, "the premise: the mail element").not.toBeNull();
  expect(mail!.contains(card!), "the card is inside the mail").toBe(false);
  expect(card!.compareDocumentPosition(mail!) & Node.DOCUMENT_POSITION_FOLLOWING, "the card is under the mail").toBeTruthy();
}

function engineServing(shape: InviteShape, store: MemoryMirrorStore): OhmailEngine {
  return new OhmailEngine({
    store,
    adapter: {
      sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: store.getCursor(), hasMore: false, serverTime: ISO }),
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => ({
        text: shape.text, html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
      }),
      listAttachments: async () => shape.parts.map((p) => ({
        id: p.id, filename: p.filename, contentType: p.contentType, sizeBytes: p.bytes.length,
        inline: p.inline, contentId: p.contentId, messageId: idOf(shape),
      })),
      fetchAttachment: async (id: string) =>
        new Response(shape.parts.find((p) => p.id === id)!.bytes, { headers: { "content-type": "application/octet-stream" } }).blob(),
    },
  } as never);
}

const engineMessage = (shape: InviteShape): EngineMessage => ({
  ...letter(idOf(shape), shape.name),
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
} as unknown as EngineMessage);

async function mountScreener(shape: InviteShape): Promise<HTMLElement> {
  const entity = engineMessage(shape);
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    { type: "message", op: "create", id: entity.id, seq: 1, updatedAt: ISO, entity },
  ]);
  window.location.hash = "#/screener";
  const host = await mountShell([mailbox({
    id: "mb_1", organizerRole: "organizer", organizeConsentedAt: ISO, lastSyncAt: ISO,
  })], { engine: engineServing(shape, store), suggestWire: "none", junkWire: "none" });
  await tick(50);
  await act(async () => { within(host).getByRole("option", { name: /Ada Organizer:/ }).click(); });
  await settleCards();
  return within(within(host).getByRole("region", { name: "Reading" })).getByRole("article");
}

describe("a conversation panel and the Screener preview show the event above the mail", () => {
  it("the Screener's preview: one card for Google's pair, before .hm-body", async () => {
    const article = await mountScreener(GOOGLE);
    const mail = within(article).getByText(GOOGLE.text!, { exact: true });
    const cards = within(article).queryAllByText("Quarterly planning", { exact: true });
    expect(cards).toHaveLength(1);
    expectAbove(cards[0]!.closest("section"), mail);
  }, 60_000);
});
