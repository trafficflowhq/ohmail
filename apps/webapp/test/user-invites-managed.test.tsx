/** @vitest-environment jsdom */
/**
 * ═══ THE INVITE SURFACES ON THE MANAGED BUILD: STRUCTURALLY ABSENT ══════════════════════════
 *
 * The compiled half of the flavor gate, in its own file because the flavor is inlined at module
 * load — one flavor per process, exactly as one flavor per bundle (`user-invites.test.tsx`
 * carries the self-host half). NO flavor is set here, which IS the managed build: the
 * `OHMAIL_FLAVOR` arm only exists on the self-host compose.
 *
 * Two absences, each pinned at the strongest observable:
 *
 *  1. **`useUserInvites` answers false WITHOUT asking `/hello`** — even against a server
 *     scripted to announce `features.pairing: true`. The managed API mounts no `/pair` mint
 *     routes (an invite redeem there would bypass the billing funnel), so a managed tab that
 *     asked "may I show the pane?" would be paying a round trip for a question whose answer is
 *     compiled. The wire assertion is what the recorded mutation cannot pass: forcing
 *     `SELF_HOST_BUILD` true in `app/hello.ts` makes this case red twice over (a `/hello`
 *     leaves, and the hook flips on).
 *  2. **`/join/invite` is a 404** — `notFound()`, thrown before the screen exists. Nothing on
 *     managed ever mints a link of this shape; a live page there would be a form whose submit
 *     can only bounce. Mutation: forcing the page's flavor constant true turns this case red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
// THE MANAGED BUILD: no flavor inlined. Deleted defensively in case a runner env carries one.
delete process.env.NEXT_PUBLIC_OHMAIL_FLAVOR;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOT_FOUND = new Error("NEXT_NOT_FOUND (test stub)");
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  notFound: () => {
    throw NOT_FOUND;
  },
}));

let calls: string[] = [];
let originalFetch: typeof globalThis.fetch;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  calls = [];
  originalFetch = globalThis.fetch;
  // A server that WOULD say yes, deliberately: `features.pairing: true`. The point is that the
  // managed bundle never even asks.
  globalThis.fetch = vi.fn(async (input: unknown) => {
    calls.push(String(input));
    return new Response(
      JSON.stringify({
        product: "ohmail", flavor: "selfhost", apiVersion: "0.0.0", needsSetup: false,
        auth: { password: true, totp: true, webauthn: true, publicSignup: false },
        features: { sse: true, staging: true, ai: false, pairing: true },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
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

describe("the managed build's invite gate", () => {
  it("useUserInvites answers false and never asks /hello — even a pairing-capable server cannot summon the pane", async () => {
    const { useUserInvites } = await import("../app/(product)/mailbox/use-user-invites.js");
    function Probe() {
      return h("output", null, useUserInvites(false) ? "invites:on" : "invites:off");
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        h(NextIntlClientProvider, {
          locale: "en", messages, timeZone: "UTC",
          children: h(ThemeProvider, null, h(ToastHost, null, h(Probe))),
        }),
      );
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(host.textContent).toContain("invites:off");
    // THE WIRE ASSERTION the flavor mutation cannot pass: the managed bundle's effect body is
    // a compiled-out constant, so no capability probe ever leaves.
    expect(calls.some((u) => u.includes("/hello")), "no /hello left the managed build").toBe(false);
  });

  it("/join/invite is a 404 on the managed build — notFound() before any screen exists", async () => {
    const page = (await import("../app/(product)/join/invite/page.js")).default;
    expect(() => page()).toThrow(NOT_FOUND);
  });
});
