/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";

import { SettingsView } from "../app/views/SettingsView";

/**
 * TWO CASES OF `settings-section-parity.test.tsx`, MOVED WORD FOR WORD: they
 * draw today's `SettingsView` and wait for their mounts as their rows stood (the Screener's three controls on
 * the desktop: `pane:screener`; the desktop's own pane: `host-panes`). The file they left reads the new
 * Settings' contract and imports nothing that leaves.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const h = React.createElement;

/* `null` between mounts, because half the cases in this file are source assertions that never
   render — an unconditional teardown would fail every one of them on a root that was never
   created, which is a suite reporting twelve failures about a defect that does not exist. */
let host: HTMLDivElement | null = null;
let root: Root | null = null;

/** Take down whatever is mounted, if anything. Idempotent, so a case may re-mount mid-test. */
async function unmount(): Promise<void> {
  const live = root;
  const el = host;
  root = null;
  host = null;
  if (live) await act(() => live.unmount());
  el?.remove();
}

async function mount(props: Parameters<typeof SettingsView>[0]) {
  await unmount();
  host = document.createElement("div");
  document.body.append(host);
  const live = createRoot(host);
  root = live;
  await act(async () => {
    live.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        children: h(ThemeProvider, null, h(ToastHost, null, h(SettingsView, props))),
      }),
    );
  });
}

afterEach(unmount);

const navLabels = () =>
  [...host!.querySelectorAll(".set-nav button")].map((b) => b.textContent?.trim());

const node = (id: string) => h("p", { className: id }, id);

/** Every section prop a signed-in browser tab supplies. */
const WEB: Parameters<typeof SettingsView>[0] = {
  notifications: null,
  tags: [],
  tagCounts: {},
  rules: {
    items: [],
    onRevoke: async () => ({ status: "confirmed" }),
    onRetarget: async () => ({ status: "confirmed" }),
    pastMail: () => null,
  },
  mailboxSection: node("mailboxes"),
  screeningSection: node("screening"),
  autoSuggestSection: node("auto-suggest"),
  dormancySection: node("dormancy"),
  autoUnsubscribeSection: node("auto-unsub"),
  remoteImagesSection: node("remote-images"),
  seedSection: { label: "Sent-mail review", node: node("seed") },
  awaySection: node("away"),
  aiSection: node("ai"),
  billingSection: node("billing"),
  securitySection: node("security"),
  accountSection: node("account"),
  aboutSection: node("about"),
  helpSection: node("help"),
};

/**
 * The same, as the desktop's HOSTED door produces it — the difference being exactly the two
 * rulings this slice made, and nothing else.
 *
 * `remoteImagesSection` and `seedSection` are absent, and both for the SAME reason rather than
 * two: their machinery calls `app/api-client` directly and no injected wire substitutes for it.
 * Consented images load through `GET /img` on this origin, which the desktop window (its CSP
 * admits no address off the machine) does not have; the sent-mail review's whole ceremony is api-client calls.
 * Both are sub-pane rows, so neither removes a nav entry — which is why the nav sets below are
 * identical apart from the one pane the web genuinely cannot have.
 */
const DESKTOP: Parameters<typeof SettingsView>[0] = (() => {
  const { remoteImagesSection: _r, seedSection: _s, ...rest } = WEB;
  return { ...rest, desktopSection: { label: "Desktop", node: node("desktop") } };
})();

describe("SET-P — the two surfaces offer the same panes", () => {
  it("…and adds exactly one the browser cannot have", async () => {
    await mount(WEB);
    const web = navLabels();

    await mount(DESKTOP);
    expect(navLabels().filter((l) => !web.includes(l))).toEqual(["Desktop"]);
  });

  it("the Screener pane on the desktop carries the three controls it used to be short of", async () => {
    await mount({ ...DESKTOP, initialPane: "screener" });
    for (const cls of ["screening", "dormancy", "auto-suggest", "auto-unsub"]) {
      expect(host!.querySelector(`.${cls}`), `the Screener pane lost its ${cls} control`).toBeTruthy();
    }
  });
});
