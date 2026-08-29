/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import fs from "node:fs";
import path from "node:path";

import { DesktopGate } from "../src/DesktopGate.js";
import type { EngineStatus } from "../src/bridge-fetch.js";
import messages from "../../webapp/messages/en.json";

/**
 * ═══ THE HOSTED AUTH GATE IS NEVER STALE ACROSS ENGINE CHANGES ═══════════════════════════════
 *
 * THE FAILURE THIS FILE PINS SHUT: `hostedAuthKnown` was a bare boolean that latched on the
 * FIRST Cloud `/health` answer and was cleared only by leaving for a non-cloud door — so after
 * any engine-lifecycle act that kept `door === "cloud"` (an in-place sign-in, a same-door
 * reconfigure, local-and-back), the gate mounted `AppShell` on the PREVIOUS engine's answer,
 * before the new engine's `/health` could report pre-auth or expiry. A mounted mail client over
 * an engine whose mail routes refuse: error toasts over stale mail.
 *
 * The fix keys the answer to the engine's lifetime: `authKey` = (cloud door, `authEpoch`), the
 * epoch bumped by every status `onStatus` delivers (each one follows a door entry, sign-in or
 * reconfigure — any of which may have replaced the engine), and an answer is believed only while
 * its key matches. A replaced or re-entered engine mints a key no stored answer matches, so the
 * auth state is structurally pending again and the mail app is withheld until the NEW engine's
 * own first `/health` lands.
 *
 * ── MUTATIONS THESE WERE WATCHED AGAINST (each restored, 2026-08-24) ────────────────────────
 *  · revert to the boolean latch (never reset on `onStatus`, cleared only door-off)
 *      ⇒ "an in-place sign-in re-earns the answer" red — `AppShell` mounts with ZERO fresh
 *        `/health` asks, over an engine still answering pre-auth;
 *      ⇒ "mounts only after a fresh /health" red the same way (mounted with no new ask).
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

interface Host {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
    transformCallback: (cb: (payload: unknown) => void, once?: boolean) => number;
  };
}
const host = globalThis as unknown as Host;

const CLOUD_SERVING: EngineStatus = {
  state: "serving",
  mode: "cloud",
  address: "someone@ohmail.app",
  mailboxId: "mbx-1",
  credentialState: "ready",
};

function encode(status: number, body: string): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "OK", h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

const EMPTY_PAGE = JSON.stringify({
  changes: { creates: [], updates: [], moves: [], deletes: [] },
  cursor: "MA",
  hasMore: false,
  serverTime: "2026-01-01T00:00:00.000Z",
});
const EMPTY_SNAPSHOT = JSON.stringify({
  asOfSeq: 0,
  changes: [],
  nextCursor: null,
  window: { days: 90, minRows: 500 },
});

/**
 * The stand-in shell: a mutable engine status, a MUTABLE `/health` answer, and a count of how
 * many times `/health` was actually asked — the count is what tells "mounted on a fresh answer"
 * apart from "mounted on a remembered one", which is the whole defect.
 */
function fakeShell(initial: EngineStatus): {
  set(status: EngineStatus): void;
  health(next: { signedIn?: boolean; sessionExpired?: boolean }): void;
  healthAsks(): number;
  signins(): number;
} {
  let status = initial;
  let health: { signedIn?: boolean; sessionExpired?: boolean } = { signedIn: true };
  let healthAsks = 0;
  let signins = 0;
  const callbacks = new Map<number, (payload: unknown) => void>();
  let next = 1;
  host.__TAURI_INTERNALS__ = {
    transformCallback: (cb) => {
      const id = next++;
      callbacks.set(id, cb);
      return id;
    },
    invoke: async (command, payload) => {
      if (command === "engine_status") return status;
      if (command === "mailto_claim") return null;
      if (command === "plugin:event|listen") return null;
      if (command === "engine_request") {
        const url = String(payload?.url ?? "");
        if (url === "/health") {
          healthAsks++;
          return encode(200, JSON.stringify(health));
        }
        if (url === "/cloud/signin") {
          signins++;
          return encode(200, '{"status":"signed_in"}');
        }
        if (url.startsWith("/sync/snapshot")) return encode(200, EMPTY_SNAPSHOT);
        if (url.startsWith("/mailboxes")) return encode(200, JSON.stringify({ items: [] }));
        return encode(200, EMPTY_PAGE);
      }
      // default_mail_status, set_badge, notify — granted, and nothing this file asserts on.
      return null;
    },
  };
  return {
    set: (n) => { status = n; },
    health: (n) => { health = n; },
    healthAsks: () => healthAsks,
    signins: () => signins,
  };
}

let root: Root | null = null;
let mountPoint: HTMLElement | null = null;

async function render(): Promise<HTMLElement> {
  mountPoint = document.createElement("div");
  document.body.appendChild(mountPoint);
  root = createRoot(mountPoint);
  await act(async () => {
    root!.render(
      h(
        IntlProvider,
        { locale: "en", messages: messages as never, timeZone: "UTC" },
        h(ThemeProvider, { storageKey: "ohmail.theme" }, h(ToastHost, null, h(DesktopGate, null))),
      ),
    );
  });
  await settle();
  return mountPoint;
}

/** Enough timer turns for the status call, the auth probes and the mount to land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
}

/** Long enough for the 400ms first-answer probe loop to tick at least once. */
async function settleThroughFastProbe(): Promise<void> {
  for (let i = 0; i < 40; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
}

async function type(el: HTMLElement, id: string, value: string): Promise<void> {
  const input = el.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`no field #${id} on screen`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function buttonSaying(el: HTMLElement, label: string): HTMLButtonElement {
  const found = [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(label));
  if (!found) throw new Error(`no button saying "${label}"`);
  return found;
}

/** Fill the in-place cloud sign-in and press it — the pre-auth surface's own form. */
async function signIn(el: HTMLElement): Promise<void> {
  await type(el, "cloud-address", "someone@ohmail.app");
  await type(el, "cloud-password", "a-password-long-enough");
  await type(el, "cloud-totp", "123456");
  await act(async () => {
    buttonSaying(el, "Sign in").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** The mail app's unmistakable text — the rail's Ohbox entry only `AppShell` renders. */
const mounted = (el: HTMLElement): boolean => (el.textContent ?? "").includes("Ohbox");
const signInSurface = (el: HTMLElement): boolean =>
  (el.textContent ?? "").includes("Sign in to ohmail Cloud");

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  mountPoint?.remove();
  root = null;
  mountPoint = null;
  delete host.__TAURI_INTERNALS__;
  window.location.hash = "";
  localStorage.clear();
});

beforeEach(() => {
  window.location.hash = "";
  localStorage.clear();
});

describe("the hosted auth gate", () => {
  it("a signed-in cloud engine mounts the mail app after its first /health", async () => {
    const shell = fakeShell(CLOUD_SERVING);
    shell.health({ signedIn: true });
    const el = await render();
    expect(mounted(el)).toBe(true);
    expect(shell.healthAsks(), "the mount rode a real answer").toBeGreaterThanOrEqual(1);
  });

  it("the mounted mail app carries the Pull-new-mail control — on BOTH doors (owner report 2026-08-29, bug 2)", async () => {
    /* THE REGRESSION: the control gated itself on `apiConfigured()` from `app/api-client`,
       which every desktop artifact folds to `false` at build time (`vite.config.ts` defines
       `NEXT_PUBLIC_API_BASE` as `undefined`; the packaged tree aliases the whole module to a
       refusing stub) — so the wave that claimed webapp/desktop coverage shipped a control no
       desktop door could ever render, although the bridge adapter behind both doors serves
       `POST /sync/pull` (the hosted door forwards it to the Cloud; the standalone door stamps
       its own engine, whose ≤15 s poll answers it). The gate is now the ENGINE's own
       `pullAvailable()`, which reads the adapter that will take the press. Mutation-watched:
       re-gating `available` on a build-env base (`process.env.NEXT_PUBLIC_API_BASE`, the old
       predicate's shape) turned this red on both doors; restored. */
    const shell = fakeShell(CLOUD_SERVING);
    shell.health({ signedIn: true });
    const cloudDoor = await render();
    expect(mounted(cloudDoor)).toBe(true);
    expect(
      cloudDoor.querySelector(".rail-pull"),
      "the hosted door's rail has no Pull-new-mail control",
    ).not.toBeNull();
    expect(cloudDoor.querySelector(".rail-pull")!.textContent).toContain("Pull new mail");

    // The standalone door: the same shell over `mode: "local"` — no hosted session to gate on.
    await act(async () => { root!.unmount(); });
    mountPoint?.remove();
    root = null;
    fakeShell({ ...CLOUD_SERVING, mode: "local" });
    const localDoor = await render();
    expect(mounted(localDoor)).toBe(true);
    expect(
      localDoor.querySelector(".rail-pull"),
      "the standalone door's rail has no Pull-new-mail control",
    ).not.toBeNull();
  });

  it("a PRE-AUTH cloud engine gets the sign-in surface, never the mail app", async () => {
    const shell = fakeShell(CLOUD_SERVING);
    shell.health({ signedIn: false });
    const el = await render();
    expect(signInSurface(el)).toBe(true);
    expect(mounted(el)).toBe(false);
  });

  it("an EXPIRED session gets the honest sentence, never the mail app", async () => {
    const shell = fakeShell(CLOUD_SERVING);
    shell.health({ signedIn: false, sessionExpired: true });
    const el = await render();
    expect(el.textContent ?? "").toContain("signed out of your hosted account");
    expect(mounted(el)).toBe(false);
  });

  it("an in-place sign-in RE-EARNS the auth answer: still pre-auth ⇒ still withheld", async () => {
    /* The stale-latch defect, reproduced: the first probe has answered, so the old boolean latch
       is set for the life of the door. The sign-in's onStatus is an engine-lifecycle act — the
       engine behind the bridge may have been replaced — and this engine STILL answers pre-auth
       (a sealed session that did not take, an abandoned handoff's relaunch). The gate must ask
       it and believe the fresh answer, never mount the mail app on the remembered one. */
    const shell = fakeShell(CLOUD_SERVING);
    shell.health({ signedIn: false });
    const el = await render();
    expect(signInSurface(el)).toBe(true);

    const asksBeforeSignIn = shell.healthAsks();
    await signIn(el);
    expect(shell.signins()).toBe(1);
    await settleThroughFastProbe();

    // A FRESH ask happened, its answer is pre-auth, and the mail app stayed withheld.
    expect(shell.healthAsks(), "no fresh /health was asked after the sign-in")
      .toBeGreaterThan(asksBeforeSignIn);
    expect(mounted(el), "AppShell mounted on a stale auth answer").toBe(false);
    expect(signInSurface(el)).toBe(true);
  });

  it("an in-place sign-in mounts ONLY AFTER a fresh /health says signed in", async () => {
    const shell = fakeShell(CLOUD_SERVING);
    shell.health({ signedIn: false });
    const el = await render();
    expect(signInSurface(el)).toBe(true);

    // The session takes: the engine's NEXT /health answers signed in.
    shell.health({ signedIn: true });
    const asksBeforeSignIn = shell.healthAsks();
    await signIn(el);
    await settleThroughFastProbe();

    expect(mounted(el)).toBe(true);
    // The mount rode a FRESH answer — the stale latch mounts with zero new asks.
    expect(shell.healthAsks(), "mounted without re-asking the engine").toBeGreaterThan(asksBeforeSignIn);
  });
});

describe("the auth key, pinned at the source", () => {
  /* The door-switch half (cloud → local → cloud) cannot be driven through the rendered gate —
     door switches ride `onStatus` from flows this harness does not mount — so the mechanism is
     pinned where the repo's other gate mechanics are: at the source. The answer must be KEYED,
     the key must carry the epoch, the epoch must move with every delivered status, and a
     non-cloud door must have no key at all (a keyless door can match no stored answer, which is
     what makes local-and-back structurally fresh). */
  const src = fs.readFileSync(
    path.resolve(__dirname, "../src/DesktopGate.tsx"),
    "utf8",
  );

  it("believes an answer only under its own key, and the key carries the engine epoch", () => {
    expect(src).toMatch(/hostedAuth\.key === authKey/);
    expect(src).toMatch(/`cloud:\$\{authEpoch\}`/);
    expect(src).toMatch(/setAuthEpoch\(\(n\) => n \+ 1\)/);
    // Non-cloud doors carry no key — leaving the cloud door orphans every stored answer.
    expect(src).toMatch(/door === "cloud" && bridgeAvailable\(\) \? `cloud:\$\{authEpoch\}` : null/);
    // And the pending gate withholds the app on the KEYED answer, not on a bare boolean.
    expect(src).toMatch(/if \(authKey !== null && !hostedAuthKnown\)/);
  });

  it("cancelling the door overlay ADVANCES THE EPOCH — an abandoned configure has none of its own", () => {
    /* `engine_configure` runs BEFORE the credential step, so a rejected password or an abandoned
       browser handoff can have replaced the engine without any status ever reaching `onStatus` —
       the epoch never moves and the stored answer still matches. Closing the overlay is the
       moment the mail client underneath would render on that stale answer. The handler must
       advance the EPOCH, not merely clear the stored answer: a probe already in flight holds the
       old key in its closure, and a late answer from the replaced engine would re-store under a
       still-current key — the bump re-keys the gate and retires the in-flight read with the
       effect it belongs to. Pinned at the source because the overlay only opens from flows this
       harness does not mount. */
    const cancel = /onCancel=\{\(\) => \{[\s\S]*?\}\}/.exec(src)?.[0] ?? "";
    expect(cancel, "the overlay's cancel handler must re-key the hosted auth answer")
      .toMatch(/setAuthEpoch\(\(n\) => n \+ 1\)/);
    expect(cancel).toMatch(/setOverlay\(null\)/);
    // And no surface anywhere clears the stored answer WITHOUT re-keying — a bare clear is the
    // in-flight-probe race the round above closed.
    expect(src).not.toMatch(/setHostedAuth\(null\)/);
  });
});
