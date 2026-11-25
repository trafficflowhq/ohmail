/** @vitest-environment jsdom */
/**
 * A HALF-WRITTEN LETTER STAYS IN ITS OWN PARTITION. Under scope A a letter is begun; the host now names scope B (the
 * storage owner and the scope change together, as every entry changes them). The frame is mounted again, so B's composer is
 * empty, nothing B sends carries A's words, and A's letter is there when A returns. The frame's `Scoped` key is what
 * holds it: without it today's composer keeps A's words in its state under B's partition (seen red so).
 *
 * The frame mounts with the same account scope and engine as its web entry.
 */
import { createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextProvider } from "@ohmail/app/text";
import { setStorageOwner, resetStorageOwnerForTest } from "@ohmail/app-logic/storage/storage-owner";
import type { EngineAdapter, OhmailEngine } from "@ohmail/client-engine";
import { DraftServer } from "../_draft-shell";
import { typeInto } from "../fixtures/rich-editor-driver";
import messages from "../../messages/en.json";
import { act, consentTransport, engineOver, msg, NOW, setup, storeWith, teardown, waitFor, S } from "../_view-shell";

const A = "acct-aaaa";
const B = "acct-bbbb";
const WORDS = "Half a letter for A";

let root: Root | null = null;

const ROSTER = async () => [{
  id: "mb1", address: "me@example.invalid", status: "connected", errorCode: null,
  disabledReason: null, syncBlockedReason: null, syncBlockedSince: null,
  lastSyncAt: "2026-09-16T08:59:00.000Z", createdAt: "2026-09-01T00:00:00.000Z",
  organizerRole: "organizer" as const, organizedBy: null, organizeConsentedAt: "2026-09-01T00:00:00.000Z",
}];

/** The modules a mount needs, loaded once: an entry's component keeps one identity across renders, as a real one does. */
async function loaded() {
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const { MailShell } = await import("../_mail-shell");
  return { ThemeProvider, ToastHost, MailShell };
}
let parts: Awaited<ReturnType<typeof loaded>> | null = null;

async function draw(engine: OhmailEngine, scope: string) {
  parts ??= await loaded();
  const { ThemeProvider, ToastHost, MailShell } = parts;
  /* As an entry builds it: the host names the scope, and the frame under it is keyed by it. One component for every
     draw, so only the frame's own key can end what stood under the scope before. */
  const tree = h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", now: NOW } as never,
    h(TextProvider, { locale: "en", messages: messages as never, timeZone: "UTC" } as never,
      h(ThemeProvider as never, null, h(ToastHost as never, null,
        h(MailShell, { demo: false, engine, scope, consentTransport, mailboxFacts: ROSTER } as never)))));
  if (root === null) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => { root!.render(tree); });
}

/** Write's Subject (a textarea that grows; today's was an input). */
const subject = (): HTMLInputElement | HTMLTextAreaElement | null =>
  document.querySelector<HTMLInputElement | HTMLTextAreaElement>('input[aria-label="Subject"], textarea[aria-label="Subject"]');

beforeEach(() => {
  setup();
  resetStorageOwnerForTest();
  window.location.hash = "#/compose";
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  resetStorageOwnerForTest();
  await teardown();
});

describe("a change of scope", () => {
  it("mounts the frame again: B's composer is empty, nothing under B carries A's words, A's letter is back", async () => {
    const original = new DraftServer();
    const replacement = new DraftServer();
    const engines = { [A]: await original.device(), [B]: await replacement.device() };
    let answer!: () => void;
    const pending = new Promise<void>((resolve) => { answer = resolve; });
    const sent: Array<{ owner: string; words: string }> = [];
    for (const [owner, engine] of Object.entries(engines)) {
      const mutate = engine.mutate.bind(engine);
      vi.spyOn(engine, "mutate").mockImplementation(async (mutation, options) => {
        sent.push({ owner, words: JSON.stringify(mutation) });
        if (owner === A && mutation.kind === "draft_save") await pending;
        return mutate(mutation, options);
      });
    }

    const body = "First words. And the last words.";
    try {
      setStorageOwner(A);
      S.engine = engines[A];
      await draw(engines[A], A);
      await waitFor(() => subject() !== null, "the composer under A");
      const editor = await screen.findByRole("textbox", { name: "Message" });
      await act(async () => {
        fireEvent.change(subject()!, { target: { value: WORDS } });
        typeInto(editor, "First words.");
      });
      await waitFor(() => Object.keys(localStorage).some((k) => (localStorage.getItem(k) ?? "").includes(WORDS)), "A's words kept on this device");
      await waitFor(() => sent.some((write) => write.owner === A && write.words.includes("First words.")), "A's autosave");
      await act(async () => { typeInto(editor, body); });

      setStorageOwner(B);
      S.engine = engines[B];
      await draw(engines[B], B);
      await waitFor(() => subject() !== null, "the composer under B");
      expect(subject()!.value).toBe("");
      await act(async () => { answer(); });
      await waitFor(() => [...original.rows.values()].some((row) => row.body === body), "all words on the previous account");
      expect([...original.rows.values()]).toEqual([expect.objectContaining({ subject: WORDS, body })]);
      expect(replacement.rows.size).toBe(0);
      expect(sent.filter((write) => write.owner === B && write.words.includes(WORDS))).toEqual([]);

      setStorageOwner(A);
      S.engine = engines[A];
      await draw(engines[A], A);
      await waitFor(() => subject()?.value === WORDS, "A's letter back under A");
      expect(screen.getByRole("textbox", { name: "Message" }).textContent).toBe(body);
    } finally {
      await act(async () => { answer(); });
      engines[A].dispose();
      engines[B].dispose();
    }
  }, 15_000);

  it("a late calendar attachment from the previous account cannot change the open reader", async () => {
    const id = "same-message";
    const partId = "same-part";
    const summaryA = "Planning for the original account";
    const summaryB = "Planning for the replacement account";
    const calendar = (summary: string) => new Response([
      "BEGIN:VCALENDAR", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:fixture",
      "DTSTART:20260916T140000Z", `SUMMARY:${summary}`, "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n"), { headers: { "content-type": "application/octet-stream" } }).blob();
    let answerA!: (value: Blob) => void;
    const pendingA = new Promise<Blob>((resolve) => { answerA = resolve; });
    const returnedA = vi.fn();
    const fetchA = vi.fn(async () => {
      const bytes = await pendingA;
      returnedA();
      return bytes;
    });
    async function engineFor(accountId: string, fetchAttachment: EngineAdapter["fetchAttachment"]) {
      const store = await storeWith([msg(id, { accountId, hasAttachments: true, attachmentCount: 1 })]);
      const adapter: EngineAdapter = {
        sync: async () => ({
          changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: store.getCursor(),
          hasMore: false, serverTime: NOW.toISOString(),
        }),
        mutate: async () => ({ changes: [], seq: null }),
        withdrawSend: async () => ({ outcome: "unsupported" }),
        fetchBody: async () => ({
          text: "An invitation", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
        }),
        listAttachments: async () => [{
          id: partId, filename: "invite.ics", contentType: "text/calendar", sizeBytes: 200, inline: false, messageId: id,
        }],
        fetchAttachment,
      };
      return engineOver(store, { adapter });
    }
    const original = await engineFor(A, fetchA);
    const replacement = await engineFor(B, () => calendar(summaryB));
    window.location.hash = `#/ohbox/m/${id}`;

    setStorageOwner(A);
    S.engine = original;
    await draw(original, A);
    await waitFor(() => fetchA.mock.calls.length > 0, "the original account's pending calendar part");
    const originalCalendar = original.loadCalendarTexts(id);

    setStorageOwner(B);
    S.engine = replacement;
    await draw(replacement, B);
    const region = await screen.findByRole("region", { name: "Open message" });
    await within(region).findByText(summaryB);
    const blob = await calendar(summaryA);
    await act(async () => { answerA(blob); await originalCalendar; });

    expect(returnedA).toHaveBeenCalledTimes(1);
    expect(original.calendarTextsOf(id).has(partId)).toBe(false);
    expect(screen.getByRole("region", { name: "Open message" })).toBe(region);
    expect(region.querySelectorAll(".ics-card")).toHaveLength(1);
    expect(within(region).queryByText(summaryA)).toBeNull();
    expect(within(region).getByText(summaryB)).toBeTruthy();
    original.dispose();
  });
});
