/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import de from "../messages/de.json";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import {
  COMPOSE_ATTACH_STAGED_SURFACE_BYTES, composeAttachBudgetFor, composeAttachCap,
  composeAttachCapBinding,
} from "@ohmail/client-engine";
import { setActiveCatalog } from "../app/shell/locale";
import { announceUpdate, resetUpdateStoreForTests, restartHold } from "@ohmail/app-logic/doors/app-update";
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
 *  · drop the host ceiling from either shared Write surface
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

/*
 * OVER THE NEW SHELL (re-pointed from today's AppShell by the older tests' sorting, share write-1): the frame over the
 * mail ground, mounted through the shell's test door (`_mail-shell.tsx`), which reads the old door's inputs by their
 * old names (`mailboxFacts`, `sendSurfaceMaxTotalBytes`, handed on as the host's `sendCeiling`). Today's compose view
 * is Write's letter, the region "New message"; today's inline reply is Write's reply in the open letter, the region
 * "Open message" (opened at the Ohbox: History is not mounted). THE STATED CEILING is the name of Write's clip (the
 * kit's Attach: "Attach files, at most <size> in all"), the same number its pick refuses at; THE CLAUSE that says why
 * the small one binds stands in Write's room under the files, which Write draws from the first file on (the studio's
 * room), so a case that reads the clause puts one small file on first, in both of its halves. Both sentences are read
 * from Write's own catalogue (`packages/app/messages/write.*.json`, `files.attach`, `files.capSurface`).
 */
const writeWords = (locale: "en" | "de"): { letter: string; attach: string; capSurface: string; remove: string } => {
  const rel = `packages/app/messages/write.${locale}.json`;
  let text: string;
  try { text = readFileSync(resolve(process.cwd(), rel), "utf8"); }
  catch { text = readFileSync(resolve(process.cwd(), "../..", rel), "utf8"); }
  const write = (JSON.parse(text) as {
    write: { letter: string; files: { attach: string; capSurface: string; remove: string } };
  }).write;
  return { letter: write.letter, attach: write.files.attach, capSurface: write.files.capSurface, remove: write.files.remove };
};
/** Write's letter in either language ("New message", "Neue Nachricht": `write.letter`). */
const LETTER = (["en", "de"] as const).map((l) => `[role="region"][aria-label="${writeWords(l).letter}"]`).join(", ");
const REPLY = '[role="region"][aria-label="Open message"]';

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
  const { MailShell } = await import("./_mail-shell.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const probe = async (): Promise<MailboxFacts[]> => facts(opts.size);
  // The register and the provider are built together, which is `LocaleShell`'s own contract: the
  // SENTENCE comes from the provider and the NUMBER in it from `activeFormatLocale()`.
  activeLocale = opts.locale ?? "en";
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
            children: h(MailShell as never, {
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

/**
 * Open the newest Ohbox message, then its reply editor — the product's own keys: the Ohbox's first row by its press
 * (the new shell's Ohbox, by role), then "r" where the keys are.
 */
async function openReply(): Promise<void> {
  const firstRow = (): HTMLElement | null =>
    host!.querySelector<HTMLElement>('section[aria-label="Messages"] [role=option][data-id]');
  const deadline = Date.now() + 10_000;
  while (!firstRow() && Date.now() <= deadline) {
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
  const row = firstRow();
  expect(row, "the Ohbox listed no letter").not.toBeNull();
  await act(async () => {
    row!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    row!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
  await act(async () => {
    (document.activeElement ?? document).dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true, cancelable: true }));
  });
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
  const sheet = (): Element | null => host!.querySelector(REPLY)?.querySelector('[role="textbox"][aria-label="Reply body"]') ?? null;
  while (!sheet() && Date.now() <= deadline) {
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
  expect(sheet(), "the reply never opened").not.toBeNull();
}

/** The stated ceiling: the name of the clip (Write's `files.attach`, in the locale on screen). */
const capText = (scope: string): string => {
  const lead = writeWords(activeLocale).attach.split("{size}")[0]!;
  const clip = [...(host!.querySelector(scope)?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
    .find((b) => (b.getAttribute("aria-label") ?? "").startsWith(lead));
  return clip?.getAttribute("aria-label") ?? "";
};

/** The clause beside the cap (Write's `files.capSurface`, either language), or "" where the surface renders none. */
const whyText = (scope: string): string => {
  const region = host!.querySelector(scope);
  if (!region) return "";
  const clauses = [writeWords("en").capSurface, writeWords("de").capSurface];
  const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
  const said: string[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.textContent ?? "").trim();
    if (clauses.some((c) => text.includes(c))) said.push(text);
  }
  return said.join(" ");
};

/** One small file on the letter or the reply, read and attached: Write draws its room (and the clause) from the first file on. */
async function attachSmall(scope: string): Promise<void> {
  const input = host!.querySelector(scope)!.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File([new Uint8Array(2048)], "notes.txt", { type: "text/plain" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  expect(removeButton(scope, "notes.txt"), "the file never attached").not.toBeNull();
}

/**
 * A file on the letter: its way off, the press "Remove <name>" (Write's `files.remove`, in the locale on screen; today's
 * `.compose-attach-item` row and its remove).
 */
const removeButton = (scope: string, name: string): HTMLButtonElement | null =>
  [...(host!.querySelector(scope)?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
    .find((b) => b.getAttribute("aria-label") === writeWords(activeLocale).remove.replace("{filename}", name)) ?? null;

let activeLocale: "en" | "de" = "en";

beforeEach(() => {
  setViewport();
  window.location.hash = "#/ohbox";
  try { window.localStorage.clear(); } catch { /* storage blocked */ }
});

afterEach(async () => {
  await unmount();
  setActiveCatalog("en", null);
  resetUpdateStoreForTests();
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
    expect(capText(LETTER)).toContain("19.1 MB");
    expect(capText(LETTER)).not.toContain("3.1 MB");
    expect(capText(LETTER)).not.toContain("25 MB");
  });

  it("the hosted tab is byte-identical: no declaration, the constant still binds", async () => {
    await mountShell({ size: 25 * MIB });
    await goCompose();
    expect(capText(LETTER)).toContain("3.1 MB");
    expect(capText(LETTER)).not.toContain("25 MB");
  });

  it("an uncapped surface with NO measured SIZE states the assumed provider SIZE — not 3 MB, not 'unbounded'", async () => {
    await mountShell({ size: null, surface: null });
    await goCompose();
    // A 25 MiB announcement's budget, the same number a measured 25 MiB states above.
    expect(capText(LETTER)).toContain("19.1 MB");
    expect(capText(LETTER)).not.toContain("3.1 MB");
    // …and no claim about a server nobody measured.
    expect(capText(LETTER)).not.toContain("would take more");
  });

  it("a stingy provider still binds an uncapped surface below the constant", async () => {
    await mountShell({ size: 2 * MIB, surface: null });
    await goCompose();
    expect(composeAttachBudgetFor(2 * MIB)).toBe(1_484_642);
    expect(capText(LETTER)).toContain("1.5 MB");
    expect(capText(LETTER)).not.toContain("3.1 MB");
  });

  it("the German catalog renders the same large value", async () => {
    await mountShell({ size: 25 * MIB, surface: null, locale: "de" });
    await goCompose();
    // The sentence AND its number: today's "Bis zu 19,1 MB insgesamt" is, in Write's catalogue (`files.attach`, de),
    // "Dateien anhängen, höchstens 19,1 MB insgesamt": the German sentence, read in Write's words.
    expect(capText(LETTER)).toContain("19,1 MB");
    expect(capText(LETTER)).not.toContain("19.1 MB");
    expect(capText(LETTER)).toMatch(/höchstens/);
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
    expect(capText(LETTER)).toContain("3.1 MB");

    await mountShell({ size: 50 * MIB, surface: sendSurfaceFor(false, origin) });
    await goCompose();
    expect(capText(LETTER)).toContain("38.3 MB");
  });
});

describe("inline reply — the same declaration reaches the editor through the chrome", () => {
  it("an uncapped surface promises what the mailbox's announcement carries", async () => {
    await mountShell({ size: 25 * MIB, surface: null });
    await openReply();
    // The budget, not the face value — see the compose case above for the derivation.
    expect(capText(REPLY)).toContain("19.1 MB");
    expect(capText(REPLY)).not.toContain("3.1 MB");
    expect(capText(REPLY)).not.toContain("25 MB");
  });

  it("the hosted tab is byte-identical in the reply too", async () => {
    await mountShell({ size: 25 * MIB });
    await openReply();
    expect(capText(REPLY)).toContain("3.1 MB");
    expect(capText(REPLY)).not.toContain("25 MB");
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
    expect(capText(LETTER)).toContain("3.1 MB");

    await mountShell({ size: ANNOUNCED, surface: COMPOSE_ATTACH_STAGED_SURFACE_BYTES });
    await goCompose();
    expect(capText(LETTER)).toContain("38.3 MB");
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
    await attachSmall(LETTER); // Write's room, where the clause stands, is drawn from the first file on
    expect(whyText(LETTER)).toContain("Your mail server would take more");

    await mountShell({ size: ANNOUNCED, surface: COMPOSE_ATTACH_STAGED_SURFACE_BYTES });
    await goCompose();
    await attachSmall(LETTER); // the same room, so its silence is read where the clause would stand
    expect(whyText(LETTER)).toBe("");
  });

  /* ONE mount per case from here down. Opening the reader schedules a selection-restore
     through `requestAnimationFrame`, and a second `mountShell` in the same case lets that
     callback land on the remounted document, where jsdom has no `CSS.escape` — an unhandled
     error beside green tests, which is a suite saying less than it appears to. */
  it("the reply editor states it too", async () => {
    await mountShell({ size: ANNOUNCED });
    await openReply();
    expect(capText(REPLY)).toContain("3.1 MB");
    await attachSmall(REPLY); // Write's room, where the clause stands, is drawn from the first file on
    expect(whyText(REPLY)).toContain("Your mail server would take more");
  });

  it("the German catalogue carries the sentence", async () => {
    await mountShell({ size: ANNOUNCED, locale: "de" });
    await goCompose();
    // The decimal comma, as the large-value case above reads it.
    expect(capText(LETTER)).toContain("3,1 MB");
    await attachSmall(LETTER); // Write's room, where the clause stands, is drawn from the first file on
    expect(whyText(LETTER)).toContain("Der Mailserver");
    expect(whyText(LETTER)).not.toContain("Your mail server");
  });
});

/**
 * ═══ A DRAFT'S FILES HOLD A RESTART ═══════════════════════════════════════════════════════
 *
 * Attached files live in memory only: the scratch buffer and the account's draft row keep the
 * text, never the bytes. A restart from the update line brought the draft back without its
 * file, and sent as it stood it went without the attachment. While the compose or a reply holds
 * a file, or a pick is still being read, the update notice draws no Restart and says why.
 */
describe("a draft's files hold a restart", () => {
  const attach = async (scope: string): Promise<void> => {
    const input = host!.querySelector(scope)!.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File([new Uint8Array(2048)], "notes.txt", { type: "text/plain" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  };
  // FileReader delivers as a task.
  const drain = async (): Promise<void> => {
    for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };
  const remove = async (scope: string): Promise<void> => {
    await act(async () => { removeButton(scope, "notes.txt")!.click(); });
  };
  /** The update notice: the frame's notice whose title names the ready version. */
  const updateSaid = (): HTMLElement | null =>
    [...host!.querySelectorAll<HTMLElement>("[role='status'][data-place]")]
      .find((n) => (n.textContent ?? "").includes("0.30.6")) ?? null;
  const restart = (): HTMLButtonElement | null =>
    [...(updateSaid()?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
      .find((b) => b.textContent === messages.update.lineRestart) ?? null;

  /* The frame draws no Restart while a draft's file holds it (the line says why), rather than a greyed one. */
  it("in the compose: a file being read, then attached, holds the notice's Restart until it is removed", async () => {
    await mountShell({ size: 25 * MIB });
    await goCompose();
    const pressed = vi.fn();
    await act(async () => announceUpdate({ kind: "ready", version: "0.30.6", act: pressed, key: "ready:0.30.6" }));
    expect(restart(), "the premise: a ready update offers Restart").not.toBeNull();
    await attach(LETTER);
    expect(restartHold(), "a pick still being read did not hold the restart").toBe("files");
    expect(restart(), "Restart stood pressable while a pick was being read").toBeNull();
    await drain();
    expect(removeButton(LETTER, "notes.txt"), "the file never attached").not.toBeNull();
    expect(restartHold(), "an attached file did not hold the restart").toBe("files");
    expect(restart(), "Restart stood pressable while the draft held a file").toBeNull();
    expect(updateSaid()!.textContent).toContain(messages.update.lineAfterFiles);
    for (const b of updateSaid()!.querySelectorAll<HTMLButtonElement>("button")) {
      if (b.textContent !== messages.update.lineLater) await act(async () => { b.click(); });
    }
    await drain();
    expect(pressed, "Restart dropped the draft's file").not.toHaveBeenCalled();

    await remove(LETTER);
    expect(restartHold()).toBeNull();
    expect(restart(), "Restart did not come back once the file was removed").not.toBeNull();
    expect(updateSaid()!.textContent).not.toContain(messages.update.lineAfterFiles);
    await act(async () => { restart()!.click(); });
    await drain();
    expect(pressed, "the control: Restart with nothing held restarts").toHaveBeenCalledTimes(1);
  });

  it("in a reply: its files hold the restart while the editor holds them", async () => {
    await mountShell({ size: 25 * MIB });
    await openReply();
    await attach(REPLY);
    await drain();
    expect(removeButton(REPLY, "notes.txt"), "the file never attached").not.toBeNull();
    expect(restartHold()).toBe("files");
    await remove(REPLY);
    expect(restartHold()).toBeNull();
  });
});
