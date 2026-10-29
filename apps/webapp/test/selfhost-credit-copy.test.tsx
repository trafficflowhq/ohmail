/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { ManagedServiceContext } from "../app/shell/managed-service";
import { DraftReplyCard } from "../app/shell/InlineReply";
import { AutoSuggestRow } from "../app/shell/AutoSuggestRow";
import { SuggestControl } from "../app/views/ScreenerView";
import { DRAFT_REPLY_COST_CREDITS, type DraftReplyControl } from "../app/shell/draft-reply";
import type { AutoOptInControl, SuggestBatchControl } from "../app/shell/screener-suggest";

/**
 * AN UNMETERED HOST STATES NO CREDIT PRICE — read off the rendered offer, the auto-suggest confirm
 * and the Screener's quote. A self-hosted server, the standalone desktop and a paired computer
 * charge nothing, yet the shared shell said "This uses 15 credits of your AI budget" on every host.
 * The managed control keeps its sentence, with the number from `DRAFT_REPLY_COST_CREDITS`.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  host?.remove();
  host = null;
});

const noop = (): void => {};

/** Renders `node` under a catalogue and, when given, a host fact; answers the text a person reads. */
function render(node: React.ReactNode, opts: { locale: "en" | "de"; managed?: boolean }): string {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const tree = (
    <NextIntlClientProvider locale={opts.locale} messages={(opts.locale === "en" ? en : de) as never} timeZone="UTC">
      {opts.managed === undefined ? node : (
        <ManagedServiceContext.Provider value={opts.managed}>{node}</ManagedServiceContext.Provider>
      )}
    </NextIntlClientProvider>
  );
  act(() => { root!.render(tree); });
  return host.textContent ?? "";
}

const offered = (): DraftReplyControl => ({
  phase: "offered", messageId: "m1", cost: DRAFT_REPLY_COST_CREDITS, notice: null,
  open: noop, cancel: noop, confirm: noop,
});
const draftCard = () => (
  <DraftReplyCard chrome={{ control: offered(), pending: null, resolve: noop } as never} messageId="m1" />
);

const autoControl = (credits: number): AutoOptInControl => ({
  supported: true, batchSize: 10, available: 3, phase: "ready",
  quote: { senders: 3, credits }, notice: null, open: noop, cancel: noop,
});
const autoRow = (credits: number) => (
  <AutoSuggestRow on={false} since={null} control={autoControl(credits)} setAutoSuggest={async () => true} />
);

const batch = (credits: number): SuggestBatchControl => ({
  available: 4, resuggestable: 0, unanswered: 4, mode: "new", pool: 4, sizes: [4], size: 4,
  phase: "ready", quote: { senders: 4, credits }, notice: null, progress: null,
  open: noop, openAgain: noop, choose: noop, confirm: noop, cancel: noop,
} as SuggestBatchControl);

const CREDIT_WORDS = { en: /credit|AI budget/i, de: /Punkt|Guthaben|KI-Budget/i } as const;

describe("the draft offer", () => {
  it("CONTROL — a managed host states the price, and the number is the constant's", () => {
    const text = render(draftCard(), { locale: "en" });
    expect(text).toContain(`This uses ${DRAFT_REPLY_COST_CREDITS} credits of your AI budget.`);
    expect(render(draftCard(), { locale: "de", managed: true }))
      .toContain(`Das kostet ${DRAFT_REPLY_COST_CREDITS} Punkte deines KI-Budgets.`);
  });

  it.each(["en", "de"] as const)("%s: an account the Screener already knows has no credits is told so, not offered a price", (locale) => {
    const text = render(
      <DraftReplyCard chrome={{ control: offered(), pending: null, resolve: noop, noCredits: true } as never} messageId="m1" />,
      { locale, managed: true },
    );
    expect(text).toContain((locale === "en" ? en : de).aiRefusal.insufficientCredits);
    expect(text).not.toContain(String(DRAFT_REPLY_COST_CREDITS));
  });

  it.each(["en", "de"] as const)("%s: an unmetered host says what happens and states no price", (locale) => {
    const text = render(draftCard(), { locale, managed: false });
    expect(text).toContain(locale === "en" ? en.draftReply.offerBodyUnmetered : de.draftReply.offerBodyUnmetered);
    expect(text).not.toMatch(CREDIT_WORDS[locale]);
    expect(text).not.toContain(String(DRAFT_REPLY_COST_CREDITS));
  });
});

describe("the auto-suggest confirm", () => {
  it("CONTROL — a managed host states the cost sentence and the quote's credits", () => {
    const text = render(autoRow(3), { locale: "en" });
    expect(text).toContain(en.screener.suggest.autoCost);
    expect(text).toContain("3 senders · 3 credits");
  });

  it.each(["en", "de"] as const)("%s: an unmetered host counts senders and names no credits", (locale) => {
    const text = render(autoRow(0), { locale, managed: false });
    expect(text).toContain(locale === "en" ? "3 senders" : "3 Absender");
    expect(text).not.toMatch(CREDIT_WORDS[locale]);
  });
});

describe("the Screener's suggest quote", () => {
  it("CONTROL — a managed host quotes senders and credits", () => {
    expect(render(<SuggestControl control={batch(4)} />, { locale: "en" })).toContain("4 senders · 4 credits");
  });

  it.each(["en", "de"] as const)("%s: an unmetered host quotes senders only", (locale) => {
    const text = render(<SuggestControl control={batch(0)} />, { locale, managed: false });
    expect(text).toContain(locale === "en" ? "4 senders" : "4 Absender");
    expect(text).not.toMatch(CREDIT_WORDS[locale]);
  });
});
