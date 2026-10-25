/** @vitest-environment jsdom */
/**
 * ═══ SETTINGS → INVITES — SELF-HOST ONLY, MINT → LINK → QR, LIST, REVOKE ════════════════════
 *
 * The self-host invites pane: `POST /pair` mints an invite, the pane shows ONE link
 * (`<origin>/join/invite#<token>`) as a QR plus a copy button, lists the open invites, and
 * takes one back with `DELETE /pair/:id`. What is pinned, deliberately at the wire and the
 * rendered artifact rather than at labels:
 *
 *  1. **The gate is compiled + negotiated.** `useUserInvites` answers `false` on the managed
 *     flavor WITHOUT even asking `/hello` (the flavor is a build arm; the managed bundle pays
 *     no round trip for a pane it can never have), and on the self-host flavor it answers what
 *     `features.pairing` says. The recorded mutation: forcing `SELF_HOST_BUILD` true makes the
 *     managed case red — a `/hello` fetch leaves and the hook flips on.
 *  2. **The QR encodes the exact link.** The rendered SVG is decoded by the spec-derived
 *     decoder (`fixtures/qr-decode.ts`, itself anchored to a foreign encoder's bytes) back to
 *     `${origin}/join/invite#<the minted token>` — not "a QR is present", the payload itself.
 *  3. **The raw token is never SHOWN.** The design rule is scan-or-copy over print; the pane's
 *     textContent must not contain the token. The copy button carries it to the clipboard.
 *  4. **Revoke hits the row's own id and the list refreshes.**
 *  5. **A closed step-up window asks for the factor in place** — `DevicesSection`'s discipline.
 *
 * The real `InvitesSection`, the real `api-client`, only `fetch` (and the clipboard) stubbed —
 * the settings-parity suite's mount, the setup suite's wire recording.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import { decodeQr, matrixFromSvg } from "./fixtures/qr-decode";

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
// THE FLAVOR, before any module under test loads — the test-side twin of the build inlining
// it. One flavor per process, exactly as one flavor per bundle: the MANAGED build's half of
// the gate lives in `user-invites-managed.test.tsx`.
process.env.NEXT_PUBLIC_OHMAIL_FLAVOR = "selfhost";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOKEN = "udfcxjjqlambhcvfnzikwbasgdteghcyrfepaoqiiue-fixture-token";

type Answer = { status: number; body?: unknown };
/** Scripted answers by `"METHOD path"`, plus a record of every request — the wire is what the suite reads. */
let answers: Record<string, Answer> = {};
let calls: Array<{ method: string; url: string; body: unknown }> = [];
let originalFetch: typeof globalThis.fetch;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

const HELLO = (pairing: boolean): Answer => ({
  status: 200,
  body: {
    product: "ohmail", flavor: "selfhost", apiVersion: "0.0.0", needsSetup: false,
    auth: { password: true, totp: true, webauthn: true, publicSignup: false },
    features: { sse: true, staging: true, ai: false, pairing },
  },
});

const LIVE_ROW = {
  id: "pt-1", grant: "invite", label: "Mara", createdAt: "2026-08-10T09:00:00.000Z",
  expiresAt: "2026-08-17T09:00:00.000Z", consumedAt: null, revokedAt: null, status: "live",
};

beforeEach(() => {
  answers = { "GET /api/pair": { status: 200, body: { items: [] } } };
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
    return new Response(a.body === undefined ? null : JSON.stringify(a.body), {
      status: a.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = originalFetch;
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

async function mountSection(): Promise<HTMLElement> {
  const { InvitesSection } = await import("../app/(product)/mailbox/InvitesSection.js");
  return mountNode(h(InvitesSection));
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

const buttonByText = (c: HTMLElement, text: string): HTMLButtonElement => {
  const b = [...c.querySelectorAll("button")].find((x) => x.textContent?.trim() === text);
  expect(b, `a button reading "${text}"`).toBeTruthy();
  return b!;
};

describe("useUserInvites — the negotiated half of the gate (the compiled half is `user-invites-managed.test.tsx`)", () => {
  /** A probe that renders the hook's answer, so the DOM is the assertion surface. */
  async function mountProbe(demo = false): Promise<HTMLElement> {
    const { useUserInvites } = await import("../app/(product)/mailbox/InvitesSection.js");
    function Probe() {
      return h("output", null, useUserInvites(demo) ? "invites:on" : "invites:off");
    }
    return mountNode(h(Probe));
  }

  it("the self-host flavor with features.pairing:true answers true", async () => {
    answers["GET /api/hello"] = HELLO(true);
    const c = await mountProbe();
    expect(c.textContent).toContain("invites:on");
  });

  /**
   * DEMO-HYDRATION-EGRESS. This hook had no demo gate at all, so a fixtures page on a self-host
   * build paid a `/hello` round trip for a pane whose every verb mints a real credential. The
   * verdict is the WIRE — an answer of `invites:off` could come from a server that simply said
   * no.
   */
  it("a demo page issues no /hello at all", async () => {
    answers["GET /api/hello"] = HELLO(true);
    const c = await mountProbe(true);
    expect(c.textContent).toContain("invites:off");
    expect(calls.filter((x) => x.url.includes("/hello")), "the demo reached the network").toEqual([]);
  });

  it("the self-host flavor against a server NOT announcing pairing answers false — absence from the descriptor, not a 404 mid-flow", async () => {
    answers["GET /api/hello"] = HELLO(false);
    const c = await mountProbe();
    expect(c.textContent).toContain("invites:off");
  });
});

describe("the Settings nav — a wired invitesSection is an entry, an absent one is none", () => {
  async function mountSettings(withInvites: boolean): Promise<HTMLElement> {
    const { SettingsView } = await import("../app/views/SettingsView.js");
    return mountNode(
      h(SettingsView, {
        notifications: null, tags: [], tagCounts: {},
        ...(withInvites ? { invitesSection: h("p", { className: "invites-probe" }, "the pane") } : {}),
      }),
    );
  }

  it("wired ⇒ an Invites entry that opens the node", async () => {
    const c = await mountSettings(true);
    const entry = [...c.querySelectorAll(".set-nav button")].find((b) => b.textContent?.trim() === "Invites");
    expect(entry, "the Invites nav entry").toBeTruthy();
    await click(entry!);
    expect(c.querySelector(".invites-probe")).toBeTruthy();
  });

  it("absent ⇒ no entry, structurally", async () => {
    const c = await mountSettings(false);
    expect([...c.querySelectorAll(".set-nav button")].map((b) => b.textContent?.trim())).not.toContain("Invites");
  });
});

describe("mint → one link, shown as a QR and a copy button — never as printed text", () => {
  it("POST /pair carries the label; the QR decodes to the exact invite link; the clipboard gets the same", async () => {
    answers["POST /api/pair"] = {
      status: 200,
      body: { id: "pt-9", token: TOKEN, grant: "invite", label: "Mara", expiresAt: "2026-08-25T09:00:00.000Z" },
    };
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: (s: string) => { written.push(s); return Promise.resolve(); } },
    });

    const c = await mountSection();
    await type(c.querySelector<HTMLInputElement>(".invites-mint input")!, "Mara");
    await click(buttonByText(c, "Make an invite link"));

    const mint = calls.find((r) => r.method === "POST" && r.url.includes("/api/pair") && !r.url.includes("redeem"));
    expect(mint, "the mint left").toBeTruthy();
    expect(mint!.body).toMatchObject({ grant: "invite", label: "Mara" });

    // THE ARTIFACT, not the label: decode the rendered QR back to the exact link. `qr-decode`
    // is the spec-derived decoder anchored to a foreign encoder's bytes, so this is the whole
    // chain — mint response → link assembly → encoder → SVG — under one assertion.
    const link = `${window.location.origin}/join/invite#${TOKEN}`;
    const svg = c.querySelector<SVGSVGElement>(".join-qr svg");
    expect(svg, "the QR rendered").toBeTruthy();
    expect(decodeQr(matrixFromSvg(svg!))).toBe(link);

    // The raw token is never PRINTED — scan or copy, per the design rules.
    expect(c.textContent).not.toContain(TOKEN);

    await click(buttonByText(c, "Copy the link"));
    expect(written).toEqual([link]);
    // The toast may only speak AFTER the write fulfilled — see the refusal case below.
    expect(document.body.textContent).toContain("Link copied.");
  });

  it("a refused clipboard never claims success — the QR is named as the path that still works", async () => {
    answers["POST /api/pair"] = {
      status: 200,
      body: { id: "pt-9", token: TOKEN, grant: "invite", label: "", expiresAt: "2026-08-25T09:00:00.000Z" },
    };
    // A clipboard that REFUSES (no permission, no focus) — the raw link is deliberately not
    // printed anywhere, so a "Link copied." over a rejected write would strand the operator
    // with nothing to send. Review finding, fixed red-first.
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });

    const c = await mountSection();
    await click(buttonByText(c, "Make an invite link"));
    await click(buttonByText(c, "Copy the link"));

    expect(document.body.textContent).not.toContain("Link copied.");
    expect(c.textContent).toContain("scan the code");
  });

  it("a closed step-up window asks for the factor in place, and is not swallowed", async () => {
    answers["POST /api/pair"] = {
      status: 403,
      body: { error: { code: "step_up_required", message: "step-up verification required" } },
    };
    answers["GET /api/auth/session"] = {
      status: 200,
      body: { user: { email: "o@example.test", twofaEnrolled: { webauthn: false, totp: true } }, scope: "full" },
    };
    const c = await mountSection();
    await click(buttonByText(c, "Make an invite link"));
    expect(c.querySelector('[data-testid="step-up-prompt"]'), "the refusal was a dead end").toBeTruthy();
    expect(calls.filter((x) => x.method === "POST" && x.url.endsWith("/api/pair"))).toHaveLength(1);
    expect(c.querySelector('[role="alert"]'), "the prompt was answered with an error").toBeNull();
  });
});

describe("Strict Mode — development double-mount must not wedge the pane", () => {
  it("the list still renders under a replayed mount effect", async () => {
    // React 18 Strict Mode runs the mount effect's cleanup and then the setup AGAIN. A
    // liveness ref that is armed at declaration and only ever DISARMED in cleanup is false
    // for the whole second life, so every list answer is discarded and the pane sticks
    // empty. Review finding, fixed red-first: the setup must re-arm the ref.
    answers["GET /api/pair"] = { status: 200, body: { items: [LIVE_ROW] } };
    const { InvitesSection } = await import("../app/(product)/mailbox/InvitesSection.js");
    const c = await mountNode(h(React.StrictMode, null, h(InvitesSection)));
    expect(c.textContent).toContain("Mara");
  });
});

describe("the list — live invites only, and revoke removes the row it names", () => {
  it("renders live invite rows (label, made/expires) and hides spent, expired and device-pair rows", async () => {
    answers["GET /api/pair"] = {
      status: 200,
      body: {
        items: [
          LIVE_ROW,
          { ...LIVE_ROW, id: "pt-2", label: "Grandpa", status: "consumed", consumedAt: "2026-08-11T09:00:00.000Z" },
          { ...LIVE_ROW, id: "pt-3", label: "Old one", status: "expired" },
          { ...LIVE_ROW, id: "pt-4", label: "My phone", grant: "device-pair" },
        ],
      },
    };
    const c = await mountSection();
    expect(c.textContent).toContain("Open invites");
    expect(c.textContent).toContain("Mara");
    // History and other credential classes stay off this pane.
    expect(c.textContent).not.toContain("Grandpa");
    expect(c.textContent).not.toContain("Old one");
    expect(c.textContent).not.toContain("My phone");
  });

  it("revoke DELETEs the row's own id and the refreshed list drops it", async () => {
    answers["GET /api/pair"] = { status: 200, body: { items: [LIVE_ROW] } };
    answers["DELETE /api/pair/pt-1"] = { status: 204 };
    const c = await mountSection();
    expect(c.textContent).toContain("Mara");

    answers["GET /api/pair"] = { status: 200, body: { items: [] } };
    await click(buttonByText(c, "Revoke"));

    expect(calls.some((r) => r.method === "DELETE" && r.url.includes("/api/pair/pt-1"))).toBe(true);
    expect(c.textContent).not.toContain("Mara");
    expect(c.textContent).not.toContain("Open invites");
  });
});
