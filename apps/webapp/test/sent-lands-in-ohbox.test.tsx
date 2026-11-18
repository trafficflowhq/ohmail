/** @vitest-environment jsdom */
import type { EngineMutation } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { OhmailEngine, type MutationResult } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { typeInto } from "./fixtures/rich-editor-driver";

/**
 * ═══ PRESS SEND AND YOU ARE BACK IN THE OHBOX, WITH THE MESSAGE AT THE TOP ═══════════════
 *
 * Three things had to be true at once for this to work, and none of them was:
 *
 *  · Compose never left. A confirmed send emptied the form and stayed put, so the only thing
 *    that said the message had gone was a toast over a blank compose surface. `cancelCompose`
 *    navigated; the successful path did not.
 *  · The row was not there to arrive at. The engine mints an optimistic Sent copy from the
 *    server's own `{status:"sent"}` answer, and that call sat below a full reconciliation
 *    drain — a drain that cannot carry a sent message, because the only `change_log` row a
 *    send writes is the draft's flip to `sent`.
 *  · And when the row did land it landed at the BOTTOM. "Earlier" is ordered by reading, and
 *    nothing stamps `lastReadAt` on outbound mail, so a sent message sorted below every
 *    message the reader had ever opened.
 *
 * Driven through the whole shipped shell on the demo world, because every one of these lives
 * in the wiring: the engine's dispatch order, the selector's order, and the shell's callback.
 * The demo's adapter answers a minted `providerMessageId` exactly as the live route does — a
 * demo that cannot show sent mail is not showing the product.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];

beforeEach(() => {
  window.location.hash = "";
  try { window.localStorage.clear(); } catch { /* storage blocked; the in-memory half still runs */ }
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  });
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {} unobserve(): void {} disconnect(): void {}
    takeRecords(): [] { return []; }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const root of roots) await act(() => { root.unmount(); });
  roots = [];
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

/**
 * A PRESS CROSSES A TASK BOUNDARY NOW, so a microtask-only drain can no longer observe one.
 * `useMailSend.send` paints the acknowledgement and defers `engine.mutate` to a later task
 * (`afterPaint`), and microtasks drain before the task ends — so this flushes a zero-delay timer
 * per round instead of `Promise.resolve()`.
 */
const drain = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) {
    await act(async () => { await new Promise((r) => { setTimeout(r, 0); }); });
  }
};

/**
 * Run out the CLOSING BEAT a delivered send is held on before the surface closes and the shell
 * navigates (`SENT_BEAT_MS`).
 *
 * The navigation moved onto that beat, deliberately: a confirmed send now SHOWS its delivered
 * state for 600 ms and then leaves, instead of the surface simply vanishing — which read as
 * "something happened" rather than "this was sent". So a case asserting where the reader ENDS UP
 * has to let it elapse. Kept separate from `drain` because the case below that asserts the reader
 * is still on the compose form needs the drain WITHOUT it: that is the whole discrimination
 * between "navigates on the confirmation" and "navigates on the press".
 */
const settled = async (): Promise<void> => {
  const { SENT_BEAT_MS } = await import("@ohmail/app-logic/writing/mail-send");
  await act(async () => { await new Promise((r) => { setTimeout(r, SENT_BEAT_MS + 80); }); });
  await drain();
};

async function shell(): Promise<HTMLElement> {
  const { AppShell } = await import("./_todays-shell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(ToastHost, { children: h(AppShell, { demo: true }) }),
        }),
      }),
    );
  });
  await drain();
  return container;
}

const goto = async (hash: string): Promise<void> => {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await drain();
};

const clickText = async (el: HTMLElement, label: string): Promise<void> => {
  // The label WITHOUT the keycap the button may wear (Send prints its ⌘↵ cap now).
  const bare = (x: HTMLElement): string => {
    const kbd = x.querySelector("kbd")?.textContent ?? "";
    return (x.textContent ?? "").replace(kbd, "").trim();
  };
  const b = [...el.querySelectorAll<HTMLButtonElement>("button")]
    .find((x) => bare(x) === label);
  if (!b) throw new Error(`no button reading ${JSON.stringify(label)} on screen`);
  await act(async () => { b.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
};

/** Rows under a named group, top to bottom — `[role=listbox]` carries the group's label. */
const rowsUnder = (el: HTMLElement, label: string): HTMLElement[] => [
  ...el.querySelectorAll<HTMLElement>(`[aria-label="${label}"] :is(.row, [role=option])[data-id]`),
];

/** Write a whole message into the compose form: one recipient, one line of body. */
async function writeMessage(el: HTMLElement, to: string, body: string): Promise<void> {
  const input = el.querySelector<HTMLInputElement>("#compose-to")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!
      .set!.call(input, to);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    typeInto(el.querySelector<HTMLElement>(".compose-editor .rte-surface")!, body);
  });
  await drain();
}

describe("sending a message returns to the Ohbox, with the message in it", () => {
  /**
   * THE HEADLINE, in one press.
   *
   * Mutations that prove each half bites, WATCHED:
   *  · delete `go("ohbox")` from `onSendSettled`'s compose branch ⇒ the hash stays `#/compose`;
   *  · delete `setOhboxSel(null)` beside it ⇒ a message opened before composing is still open
   *    on arrival (the second test);
   *  · delete the `providerMessageId` the FixturesAdapter answers, or `materializeSentOverlay`
   *    itself ⇒ no row joins "Earlier" at all.
   *
   * The ORDER claim — "first" rather than merely "present" — is asserted here and DISCRIMINATED
   * in `packages/client-engine/test/sent-in-ohbox.test.ts`: the demo's Earlier rows carry no
   * `lastReadAt` at all, so this world cannot tell "ranked by send time" apart from "unstamped
   * rows sort by date". That distinction is the whole of the defect on a live account, so its
   * guard belongs where a mirror can be given real reading times.
   */
  it("lands on the Ohbox with the just-sent message as the FIRST row under Earlier", async () => {
    const el = await shell();
    // Counted on the Ohbox, before leaving it — the list is not mounted while Compose is open.
    const earlierBefore = rowsUnder(el, "Earlier").length;
    expect(earlierBefore, "the demo Ohbox has no Earlier rows to compare against").toBeGreaterThan(0);

    await goto("#/compose");
    await writeMessage(el, "nora@example.net", "Donnerstag passt.");
    await clickText(el, "Send");
    await drain();
    await settled();

    expect(window.location.hash, "a confirmed send left the reader on the compose form")
      .toBe("#/ohbox");

    const earlier = rowsUnder(el, "Earlier");
    expect(earlier.length, "the sent message did not join Earlier").toBe(earlierBefore + 1);
    // The row a sent message wears: "Me → <recipient>" (`sentRowRecipient`). FIRST, because
    // the reader has just finished with it and Earlier is a history of finishing.
    expect(
      earlier[0]!.textContent,
      "the just-sent message is not the top row of Earlier — it is somewhere down the list",
    ).toContain("Me → nora@example.net");
    // …and never in "New for you": nothing you wrote is new to you.
    expect(rowsUnder(el, "New").map((r) => r.textContent ?? "").join("|"))
      .not.toContain("Me → nora@example.net");
  });

  it("arrives with NOTHING selected — no stranger's mail in the reading column", async () => {
    const el = await shell();
    // Open a message first, so there is a selection to be left behind.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true }));
    });
    await drain();
    expect(el.querySelector(".view-ohbox :is(.row.sel, [role=option][data-open])"), "nothing was opened to begin with")
      .not.toBeNull();

    await goto("#/compose");
    await writeMessage(el, "nora@example.net", "Donnerstag passt.");
    await clickText(el, "Send");
    await drain();
    await settled();

    expect(window.location.hash).toBe("#/ohbox");
    expect(
      el.querySelector(".view-ohbox :is(.row.sel, [role=option][data-open])"),
      "the Ohbox still had a message open from before the compose",
    ).toBeNull();
  });

  it("a send that has not confirmed keeps the reader on the compose form", async () => {
    // The other side of "on the confirmation, not on the press". Navigating at press time would
    // take somebody away from a message that may still fail, and away from its text.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const real = OhmailEngine.prototype.mutate;
    vi.spyOn(OhmailEngine.prototype, "mutate").mockImplementation(async function patched(
      this: OhmailEngine, m: EngineMutation,
    ): Promise<MutationResult> {
      if (m.kind === "mail_send") await gate;
      return real.call(this, m);
    });

    const el = await shell();
    await goto("#/compose");
    await writeMessage(el, "nora@example.net", "Donnerstag passt.");
    await clickText(el, "Send");
    await drain();

    expect(window.location.hash, "the shell navigated before the send confirmed").toBe("#/compose");

    release();
    await drain();
    await settled();
    expect(window.location.hash).toBe("#/ohbox");
  });
});
