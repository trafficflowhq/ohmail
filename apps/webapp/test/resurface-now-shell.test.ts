/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { FixturesAdapter, type EngineMutation } from "@ohmail/client-engine";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import { stubThreadLayout, type ThreadLayout } from "./fixtures/thread-layout.js";

/**
 * "RESURFACE NOW", DRIVEN THROUGH THE SHELL.
 *
 * `action-bar.test.ts` pins what the panel DISPATCHES (`resurface_now`, never a `resurface:`
 * date). This pins what the shell does with it, which is a separate failure with a distinctive
 * shape: `onAction`'s switch ends in a `default` arm that parses anything unrecognised as
 * `move:<view>`, so a missing case does not throw and does not warn — `"resurface_now".slice(5)`
 * is not a view, `FOLDER_OF_VIEW[…]` is undefined, and the press becomes a silent no-op. The
 * only way to see that is to count what reached the adapter.
 *
 * The state matters as much as the count. `bubbled_up` with a past instant would satisfy "a
 * triage_set was sent" while pinning nothing until a bubble-up pass ran — and a standalone
 * desktop install runs none.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let sent: EngineMutation[] = [];

function setViewport(): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false, media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

async function mountShell(): Promise<void> {
  await unmount();
  const { AppShell } = await import("../app/shell/AppShell.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(ToastHost, { children: h(AppShell, { demo: true }) }),
        }),
      }),
    );
  });
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
  // The Ohbox selects nothing by itself — land the cursor on the first row.
  await key("j");
}

const key = async (k: string): Promise<void> => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
};

const click = async (el: Element | null | undefined): Promise<void> => {
  expect(el, "nothing to click").toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};

/** An action-bar control by the START of its label — labels carry keycaps. */
const barButton = (label: string): HTMLButtonElement | undefined =>
  [...host!.querySelectorAll<HTMLButtonElement>(".abar button")]
    .find((b) => (b.textContent ?? "").trim().startsWith(label));

const kinds = (kind: string) => sent.filter((m) => m.kind === kind);

/** The reader is laid out, so an open message's lines are on screen and the rule reads it. */
let layout: ThreadLayout;
beforeEach(() => {
  vi.useFakeTimers();
  layout = stubThreadLayout();
  setViewport();
  window.location.hash = "#/ohbox";
  sent = [];
  // Counted at the ADAPTER — the last thing before the wire — and CALLED THROUGH, so the
  // engine's overlay is reconciled rather than frozen. See `shell-screening-bulk.test.ts`.
  const real = FixturesAdapter.prototype.mutate;
  vi.spyOn(FixturesAdapter.prototype, "mutate").mockImplementation(async function (
    this: FixturesAdapter,
    ...args: Parameters<FixturesAdapter["mutate"]>
  ) {
    sent.push(args[0] as EngineMutation);
    return real.apply(this, args);
  } as never);
});

afterEach(async () => {
  await unmount();
  layout.restore();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the resurface chooser's fourth answer, through the shell", () => {
  it("Now puts `triage_set → resurfaced` on the wire, with no bubbleUpAt", async () => {
    await mountShell();
    // The message under the cursor shows its action bar in the column. A preview: it reads
    // nothing, so the demo mailbox the next cases mount still holds it unread.
    const resurface = barButton("Resurface");
    expect(resurface, "the reader has no Resurface control").toBeTruthy();

    sent = [];
    await click(resurface);
    await click(barButton("Now"));

    const sets = kinds("triage_set");
    expect(sets, "the press reached the adapter as nothing at all").toHaveLength(1);
    const set = sets[0] as { state: string; bubbleUpAt?: string | null };
    // THE STATE, not a date. `bubbled_up` here would be the implementation this slice rejects.
    expect(set.state).toBe("resurfaced");
    expect(set.bubbleUpAt ?? null, "a schedule was attached to an answer that has none").toBeNull();
    // And nothing else was dispatched — the `default` arm did not also read it as a move.
    expect(kinds("move")).toHaveLength(0);
  });
});

/**
 * A GLANCE READS BUT MUST NOT SPEND A RESURFACE, ASSERTED THROUGH THE WHOLE CHAIN. Under
 * the 2026-08-26 ruling a glance-read LANDS, and only the server can keep the pin — if the LABEL
 * reaches the wire. Three links, each silent alone: `OhboxView.readByRule` labels its save `via:
 * "glance"`, `AppShell`'s `markSeen` FORWARDS it, the adapters send it (`MessageService` skips
 * `spendResurface`). A two-parameter callback is assignable where three are expected, so a
 * dropped `via` is no type error; this counts at the ADAPTER, downstream of every link.
 */
describe("a resurfaced row survives being looked at, through the shell", () => {
  const seenIds = (): string[] =>
    (kinds("mark_seen") as Array<{ messageIds: string[] }>).flatMap((m) => m.messageIds);

  const pagehide = async (): Promise<void> => {
    await act(async () => { window.dispatchEvent(new Event("pagehide")); });
  };

  it("opening a pinned row sends the read AS A GLANCE — the label on the wire", async () => {
    await mountShell();                     // the cursor is on the first row, a preview
    await click(barButton("Resurface"));
    await click(barButton("Now"));

    sent = [];
    // Open it: the read rule saves the read once its top was on screen for the dwell.
    await key("Enter");
    await act(async () => { vi.advanceTimersByTime(100); });
    await layout.passDwell(); // its top on screen for the dwell: read
    await pagehide();

    // The read TRAVELS — dropping it was the reported flip-back (a pinned row presented
    // as read while open and turned back to unread on leave, because nothing ever landed)…
    expect(
      seenIds(),
      "the glance-read of a pinned row never left the client — it will not stick",
    ).toEqual(["giulia"]);
    // …and it travels LABELLED, which is what stops the server spending the pin on it.
    const glance = kinds("mark_seen")[0] as { via?: string; unread: boolean };
    expect(glance.unread).toBe(false);
    expect(glance.via, "the pinned row's read arrived deliberate — the pin is spent").toBe("glance");
  });

  /**
   * THE POSITIVE CONTROL: the same gesture on an UNPINNED row saves the read with the same label,
   * so the label above is the shell's forwarding and not an accident of the pinned path.
   */
  it("…while the same gesture on an unpinned row still saves the read", async () => {
    await mountShell();

    sent = [];
    await key("Enter");
    await act(async () => { vi.advanceTimersByTime(100); });
    await layout.passDwell(); // its top on screen for the dwell: read
    await pagehide();

    expect(seenIds(), "the open's read is not firing at all").toHaveLength(1);
    const glance = kinds("mark_seen")[0] as { via?: string; unread: boolean };
    expect(glance.unread).toBe(false);
    // The label survived the shell. Without this the id above would have been sent for a PINNED
    // row too, and the first test would be the one that failed — but this names the link.
    expect(glance.via, "AppShell.markSeen dropped `via` on the way to the engine").toBe("glance");
  });
});
