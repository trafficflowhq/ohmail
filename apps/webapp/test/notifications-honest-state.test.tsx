/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { MAIL_NOTICE_KINDS, type NoticeKind, type NoticePermission } from "@ohmail/client-engine";
import type { HostNoticeEmitter } from "@ohmail/app-logic/notices/use-notices";
import messages from "../messages/en.json";
import { SettingsView, type NotificationsMeta } from "../app/views/SettingsView";
import {
  NOTIFICATION_CHANNELS_KEY,
  /* THE STORED VALUE the emitter reads before every notice — the only thing that actually stops
     one being drawn, and therefore what the desktop cases assert rather than the rendered pip. */
  readChannels,
  type NotificationHost,
  type PushSyncOutcome,
} from "../app/shell/notification-settings";

/**
 * SETTINGS → NOTIFICATIONS — THE PANE MAY NOT CLAIM MORE THAN THE PLATFORM ALLOWS.
 *
 * ── WHAT THIS FILE USED TO HOLD DOWN, AND WHY IT CHANGED ───────────────────────────────────
 *
 * It used to assert the pane rendered NO switches and one sentence saying delivery did not
 * exist. That was right at the time and is wrong now: delivery exists, so the sentence would be
 * the lie. Its own header named the consumer — "the slice that wires `Notification`
 * .requestPermission + a real subscription … rewrites this file to hold THAT down" — and this is
 * that rewrite. The demo-world assertions below are unchanged.
 *
 * It also carried a claim that has since gone stale and is corrected here rather than repeated:
 * that no worker read `push_subscriptions` and that there was "no web-push sender anywhere in
 * the repository". `apps/worker/src/push-wake.ts` is one, with its own content-free census.
 *
 * ── WHAT IT HOLDS DOWN NOW ────────────────────────────────────────────────────────────────
 *
 * One rule, in four platform states: **no switch may claim ON while the OS draws nothing.**
 * A control whose ON position means nothing is the defect this pane WAS, and it does not come
 * back through a permission the pane forgot to read.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const settingsCopy = (messages as unknown as { settings: Record<string, string> }).settings;

const DEMO_META: NotificationsMeta = {
  vipLabel: "VIP — always notifies",
  vips: ["Petra Muhr"],
  learnedSuggestion: {
    text: "You usually open Petra's mail within 5 minutes.",
    target: "Petra Muhr",
    acceptedToast: "Added.",
    dismissedToast: "Okay.",
  },
};

/** A host that answers a fixed platform state; `request` reports what the OS would settle on. */
/** An emitter that draws `carries`, as a surface hands one in. */
function carrying(carries: readonly NoticeKind[]): HostNoticeEmitter {
  return { carries, acts: [], ahead: "none", post: () => {}, takeBack: () => {} };
}

function hostAt(state: NoticePermission, afterAsk: NoticePermission = state): NotificationHost {
  return { permission: () => state, request: () => Promise.resolve(afterAsk), emitter: carrying(MAIL_NOTICE_KINDS) };
}

/** Records what the pane asked the subscription layer for, and answers a fixed outcome. */
function hostSyncing(
  state: NoticePermission,
  outcome: PushSyncOutcome | null = "subscribed",
): NotificationHost & { asked: boolean[] } {
  const asked: boolean[] = [];
  return {
    asked,
    permission: () => state,
    request: () => Promise.resolve(state),
    syncSubscription: (wanted: boolean) => { asked.push(wanted); return Promise.resolve(outcome); },
    emitter: carrying(MAIL_NOTICE_KINDS),
  };
}

let host: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  window.localStorage.clear();
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

async function renderPane(
  notifications: NotificationsMeta | null,
  notificationHost: NotificationHost = hostAt("granted"),
): Promise<void> {
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        children: h(ThemeProvider, {
          children: h(ToastHost, {
            children: h(SettingsView, {
              notifications,
              tags: [],
              tagCounts: {},
              initialPane: "notifications",
              notificationHost,
            }),
          }),
        }),
      }),
    );
  });
}

/** Every switch on the pane — the `Switch` primitive renders `role="switch"`. */
function switches(): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('[role="switch"]')];
}
function switchFor(label: string): HTMLElement | undefined {
  return switches().find((s) => s.getAttribute("aria-label") === label);
}

describe("a granted platform — the switches are real", () => {
  it("renders the master and a switch for each kind this surface's emitter draws, and no other", async () => {
    await renderPane(null);
    // master + the four mail kinds the emitter carries. No switch says who a notice is from or
    // what its subject is: no notice has a place for either.
    expect(switches().map((s) => s.getAttribute("aria-label"))).toEqual(
      ["notifyMaster", "notifyOhbox", "notifyScreener", "notifyScheduled", "notifyPairing"].map((k) => settingsCopy[k]),
    );
  });

  it("offers no switch for a kind the emitter does not draw, and none at all where there is no emitter", async () => {
    await renderPane(null, { ...hostAt("granted"), emitter: carrying(["ohbox", "cal_alert"]) });
    expect(switches().map((s) => s.getAttribute("aria-label"))).toEqual([settingsCopy.notifyMaster, settingsCopy.notifyOhbox]);
    await renderPane(null, { ...hostAt("granted"), emitter: "none" });
    expect(switches().map((s) => s.getAttribute("aria-label")), "a switch that could change nothing").toEqual([settingsCopy.notifyMaster]);
  });

  it("says the privacy sentence, which is now TRUE of the code beneath it", async () => {
    await renderPane(null);
    expect(host.textContent).toContain(settingsCopy.notificationPrivacy!);
  });

  it("says how far the choice reaches — these are this device's", async () => {
    await renderPane(null);
    expect(host.textContent).toContain(settingsCopy.notifyReach!);
  });

  it("the master press is written to storage and rendered back", async () => {
    await renderPane(null);
    const master = switchFor(settingsCopy.notifyMaster!)!;
    expect(master.getAttribute("aria-checked")).toBe("true");
    await act(async () => { master.click(); });
    expect(switchFor(settingsCopy.notifyMaster!)!.getAttribute("aria-checked")).toBe("false");
    expect(JSON.parse(window.localStorage.getItem(NOTIFICATION_CHANNELS_KEY)!).master).toBe(false);
  });

  it("master OFF withdraws the event switches — no control that cannot act", async () => {
    await renderPane(null);
    await act(async () => { switchFor(settingsCopy.notifyMaster!)!.click(); });
    expect(switches()).toHaveLength(1);
    expect(switchFor(settingsCopy.notifyOhbox!)).toBeUndefined();
  });
});

describe("a platform that refuses — no switch may claim ON", () => {
  it("DENIED: the master is disabled, unchecked, and the four events are gone", async () => {
    await renderPane(null, hostAt("denied"));
    const master = switchFor(settingsCopy.notifyMaster!)!;
    expect(master.getAttribute("aria-checked"), "a switch claimed ON under a denied OS").toBe("false");
    expect((master as HTMLButtonElement).disabled).toBe(true);
    expect(switches()).toHaveLength(1);
  });

  it("DENIED: names the system settings, and never tells anyone to turn it on here", async () => {
    await renderPane(null, hostAt("denied"));
    expect(host.textContent).toContain(settingsCopy.notifyDenied!);
  });

  it("UNSUPPORTED: says so, and is not confused with a refusal", async () => {
    await renderPane(null, hostAt("unsupported"));
    expect(host.textContent).toContain(settingsCopy.notifyUnsupported!);
    expect(host.textContent).not.toContain(settingsCopy.notifyDenied!);
    expect((switchFor(settingsCopy.notifyMaster!) as HTMLButtonElement).disabled).toBe(true);
  });

  it("DEFAULT: says an ask is coming, and shows no event switches until it is answered", async () => {
    await renderPane(null, hostAt("default"));
    expect(host.textContent).toContain(settingsCopy.notifyAskFirst!);
    expect(switches()).toHaveLength(1);
    expect(switchFor(settingsCopy.notifyMaster!)!.getAttribute("aria-checked")).toBe("false");
  });

  it("DEFAULT then REFUSED at the prompt leaves the master OFF, not ON", async () => {
    await renderPane(null, hostAt("default", "denied"));
    await act(async () => { switchFor(settingsCopy.notifyMaster!)!.click(); });
    expect(
      switchFor(settingsCopy.notifyMaster!)!.getAttribute("aria-checked"),
      "the master latched ON over an OS that refused at the prompt",
    ).toBe("false");
    expect(window.localStorage.getItem(NOTIFICATION_CHANNELS_KEY)).toBeNull();
  });

  it("DEFAULT then GRANTED at the prompt turns it on and reveals the events", async () => {
    await renderPane(null, hostAt("default", "granted"));
    await act(async () => { switchFor(settingsCopy.notifyMaster!)!.click(); });
    expect(switchFor(settingsCopy.notifyMaster!)!.getAttribute("aria-checked")).toBe("true");
    expect(switchFor(settingsCopy.notifyOhbox!)).toBeDefined();
  });
});

describe("A HOST THAT CANNOT READ THE OS ANSWER — the desktop window", () => {
  /* ── THE DEFECT ────────────────────────────────────────────────────────────────────────────
   *
   * MEASURED on the released 0.13.7 under WebKitGTK, on a display with no notification service:
   * the master switch COULD NOT BE TURNED ON and nothing said why. Three presses, frames at
   * 0.3 s and 3 s, and the switch stayed off with no sentence anywhere on the pane. The web
   * build in the comparable state says "This device is set to refuse notifications from ohmail.
   * That is changed in the system settings, not here." — the desktop had no equivalent.
   *
   * The cause was the DEFAULT host: the desktop fell back to the browser reader, whose
   * `Notification.requestPermission()` resolves in that webview without granting anything, so
   * `pressMaster` took its `state !== "granted"` arm and wrote nothing. It was reporting a
   * refusal that had not happened, for a permission the page does not hold.
   *
   * ── HOW TO WATCH THESE FAIL ────────────────────────────────────────────────────────────────
   *
   *  · delete the `osHoldsPermission` note from `SettingsView` → "says who has the last word"
   *    goes red with a switch and no sentence, which is the released pane exactly;
   *  · leave `notifyAskFirst` ungated → "and NOT the browser's three sentences" goes red with
   *    two sentences making different promises about the same state;
   *  · make `desktopNotificationHost.request()` answer "default" → "the press is written" goes
   *    red with the switch stuck off, which is the released behaviour;
   *  · put "switches below" back in `notifyMasterWhy` → "the master sentence does not promise"
   *    goes red.
   *
   * All four were run.
   */
  const desktopHost: NotificationHost = {
    permission: () => "granted",
    request: () => Promise.resolve("granted"),
    osHoldsPermission: true,
    emitter: carrying(MAIL_NOTICE_KINDS),
  };

  it("SAYS WHO HAS THE LAST WORD — the switch asks, the computer decides", async () => {
    await renderPane(null, desktopHost);
    expect(host.textContent ?? "").toContain(messages.settings.notifyOsHeld);
  });

  it("and NOT the browser's three sentences, which are about a state it cannot read", async () => {
    /* `permission()` answers a NARROWER question on this door — may this window ask the shell —
       so `denied`, `unsupported` and `default` are all untrue here. Two sentences making
       different promises about one state is the shape this pane exists to remove. */
    await renderPane(null, { ...desktopHost, permission: () => "default", request: () => Promise.resolve("default") });
    const text = host.textContent ?? "";
    expect(text, "the browser's 'your device will ask' sentence reached a host that cannot ask")
      .not.toContain(messages.settings.notifyAskFirst);
    expect(text).toContain(messages.settings.notifyOsHeld);
  });

  it("THE SWITCH READS WHAT THE EMITTER READS — and the released pane read the opposite", async () => {
    /* ── THE SHARPER HALF OF THE MEASUREMENT, found by this case going red ─────────────────
     *
     * `DEFAULT_CHANNELS` is `master: true, ohbox: true`, and the desktop's emitter
     * (`DesktopGate`) passes `readChannels()` to `decideNotices` with a literal `"granted"`.
     * So the released build WAS drawing OS notices on every rise in the unread count — while
     * this pane drew the master OFF, because `checked` is ANDed with `notifyPermission ===
     * "granted"` and the browser reader never answered that in this webview.
     *
     * The switch was not merely stuck. It was stuck showing the OPPOSITE of what the app was
     * doing, and the person had no way to stop the notices it said were already off. */
    await renderPane(null, desktopHost);
    const master = switchFor(messages.settings.notifyMaster)!;
    expect(
      master.getAttribute("aria-checked"),
      "the pane drew OFF over an emitter that was drawing notices",
    ).toBe("true");
    /* AND THE EVENT SWITCHES ARE THERE WITH IT — the controls that actually gate what the
       desktop draws, and which a dead master hid. */
    expect(switches().length).toBeGreaterThan(1);
  });

  it("AND TURNING IT OFF IS WRITTEN — the press the released build swallowed", async () => {
    await renderPane(null, desktopHost);
    await act(async () => { switchFor(messages.settings.notifyMaster)!.click(); });
    expect(
      switchFor(messages.settings.notifyMaster)!.getAttribute("aria-checked"),
      "the master press was swallowed, exactly as it was on the released build",
    ).toBe("false");
    /* THE STORED VALUE, not the rendered one — this is what the emitter reads before every
       notice, so it is the only thing that actually stops one being drawn. */
    expect(readChannels().master, "nothing was written, so nothing stopped").toBe(false);
    // No control that cannot act: the events go with a dead master.
    expect(switches()).toHaveLength(1);
  });

  it("the master's own sentence does not promise switches that are not rendered", () => {
    /* "Off means ohmail draws nothing here, whatever the switches below say" — measured on
       0.13.7 with no switches below, because the per-event switches only render while the master
       is live. The sentence now names the events rather than controls. */
    expect(messages.settings.notifyMasterWhy).not.toContain("switches below");
  });

  it("CONTROL: a browser host is unchanged — no OS sentence, its own three intact", async () => {
    await renderPane(null, hostAt("default"));
    const text = host.textContent ?? "";
    expect(text).toContain(messages.settings.notifyAskFirst);
    expect(text, "the desktop's sentence reached a browser tab")
      .not.toContain(messages.settings.notifyOsHeld);
  });
});

describe("the stored intent is reconciled on ARRIVAL, not only on a press", () => {
  it("asks for a subscription on mount, because the defaults already say yes", async () => {
    /**
     * The defaults are master-on and new-mail-on, so the ordinary first visit carries an intent
     * to be woken that nothing had acted on: a subscription was only ever created by a PRESS.
     * A reader whose browser had already granted permission — and everybody upgrading into this
     * build — got a pane saying yes to everything over a browser no server could reach.
     */
    const h = hostSyncing("granted");
    await renderPane(null, h);
    expect(h.asked, "nothing reconciled the stored intent on mount").toEqual([true]);
  });

  it("asks for NO subscription on mount when the platform refuses", async () => {
    const h = hostSyncing("denied");
    await renderPane(null, h);
    expect(h.asked).toEqual([false]);
  });
});

describe("a server that cannot deliver says so — a switch may not imply otherwise", () => {
  it("renders the no-signing-key sentence when the server has no keypair", async () => {
    await renderPane(null, hostSyncing("granted", "no_server_key"));
    expect(host.textContent).toContain(settingsCopy.notifyNoServerKey!);
  });

  it("says when a server row outlived the browser it pointed at", async () => {
    await renderPane(null, hostSyncing("granted", "row_remains"));
    expect(host.textContent).toContain(settingsCopy.notifyRowRemains!);
  });

  it("says nothing extra when the reconciliation was ordinary", async () => {
    await renderPane(null, hostSyncing("granted", "subscribed"));
    expect(host.textContent).not.toContain(settingsCopy.notifyNoServerKey!);
    expect(host.textContent).not.toContain(settingsCopy.notifyRowRemains!);
    expect(host.textContent).not.toContain(settingsCopy.notifyNotRegistered!);
  });
});

describe("the dead sentence is gone from the shipping catalogue", () => {
  it("no key claims notifications are unavailable — delivery exists now", () => {
    expect(settingsCopy.notificationsUnavailable).toBeUndefined();
  });
});

describe("SET-M1 — the demo world keeps the prototype screen", () => {
  it("with the mirror's meta present, the channel switches render", async () => {
    await renderPane(DEMO_META);
    expect(switches().length, "the demo lost its Notifications prototype").toBeGreaterThan(0);
    expect(host.textContent).toContain("VIP — always notifies");
  });

  it("and the real per-device controls do not also appear", async () => {
    await renderPane(DEMO_META);
    expect(switchFor(settingsCopy.notifyMaster!)).toBeUndefined();
  });
});
