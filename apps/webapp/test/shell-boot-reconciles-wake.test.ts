/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installShellEnv, mailbox, mountShell, teardownShellEnv, tick } from "./fixtures/live-walk-shell";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE RECONCILE RUNS AT BOOT — NOT WHEN SOMEBODY HAPPENS TO OPEN SETTINGS
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `sign-in-reconciles-wake.test.ts` covers what `reconcileWakeRegistration` DOES. This covers the
 * claim that actually closes the defect: that the shipped shell calls it on the way up, so a
 * returning reader's notices come back without their being sent to look for them.
 *
 * That distinction is the whole gap. The reconcile logic already existed — as `SettingsView`'s
 * mount effect — and the switches still lied, because a pane that is never mounted never runs
 * its effects. A guard that drove the pane would have been green throughout the defect.
 *
 * So this mounts the REAL shell, the way the Cloud entry mounts it, over the stale local state a
 * sign-out leaves behind, and asserts the worker's permission to draw is restored with the
 * settings pane never rendered. Mounting the real `AppShell` is what makes the effect being
 * edited away a failure here — a probe wiring its own copy of the gate could not notice that.
 */

const cachePuts: { url: string; body: string }[] = [];
const registered: string[] = [];
const NOTIFY_STATE_URL = "/__ohmail_notify_state";
const CHANNELS_KEY = "ohmail.notifications.channels";

function installFakeCaches(): void {
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      open: () => Promise.resolve({
        put: async (url: string, res: Response) => {
          cachePuts.push({ url, body: await res.text() });
        },
        /* `match` is required, not optional: the boot writes the `enabled` byte through a
           read-modify-write that PRESERVES the stored words, because the reconcile no longer owns
           them — the locale relabel does. A fake without `match` makes every such write throw
           into its own catch and the entry never appears, which is a fixture failure that looks
           exactly like the shell not reconciling at all. */
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

/**
 * A BROWSER THAT CAN ACTUALLY REGISTER, and the two endpoints the announce calls.
 *
 * Both are needed because the boot reconcile now enables the worker ONLY for a row the server
 * named — writing `enabled: true` up front would re-arm it for a previous user's surviving
 * registration (`sign-in-reconciles-wake.test.ts` holds that sequence). So a shell test that
 * wants to assert the worker was re-armed has to let a real registration happen.
 *
 * The harness's own `fetch` is wrapped rather than replaced, so `/sync` and `/consent` keep
 * answering and the shared fixture is untouched.
 */
function installPushCapableBrowser(): void {
  const sub = {
    endpoint: "https://push.example/ep/boot",
    getKey: (n: string) => new Uint8Array(n === "auth" ? 16 : 65).fill(5).buffer,
    unsubscribe: () => Promise.resolve(true),
  };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      register: (u: string) => { registered.push(u); return Promise.resolve({
        pushManager: {
          getSubscription: () => Promise.resolve(null),
          subscribe: () => Promise.resolve(sub),
        },
      }); },
    },
  });
  const inner = globalThis.fetch;
  const json = (v: unknown): Response =>
    new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/push/vapid-key")) return json({ publicKey: "BFAKEa-b_c0123456789" });
    if (url.includes("/push/subscriptions")) return json({ id: "row-boot" });
    return inner(input as RequestInfo, init);
  }) as typeof fetch;
}

/** Every switch a returning reader left ON, exactly as sign-out preserved them. */
const ALL_ON = JSON.stringify({
  master: true, ohbox: true, screener: true,
  scheduled: true, pairing: true, showSenderAndSubject: false,
});


describe("the shell's boot reconcile", () => {
  beforeEach(() => {
    cachePuts.length = 0;
    registered.length = 0;
    window.localStorage.clear();
    installShellEnv();
    installFakeCaches();
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request: async (_name: string, write: () => Promise<void>) => write() },
    });
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: { permission: "granted" },
    });
  });
  afterEach(async () => {
    Reflect.deleteProperty(navigator, "locks");
    await teardownShellEnv();
  });

  it("a sign-in over stale switches restores the worker's permission, Settings unopened", async () => {
    /*
     * THE DEFECT, DRIVEN. The stale state is what a sign-out leaves: switches still ON and the
     * OS grant still held (both survive deliberately — they are an install preference), against
     * a worker last told `enabled: false` and a server row that was deleted.
     */
    window.localStorage.setItem(CHANNELS_KEY, ALL_ON);
    installPushCapableBrowser();
    /* The boot's two doors are the host's own (`device.notifications`): the web's entry hands the browser's host. */
    const { browserNotificationHost } = await import("../app/shell/notification-settings");

    const container = await mountShell([mailbox()], { notificationHost: browserNotificationHost });
    await tick(0);

    /*
     * THE LAST WRITE, not the first — and this is not a detail. The boot now makes TWO writes to
     * this key: the locale relabel creates the entry (disarmed, because a language change may
     * never arm the worker), and the reconcile sets the `enabled` byte afterwards while
     * preserving the words. `.find()` returned the relabel's `false` and read as a boot that had
     * not reconciled, which is a fixture reading the wrong write rather than a defect.
     */
    const writes = cachePuts.filter((p) => p.url === NOTIFY_STATE_URL);
    expect(writes.length, "the shell booted without reconciling at all").toBeGreaterThan(0);
    // Only `syncWebPush` registers the worker, so this is the boot reconcile's own fingerprint —
    // no other surface in this mount could have left it.
    expect(registered, "the boot never reached the push path").toEqual(["/sw.js"]);
    expect(JSON.parse(writes.at(-1)!.body).enabled).toBe(true);
    /* The WORDS the worker may draw, resolved through the shell's own `useTranslations()`. Held
       because the boot path reaches the key by its full path (`settings.notifyClosedBody`) from
       the root namespace, and next-intl answers a missing key with the key itself rather than by
       throwing — so a mis-spelled path would put "settings.notifyClosedBody" on somebody's lock
       screen and nothing here would have noticed. */
    expect(JSON.parse(writes.at(-1)!.body).body).toBe("New mail.");

    /*
     * …AND THE PANE THAT USED TO BE THE ONLY RECONCILE WAS NEVER MOUNTED. The notification
     * switches live in Settings; none is in this document, so nothing here ran through the
     * effect that used to be the app's only one. This is the assertion that would still have
     * been red on the day the defect was filed.
     */
    expect(container.querySelector('[role="switch"]'),
      "the settings pane rendered — this proves nothing about a boot")
      .toBeNull();
    expect(window.location.hash).not.toContain("settings");
  });

  it("the boot reconcile is gated on the CLIENT-RESOLVED demo, not the hydration one", () => {
    /*
     * PINNED BY SOURCE because the harness mounts a signed-in shell only, so no behavioural case
     * here can reach the other arm — reproducing it needs `hydrateRoot`, not `createRoot`.
     *
     * ── AND `demo` IS NOT THE SAME VALUE AS `resolvedDemo`, WHICH IS THE WHOLE POINT ──────
     *
     * `useDemoMode` returns the SERVER snapshot on the hydration render so the markup matches
     * what was sent. A prerendered route bakes `searchParams = {}`, so on a `?demo=1` page that
     * snapshot is FALSE while the client answer is true — and this effect fires on exactly that
     * commit. Gated on `demo` it ran on a demo page and issued `GET /push/vapid-key` and
     * `POST /push/subscriptions` from the one surface that promises nothing leaves the tab.
     *
     * So the pin is on `resolvedDemo` specifically. `if (demo)` passing here again would be the
     * defect returning under a name that reads correct.
     */
    /* The mail ground reconciles and relabels in separate effects over the host's notification door. */
    const shell = readFileSync(`${existsSync("packages/app/src") ? "packages/app/src" : "../../packages/app/src"}/mail/ground/boot-wake.ts`, "utf8");
    expect(shell).toMatch(
      /if \(demo \|\| !worded\) return;\s*\n\s*const doors = now\.current\.notifications;\s*\n\s*if \(doors !== NONE\) void doors\.reconcile\?\.\(now\.current\.body\);/,
    );
    // …and the relabel that follows the account's locale is gated the same way, and is a RELABEL:
    // re-running the reconcile there would recompute `enabled` from an intent.
    expect(shell).toMatch(
      /if \(demo \|\| !worded\) return;\s*\n\s*const doors = now\.current\.notifications;\s*\n\s*if \(doors !== NONE\) void doors\.relabel\?\.\(TITLE, body\);/,
    );
    // The hook must be the effect-only one. Reading it in render output would reintroduce the
    // hydration mismatch `useDemoMode` exists to prevent.
    expect(shell).toMatch(/const demo = useResolvedDemoMode\(\);/);
    expect(shell).not.toMatch(/\buseDemoMode\(/);
  });

  it("over the new shell (the frame on the mail ground): the same sign-in restores the worker's permission, Settings unopened", async () => {
    /*
     * THE SAME DEFECT, DRIVEN OVER THE SHELL THAT REPLACES TODAY'S. There the boot is the mail ground's
     * (`MailBoot`), and the two doors it presses are the host's own (`device.notifications`): the web's entry
     * hands the browser's host, so this mount hands it too. Nothing else of the case moved.
     */
    window.localStorage.setItem(CHANNELS_KEY, ALL_ON);
    installPushCapableBrowser();
    const { browserNotificationHost } = await import("../app/shell/notification-settings");

    const container = await mountShell([mailbox()], { notificationHost: browserNotificationHost });
    await tick(0);

    const writes = cachePuts.filter((p) => p.url === NOTIFY_STATE_URL);
    expect(writes.length, "the new shell booted without reconciling at all").toBeGreaterThan(0);
    expect(registered, "the boot never reached the push path").toEqual(["/sw.js"]);
    expect(JSON.parse(writes.at(-1)!.body).enabled).toBe(true);
    expect(JSON.parse(writes.at(-1)!.body).body).toBe("New mail.");
    expect(container.querySelector('[role="switch"]'),
      "the settings pane rendered — this proves nothing about a boot")
      .toBeNull();
    expect(window.location.hash).not.toContain("settings");
  });
});
