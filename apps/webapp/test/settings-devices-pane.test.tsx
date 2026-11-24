/** @vitest-environment jsdom */
/**
 * ═══ SETTINGS → DEVICES — THE MANAGED BUILD: GATE, MINT → QR + TYPED LINK, LIST, TAKE-BACK ═══
 *
 * The Cloud Devices pane: `POST /pair` (device-pair grant) mints a code, the pane shows ONE
 * link (`<apiOrigin>/pair#<token>`) as a QR plus the raw link for typed entry, lists the
 * account's signed-in devices from `GET /devices`, and signs one out with `DELETE /devices/:id`.
 * Pinned at the wire and the rendered artifact, `user-invites.test.tsx`'s discipline:
 *
 *  1. **The gate is the server's runtime word alone.** Unlike the Invites pane there is NO
 *     compiled flavor arm: the managed service mounts the device-pair ceremony, so
 *     `useDevicePairing` asks `/hello` on THIS build (the file runs with no flavor inlined —
 *     the managed process) and answers exactly `features.pairing`.
 *  2. **The link's origin is the API's, never this page's.** The QR decodes to
 *     `https://api.ohmail.app/pair#<token>` — the one allow-listed API origin — because the
 *     scanning device redeems and then syncs against `${origin}/…` at the ROOT, and ohmail.app
 *     serves the API only under the `/api` rewrite. A link minted on `window.location.origin`
 *     here would negotiate against a Next 404 in the phone's hands. (The self-host arm, where
 *     the page origin IS the API origin, is `settings-devices-selfhost.test.tsx` — one flavor
 *     per process, as the invites pair splits it.)
 *  3. **The raw link IS printed, deliberately** — the one divergence from the invites pane's
 *     scan-or-copy rule, because a device without a camera path needs the link TYPED into the
 *     app, and a five-minute single-use lifetime bounds the exposure. Asserted positively.
 *  4. **The current session's row offers no sign-out** — that verb exists and is called
 *     signing out; every other row's remove is confirm-then-DELETE on its own id.
 *  5. **A closed step-up window opens the INLINE factor prompt** (`StepUpPrompt`): the refused
 *     verb is parked, the second factor verifies against the session the browser already
 *     holds, and the verb re-runs in place. The old dead end — "sign in again" for someone
 *     already in their mailbox — renders only for a genuinely dead session.
 *  6. **Plain browser sessions collapse into ONE group** with one bulk sign-out — but only
 *     where the server's own `/hello` flavor says the bulk route is mounted (hosted /
 *     self-host), only on rows the SERVER marks `named: false`, and never the current row or
 *     a paired device.
 */
import { WithReport } from "../../../packages/app/test/support/with-report.js";
import { within } from "@testing-library/react";
import { NONE, type FeatureEntry } from "@ohmail/app/host";
import { mailSettings, NO_PANE_PARTS, type MailPaneParts } from "@ohmail/app/mail";
import { fakeHost, SEAM_AT_REST } from "../../../packages/app/test/support/fake-host.js";
import { fakeAddress } from "../../../packages/app/test/support/fake-window.js";
import { MailFrame } from "../app/shell/browser-mail";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import { MemoryMirrorStore, noticeChoicesOf, type Notice, type SyncChange } from "@ohmail/client-engine";
import { EngineContext, type EngineBinding } from "@ohmail/app-logic/engine/context";
import { ConsentContext, useConsentState } from "@ohmail/app-logic/consent";
import { NoticeCaller, noticeReadsOf, toldDevicesIn, type HostNoticeEmitter } from "@ohmail/app-logic/notices/use-notices";
import messages from "../messages/en.json";
import { decodeQr, matrixFromSvg } from "./fixtures/qr-decode";

const DEVICE_ACCOUNT = "device-settings";
let releaseOwner = () => {};

const HERE = path.dirname(fileURLToPath(import.meta.url));

(globalThis as unknown as { React: unknown }).React = React;
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_BASE = "/api";
  delete process.env.NEXT_PUBLIC_OHMAIL_FLAVOR;
});

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* A pair token is 43 base64url characters, the shape the link assertion below reads: a sha256 digest has it. */
const TOKEN = createHash("sha256").update("settings-devices-pane fixture").digest("base64url");
/** The one allow-listed managed API origin (`app/api-origin.ts`) — the link's base. */
const API_ORIGIN = "https://api.ohmail.app";

/** `held`: the answer waits until it resolves, as a read still on the wire does. */
type Answer = { status: number; body?: unknown; held?: Promise<void> };
let answers: Record<string, Answer> = {};
let calls: Array<{ method: string; url: string; body: unknown }> = [];
let originalFetch: typeof globalThis.fetch;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

const HELLO = (pairing: boolean): Answer => ({
  status: 200,
  body: {
    product: "ohmail", flavor: "managed", apiVersion: "0.0.0", needsSetup: false,
    auth: { password: true, totp: true, webauthn: true, publicSignup: false },
    features: { sse: true, staging: true, ai: true, pairing },
  },
});

/** `GET /devices` rows: the browser reading this pane, and a paired phone. */
const THIS_BROWSER = {
  id: "dev-1", kind: "web", label: "Web", createdAt: "2026-08-01T09:00:00.000Z",
  lastSeenAt: "2026-08-20T09:00:00.000Z", ip: "", current: true, pushToken: null,
};
const PAIRED_PHONE = {
  id: "dev-2", kind: "web", label: "Mila's phone", createdAt: "2026-08-10T09:00:00.000Z",
  lastSeenAt: "2026-08-19T09:00:00.000Z", ip: "", current: false, pushToken: null,
};

const LIVE_CODE = {
  id: "pt-1", grant: "device-pair", label: "Mila's phone", createdAt: "2026-08-20T09:00:00.000Z",
  expiresAt: "2026-08-20T09:05:00.000Z", consumedAt: null, revokedAt: null, status: "live",
};

beforeEach(() => {
  answers = {
    "GET /api/devices": { status: 200, body: { items: [] } },
    "GET /api/pair": { status: 200, body: { items: [] } },
  };
  calls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const hit = Object.entries(answers).find(([key]) => {
      const [m, path] = key.split(" ");
      return m === method && url.includes(path!);
    });
    if (!hit) return new Response("{}", { status: 200 });
    const [, a] = hit;
    if (a.held) await a.held;
    return new Response(a.body === undefined ? null : JSON.stringify(a.body), {
      status: a.status,
      headers: { "content-type": "application/json", "X-Ohmail-Account": DEVICE_ACCOUNT },
    });
  }) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = originalFetch;
  releaseOwner();
  releaseOwner = () => {};
  vi.restoreAllMocks();
});

async function mountNode(node: React.ReactNode): Promise<HTMLElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC",
        children: h(ThemeProvider, null, h(ToastHost, null, node)),
      }),
    );
    await Promise.resolve();
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return host;
}

function DeviceConsent({ children }: { readonly children?: React.ReactNode }) {
  const consent = useConsentState(false, DEVICE_ACCOUNT, NONE);
  return h(ConsentContext.Provider, { value: consent }, children);
}

function mountDevices(part: MailPaneParts["devices"], first: "general" | "devices", binding?: EngineBinding) {
  const settings = mailSettings({ ...NO_PANE_PARTS, general: () => null, devices: part });
  const devices: FeatureEntry | typeof NONE = part === NONE ? NONE : { name: "devices", render: () => null };
  const empty = new MemoryMirrorStore();
  const { host } = fakeHost({
    engine: binding?.engine ?? { ...SEAM_AT_REST, read: () => empty } as unknown as EngineBinding["engine"],
    service: "managed",
    scope: DEVICE_ACCOUNT, account: DEVICE_ACCOUNT,
    address: fakeAddress(`#/settings/${first}`),
    places: { settings },
    features: { devices },
  });
  const pairingHost = { ...host, capabilities: { ...host.capabilities, pairing: "account" as const } };
  const frame = h(DeviceConsent, null, h(MailFrame, { host: pairingHost }));
  return mountNode(binding ? h(EngineContext.Provider, { value: binding }, frame) : frame);
}

async function mountSection(binding?: EngineBinding): Promise<HTMLElement> {
  const { bindApiOwner } = await import("../app/api-client");
  document.cookie = `tf_owner=${DEVICE_ACCOUNT}; Path=/`;
  bindApiOwner(DEVICE_ACCOUNT);
  releaseOwner = () => {
    bindApiOwner(null);
    document.cookie = "tf_owner=; Path=/; Max-Age=0";
  };
  const { WEB_PANE_PARTS } = await import("../app/(product)/mailbox/pane-parts");
  const section = await mountDevices(WEB_PANE_PARTS.devices, "devices", binding);
  await within(section).findByRole("button", { name: messages.devices.addAction });
  await act(async () => { await Promise.resolve(); });
  return section;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    (el as HTMLElement).click();
    await Promise.resolve();
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const dialog = (c: HTMLElement) => within(c).getByRole("dialog");
const factorPrompt = (c: HTMLElement) => within(c).queryByRole("dialog", { name: /^Confirm with / });

const buttonByText = (c: ParentNode, text: string): HTMLButtonElement => {
  const b = within(c as HTMLElement).queryAllByRole<HTMLButtonElement>("button", { name: text })[0];
  expect(b, `a button reading "${text}"`).toBeTruthy();
  return b!;
};

describe("useDevicePairing — the runtime gate, asked on the MANAGED build too", () => {
  async function mountProbe(demo = false): Promise<HTMLElement> {
    const { useDevicePairing } = await import("../app/(product)/mailbox/DevicesSection.js");
    function Probe() {
      return h("output", null, useDevicePairing(demo) ? "devices:on" : "devices:off");
    }
    return mountNode(h(Probe));
  }

  it("a managed server announcing features.pairing:true answers true — and /hello WAS asked", async () => {
    // The half that distinguishes this hook from `useUserInvites`: the managed build pays the
    // round trip, because the managed table mounts the ceremony. A compiled short-circuit here
    // would keep the pane off every managed tab for ever, with the routes answering underneath.
    answers["GET /api/hello"] = HELLO(true);
    const c = await mountProbe();
    expect(c.textContent).toContain("devices:on");
    expect(calls.some((r) => r.method === "GET" && r.url.includes("/api/hello"))).toBe(true);
  });

  it("a server NOT announcing pairing answers false — absence from the descriptor, not a 404 mid-flow", async () => {
    answers["GET /api/hello"] = HELLO(false);
    const c = await mountProbe();
    expect(c.textContent).toContain("devices:off");
  });

  it("IN DEMO MODE the hook answers false and NEVER asks /hello — proven live first", async () => {
    // Measured on the hosted service before the fix: `/?demo=1` in a signed-in browser fetched
    // `/api/hello` once and grew a Devices entry in the demo's Settings nav — the ONE account
    // pane that leaked, because `AppShell`'s demo mask deliberately skipped `devicesSection`
    // ("a browser tab passes nothing", a premise the Cloud pane falsified) and the hook fetched
    // unconditionally. Opening the pane rendered the REAL device list inside the fixtures UI,
    // with a live mint verb beside it. So the gate takes the authoritative demo flag: in demo
    // there is no capability probe (the demo promises zero fetches) and no pane (its every verb
    // is a cookie-authenticated credential mutation).
    answers["GET /api/hello"] = HELLO(true);
    const c = await mountProbe(true);
    expect(c.textContent).toContain("devices:off");
    expect(
      calls.filter((r) => r.url.includes("/api/hello")),
      "the demo paid a /hello round trip",
    ).toEqual([]);
  });

  // Search's word rides the same hello: `searchBy` is "people" only where it reads true, and
  // sending `to` or `party` to a server that never said so shows unfiltered letters under a name.
  async function mountSearchProbe(demo = false): Promise<HTMLElement> {
    const { useServerWords } = await import("../app/server-words.js");
    function Probe() {
      return h("output", null, useServerWords(demo).searchPeople ? "people:on" : "people:off");
    }
    return mountNode(h(Probe));
  }
  const HELLO_SEARCH = (searchPeople: boolean): Answer => {
    const base = HELLO(true).body as { features: Record<string, boolean> };
    return { status: 200, body: { ...base, features: { ...base.features, searchPeople } } };
  };

  it("an older server, whose hello names no searchPeople, answers false", async () => {
    answers["GET /api/hello"] = HELLO(true);
    const c = await mountSearchProbe();
    expect(calls.some((r) => r.url.includes("/api/hello"))).toBe(true);
    expect(c.textContent).toContain("people:off");
  });

  it("a server announcing searchPeople:true answers true", async () => {
    answers["GET /api/hello"] = HELLO_SEARCH(true);
    const c = await mountSearchProbe();
    expect(c.textContent).toContain("people:on");
  });

  it("a failed hello and an answer that is no hello both answer false", async () => {
    answers["GET /api/hello"] = { status: 500, body: { error: "down" } };
    expect((await mountSearchProbe()).textContent).toContain("people:off");
    await act(async () => root!.unmount());
    host?.remove();
    answers["GET /api/hello"] = { status: 200, body: null };
    expect((await mountSearchProbe()).textContent).toContain("people:off");
  });

  it("the demo answers false and asks nothing", async () => {
    answers["GET /api/hello"] = HELLO_SEARCH(true);
    const c = await mountSearchProbe(true);
    expect(c.textContent).toContain("people:off");
    expect(calls.filter((r) => r.url.includes("/api/hello"))).toEqual([]);
  });

});

describe("the Settings nav — a wired devicesSection is an entry, an absent one is none", () => {
  const mountSettings = (withDevices: boolean) =>
    mountDevices(withDevices ? () => h("p", { className: "devices-probe" }, "the pane") : NONE, "general");
  const nav = async (c: HTMLElement) => within(await within(c).findByRole("navigation", { name: messages.settings.navAria }));

  it("wired ⇒ a Devices entry that opens the node", async () => {
    const c = await mountSettings(true);
    const entry = (await nav(c)).queryByRole("button", { name: "Devices" });
    expect(entry, "the Devices nav entry").toBeTruthy();
    await click(entry!);
    expect(c.querySelector(".devices-probe")).toBeTruthy();
  });

  it("absent ⇒ no entry, structurally", async () => {
    const c = await mountSettings(false);
    expect((await nav(c)).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim())).not.toContain("Devices");
  });
});

describe("mint → one link: the QR, the typed-entry line, the clipboard — all the API origin's", () => {
  it("POST /pair carries grant device-pair + the label; QR, printed link and clipboard agree on the exact link", async () => {
    answers["POST /api/pair"] = {
      status: 200,
      body: { id: "pt-9", token: TOKEN, grant: "device-pair", label: "Mila's phone", expiresAt: "2026-08-20T09:05:00.000Z" },
    };
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: (s: string) => { written.push(s); return Promise.resolve(); } },
    });

    const c = await mountSection();
    await type(within(c).queryByRole<HTMLInputElement>("textbox", { name: messages.devices.whoseDevice })!, "Mila's phone");
    await click(buttonByText(c, "Add a device"));

    const mint = calls.find((r) => r.method === "POST" && r.url.includes("/api/pair") && !r.url.includes("redeem"));
    expect(mint, "the mint left").toBeTruthy();
    expect(mint!.body).toMatchObject({ grant: "device-pair", label: "Mila's phone" });

    // THE LINK, three ways, one value — and its origin is the API's, not this page's (jsdom's
    // `window.location.origin` here is `http://localhost:3000`, which is exactly the wrong
    // answer this assertion exists to keep out). The shape is the frozen fragment wire the
    // mobile parser accepts: path exactly `/pair`, token in the fragment, no query.
    const link = `${API_ORIGIN}/pair#${TOKEN}`;
    expect(link).toMatch(/^https:\/\/api\.ohmail\.app\/pair#[A-Za-z0-9_-]{43}$/);

    const svg = (within(c).queryByRole("img", { name: messages.devices.qrAria }) as unknown as SVGSVGElement | null);
    expect(svg, "the QR rendered").toBeTruthy();
    expect(decodeQr(matrixFromSvg(svg!))).toBe(link);

    // The raw link IS printed — typed entry for a device without a camera path. The deliberate
    // divergence from the invites pane's scan-or-copy rule; see the pane header.
    const printed = c.querySelector(".account-device-link");
    expect(printed, "the typed-entry line").toBeTruthy();
    expect(printed!.textContent).toBe(link);

    await click(buttonByText(c, "Copy the link"));
    expect(written).toEqual([link]);
    expect(document.body.textContent).toContain("Link copied.");
  });

  it("a closed step-up window opens the INLINE factor prompt, and a verified code retries the mint in place", async () => {
    // The reported dead end, repaired: 403 `step_up_required` used to yield only "sign in
    // again" — a full round trip for someone already in their mailbox. Now the pane parks the
    // mint, asks for the second factor inline, and re-runs the mint the moment it verifies.
    answers["POST /api/pair"] = {
      status: 403,
      body: { error: { code: "step_up_required", message: "step-up verification required" } },
    };
    answers["GET /api/auth/session"] = {
      status: 200,
      body: { user: { twofaEnrolled: { webauthn: false, totp: true, recoveryCodes: true } }, scope: "full" },
    };
    const c = await mountSection();
    await click(buttonByText(c, "Add a device"));

    // No dead-end sentence — the prompt is the answer.
    const prompt = factorPrompt(c);
    expect(prompt).toBeTruthy();
    expect(c.textContent).not.toContain("Sign in again");
    expect(c.textContent).toContain("This continues right here once your second factor is verified.");

    // The factor verifies, the window reopens, the SAME mint re-runs and the QR arrives —
    // all without any sign-out.
    answers["POST /api/auth/step-up/totp"] = { status: 200, body: { ok: true } };
    answers["POST /api/pair"] = {
      status: 200,
      body: { id: "pt-9", token: TOKEN, grant: "device-pair", label: "", expiresAt: "2026-08-21T09:05:00.000Z" },
    };
    const codeInput = within(c).queryByRole<HTMLInputElement>("textbox", { name: messages.devices.stepUpTotpLabel });
    expect(codeInput).toBeTruthy();
    await type(codeInput!, "123456");
    await click(buttonByText(c, "Verify code"));

    expect(calls.some((r) => r.method === "POST" && r.url.includes("/api/auth/step-up/totp"))).toBe(true);
    const link = c.querySelector(".account-device-link");
    expect(link, "the retried mint's QR block").toBeTruthy();
    expect(link!.textContent).toBe(`${API_ORIGIN}/pair#${TOKEN}`);
    expect(calls.some((r) => r.url.includes("/auth/logout") || r.url.includes("/auth/refresh/logout"))).toBe(false);
  });

  it("the step-up sheet says codes are single-use, and a lockout says HOW LONG", async () => {
    // The trap this copy exists for, measured 2026-08-28 on a live account: the code that just
    // signed someone in is SPENT (single-use per timestep, cross-door), the sheet's refusal
    // deliberately reads as a wrong code, and five re-entries of the same six digits bought a
    // fifteen-minute lockout. The hint pre-empts the re-typing; the lockout sentence must then
    // say WHEN trying again is worth it, not just that it happened.
    answers["POST /api/pair"] = {
      status: 403,
      body: { error: { code: "step_up_required", message: "step-up verification required" } },
    };
    answers["GET /api/auth/session"] = {
      status: 200,
      body: { user: { twofaEnrolled: { webauthn: false, totp: true, recoveryCodes: true } }, scope: "full" },
    };
    const c = await mountSection();
    await click(buttonByText(c, "Add a device"));
    const prompt = factorPrompt(c);
    expect(prompt).toBeTruthy();
    expect(prompt!.textContent).toContain("Each code works once");

    // 700 seconds of `retryAfter` → "12 minutes", never the server's bare sentence.
    answers["POST /api/auth/step-up/totp"] = {
      status: 423,
      body: { error: { code: "account_locked", message: "too many failed attempts", details: { retryAfter: 700 } } },
    };
    const codeInput = within(c).queryByRole<HTMLInputElement>("textbox", { name: messages.devices.stepUpTotpLabel });
    expect(codeInput).toBeTruthy();
    await type(codeInput!, "123456");
    await click(buttonByText(c, "Verify code"));
    expect(factorPrompt(c)?.textContent).toContain("try again in 12 minutes");
    expect(factorPrompt(c)?.textContent).not.toContain("too many failed attempts");
  });
});

describe("the open codes — live device-pair rows only, revocable by their own id", () => {
  it("renders live device-pair codes, hides invite/spent rows, and revoke DELETEs the id", async () => {
    answers["GET /api/pair"] = {
      status: 200,
      body: {
        items: [
          LIVE_CODE,
          { ...LIVE_CODE, id: "pt-2", label: "Mara", grant: "invite" },
          { ...LIVE_CODE, id: "pt-3", label: "Spent one", status: "consumed", consumedAt: "2026-08-20T09:02:00.000Z" },
        ],
      },
    };
    answers["DELETE /api/pair/pt-1"] = { status: 204 };
    const c = await mountSection();
    expect(c.textContent).toContain("Codes not yet used");
    expect(c.textContent).toContain("Mila's phone");
    // Invite tokens belong to the Invites pane (on the build that has one); history stays off.
    expect(c.textContent).not.toContain("Mara");
    expect(c.textContent).not.toContain("Spent one");

    answers["GET /api/pair"] = { status: 200, body: { items: [] } };
    await click(buttonByText(c, "Revoke"));
    expect(calls.some((r) => r.method === "DELETE" && r.url.includes("/api/pair/pt-1"))).toBe(true);
    expect(c.textContent).not.toContain("Codes not yet used");
  });

  it("revoking the JUST-MINTED code clears the displayed QR and link — a dead credential must not stay on screen", async () => {
    // After a mint, `refresh()` lists the same token under "Codes not yet used" while the QR
    // and the typed-entry link stay displayed above it. Revoking that row killed the token but
    // left the display up — a credential shown as usable whose every redemption now refuses.
    // The pane keeps the minted row's ID and retires the display with the row.
    answers["POST /api/pair"] = {
      status: 200,
      body: { id: "pt-1", token: TOKEN, grant: "device-pair", label: "Mila's phone", expiresAt: "2026-08-20T09:05:00.000Z" },
    };
    answers["GET /api/pair"] = { status: 200, body: { items: [LIVE_CODE] } };
    answers["DELETE /api/pair/pt-1"] = { status: 204 };
    const c = await mountSection();
    await click(buttonByText(c, "Add a device"));
    expect(c.querySelector(".account-device-link"), "the minted display is up").toBeTruthy();
    expect(within(c).queryByText(messages.devices.codesTitle)).toBeNull();
    const shownRevoke = within(c).getByRole("button", { name: messages.devices.revokePairingLink });
    expect(shownRevoke.closest(".oh-sheet")?.querySelector(".account-device-link")).toBeTruthy();

    answers["GET /api/pair"] = { status: 200, body: { items: [] } };
    await click(shownRevoke);
    expect(calls.some((r) => r.method === "DELETE" && r.url.includes("/api/pair/pt-1"))).toBe(true);
    // The row is gone AND the credential display above it is gone with it.
    expect(c.querySelector(".account-device-link"), "the dead credential stayed on screen").toBeNull();
    expect(within(c).queryByRole("img", { name: messages.devices.qrAria }), "the dead QR stayed on screen").toBeNull();
    expect(c.textContent).not.toContain(TOKEN);

    // …and revoking some OTHER row leaves a live minted display alone: the retirement is keyed
    // on the row's own id, not on any revoke.
    answers["POST /api/pair"] = {
      status: 200,
      body: { id: "pt-9", token: TOKEN, grant: "device-pair", label: "Second", expiresAt: "2026-08-20T09:05:00.000Z" },
    };
    answers["GET /api/pair"] = { status: 200, body: { items: [{ ...LIVE_CODE, id: "pt-2", label: "Older code" }] } };
    answers["DELETE /api/pair/pt-2"] = { status: 204 };
    await click(buttonByText(c, "Add a device"));
    expect(c.querySelector(".account-device-link")).toBeTruthy();
    await click(buttonByText(c, "Revoke"));
    expect(c.querySelector(".account-device-link"), "an unrelated revoke took down a live display").toBeTruthy();
  });
});

describe("the signed-in list — the current row keeps its verb, every other row's is confirm-then-DELETE", () => {
  it("renders both rows; the current one offers no sign-out; the phone's confirm DELETEs dev-2 and the list drops it", async () => {
    answers["GET /api/devices"] = { status: 200, body: { items: [THIS_BROWSER, PAIRED_PHONE] } };
    answers["DELETE /api/devices/dev-2"] = { status: 204 };
    const c = await mountSection();
    expect(c.textContent).toContain("Signed in");
    expect(c.textContent).toContain("Mila's phone");
    expect(c.textContent).toContain("This browser");

    // Exactly ONE "Sign out" verb: the phone's. The current session's row must not wear one —
    // revoking yourself is signing out, a verb that already exists elsewhere.
    const signOuts = within(c).queryAllByRole("button", { name: "Sign out" });
    expect(signOuts).toHaveLength(1);

    await click(signOuts[0]!);
    expect(dialog(c).getAttribute("aria-labelledby")).toBeTruthy();
    expect(within(dialog(c)).getByRole("heading", { name: "Sign out Mila's phone" })).toBeTruthy();
    expect(dialog(c).querySelector(".oh-nowrap > .oh-dot")).toBeTruthy();

    answers["GET /api/devices"] = { status: 200, body: { items: [THIS_BROWSER] } };
    await click(buttonByText(dialog(c), "Sign out"));
    expect(calls.some((r) => r.method === "DELETE" && r.url.includes("/api/devices/dev-2"))).toBe(true);
    expect(c.textContent).not.toContain("Mila's phone");
    expect(c.textContent).toContain("This browser");
  });

  it("renders the platform-qualified kinds by name — a Linux desktop is not 'Browser'", async () => {
    // The device vocabulary's client half: the server now records desktop-linux/-windows and
    // the mobile kinds, and the pane must say so. The old two-arm word map rendered every
    // non-macos kind as "Browser", which is a lie precisely about the devices this list exists
    // to make visible. An unknown FUTURE kind falls back to the generic word, never "Browser".
    const named = (id: string, kind: string, label: string) => ({
      id, kind, label, createdAt: "2026-08-10T09:00:00.000Z",
      lastSeenAt: "2026-08-19T09:00:00.000Z", ip: "", current: false, named: true, pushToken: null,
    });
    answers["GET /api/devices"] = {
      status: 200,
      body: {
        items: [
          { ...THIS_BROWSER, named: false },
          named("dev-l", "desktop-linux", "work laptop"),
          named("dev-w", "desktop-windows", "gaming rig"),
          named("dev-m", "desktop-macos", "studio mac"),
          named("dev-a", "mobile-android", "pixel"),
          named("dev-i", "mobile-ios", "phone"),
          named("dev-x", "kind-from-the-future", "mystery"),
        ],
      },
    };
    const c = await mountSection();
    const rows = [
      ["work laptop", "Linux"],
      ["gaming rig", "Windows"],
      ["studio mac", "Mac"],
      ["pixel", "Android"],
      ["phone", "iOS"],
      ["mystery", "Device"],
    ];
    for (const [name, kind] of rows) {
      const row = within(c).getByRole("group", { name });
      expect(within(row).getByText(kind!, { exact: true })).toBeTruthy();
      expect(within(row).queryByText("Browser", { exact: true })).toBeNull();
    }
    expect(c.textContent).toContain("This browser");
  });

  it("a step-up-expired revoke opens the inline prompt, the row survives, and cancel drops the verb", async () => {
    answers["GET /api/devices"] = { status: 200, body: { items: [THIS_BROWSER, PAIRED_PHONE] } };
    answers["DELETE /api/devices/dev-2"] = {
      status: 403,
      body: { error: { code: "step_up_required", message: "step-up verification required" } },
    };
    answers["GET /api/auth/session"] = {
      status: 200,
      body: { user: { twofaEnrolled: { webauthn: false, totp: true, recoveryCodes: true } }, scope: "full" },
    };
    const c = await mountSection();
    await click(buttonByText(c, "Sign out"));
    await click(buttonByText(dialog(c), "Sign out"));
    // The prompt, not the dead end; the device is untouched underneath.
    expect(factorPrompt(c)).toBeTruthy();
    expect(c.textContent).not.toContain("Sign in again");
    expect(c.textContent).toContain("Mila's phone");
    // Cancel abandons the parked revoke — nothing re-fires it.
    const deletesBefore = calls.filter((r) => r.method === "DELETE").length;
    await click(buttonByText(c, "Cancel"));
    expect(factorPrompt(c)).toBeNull();
    expect(calls.filter((r) => r.method === "DELETE").length).toBe(deletesBefore);
  });
});

describe("the collapsed web-session group — hosted flavor, server-discriminated rows", () => {
  const HELLO_MANAGED = HELLO(true);
  /** New-shape rows: the server's own `named` discriminator, plain rows label-less. */
  const CURRENT = { ...THIS_BROWSER, label: "", named: false };
  const NAMED_PHONE = { ...PAIRED_PHONE, named: true };
  const plain = (n: number) => ({
    id: `sess-${n}`, kind: "web", label: "", createdAt: "2026-07-01T09:00:00.000Z",
    lastSeenAt: "2026-08-01T09:00:00.000Z", ip: "", current: false, named: false, pushToken: null,
  });

  it("collapses plain sessions into one group row; named devices and the current row stay individual", async () => {
    answers["GET /api/hello"] = HELLO_MANAGED;
    answers["GET /api/devices"] = {
      status: 200, body: { items: [CURRENT, NAMED_PHONE, plain(1), plain(2), plain(3)] },
    };
    const c = await mountSection();
    expect(c.textContent).toContain("3 other web sessions");
    expect(c.textContent).toContain("Mila's phone");
    expect(c.textContent).toContain("This browser");
    // The plain rows do NOT render individually: exactly one group verb, no per-row sign-out
    // beyond the named device's.
    const signOuts = within(c).queryAllByRole("button", { name: "Sign out" });
    expect(signOuts).toHaveLength(1); // the named phone's
    expect(buttonByText(c, "Sign out all")).toBeTruthy();
  });

  it("'Sign out all' is confirm-then-POST to the bulk route, and reports the server's own count", async () => {
    answers["GET /api/hello"] = HELLO_MANAGED;
    answers["GET /api/devices"] = {
      status: 200, body: { items: [CURRENT, NAMED_PHONE, plain(1), plain(2)] },
    };
    answers["POST /api/devices/revoke-web-sessions"] = { status: 200, body: { revoked: 2 } };
    const c = await mountSection();
    await click(buttonByText(c, "Sign out all"));
    expect(within(dialog(c)).getByRole("heading", { name: "Sign out 2 web sessions" })).toBeTruthy();
    expect(dialog(c).querySelector(".oh-nowrap > .oh-dot")).toBeTruthy();
    // The refreshed list: the plain rows are gone.
    answers["GET /api/devices"] = { status: 200, body: { items: [CURRENT, NAMED_PHONE] } };
    await click(buttonByText(dialog(c), "Sign out all"));
    expect(calls.some((r) => r.method === "POST" && r.url.includes("/api/devices/revoke-web-sessions"))).toBe(true);
    expect(c.textContent).not.toContain("other web session");
    expect(c.textContent).toContain("Mila's phone");
  });

  it("does NOT collapse where the flavor is not hosted/self-host — the desktop-host door has no bulk route", async () => {
    answers["GET /api/hello"] = {
      status: 200,
      body: { ...(HELLO_MANAGED.body as Record<string, unknown>), flavor: "desktop-host" },
    };
    answers["GET /api/devices"] = {
      status: 200, body: { items: [CURRENT, NAMED_PHONE, plain(1), plain(2)] },
    };
    const c = await mountSection();
    expect(c.textContent).not.toContain("other web session");
    expect((within(c).queryByRole("button", { name: "Sign out all" }) !== null)).toBe(false);
    // The plain rows render individually instead — every session stays visible and revocable.
    const signOuts = within(c).queryAllByRole("button", { name: "Sign out" });
    expect(signOuts).toHaveLength(3); // the named phone + the two plain rows
  });

  it("an older server that sends no `named` keeps its rows individual — nothing is guessed from labels", async () => {
    answers["GET /api/hello"] = HELLO_MANAGED;
    answers["GET /api/devices"] = { status: 200, body: { items: [THIS_BROWSER, PAIRED_PHONE] } };
    const c = await mountSection();
    expect(c.textContent).not.toContain("other web session");
    expect(c.textContent).toContain("Mila's phone");
  });
});

describe("Strict Mode — development double-mount must not wedge the pane", () => {
  it("both lists still render under a replayed mount effect", async () => {
    answers["GET /api/devices"] = { status: 200, body: { items: [PAIRED_PHONE] } };
    answers["GET /api/pair"] = { status: 200, body: { items: [LIVE_CODE] } };
    const { DevicesSection } = await import("../app/(product)/mailbox/DevicesSection.js");
    const c = await mountNode(h(React.StrictMode, null, h(WithReport, { view: DevicesSection })));
    expect(c.textContent).toContain("Mila's phone");
    expect(c.textContent).toContain("Codes not yet used");
  });
});

describe("the list is live: a device paired while the pane is open appears in it, and only then counts as told", () => {
  const AT = "2026-11-17T09:00:00.000Z";
  let seq = 0;
  const PAIRED: Notice = { kind: "pairing", change: "paired", device: null };

  /**
   * The account's engine as the pane and the notices read it: its copy, where a ring puts the settings
   * record, and its subscription. The notices' reads are built as every surface builds them, with the
   * person standing at this pane in a window that is looked at.
   */
  async function paneWithNotices() {
    const copy = new MemoryMirrorStore();
    await copy.load();
    const listeners = new Set<() => void>();
    const engine = {
      read: () => copy,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const ring = async (made: number): Promise<void> => {
      await copy.applyChanges([{
        type: "settings", op: "update", id: "acct", seq: ++seq, updatedAt: AT,
        entity: {
          accountId: "acct", dormancyDays: null, folderMailboxesOff: {}, locale: null, updatedAt: AT,
          devices: made, devicesMade: made, devicesRevoked: 0,
        },
      } as SyncChange]);
      await act(async () => {
        for (const listener of listeners) listener();
        await Promise.resolve();
      });
    };
    await ring(1);
    const jar = new Map<string, string>();
    const told = toldDevicesIn({
      get: (key) => jar.get(key) ?? null,
      set: (key, value) => { jar.set(key, value); return "stored"; },
      remove: (key) => { jar.delete(key); return "stored"; },
    });
    /** In front the platform draws nothing; behind it takes the notice. */
    let behind = false;
    const posted: Notice[] = [];
    const emitter: HostNoticeEmitter = {
      carries: ["ohbox", "screener", "pairing"], acts: [], ahead: "none",
      post: (notice) => { posted.push(notice); return behind; },
      takeBack: () => undefined,
    };
    const caller = new NoticeCaller(emitter, noticeReadsOf(engine, { permission: () => "granted" }, {
      choices: () => noticeChoicesOf(null, null, { ohcalPhone: false }),
      atDevices: () => !behind,
      told,
    }));
    const binding = { engine, demo: false, serverDemo: false, sync: { state: "idle" } } as unknown as EngineBinding;
    const c = await mountSection(binding);
    const settle = (): void => caller.settle("acct", copy);
    return {
      c, ring, settle, posted,
      kept: () => told.read("acct"),
      goBehind: () => { behind = true; },
      listReads: () => calls.filter((r) => r.method === "GET" && r.url.includes("/api/devices")).length,
    };
  }

  it("the record rises, the list is read again and shows the new device, and only then the numbers are kept", async () => {
    answers["GET /api/devices"] = { status: 200, body: { items: [THIS_BROWSER] } };
    const p = await paneWithNotices();
    p.settle();
    expect(p.kept(), "this browser's first sign-in learns the record").toEqual({ made: 1, revoked: 0 });
    const readsBefore = p.listReads();

    // At night a device is paired: the ring reaches the copy while the list's read is still on the wire.
    let answer!: () => void;
    answers["GET /api/devices"] = {
      status: 200, body: { items: [THIS_BROWSER, PAIRED_PHONE] }, held: new Promise<void>((r) => { answer = r; }),
    };
    await p.ring(2);
    expect(p.listReads(), "the pane reads its list again by itself").toBe(readsBefore + 1);
    p.settle();
    expect(p.kept(), "a rise the list does not show yet is not told").toEqual({ made: 1, revoked: 0 });
    expect(p.c.textContent).not.toContain("Mila's phone");

    await act(async () => {
      answer();
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(p.c.textContent).toContain("Mila's phone");
    p.settle();
    expect(p.kept(), "the list shows the new device: the person has read it").toEqual({ made: 2, revoked: 0 });
    p.goBehind();
    p.settle();
    // Handed twice to a window in front, which drew neither; nothing once it is behind.
    expect(p.posted, "nothing more to tell once the window is behind").toEqual([PAIRED, PAIRED]);
  });

  it("a read of the list already on the wire when the device is paired does not count the device as shown", async () => {
    // The pane opens and reads its list; the pairing rings before that read answers, with the old list.
    let first!: () => void;
    answers["GET /api/devices"] = {
      status: 200, body: { items: [THIS_BROWSER] }, held: new Promise<void>((r) => { first = r; }),
    };
    const p = await paneWithNotices();
    p.settle();
    let second!: () => void;
    answers["GET /api/devices"] = {
      status: 200, body: { items: [THIS_BROWSER, PAIRED_PHONE] }, held: new Promise<void>((r) => { second = r; }),
    };
    await p.ring(2);
    await act(async () => {
      first();
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    p.settle();
    expect(p.kept(), "the list that answered was read before the pairing").toEqual({ made: 1, revoked: 0 });
    await act(async () => {
      second();
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(p.c.textContent).toContain("Mila's phone");
    p.settle();
    expect(p.kept()).toEqual({ made: 2, revoked: 0 });
  });

  it("with the list's read failing nothing is kept, and the notice is drawn once the window is behind", async () => {
    answers["GET /api/devices"] = { status: 200, body: { items: [THIS_BROWSER] } };
    const p = await paneWithNotices();
    p.settle();
    answers["GET /api/devices"] = { status: 503, body: { error: { code: "unavailable", message: "unavailable" } } };
    await p.ring(2);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    p.settle();
    expect(p.kept(), "the list could not show the new device").toEqual({ made: 1, revoked: 0 });
    expect(p.c.textContent).not.toContain("Mila's phone");
    p.goBehind();
    p.settle();
    expect(p.posted).toEqual([PAIRED, PAIRED]);
    expect(p.kept(), "told once the platform took it").toEqual({ made: 2, revoked: 0 });
  });
});
