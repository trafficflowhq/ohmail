/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import messages from "../../webapp/messages/en.json";
import german from "../../webapp/messages/de.json";
import { BILLING_PATH, DesktopBilling } from "../src/DesktopBilling.js";

/**
 * ═══ ONE ACCOUNT, ONE STORAGE ROW — THE APP'S SUBSCRIPTION PANE AND THE BROWSER TAB'S ═══════
 *
 * The hosted tier stores message body text so a browser tab and an account's other devices can
 * read mail without each of them talking to the mail server, and that store has a per-account
 * byte cap. The browser tab's billing pane shows the account's position against it. The app's
 * subscription pane did not: it listed the plan, the mailbox limit and the AI budget and then
 * stopped, so the one number that decides whether new mail keeps being stored was visible in a
 * browser and invisible in the app on the same desk.
 *
 * ── WHAT THIS FILE HOLDS ────────────────────────────────────────────────────────────────────
 *
 * Two things, and the second is the one that survives a redesign.
 *
 *  1. THE ROW, RENDERED. The pane is mounted over a stubbed shell answering the same
 *     `GET /billing/subscription` the account would, and the storage row is read off the DOM:
 *     both forms present, the sentence appearing only from the threshold, and — the case that
 *     matters most — NO row at all when the server did not send the figures. "0 of 0" would
 *     describe every such account as simultaneously empty and full.
 *
 *  2. A RULING PER ROW. Asserting today's row list would go green for ever while a NEW row
 *     appeared in the browser pane and quietly failed to reach the app — which is the exact
 *     defect above. So the browser pane's rows are DERIVED from its source, and every one of
 *     them must carry a ruling here: either the app has it too (and the assertion names the
 *     string it renders it from), or the ceremony behind it needs a second factor this app
 *     cannot assert and the pane's existing door to a browser is the answer. A new row in the
 *     browser pane fails this file until somebody has decided which. The failure is a question,
 *     not a chore.
 *
 * ── WHY NEITHER PANE DOES ITS OWN ARITHMETIC ────────────────────────────────────────────────
 *
 * The threshold, the byte formatter and the bytes-per-email estimate live once, in
 * `apps/webapp/app/shell/storage-state.ts`, and both panes import them. A second copy would be
 * two thresholds and two formatters, and the first thing to drift would be the number a person
 * compares between a browser tab and the app in front of them. The last case below asserts that
 * neither pane holds the arithmetic itself.
 *
 * ── MUTATION WATCH ──────────────────────────────────────────────────────────────────────────
 *
 * Every one of these was run, watched fail, and restored:
 *
 *  · delete the storage row from the app's pane → six cases go red (the ruling and all five
 *    render cases);
 *  · delete it from the browser pane instead → the derivation stops finding it and the "the
 *    table names exactly the rows the browser pane has" case goes red;
 *  · add a row to the browser pane with no ruling here → the same completeness case goes red,
 *    which is the direction that matters: it is a row nobody has decided about yet;
 *  · drop the `storageFigures` guard and render the row unconditionally → both no-row cases go
 *    red on a row that should not be there;
 *  · render only gigabytes, or only the email count → the both-forms case goes red;
 *  · inline `Math.floor(bytes / 25_000)` in either pane → the one-derivation case goes red;
 *  · move the browser door inside the has-a-plan branch → the door case goes red. That one is
 *    worth naming: its first spelling stayed GREEN through exactly that move, because it
 *    searched for the first `) : null}` after the branch opened and found a row inside it. An
 *    assertion nobody has watched fail is not evidence, and this one had to be watched twice.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia ??= ((query: string) =>
  ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false; },
  })) as never;

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n]*?\/\/.*$/gm, "");
const read = (rel: string): string => stripComments(fs.readFileSync(path.join(REPO, rel), "utf8"));

const APP_PANE = read("apps/desktop/src/DesktopBilling.tsx");
const WEB_PANE = read("apps/webapp/app/(product)/mailbox/BillingSection.tsx");

/* ══ 1. THE RULINGS ══════════════════════════════════════════════════════════════════════════ */

/**
 * The rows the browser pane draws, by the catalogue key each takes its label from. Derived, not
 * listed: a row added there with no ruling here is the drift this file exists to catch.
 *
 * The plan row's label is composed (`plan_${plan}`), so the template form is collected under the
 * stem it shares. Everything else names its key outright.
 */
function webRowKeys(): string[] {
  const plain = [...WEB_PANE.matchAll(/label=\{t\("([A-Za-z0-9_]+)"\)\}/g)].map((m) => m[1]!);
  const composed = [...WEB_PANE.matchAll(/label=\{t\(`([A-Za-z0-9_]+)\$\{/g)].map((m) => `${m[1]!}*`);
  return [...new Set([...plain, ...composed])].sort();
}

/**
 * What the APP does about each row of the browser pane.
 *
 *  · `both`    — the app draws it too. `appKey` is the catalogue string it renders the label
 *                from, asserted present in the app's source, because "there is a row" and "it is
 *                THIS row" are different claims.
 *  · `linkOut` — the row's control is a money mutation the account gates on a second factor
 *                asserted within the last few minutes. This app holds no password, no
 *                authenticator secret, and a passkey ceremony needs a browser origin this window
 *                does not have, so there is nothing it could do on press but fail. The pane's
 *                existing entry to a browser is the answer, and it is drawn whatever the read
 *                did.
 */
type Ruling =
  | { kind: "both"; appKey: string }
  | { kind: "linkOut"; why: string };

const APP_PANE_ROWS: Record<string, Ruling> = {
  // ── The same facts about the same account, read through the shell's forward ────────────────
  "plan_*": { kind: "both", appKey: "billing" },
  mailboxes: { kind: "both", appKey: "webMailboxes" },
  credits: { kind: "both", appKey: "webBudget" },
  setupCredits: { kind: "both", appKey: "webSetupCredits" },
  storage: { kind: "both", appKey: "webStorage" },
  aiLabel: { kind: "both", appKey: "webAiLabel" },

  // ── Money mutations against the card on file ───────────────────────────────────────────────
  addonStorage: {
    kind: "linkOut",
    why: "buying storage invoices the card immediately, so the account demands a recent second " +
      "factor and this window has no way to assert one",
  },
  addonMailbox: {
    kind: "linkOut",
    why: "same posture as the storage add-on: a recurring line item added to the subscription",
  },
};

describe("the subscription pane's rows, app and browser tab", () => {
  it("resolved both panes' real sources", () => {
    expect(APP_PANE).toContain("export function DesktopBilling()");
    expect(WEB_PANE).toContain("SettingsRow");
    expect(webRowKeys().length).toBeGreaterThan(4);
  });

  it("the table names exactly the rows the browser pane has", () => {
    expect(
      Object.keys(APP_PANE_ROWS).sort(),
      "the browser tab's subscription pane has a row with no ruling for the app. Decide which it " +
        "is — the same fact read through the shell's forward, or a mutation that needs a second " +
        "factor this window cannot assert — and add the row.",
    ).toEqual(webRowKeys());
  });

  for (const [row, ruling] of Object.entries(APP_PANE_ROWS)) {
    if (ruling.kind !== "both") continue;
    it(`${row}: the app's pane draws it, from \`${ruling.appKey}\``, () => {
      expect(
        APP_PANE,
        `\`${ruling.appKey}\` is gone from the app's pane — the ${row} row is missing there again, ` +
          "and the browser tab shows it for the same account",
      ).toContain(`"${ruling.appKey}"`);
    });
  }

  it("the door to a browser is drawn whatever the read did, which is what the link-out rows rest on", () => {
    /**
     * Outside the has-a-plan branch: an account that could not be reported on is exactly the
     * account somebody most wants to go and look at, and a browser can reach it when this
     * window's shell cannot.
     *
     * The branch's OWN terminator, matched whole — `</>` and its `) : null}` together. Searching
     * for the first `) : null}` after the branch opens finds the storage row's instead, which is
     * inside it, so the comparison was true whatever the door did. (Watched: moving the door
     * inside the branch left all nineteen cases green until this was matched on the fragment.)
     */
    const door = APP_PANE.indexOf('ts("webBillingTitle")');
    const closes = APP_PANE.indexOf("</>\n      ) : null}");
    expect(door, "the browser door is gone from the pane entirely").toBeGreaterThan(0);
    expect(closes, "the has-a-plan branch no longer closes the way this case reads it").toBeGreaterThan(0);
    expect(door, "the browser door moved inside the has-a-plan branch — the link-out rows have " +
      "nowhere to send a reader whose plan could not be read").toBeGreaterThan(closes);
  });
});

/* ══ 2. ONE DERIVATION, NOT TWO ═══════════════════════════════════════════════════════════════ */

describe("the storage arithmetic has one home", () => {
  const SHARED = "shell/storage-state";

  it("both panes import the shared derivation", () => {
    expect(APP_PANE).toContain(SHARED);
    expect(WEB_PANE).toContain(SHARED);
  });

  it("neither pane computes a byte figure, a threshold or an email count of its own", () => {
    for (const [what, src] of [["the app's pane", APP_PANE], ["the browser pane", WEB_PANE]] as const) {
      /* The three constants the shared module owns. A pane that grew any of them would be a
         second definition of a number a customer compares between two screens. */
      expect(src, `${what} spells out a gigabyte divisor`).not.toMatch(/1_000_000_000|1000000000/);
      expect(src, `${what} spells out the bytes-per-email estimate`).not.toMatch(/25_000|25000/);
      expect(src, `${what} spells out the near-cap ratio`).not.toMatch(/0\.9\b/);
    }
  });
});

/* ══ 3. THE ROW, RENDERED ════════════════════════════════════════════════════════════════════ */

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
interface Host { __TAURI_INTERNALS__?: { invoke: Invoke } }
const host = globalThis as unknown as Host;

/** One answer, framed exactly as the shell frames one for the window's pipe. */
function encode(status: number, body: string): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "OK", h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

/**
 * The account's subscription as the hosted API answers it, with the two storage figures left to
 * the caller — `undefined` for either is the older-server shape, and the point of one case below.
 */
function status(over: { used?: number; cap?: number } = {}): Record<string, unknown> {
  return {
    subscription: {
      plan: "solo", status: "active", currentPeriodEnd: "2026-09-01T00:00:00.000Z",
      cancelAtPeriodEnd: false, billingInterval: "month", mailboxLimit: 2,
    },
    balance: 940,
    storageUsedBytes: over.used,
    entitlements: {
      syncEnabled: true, aiEnabled: true, mailboxLimit: 2, storageBytesLimit: over.cap,
    },
  };
}

let answer: Record<string, unknown>;

function shellAnswering(): void {
  host.__TAURI_INTERNALS__ = {
    invoke: async (_command, payload) => {
      const url = ((payload ?? {}) as { url?: string }).url ?? "";
      if (url === BILLING_PATH) return encode(200, JSON.stringify(answer));
      // The AI switch's own read. Answered so the pane settles; nothing here asserts on it.
      return encode(200, JSON.stringify({ aiEnabled: true }));
    },
  };
}

let hostEl: HTMLDivElement;
let root: Root;

async function mountPane(locale: "en" | "de" = "en"): Promise<void> {
  hostEl = document.createElement("div");
  document.body.append(hostEl);
  root = createRoot(hostEl);
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale,
        messages: locale === "de" ? german : messages,
        timeZone: "UTC",
        children: h(ThemeProvider, null, h(ToastHost, null, h(DesktopBilling))),
      }),
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

/**
 * The rendered row whose label is `label`, as text, or `null` if there is no such row.
 *
 * Keyed on the design system's own row markup (`.set-row` holding `.lab > b`) rather than on a
 * text search of the pane: a substring hunt would find "Storage" in the neighbouring rows' prose
 * and report a row that is not there, which is the one answer this file must never get wrong.
 */
function rowText(label: string): string | null {
  for (const row of Array.from(hostEl.querySelectorAll(".set-row"))) {
    if (row.querySelector(".lab > b")?.textContent?.trim() === label) {
      return (row.textContent ?? "").trim();
    }
  }
  return null;
}

beforeEach(() => {
  answer = status({ used: 1_500_000_000, cap: 2_000_000_000 });
  shellAnswering();
  /* Nothing on this path may open a socket: this window has no API client and no network
     permission. A fallback to one would land here rather than passing quietly. */
  globalThis.fetch = (async () => {
    throw new Error("the window opened a socket — nothing in this pane may reach the network");
  }) as typeof fetch;
});

afterEach(async () => {
  if (root) await act(async () => { root.unmount(); });
  hostEl?.remove();
  delete host.__TAURI_INTERNALS__;
});

describe("the storage row in the app's subscription pane", () => {
  it("addresses the account's own subscription endpoint", () => {
    expect(BILLING_PATH).toBe("/billing/subscription");
  });

  it("shows BOTH forms — the bytes the cap is enforced in, and a count a person can picture", async () => {
    await mountPane();
    const row = rowText("Storage");
    expect(row, "no storage row at all").not.toBeNull();
    // 1.5 GB of 2 GB — decimal units, the same convention the plan card is enforced in.
    expect(row).toContain("1.5 GB of 2 GB");
    // …and the same two figures as emails, at the shared per-email estimate.
    expect(row).toContain("Roughly 60,000 of 80,000 emails.");
  });

  /**
   * THE COUNT IS GROUPED BY THE LANGUAGE THE READER CHOSE IN THE APP, not by the computer's.
   *
   * The app's locale is a preference held by the intl provider; the machine's is a property of
   * the machine, and the two disagree all the time. Two spellings of this were wrong before it
   * became the catalogue's `{used, number}`: a hardcoded US grouping put "200,000" into a German
   * pane, and a bare `toLocaleString()` read the HOST locale — so German-in-app on a US machine
   * still said "60,000" and switching the app's language changed nothing at all, which is the one
   * thing switching a language should change. This case is that regression, and it is the reason
   * the arithmetic hands the catalogue a NUMBER rather than a formatted string.
   */
  it("groups the count for the app's language, not the machine's", async () => {
    await mountPane("de");
    const row = rowText("Speicher")!;
    expect(row).toContain("Rund 60.000 von 80.000 E-Mails.");
    expect(row, "US grouping in a German pane").not.toContain("60,000");
  });

  /**
   * …AND THE BYTE FIGURE IN THE SAME ROW AGREES WITH IT.
   *
   * The count is grouped by the catalogue; the byte figure cannot be, because it is a
   * unit-bearing string and the number lives inside it. So it takes the locale as an argument.
   * Before it did, this row said "Rund 60.000 … 1.5 GB von 2 GB" — one row, two conventions,
   * and in German a decimal point is a thousands separator, so the value read as fifteen
   * gigabytes.
   */
  it("and the byte figure uses the same convention as the count beside it", async () => {
    await mountPane("de");
    const row = rowText("Speicher")!;
    expect(row).toContain("1,5 GB von 2 GB");
    expect(row, "a US decimal point beside a German-grouped count").not.toContain("1.5 GB");
  });

  it("says nothing about attachments counting, because they never do", async () => {
    await mountPane();
    const row = rowText("Storage")!;
    expect(row).toContain("Attachments never count");
    /* And the mailbox on the reader's own server is not a hosted copy. Both halves of the
       sentence are claims about what is NOT counted, which is the half a storage row gets
       wrong. */
    expect(row).toMatch(/your own server/);
  });

  it("adds no sentence below the threshold — the numbers are the row", async () => {
    answer = status({ used: 100_000_000, cap: 2_000_000_000 });
    await mountPane();
    const row = rowText("Storage")!;
    expect(row).toContain("100 MB of 2 GB");
    expect(row).not.toContain("nearly full");
    expect(row).not.toContain("is full");
  });

  it("says so from nine tenths, and mail still keeps arriving", async () => {
    answer = status({ used: 1_800_000_000, cap: 2_000_000_000 });
    await mountPane();
    const row = rowText("Storage")!;
    expect(row).toContain("nearly full");
    /* The sentence must never read as a threat to mail that already exists: at the cap the
       store is a rolling window and the mailbox itself is never touched. */
    expect(row).toContain("Mail keeps arriving");
  });

  it("at the cap, states what is true without threatening what is stored", async () => {
    answer = status({ used: 2_000_000_000, cap: 2_000_000_000 });
    await mountPane();
    const row = rowText("Storage")!;
    expect(row).toContain("Storage is full");
    expect(row).toContain("Mail keeps arriving");
    /* The mailbox is the master and nothing at the cap deletes from it. A sentence that left
       this out would read as a threat to mail somebody already has. */
    expect(row).toContain("is ever touched");
    expect(row).toContain("2 GB of 2 GB");
  });

  it("draws NO row when the server did not send the figures", async () => {
    answer = status();
    await mountPane();
    expect(
      rowText("Storage"),
      'an older server sends neither number, and "0 of 0" would describe every such account as ' +
        "at once empty and full",
    ).toBeNull();
    // The rest of the pane is unaffected — this is a missing field, not a failed read.
    expect(rowText("Mailboxes")).not.toBeNull();
  });

  it("draws NO row on a zero cap, which is the suspended-account shape", async () => {
    answer = status({ used: 0, cap: 0 });
    await mountPane();
    expect(
      rowText("Storage"),
      "a full-red storage row on an account whose sync is switched off names the wrong problem",
    ).toBeNull();
  });
});
