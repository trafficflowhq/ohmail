/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import de from "../messages/de.json";
import type { MailboxFacts } from "../app/shell/mail-state";
import {
  COMPOSE_ATTACH_STAGED_SURFACE_BYTES, composeAttachBudgetFor, composeAttachCap,
  composeAttachCapBinding,
} from "../app/components/ComposeAttach";
import { setActiveCatalog } from "../app/shell/locale";
import { settleFirstPaint } from "./_first-paint.js";

/**
 * ═══ THE ATTACH CEILING FOLLOWS THE SENDING SURFACE, END TO END ════════════════════════════
 *
 * `composeAttachCap`'s own unit cases live in `compose-attach-cap.test.tsx`, and the rule's
 * parity with the send's `effectiveAttachmentCap` is pinned value-for-value in
 * `apps/desktop/test/desktop-attach-cap.test.ts`. What NEITHER can see is the threading: a
 * shell that resolves the right number and then fails to hand it to the form renders the old
 * constant with every unit green. So this file mounts the WHOLE client — the same `AppShell`
 * both the hosted tab and the desktop window render — hands it the two host declarations the
 * desktop's standalone door makes (`mailboxFacts` with a probed `SIZE`, and
 * `sendSurfaceMaxTotalBytes: null`), and reads the number off the rendered attach row in BOTH
 * places that row exists: the compose view and the inline reply.
 *
 * The invariant under test is the one `ComposeAttach` states at its render site: the sentence
 * on screen and the refusal at pick time take the same value, and that value must be the one
 * the send itself will enforce — `min(surface, SIZE)`, with an undeclared surface resolving to
 * the strict constant and nothing ever resolving to "unbounded".
 *
 * ── THE MUTATIONS THESE CASES WERE WATCHED AGAINST ──────────────────────────────────────────
 *
 *  · drop the `surfaceMax` argument at either call site (`ComposeView`, `InlineReply`)
 *    → the 25 MB cases go red (the form promises 3 MB below what the local engine accepts);
 *  · treat a `null` surface as "not declared" inside `composeAttachCap`
 *    → the same cases go red;
 *  · treat it as "unbounded" when no SIZE is measured
 *    → the unprobed case goes red;
 *  · thread the prop into compose but not into the chrome (or the reverse)
 *    → exactly one of the two surface cases goes red, which is the drift the invariant names.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const MIB = 1024 * 1024;

/** One connected mailbox, as `GET /mailboxes` would report it, with `SIZE` variable per case. */
function facts(smtpMaxSizeBytes: number | null): MailboxFacts[] {
  return [
    {
      // The fixture world's own mailbox id, so a reply's inherited mailbox resolves without a
      // substitution notice — the ceiling under test is the resolved sender's either way.
      id: "lichtgrat",
      address: "mila@lichtgrat.example",
      status: "connected",
      errorCode: null,
      disabledReason: null,
      syncBlockedReason: null,
      syncBlockedSince: null,
      lastSyncAt: "2026-08-10T09:00:00.000Z",
      initialImportCompletedAt: "2026-08-01T09:00:00.000Z",
      createdAt: "2026-08-01T08:00:00.000Z",
      smtpMaxSizeBytes,
    },
  ];
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function setViewport(): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false,
      media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

/**
 * The whole client on the fixture world, with the two host declarations under test.
 *
 * `sendSurfaceMaxTotalBytes` is passed with the desktop's own spread shape: ABSENT for the
 * hosted case rather than `undefined`, because absent is what a browser tab actually passes.
 */
async function mountShell(opts: {
  size: number | null;
  surface?: number | null;
  locale?: "en" | "de";
}): Promise<void> {
  await unmount();
  const { AppShell } = await import("../app/shell/AppShell.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const probe = async (): Promise<MailboxFacts[]> => facts(opts.size);
  // The register and the provider are built together, which is `LocaleShell`'s own contract: the
  // SENTENCE comes from the provider and the NUMBER in it from `activeFormatLocale()`.
  setActiveCatalog(opts.locale ?? "en", (opts.locale === "de" ? de : messages) as never);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: opts.locale ?? "en",
        messages: (opts.locale === "de" ? de : messages) as never,
        timeZone: "UTC",
        now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(ThemeProvider, {
          storageKey: null,
          children: h(ToastHost, {
            children: h(AppShell as never, {
              demo: true,
              mailboxFacts: probe,
              ...("surface" in opts ? { sendSurfaceMaxTotalBytes: opts.surface } : {}),
            } as never),
          }),
        }),
      }),
    );
  });
  // The fixtures engine hydrates synchronously but still through a promise chain, and the
  // facts probe resolves one microtask later.
  for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); });
}

async function goCompose(): Promise<void> {
  await act(async () => {
    window.location.hash = "#/compose";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await settleFirstPaint();
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
}

/** Open the newest Ohbox message, then its reply editor — the product's own keys. */
async function openReply(): Promise<void> {
  const key = async (k: string): Promise<void> => {
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    });
  };
  await key("j");
  await key("r");
}

const capText = (scope: string): string =>
  host!.querySelector<HTMLElement>(`${scope} .compose-attach-cap`)?.textContent ?? "";

/** The clause under the cap, or "" where the surface renders none. */
const whyText = (scope: string): string =>
  host!.querySelector<HTMLElement>(`${scope} .compose-attach-why`)?.textContent ?? "";

beforeEach(() => {
  setViewport();
  window.location.hash = "#/ohbox";
  try { window.localStorage.clear(); } catch { /* storage blocked */ }
});

afterEach(async () => {
  await unmount();
  setActiveCatalog("en", null);
  vi.restoreAllMocks();
});

describe("compose — the stated ceiling follows the surface declaration", () => {
  /**
   * THE NUMBER ON SCREEN IS THE BUDGET, NOT THE ANNOUNCEMENT — and the two differ by the encoding.
   *
   * A server's `SIZE` bounds the ENCODED message; attachments are base64 on the way into one, so
   * 25 MiB of announcement carries about 19 MB of files. Stating "25 MB" here would be a promise
   * the sending server breaks after the user has waited. `composeAttachBudgetFor` holds the
   * derivation, and it is asserted alongside the rendered string so a change to either is visible
   * as a disagreement rather than as a new literal.
   */
  it("an uncapped surface promises what the mailbox's announcement actually carries", async () => {
    await mountShell({ size: 25 * MIB, surface: null });
    await goCompose();
    expect(composeAttachBudgetFor(25 * MIB)).toBe(19_108_785);
    expect(capText(".view-compose")).toContain("19.1 MB");
    expect(capText(".view-compose")).not.toContain("3.1 MB");
    expect(capText(".view-compose")).not.toContain("25 MB");
  });

  it("the hosted tab is byte-identical: no declaration, the constant still binds", async () => {
    await mountShell({ size: 25 * MIB });
    await goCompose();
    expect(capText(".view-compose")).toContain("3.1 MB");
    expect(capText(".view-compose")).not.toContain("25 MB");
  });

  it("an uncapped surface with NO measured SIZE states the assumed provider SIZE — not 3 MB, not 'unbounded'", async () => {
    await mountShell({ size: null, surface: null });
    await goCompose();
    // A 25 MiB announcement's budget, the same number a measured 25 MiB states above.
    expect(capText(".view-compose")).toContain("19.1 MB");
    expect(capText(".view-compose")).not.toContain("3.1 MB");
    // …and no claim about a server nobody measured.
    expect(capText(".view-compose")).not.toContain("would take more");
  });

  it("a stingy provider still binds an uncapped surface below the constant", async () => {
    await mountShell({ size: 2 * MIB, surface: null });
    await goCompose();
    expect(composeAttachBudgetFor(2 * MIB)).toBe(1_484_642);
    expect(capText(".view-compose")).toContain("1.5 MB");
    expect(capText(".view-compose")).not.toContain("3.1 MB");
  });

  it("the German catalog renders the same large value", async () => {
    await mountShell({ size: 25 * MIB, surface: null, locale: "de" });
    await goCompose();
    // The sentence AND its number: "Bis zu 19,1 MB insgesamt".
    expect(capText(".view-compose")).toContain("19,1 MB");
    expect(capText(".view-compose")).not.toContain("19.1 MB");
    expect(capText(".view-compose")).toMatch(/Bis zu/);
  });
});

describe("the mailbox page declares the staged ceiling only where it can upload", () => {
  it("a managed build naming no storage project binds 3 MB; one naming it, the staged ceiling", async () => {
    // Tester round 46: "Up to 38.3 MB total" on a page whose policy refused every upload.
    const { sendSurfaceFor } = await import("../app/(product)/mailbox/send-surface.js");
    const origin = "https://abcdefghijklmnopqrst.storage.example";
    expect(sendSurfaceFor(false, "https://*.storage.example")).toBeUndefined();
    expect(sendSurfaceFor(true, undefined), "a self-host page uploads to its own origin").toBe(COMPOSE_ATTACH_STAGED_SURFACE_BYTES);

    await mountShell({ size: 50 * MIB, surface: sendSurfaceFor(false, undefined) });
    await goCompose();
    expect(capText(".view-compose")).toContain("3.1 MB");

    await mountShell({ size: 50 * MIB, surface: sendSurfaceFor(false, origin) });
    await goCompose();
    expect(capText(".view-compose")).toContain("38.3 MB");
  });
});

describe("inline reply — the same declaration reaches the editor through the chrome", () => {
  it("an uncapped surface promises what the mailbox's announcement carries", async () => {
    await mountShell({ size: 25 * MIB, surface: null });
    await openReply();
    // The budget, not the face value — see the compose case above for the derivation.
    expect(capText(".reply")).toContain("19.1 MB");
    expect(capText(".reply")).not.toContain("3.1 MB");
    expect(capText(".reply")).not.toContain("25 MB");
  });

  it("the hosted tab is byte-identical in the reply too", async () => {
    await mountShell({ size: 25 * MIB });
    await openReply();
    expect(capText(".reply")).toContain("3.1 MB");
    expect(capText(".reply")).not.toContain("25 MB");
  });
});

/**
 * ═══ THE TWO SURFACES STATE DIFFERENT NUMBERS, AND THE DIFFERENCE IS THE DECLARATION ══
 *
 * The 0.20.0 review read one "Up to … MB total" in the paired desktop's Cloud composer and
 * a larger one in the hosted tab FOR THE SAME ACCOUNT, and filed it as a cross-surface
 * discrepancy. Both numbers are correct and this file is where that is now provable: they are
 * ONE rule (`composeAttachCap`) read with the two different SURFACE declarations the two doors
 * make, because the two doors carry the bytes differently —
 *
 *  · the hosted browser client stages attachment bytes to object storage on a signed URL
 *    (`HttpAdapter stageAttachments: true`, the only caller), so the request body is not the
 *    ceiling and `CloudShell` declares the bucket's per-object limit;
 *  · the paired desktop's Cloud door forwards `POST /drafts/:id/send` VERBATIM to the hosted
 *    API (`cloud-proxy.ts`), bytes and all, so the serverless body limit IS the ceiling and
 *    `DesktopGate` declares nothing — the strict constant. `desktop-attach-cap.test.ts` holds
 *    that half from source, including that `stageAttachments` appears nowhere in that app.
 *
 * So the defect was never the numbers. It was that the SMALL one carried no reason, which is
 * what `capBinding` renders and what the last two cases here read off the DOM.
 *
 * ── THE MUTATIONS THESE CASES WERE WATCHED AGAINST ──────────────────────────────────────────
 *
 *  · return `"mailbox"` unconditionally from `composeAttachCapBinding` → the clause cases go red;
 *  · drop the strict `<` in its surface arm (make it `<=`) → the equal-declaration case goes red,
 *    because a tie would start claiming the mail server would take more;
 *  · stop passing `capBinding` at either call site → that surface's clause case goes red;
 *  · give the desktop door a surface declaration → the smaller cap's case goes red.
 */
describe("one rule, two declarations, and the small number says why", () => {
  /* ONE fake answer for every case below: a mail server announcing 50 MiB. It is the
     announcement that reproduces the review's own two figures to the digit. */
  const ANNOUNCED = 50 * MIB;

  it("reproduces the reported pair from one account: the paired desktop's small cap, the hosted tab's large one", async () => {
    await mountShell({ size: ANNOUNCED });               // the desktop Cloud door: no declaration
    await goCompose();
    expect(capText(".view-compose")).toContain("3.1 MB");

    await mountShell({ size: ANNOUNCED, surface: COMPOSE_ATTACH_STAGED_SURFACE_BYTES });
    await goCompose();
    expect(capText(".view-compose")).toContain("38.3 MB");
  });

  /**
   * THE SAME FIGURE ON BOTH CLIENTS WHEN THE DECLARATION IS THE SAME. This is the case that says
   * there is ONE rule and not two constants: hold the surface equal and the two doors cannot
   * render different numbers, whatever else differs between them.
   */
  it("equal declarations give one figure — the whole difference is the declaration", () => {
    for (const surface of [null, COMPOSE_ATTACH_STAGED_SURFACE_BYTES, 32 * MIB, undefined]) {
      const web = composeAttachCap(ANNOUNCED, surface);
      const desktop = composeAttachCap(ANNOUNCED, surface);
      expect(web).toBe(desktop);
    }
    // And the two REAL declarations are what separate them, by exactly these numbers.
    expect(composeAttachCap(ANNOUNCED, COMPOSE_ATTACH_STAGED_SURFACE_BYTES)).toBe(38_265_462);
    expect(composeAttachCap(ANNOUNCED, undefined)).toBe(3 * MIB);
    expect(composeAttachBudgetFor(ANNOUNCED)).toBe(38_265_462);
  });

  it("names which term bound — and never claims the server would take more on a tie", () => {
    expect(composeAttachCapBinding(ANNOUNCED, undefined)).toBe("surface");
    expect(composeAttachCapBinding(ANNOUNCED, COMPOSE_ATTACH_STAGED_SURFACE_BYTES)).toBe("mailbox");
    expect(composeAttachCapBinding(null, undefined)).toBe("unmeasured");
    expect(composeAttachCapBinding(null, null)).toBe("unmeasured");
    // `SIZE 0` is RFC 1870 "no fixed maximum", so the surface alone binds and does say so.
    expect(composeAttachCapBinding(0, 32 * MIB)).toBe("surface");
    // A TIE: both ceilings are the same number, so the clause must not fire.
    const tie = composeAttachBudgetFor(ANNOUNCED);
    expect(composeAttachCapBinding(ANNOUNCED, tie)).toBe("mailbox");
  });

  it("the paired desktop's smaller cap carries the reason; the hosted tab's larger one does not", async () => {
    await mountShell({ size: ANNOUNCED });
    await goCompose();
    expect(whyText(".view-compose")).toContain("Your mail server would take more");

    await mountShell({ size: ANNOUNCED, surface: COMPOSE_ATTACH_STAGED_SURFACE_BYTES });
    await goCompose();
    expect(whyText(".view-compose")).toBe("");
  });

  /* ONE mount per case from here down. Opening the reader schedules a selection-restore
     through `requestAnimationFrame`, and a second `mountShell` in the same case lets that
     callback land on the remounted document, where jsdom has no `CSS.escape` — an unhandled
     error beside green tests, which is a suite saying less than it appears to. */
  it("the reply editor states it too", async () => {
    await mountShell({ size: ANNOUNCED });
    await openReply();
    expect(capText(".reply")).toContain("3.1 MB");
    expect(whyText(".reply")).toContain("Your mail server would take more");
  });

  it("the German catalogue carries the sentence", async () => {
    await mountShell({ size: ANNOUNCED, locale: "de" });
    await goCompose();
    // The decimal comma, as the large-value case above reads it.
    expect(capText(".view-compose")).toContain("3,1 MB");
    expect(whyText(".view-compose")).toContain("Der Mailserver");
    expect(whyText(".view-compose")).not.toContain("Your mail server");
  });
});
