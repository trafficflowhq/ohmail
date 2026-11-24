/** @vitest-environment jsdom */
/**
 * ═══ THE SPLASH SPENDS A REFRESH TOKEN, SO IT HAD BETTER BE THE RIGHT BROWSER'S ═══════════
 *
 * The resume splash is chosen by the EDGE, under the cookies of the request that asked for `/`.
 * Its effect does not run until that document has been delivered and hydrated, and the cross-tab
 * lock inside the refresh adds a second wait. Either gap is long enough for another tab to sign
 * in and replace the shared jar.
 *
 * What happens then is not a wrong screen. `POST /auth/refresh` ROTATES whatever session the jar
 * holds, so the splash spends the OTHER account's refresh token — and a rotation consumes it, so
 * that account's own tab can later present a consumed token and be read as reuse. The reload that
 * follows then opens their mailbox in a window that was selected for somebody else.
 *
 * ── WHY THE ACCOUNT COMES FROM THE SERVER ────────────────────────────────────────────────
 *
 * A client-side read cannot see the gap, because it happens after it: by the time any code in
 * this document runs, the jar already says B. So the marker is read where the CHOICE was made —
 * `resume/page.tsx`, a server component — and handed down, and the comparison happens inside the
 * lock immediately before the request leaves.
 *
 * ── AND THE REFUSAL IS A RELOAD, NOT A SIGN-IN SCREEN ────────────────────────────────────
 *
 * B is signed in. Sending them to `/login` would answer "you are already here" with the front
 * door; reloading lets the server serve whoever it now holds. That distinction is asserted below,
 * because a refusal that lands somewhere wrong is its own defect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

process.env.NEXT_PUBLIC_API_BASE = "/api";

const A = "acct_A";
const B = "acct_B";

let asked: string[] = [];
let reloads = 0;
let replaced: string[] = [];
let priorFetch: typeof globalThis.fetch;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
/** Runs inside the fetch handler — a hook for "the jar changed while this was in flight". */
let duringFlight: (() => void) | null = null;

const setOwner = (v: string | null): void => {
  document.cookie = v === null ? "tf_owner=; Path=/; Max-Age=0" : `tf_owner=${v}; Path=/`;
};

beforeEach(() => {
  asked = [];
  reloads = 0;
  replaced = [];
  duringFlight = null;
  sessionStorage.clear();
  setOwner(A);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      href: "https://mail.example/", origin: "https://mail.example", protocol: "https:",
      reload: () => { reloads += 1; },
      replace: (u: string) => { replaced.push(u); },
    },
  });
  priorFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown) => {
    asked.push(String(input));
    duringFlight?.();
    return new Response(null, { status: 204 });
  }) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
  globalThis.fetch = priorFetch;
  setOwner(null);
  sessionStorage.clear();
  vi.restoreAllMocks();
});

async function mountResume(initialOwner: string | null): Promise<void> {
  const { ResumeRoute } = await import("../app/(product)/resume/ResumeRoute.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(ResumeRoute, { initialOwner }),
    }));
  });
  for (let i = 0; i < 12; i += 1) await act(async () => { await Promise.resolve(); });
}

const refreshes = (): string[] => asked.filter((u) => u.includes("/auth/refresh"));

describe("the resume splash refreshes the account it was chosen for, or nobody", () => {
  it("THE CONTROL — the jar has not changed, so it resumes and reloads", async () => {
    await mountResume(A);
    expect(refreshes().length, "the splash did not resume at all, so every refusal below is free")
      .toBe(1);
    expect(reloads, "a successful resume did not reload").toBe(1);
    expect(replaced, "a successful resume sent the person to the front door").toEqual([]);
  });

  it("the jar changed hands before hydration — spends nothing, and does not send them to /login", async () => {
    /* The edge chose this page for A. By the time this document runs, another tab has signed in
       as B. Every client-side read from here on says B, which is why the account has to come
       from the server: there is nothing left in this process that remembers A. */
    setOwner(B);
    await mountResume(A);
    expect(refreshes(), "the splash spent another account's refresh token")
      .toEqual([]);
    expect(replaced, "a signed-in person was sent to the sign-in screen").toEqual([]);
    expect(reloads, "the window was left on a blank splash with nothing happening").toBe(1);
  });

  /**
   * THE NARROWER WINDOW, AND THE ONE THAT SAYS WHERE THE CHECK HAS TO LIVE.
   *
   * The marker still says A when the effect runs and becomes B while the resume waits for the
   * cross-tab lock. A check at the call site cannot see that; only one inside the lock,
   * immediately before the request leaves, can — which is where `csrfToken()` is read and for the
   * same reason.
   *
   * Staged through a lock manager that flips the jar between the grant being asked for and the
   * callback running. That is the real ordering: the lock is what the caller waits on.
   */
  it("the jar changes while the resume waits for the lock — the refusal is inside it", async () => {
    Object.defineProperty(globalThis.navigator, "locks", {
      configurable: true,
      value: {
        request: async (_n: string, _o: unknown, fn: () => Promise<unknown>) => {
          setOwner(B);                       // another tab signs in while this one queues
          return fn();
        },
      },
    });
    try {
      await mountResume(A);
      expect(refreshes(), "the resume rotated a session that had become somebody else's while it waited")
        .toEqual([]);
      expect(replaced, "a signed-in person was sent to the sign-in screen").toEqual([]);
      expect(reloads, "the window was left on a blank splash").toBe(1);
    } finally {
      Reflect.deleteProperty(globalThis.navigator as unknown as Record<string, unknown>, "locks");
    }
  });

  /**
   * NO MARKER AT THE EDGE IS THE ORDINARY CROSS-SITE CASE, AND IT MUST NOT READ AS "SOMEBODY
   * ELSE".
   *
   * `SameSite=Strict` withholds the cookies from a cross-site top-level navigation — the very
   * case this splash exists for — so the edge sees no marker while the jar still holds one, and
   * this document CAN read it. Comparing the two would refuse the one flow the surface was built
   * to serve, which is why the predicate treats a null `initialOwner` as "nothing to compare"
   * rather than as a mismatch.
   *
   * The cookie is deliberately set here: with both sides null the distinction is invisible and
   * this case would pass under a predicate that compares them.
   */
  it("no marker at the edge — nothing to compare, and the resume still runs", async () => {
    setOwner(A);
    await mountResume(null);
    expect(refreshes().length, "the cross-site resume — the whole reason this page exists — was refused")
      .toBe(1);
    expect(reloads).toBe(1);
  });
});

/**
 * ═══ AND THE HANDOFF ITSELF, WHICH EVERY CASE ABOVE INJECTS PAST ═════════════════════════
 *
 * A later review's third finding. Every behavioural case here passes `initialOwner` to the component directly —
 * which is what lets them drive the sequences, and is exactly why none of them can see the prop
 * being dropped at its source. Delete the handoff in `page.tsx` and the component is left reading
 * `null`, "nothing to compare" swallows every mismatch, and all four cases above stay green while
 * the hydration race is fully restored.
 *
 * This seam has to be read from the SERVER component, so a mount cannot assert it: `page.tsx` is
 * where the marker is read at the moment the edge chose this surface, and that moment is the only
 * one that knows. Asserted structurally, which is the instrument this repository already uses for
 * the wiring it has shipped unsupplied three times.
 */
describe("the resume page hands the account down", () => {
  it("reads the marker on the server and passes it as initialOwner", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(process.cwd(), "apps/webapp/app/(product)/resume/page.tsx"), "utf8");

    expect(src, "the page does not read the marker at all — the screen has nothing to compare against")
      .toMatch(/cookieFromStore\(\s*await cookies\(\)\s*,\s*OWNER_COOKIE\s*\)/);
    expect(src, "the marker is read and then not handed down")
      .toMatch(/initialOwner=\{/);
    /* Read on the SERVER. A client-side read would be a different value entirely — the jar as it
       is after hydration, which is the thing the gap makes wrong. */
    expect(src, "the read is not the server component's").toContain('from "next/headers"');
  });
});
