/** @vitest-environment jsdom */
/**
 * ═══ COMPOSE IS A PANEL WITH A HEAD, A MESSAGE AND A FOOT ═════════════════════════════════
 *
 * The pass this file guards is a composition, so the assertions are about STRUCTURE — which
 * element contains which — and not about a computed pixel. Two of the three are things a
 * screenshot cannot tell you and a CSS change cannot fake:
 *
 *  1. THE CC/BCC AFFORDANCE IS INSIDE THE `TO` ROW. It had a full-width strip of its own
 *     (`.c-ccbcc-row`) between To and Subject, which read as a fourth field and cost the form a
 *     band of vertical space to say one 11.5px word. Lifting the button back out of the row is
 *     exactly the mutation this catches: `closest(".c-field")` stops resolving to the To field
 *     and the first assertion goes red. A test that merely asked "is there a Cc/Bcc button"
 *     would pass against the shipped defect, which is why it asks WHERE.
 *
 *  2. IT STILL OPENS THE FIELDS. Moving a control is only safe if it still does its job, so the
 *     press is driven and both rows are read out of the DOM.
 *
 *  3. THE PANEL'S THREE REGIONS ARE IN ORDER AND THE FOOT IS LAST. `.compose-head`,
 *     `.compose-editor`, `.compose-foot` are direct children of `.compose-wrap` in that order,
 *     and Send and the status line are both inside the foot — which is what `margin-top: auto`
 *     acts on. Put SendStatus back outside the foot and the last assertion fails.
 *
 * Mounted through the shipped shell rather than by handing `ComposeView` props, for the reason
 * `compose-from.test.ts` gives about the From row: the defect this replaces was a working data
 * path with the wrong thing on screen, so the acceptance is the rendered surface.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/**
 * A file under `apps/webapp`, read whichever directory the runner was started in.
 *
 * `import.meta.url` is NOT a `file:` URL under the root vitest config's jsdom environment, so
 * the `fileURLToPath(new URL(rel, import.meta.url))` idiom used by tests that only ever run
 * from `apps/webapp` throws here. This suite has to work from both, because the root run is
 * what CI does.
 */
function readSource(rel: string): string {
  const fromRoot = `apps/webapp/${rel}`;
  return readFileSync(existsSync(fromRoot) ? fromRoot : rel, "utf8");
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

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
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

async function mountCompose(): Promise<void> {
  const { AppShell } = await import("./_todays-shell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
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
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
  await act(async () => {
    window.location.hash = "#/compose";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await settleFirstPaint();
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}

const q = <T extends Element>(sel: string): T | null => host!.querySelector<T>(sel);

describe("the Cc/Bcc affordance lives in the To row", () => {
  it("is a child of the SAME `.c-field` as the To input, not a strip of its own", async () => {
    await mountCompose();

    const to = q<HTMLElement>("#compose-to");
    expect(to, "compose did not render a To field at all").not.toBeNull();

    const toRow = to!.closest(".c-field");
    expect(toRow, "the To input is no longer inside a `.c-field` row").not.toBeNull();
    expect(
      toRow!.querySelector(".c-ccbcc-toggle"),
      "the Cc/Bcc toggle is not inside the To row — it has been lifted back out into a strip",
    ).not.toBeNull();

    // …and the strip it replaced is gone from the product, not merely unused.
    expect(
      q(".c-ccbcc-row"),
      "`.c-ccbcc-row` is back: the standalone Cc/Bcc strip was the thing this pass removed",
    ).toBeNull();
  });

  it("still opens Cc and Bcc, and takes itself off screen once they are up", async () => {
    await mountCompose();
    expect(q("#compose-cc"), "Cc was already open before the toggle was pressed").toBeNull();

    await act(async () => { q<HTMLButtonElement>(".c-ccbcc-toggle")!.click(); });

    expect(q("#compose-cc"), "the toggle no longer reveals Cc").not.toBeNull();
    expect(q("#compose-bcc"), "the toggle no longer reveals Bcc").not.toBeNull();
    expect(
      q(".c-ccbcc-toggle"),
      "the toggle is still on screen with nothing left to reveal",
    ).toBeNull();
  });
});

describe("the panel is head · message · foot, in that order", () => {
  it("has the three regions as direct children of `.compose-wrap`", async () => {
    await mountCompose();
    const wrap = q<HTMLElement>(".compose-wrap");
    expect(wrap, "compose rendered no panel").not.toBeNull();

    const regions = [...wrap!.children]
      .map((c) => [...c.classList].find((n) => n.startsWith("compose-")))
      .filter((n): n is string => n !== undefined);
    expect(
      regions,
      "the panel's regions are not head → editor → foot; the composition has been undone",
    ).toEqual(["compose-head", "compose-editor", "compose-foot"]);
  });

  it("puts From, To and Subject in the head and NOTHING else there", async () => {
    await mountCompose();
    const head = q<HTMLElement>(".compose-head")!;
    expect(head.querySelector("#compose-from"), "From left the header block").not.toBeNull();
    expect(head.querySelector("#compose-to"), "To left the header block").not.toBeNull();
    expect(head.querySelector("#compose-subject"), "Subject left the header block").not.toBeNull();
    // The editor is the panel's own child, not the head's — that is what lets it take the slack.
    expect(
      head.querySelector(".compose-editor"),
      "the editor is nested inside the header block, so it cannot grow with the panel",
    ).toBeNull();
  });

  it("keeps Send AND the status line inside the foot, which is the last region", async () => {
    await mountCompose();
    const wrap = q<HTMLElement>(".compose-wrap")!;
    const foot = q<HTMLElement>(".compose-foot")!;
    expect(wrap.lastElementChild, "the foot is no longer the panel's last child").toBe(foot);
    expect(foot.querySelector(".send-row button"), "Send is not in the foot").not.toBeNull();
    // `SendStatus` renders nothing at rest, so the pin is on the markup rather than on a node:
    // it is the region the component is written into that this slice moved.
    const view = readSource("app/views/ComposeView.tsx");
    const footBlock = view.slice(view.indexOf('className="compose-foot"'));
    expect(
      footBlock.indexOf("<SendStatus"),
      "SendStatus has been moved back out of the foot — it would no longer travel with Send",
    ).toBeGreaterThan(-1);
    expect(
      footBlock.indexOf("<SendStatus"),
      "SendStatus is outside the foot's closing tag",
    ).toBeLessThan(footBlock.indexOf("</section>"));
  });

  it("renders Subject BARE — an accessible name, no label element", async () => {
    await mountCompose();
    const subject = q<HTMLInputElement>("#compose-subject")!;
    expect(
      host!.querySelector('label[for="compose-subject"]'),
      "the Subject label gutter is back",
    ).toBeNull();
    // Bare is not nameless. Losing this is the one way "bare" becomes a regression.
    expect(subject.getAttribute("aria-label"), "Subject has no accessible name").toBe("Subject");
  });
});
