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
import { fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextProvider } from "@ohmail/app/text";
import { setStorageOwner, resetStorageOwnerForTest } from "@ohmail/app-logic/storage/storage-owner";
import type { OhmailEngine } from "@ohmail/client-engine";
import messages from "../../messages/en.json";
import { act, consentTransport, engineOver, NOW, setup, storeWith, teardown, waitFor, S } from "../_view-shell";

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
    /* Each account its own engine, as a host binds one per owner (`app/shell/engine.tsx`) and hands it with the scope:
       what A's composer writes as it is taken down goes to A's engine, and B's engine is what "under B" means. Today's
       composer wrote nothing as it was taken down, so one engine for both stood in for two; Write's composer writes its
       last words as it leaves (`compose-autosave.ts`, the belt), to the engine it was mounted over. */
    const engines = { [A]: engineOver(await storeWith([])), [B]: engineOver(await storeWith([])) };
    const sent: Array<{ owner: string; words: string }> = [];
    for (const [owner, engine] of Object.entries(engines)) {
      const mutate = engine.mutate.bind(engine);
      vi.spyOn(engine, "mutate").mockImplementation(((m: unknown, ...rest: unknown[]) => {
        sent.push({ owner, words: JSON.stringify(m) });
        return (mutate as (...a: unknown[]) => unknown)(m, ...rest);
      }) as never);
    }

    setStorageOwner(A);
    S.engine = engines[A]!;
    await draw(engines[A]!, A);
    await waitFor(() => subject() !== null, "the composer under A");
    await act(async () => { fireEvent.change(subject()!, { target: { value: WORDS } }); });
    await waitFor(() => Object.keys(localStorage).some((k) => (localStorage.getItem(k) ?? "").includes(WORDS)), "A's words kept on this device");

    setStorageOwner(B);
    S.engine = engines[B]!;
    await draw(engines[B]!, B);
    await waitFor(() => subject() !== null, "the composer under B");
    expect(subject()!.value).toBe("");
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(sent.filter((s) => s.owner === B && s.words.includes(WORDS))).toEqual([]);

    setStorageOwner(A);
    S.engine = engines[A]!;
    await draw(engines[A]!, A);
    await waitFor(() => subject()?.value === WORDS, "A's letter back under A");
  });
});
