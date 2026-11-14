/** @vitest-environment jsdom */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import { SettingsView } from "../app/views/SettingsView";
import {
  NOTIFICATION_CHANNELS_KEY, NOTIFY_CACHE, NOTIFY_STATE_URL,
  type NotificationHost, type PushSyncOutcome,
} from "../app/shell/notification-settings";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE SETTINGS DOOR MAY NOT ARM THE WORKER EITHER —
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── THE DEFECT, AND WHY IT IS THE OTHER HALF OF THE BOOT ONE RATHER THAN A NEW ROW ────────
 *
 * The boot path was fixed to arm the service worker only for a row the SERVER named for THIS
 * session. The settings pane kept the shape the boot lost: `writeNotifyState(wanted, …)` first
 * and unconditionally, where `wanted` is `subscriptionWanted()` — an INTENT, computed from
 * switches and an OS permission that both survive a sign-out by design, and which says nothing
 * about whose registration is live on this browser.
 *
 * So the sequence that the boot fix closes reopened one click later:
 *
 *   1. A signs out; the DELETE loses its budget, `row_remains` retains the row deliberately, and
 *      the unload beats the local unsubscribe. A's row is live and the sender still dials it.
 *   2. B signs in. The boot reconcile refuses to arm — the fix working.
 *   3. B OPENS SETTINGS. The worker is armed over A's row, and the next push for A's mail is
 *      drawn on B's screen.
 *
 * ── AND STEP 3 IS NOT "OPENS THE NOTIFICATIONS PANE" ──────────────────────────────────────
 *
 * `AppShell` mounts `SettingsView` on `effectiveView === "settings"`, and the reconcile effect
 * lives in the VIEW body rather than in the notifications pane — so it fires when the reader
 * opens Settings at ALL. General, Account, About. That is what makes this a one-click reversal
 * of a privacy fix rather than an obscure path, and it is why the mount case below deliberately
 * renders a pane that is NOT notifications.
 *
 * Both ON-capable call sites are covered: the mount reconcile, and `setNotify` — the press.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const cachePuts: { url: string; body: string }[] = [];

function installFakeCaches(): void {
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      open: () => Promise.resolve({
        put: async (url: string, res: Response) => {
          cachePuts.push({ url, body: await res.text() });
        },
        match: async (url: string) => {
          const held = [...cachePuts].reverse().find((p) => p.url === url);
          return held
            ? new Response(held.body, { headers: { "content-type": "application/json" } })
            : undefined;
        },
      }),
    },
  });
}

/** What the pane asked the subscription layer for, and with which options. */
function hostAnswering(outcome: PushSyncOutcome | null): NotificationHost & {
  asked: { wanted: boolean; forced: boolean }[];
} {
  const asked: { wanted: boolean; forced: boolean }[] = [];
  return {
    asked,
    permission: () => "granted",
    request: () => Promise.resolve("granted"),
    syncSubscription: (wanted: boolean, opts?: { forceAnnounce?: boolean }) => {
      asked.push({ wanted, forced: opts?.forceAnnounce === true });
      return Promise.resolve(outcome);
    },
  };
}

/** Every switch a reader left ON — an install preference that survives a sign-out. */
const ALL_ON = JSON.stringify({
  master: true, ohbox: true, screener: true,
  scheduled: true, pairing: true, showSenderAndSubject: false,
});

let host: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  window.localStorage.clear();
  cachePuts.length = 0;
  installFakeCaches();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  host.remove();
  window.localStorage.clear();
});

async function renderPane(pane: string, notificationHost: NotificationHost): Promise<void> {
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC",
        children: h(ThemeProvider, {
          children: h(ToastHost, {
            children: h(SettingsView as never, {
              notifications: null, tags: [], tagCounts: {},
              initialPane: pane, notificationHost,
            } as never),
          }),
        }),
      }),
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

/** Flip the pane's first switch — master — and let the act settle. */
async function pressFirstSwitch(): Promise<void> {
  const first = [...host.querySelectorAll<HTMLElement>('[role="switch"]')][0]!;
  await act(async () => {
    first.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const enabledNow = (): unknown => {
  const last = cachePuts.filter((p) => p.url === NOTIFY_STATE_URL).at(-1);
  return last === undefined ? undefined : JSON.parse(last.body).enabled;
};

describe("the Settings door and the previous reader's registration", () => {
  it("OPENING SETTINGS ON ANOTHER TAB does not arm the worker over a row that is not ours", async () => {
    /*
     * Step 3, and deliberately on the GENERAL pane: the effect is in the view body, so the
     * notifications pane is not required to reach it. A guard that opened the notifications pane
     * would pass over a narrower path than the one people take.
     *
     * The host refuses, which is what the server does for a foreign row: the endpoint conflicts
     * and the account-scoped lookup cannot see another account's registration.
     */
    window.localStorage.setItem(NOTIFICATION_CHANNELS_KEY, ALL_ON);
    const wired = hostAnswering("not_registered");

    await renderPane("general", wired);

    expect(
      enabledNow(),
      "opening Settings re-armed the worker while the only live row still belonged to the "
      + "previous reader — the boot fix is reversible by one click",
    ).toBe(false);
    // …and the pane may not take the `unchanged` shortcut: a mount is not a press and proves
    // nothing about whose session this is.
    expect(wired.asked, "the pane trusted a stored id instead of re-announcing")
      .toEqual([{ wanted: true, forced: true }]);
  });

  /**
   * `setNotify`, the second ON-capable site. The row this closes cited only the mount effect, so
   * a fix written to the row as filed would have left this half open.
   *
   * ── AND `enabled: false` ALONE DOES NOT PROVE THIS REACHED THE ARMING PATH ────────────────
   *
   * Review caught the first version of this case asserting only `enabledNow() === false`, which
   * BOTH paths satisfy: a press that turns notifications ON and is refused writes `false` through
   * `setNotifyEnabled`, and a press that turns them OFF writes `false` through
   * `disarmNotifyState`. Identical assertion, opposite journeys.
   *
   * It happened to take the ON path, and only because of two facts the test did not pin:
   * `DEFAULT_CHANNELS.ohbox` is true, so `{master:false}` merges to `ohbox:true` and flipping
   * master alone makes `subscriptionWanted` true; and the first `[role="switch"]` in this pane
   * happens to be master. Reorder the pane, flip a default, or tighten `pressMaster`'s gate, and
   * this silently becomes an assertion about the OFF path — green for ever, over the exact site
   * the row was corrected to include.
   *
   * So the press is pinned the way the mount already was: on what the host was ASKED.
   */
  it("THE PRESS is gated the same way — turning the switch on is a wish, not a row", async () => {
    window.localStorage.setItem(NOTIFICATION_CHANNELS_KEY, JSON.stringify({ master: false }));
    const wired = hostAnswering("not_registered");
    await renderPane("notifications", wired);
    cachePuts.length = 0;
    wired.asked.length = 0;

    await pressFirstSwitch();

    expect(
      wired.asked,
      "the press never reached the arming path — this case would assert the OFF journey",
    ).toEqual([{ wanted: true, forced: true }]);
    expect(
      enabledNow(),
      "the press armed the worker before anything answered — over the previous reader's row",
    ).toBe(false);
  });

  it("CONTROL: the same press ARMS when the server names the row", async () => {
    // Without this, the case above could pass by never arming under any circumstances — the same
    // argument the mount case's control makes, which the press was missing.
    window.localStorage.setItem(NOTIFICATION_CHANNELS_KEY, JSON.stringify({ master: false }));
    const wired = hostAnswering("subscribed");
    await renderPane("notifications", wired);
    cachePuts.length = 0;
    wired.asked.length = 0;

    await pressFirstSwitch();

    expect(wired.asked).toEqual([{ wanted: true, forced: true }]);
    expect(enabledNow(), "a legitimate press never armed the worker").toBe(true);
  });

  it("CONTROL: a row the server DID name arms it, or the two above pass by never arming", async () => {
    window.localStorage.setItem(NOTIFICATION_CHANNELS_KEY, ALL_ON);

    await renderPane("general", hostAnswering("subscribed"));

    expect(enabledNow(), "a legitimate reader's own registration never armed the worker")
      .toBe(true);
  });

  it("switches OFF still disarm first and unconditionally — the safe direction is unchanged", async () => {
    // The OFF half must not acquire a precondition: a worker told not to draw cannot leak, and
    // that write needs neither the network nor a live subscription.
    window.localStorage.setItem(NOTIFICATION_CHANNELS_KEY, JSON.stringify({ master: false }));

    await renderPane("general", hostAnswering("not_registered"));

    expect(enabledNow()).toBe(false);
  });
});

describe("SOURCE CENSUS — one gated way to arm, and no obvious ungated one", () => {
  /**
   * The module offers `setNotifyEnabled` (gated on an outcome) and `writeNotifyStateUnchecked`
   * (not gated). Both doors that armed this browser reached for the ungated one while it was
   * called `writeNotifyState` — the natural import — so the rename is half the fix and this is
   * the half that holds.
   *
   * Comments are stripped first: this file and that module both discuss the banned call by name,
   * and a census that read raw bytes would be red on its own documentation, which is how a guard
   * gets weakened to make it pass.
   */
  const APP = existsSync("apps/webapp/app") ? "apps/webapp/app" : "app";
  const code = (rel: string): string => readFileSync(`${APP}/${rel}`, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "$1")).join("\n");

  it("no surface outside the module calls the ungated writer at all", () => {
    /*
     * SWEPT, not enumerated. The first version listed three files, which is narrower than the
     * claim made for it — and narrower in exactly the direction that reintroduces this defect: a
     * NEW surface (a notifications pane extracted out of `SettingsView`, say) is the shape that
     * reaches for the still-exported import, and a fixed list cannot see one arrive.
     */
    const owner = "shell/notification-settings.ts";
    /** The behaviour moved out of the shell, read with it (a path from the app's folder). */
    const LOGIC = "../../../packages/app-logic/src";
    const files = readdirSync(APP, { recursive: true, encoding: "utf8" })
      .filter((f) => /\.tsx?$/.test(f))
      .map((f) => f.split(sep).join("/"))
      .filter((f) => f !== owner)
      .concat(readdirSync(`${APP}/${LOGIC}`, { recursive: true, encoding: "utf8" })
        .filter((f) => /\.tsx?$/.test(f))
        .map((f) => `${LOGIC}/${f.split(sep).join("/")}`));
    // The sweep must actually be sweeping: a glob that silently matched nothing would pass.
    expect(files.length, "the census walked no files").toBeGreaterThan(50);
    expect(files, "the census skipped the pane it was written for")
      .toContain("views/SettingsView.tsx");

    const offenders = files.filter((f) => /writeNotifyStateUnchecked/.test(code(f)));
    expect(
      offenders,
      "a surface outside the module reaches for the ungated notify-state writer — arming has a "
      + "precondition, and it lives in applyWakeIntent rather than in the writer",
    ).toEqual([]);
  });

  it("and the pane arms through the shared, bounded act — not through a writer of its own", () => {
    const pane = code("views/SettingsView.tsx");
    // Both ON-capable sites go through it; two calls, no more, no fewer.
    expect([...pane.matchAll(/applyWakeIntent\(/g)]).toHaveLength(2);
    // …and the pane's sentence is set from the OUTCOME rather than from the wish.
    expect(pane).toMatch(/\.then\(showDelivery\)/);
    expect(pane).toMatch(/if \(alive\) showDelivery\(o\);/);
  });
});
