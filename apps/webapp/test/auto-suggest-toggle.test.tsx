/** @vitest-environment jsdom */
import { writeBootCache } from "@ohmail/app-logic/session/boot-cache";
import type { EngineMessage, SyncResponse } from "@ohmail/wire";
import { beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import { resetStorageOwnerForTest } from "@ohmail/app-logic/storage/storage-owner";
import messages from "../messages/en.json";
import {
  ACCOUNT, ISO, act, installConfirmEnv, mountCloudShell, refresh204, rememberOwner,
  scriptRefresh, scriptSession, scriptSync, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

/**
 * THE AUTO-WORK OPT-IN'S SWITCH — the writer that mail 0040 shipped without.
 *
 * `screener-auto-suggest.test.tsx` covers what the flag DOES once it is on. This file covers the
 * only way a human can turn it on, which until now did not exist: the column, the route, the
 * service and the spender were all live and tested, and nothing in the UI wrote the flag, so the
 * feature was reachable only by a raw API call. That is the same shape as `dormancy_days`, which
 * has had zero writers since its own migration, and the point of this suite is that the second
 * instance does not become permanent the way the first did.
 *
 * ── THE SIX THINGS THAT MUST BE TRUE ─────────────────────────────────────────────────────
 *
 *  1. OFF BY DEFAULT, AND THE SWITCH SAYS SO. `autoSuggestAt: null` renders `autoOff` with the
 *     switch unchecked. A failed `GET /consent` renders the same thing — there is no path from
 *     "I do not know" to a control that looks armed.
 *  2. THE PRICE COMES FROM THE SERVER, AND NO PRICE MEANS NO CONSENT. Arming the switch issues a
 *     `dryRun` and leaves the confirm DISABLED until a `quotedCredits` lands. A server that
 *     answers without that field leaves it disabled for good, because an unknown cost is not one
 *     a person can consent to. The alternative — count × an assumed credit cost — is the guess
 *     the field exists to remove.
 *  3. THE QUOTE PRICES THE SET THE BATCH WILL ACTUALLY TAKE. The dry run's senders are the first
 *     `AUTO_BATCH_SIZE` of the SAME unsuggested queue the automatic path slices, in the queue's
 *     own order. This is the assertion that bites the plausible implementation: reading the queue
 *     the Screener's own control captures gives an EMPTY list on a tab that went straight to
 *     Settings, and a confirm reading "0 senders · 0 credits" over a batch about to buy ten is a
 *     lie in the direction of spending.
 *  4. IT ARMS THE WORK AND NEVER A DECISION. Across the whole flow the only requests are the
 *     consent read, the dry run and the consent write. No `POST /screener/:id`, no non-dry
 *     purchase, and no engine mutation — so no rule, no contact, no folder change, nothing moved.
 *     Undo is vacuous because nothing moved; credits are the only thing spent, which is why it is
 *     worth asking about at all.
 *  5. TURNING IT OFF DISARMS THIS TAB, NOT JUST THE DATABASE. Off, then open the Screener in the
 *     SAME tab without a reload, and nothing is bought. This is the criterion that fails if the
 *     switch ever writes through `api-client` directly instead of through the `useConsentState`
 *     the spender reads: the flag would be off on the server and still true in this tab, and the
 *     next Screener open would spend money the user had just revoked.
 *  6. THE WRITE CARRIES ONE FIELD. The PATCH body is `{ autoSuggest }` and nothing else, so a
 *     toggle cannot reset the dormancy window or the seed state on its way past.
 *
 * `apps/webapp` typechecks its tests, so the wire shapes below are checked as well as the values.
 */

/**
 * The batch ceiling, restated as a LITERAL for the reason `screener-auto-suggest.test.tsx` gives:
 * importing it from the module under test would make the assertion "the code agrees with itself",
 * and this number is a spend ceiling. Raising it has to stop this suite.
 */
const AUTO_BATCH_SIZE = 10;

const TURNED_ON_AT = ISO;
const QUOTED_CREDITS = 17;

function msg(index: number): EngineMessage {
  const id = `h${index}`;
  return {
    id, accountId: ACCOUNT, mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`,
    from: { name: null, address: [`s${index}`, "example.invalid"].join("@") },
    to: [], cc: [],
    date: new Date(Date.parse(ISO) - index * 60_000).toISOString(),
    folder: "ohmail/Screener", snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
  };
}

const HELD = Array.from({ length: 12 }, (_, index) => msg(index));
const FIRST_BATCH = HELD.slice(0, AUTO_BATCH_SIZE).map((row) => row.from.address);

interface Recorded {
  method: string;
  path: string;
  body: { senders?: string[]; dryRun?: boolean; autoSuggest?: boolean; automatic?: boolean } | null;
}

let calls: Recorded[] = [];
let host: HTMLElement;
let consentReads = 0;

/** What the server currently holds for this account. The PATCH moves it; the GET reads it. */
let storedAt: string | null = null;
/** How `GET /consent` behaves. `fail` is the network blip that must still read as OFF. */
let consentMode: "ok" | "fail" = "ok";
/** How the dry run answers. `noPrice` is a deployment from before `quotedCredits` existed. */
let quoteMode: "ok" | "noPrice" | "refuse" = "ok";
/**
 * How the PATCH answers.
 *
 * `storesOff` is a 200 that did NOT store what was asked — the server accepted the request and
 * the row still reads off. It is the only state that can tell "the switch shows what the database
 * holds" apart from "the switch shows what the click asked for", because on a REFUSAL both
 * implementations look identical: the await throws and neither reaches its state write.
 */
let writeMode: "ok" | "refuse" | "storesOff" = "ok";

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

/** The server's refusal envelope, exactly as `packages/api` writes it. */
const refusal = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status);

function installFetch(): void {
  const wire = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname.replace(/^\/api(?=\/)/, "");
    const method = init?.method ?? "GET";
    const optIn = path === "/consent/settings" || path === "/screener/suggest";
    const raw = optIn && typeof init?.body === "string" ? JSON.parse(init.body) as Recorded["body"] : null;
    calls.push({ method, path, body: raw });

    if (path === "/consent/settings") {
      if (writeMode === "refuse") return refusal(500, "internal", "nope");
      if (writeMode === "storesOff") return json({ autoSuggestAt: null });
      storedAt = raw?.autoSuggest === true ? TURNED_ON_AT : null;
      return json({ autoSuggestAt: storedAt });
    }
    if (path === "/consent") {
      consentReads += 1;
      if (consentMode === "fail") return refusal(500, "internal", "nope");
      return json({
        seedConfirmedAt: "2026-07-01T00:00:00.000Z",
        screeningResetAt: null,
        dormancyDays: 60,
        autoSuggestAt: storedAt,
        counts: { activeUndecidedSenders: 12 },
      });
    }
    if (path.startsWith("/screener/suggest")) {
      const senders = raw?.senders ?? [];
      if (quoteMode === "refuse") {
        return refusal(402, "out_of_credits", "no AI credits remain on this account");
      }
      const base = {
        dryRun: raw?.dryRun === true, requested: senders.length,
        quoted: senders.length, charged: 0,
        suggestions: raw?.dryRun === true
          ? []
          : senders.map((s) => ({
              sender: s, messageId: `m-${s}`, decision: "yes" as const,
              confidence: 0.9, rationale: "looks like a person",
            })),
        skipped: [] as Array<{ sender: string; reason: string }>,
      };
      // The field the confirm depends on, WITHHELD in `noPrice` — a deployment from the minutes
      // between two releases, which is a real state and not a hypothetical one.
      return json(quoteMode === "noPrice" ? base : { ...base, quotedCredits: QUOTED_CREDITS });
    }
    if (path === "/screener") {
      return json({
        items: HELD.map((row) => ({
          messageId: row.id, sender: row.from, receivedAt: row.date,
          subject: row.subject, snippet: row.snippet, mailboxId: row.mailboxId,
        })),
        total: HELD.length, nextCursor: null,
        suggestable: { senders: HELD.map((row) => row.from.address), maxPerRequest: 50 },
      });
    }
    if (path === "/screener/held-releases" || path === "/screener/unscreened") {
      return json({ groups: [], total: 0 });
    }
    if (path === "/screener/auto-filed") return json({ items: [], more: false });
    if (path === "/account/screening") {
      return json({ ohboxPolicy: "people_and_replied", ohboxBar: null, defaultBar: "Mail from people" });
    }
    if (path === "/mailboxes") {
      return json({ items: [{
        id: "mb",
        address: ["mailbox", "example.invalid"].join("@"),
        status: "connected",
        organizerRole: "organizer",
        initialImportCompletedAt: ISO,
        organizeConsentedAt: ISO,
        lastSyncAt: ISO,
        createdAt: ISO,
      }] });
    }
    return wire(input, init);
  };
}

const suggestCalls = () => calls.filter((c) => c.path.startsWith("/screener/suggest"));
const dryRuns = () => suggestCalls().filter((c) => c.body?.dryRun === true);
const purchases = () => suggestCalls().filter((c) => c.body?.dryRun !== true);
const patches = () => calls.filter((c) => c.path === "/consent/settings");
/** Any POST to a per-sender screener decision — `POST /screener/:id`. */
const decides = () => calls.filter((c) => c.method === "POST" && /^\/screener\/[^s]/.test(c.path));

// Inspect the whole wire for mail mutations as well as the direct sender decisions.
const mutations = () => calls.filter(({ method, path }) =>
  method !== "GET" && /^\/(messages|rules|sync|contacts|folders)(\/|$)/.test(path));
function installSession() {
  installConfirmEnv();
  rememberOwner();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
  scriptSync(() => json({
    changes: {
      creates: HELD.map((entity, index) => ({
        type: "message", op: "create", id: entity.id, seq: index + 1, updatedAt: ISO, entity,
      })),
      updates: [], moves: [], deletes: [],
    },
    cursor: `c${HELD.length}`,
    hasMore: false,
    serverTime: ISO,
  } satisfies SyncResponse));
  installFetch();
}

async function mountShell() {
  window.location.hash = "#/settings/screener";
  host = await mountCloudShell();
  await tick(3000);
  return {
    async openScreener() {
      window.location.hash = "#/screener";
      await tick(1000);
      expect(within(host).getByRole("listbox", { name: messages.rail.screener })).toBeTruthy();
    },
    async openSettings() {
      window.location.hash = "#/settings/screener";
      await tick(300);
      expect(pane()).toBeTruthy();
    },
  };
}

const pane = () => within(within(host).getByRole("region", { name: messages.settings.screener }));
const text = () => within(host).getByRole("region", { name: messages.settings.screener }).textContent ?? "";
const switchEl = () => pane().getByRole("switch", { name: messages.screener.suggest.autoTitle });
const buttonNamed = (name: string) => pane().getByRole<HTMLButtonElement>("button", { name });
async function click(element: HTMLElement): Promise<void> {
  await act(async () => { element.click(); });
  await tick(50);
}

beforeAll(warmCloudShell);
beforeEach(() => {
  calls = [];
  consentReads = 0;
  storedAt = null; consentMode = "ok"; quoteMode = "ok"; writeMode = "ok";
  resetStorageOwnerForTest();
  localStorage.clear();
  installSession();
});
afterEach(async () => {
  await teardownConfirmEnv();
  resetStorageOwnerForTest();
  localStorage.clear();
});

async function approveQuote() {
  await click(switchEl());
  expect(suggestCalls()).toHaveLength(0);
  expect(patches()).toHaveLength(0);
  await click(buttonNamed("Get a quote")!);
}

describe("the auto-work opt-in's switch", () => {
  it("1 — is OFF by default and says so, and a failed consent read reads the same", async () => {
    await mountShell();

    expect(switchEl().getAttribute("aria-checked")).toBe("false");
    expect(text()).toContain(messages.screener.suggest.autoOff);
    // Nothing was priced and nothing was written just by looking at the pane.
    expect(dryRuns()).toHaveLength(0);
    expect(patches()).toHaveLength(0);

    await teardownConfirmEnv();
    resetStorageOwnerForTest();
    localStorage.clear();
    consentMode = "fail";
    const readsBefore = consentReads;
    installSession();
    await mountShell();
    expect(consentReads).toBeGreaterThan(readsBefore);
    expect(switchEl().getAttribute("aria-checked")).toBe("false");
    expect(text()).toContain(messages.screener.suggest.autoOff);

    await teardownConfirmEnv();
    resetStorageOwnerForTest();
    localStorage.clear();
    installSession();
    writeBootCache("consent", ACCOUNT, {
      v: 1, seedConfirmedAt: ISO, dormancyDays: 180, screeningBaselineAt: null,
    });
    consentMode = "fail";
    await mountShell();
    expect(consentReads).toBeGreaterThan(0);
    expect((switchEl() as HTMLButtonElement).disabled).toBe(true);
    await click(switchEl());
    expect(suggestCalls()).toHaveLength(0);
    expect(patches()).toHaveLength(0);

    consentMode = "ok";
    window.dispatchEvent(new Event("online"));
    await tick(3000);
    expect((switchEl() as HTMLButtonElement).disabled).toBe(false);

    consentMode = "fail";
    window.dispatchEvent(new Event("online"));
    await tick(300);
    expect((switchEl() as HTMLButtonElement).disabled).toBe(true);
  });

  it("2 — prices on the SERVER, and without `quotedCredits` the confirm never arms", async () => {
    quoteMode = "noPrice";
    await mountShell();

    await approveQuote();
    expect(dryRuns()).toHaveLength(1);
    const confirm = buttonNamed(messages.screener.suggest.autoTurnOn)!;
    expect(confirm).toBeTruthy();
    // NO PRICE, NO CONSENT. The server answered 200 and the button stays dead.
    expect(confirm.disabled).toBe(true);
    // And it never becomes armed by pressing it.
    await click(confirm);
    expect(patches()).toHaveLength(0);
    expect(storedAt).toBeNull();
  });

  it("2b — the armed confirm shows the SERVER's figure, not a count times an assumed cost", async () => {
    await mountShell();
    await approveQuote();

    const confirm = buttonNamed(messages.screener.suggest.autoTurnOn)!;
    expect(confirm.disabled).toBe(false);
    expect(pane().getByText(`${AUTO_BATCH_SIZE} senders · ${QUOTED_CREDITS} credits`)).toBeTruthy();
    expect(text()).toContain("credits");
    // The batch ceiling is stated from the constant the spender slices by, not from a literal.
    expect(text()).toContain(String(AUTO_BATCH_SIZE));
  });

  it("3 — prices the FIRST AUTO_BATCH_SIZE of the same queue the batch will take", async () => {
    await mountShell();

    expect(HELD.length).toBeGreaterThan(AUTO_BATCH_SIZE);

    // Priced from the SETTINGS pane, having never visited the Screener — the tab whose
    // `forSenders` capture is still empty.
    await approveQuote();
    expect(dryRuns()).toHaveLength(1);
    expect(dryRuns()[0]!.body!.senders).toEqual(FIRST_BATCH);
    // Not zero, which is what a quote read from the unbound capture would have said.
    expect(dryRuns()[0]!.body!.senders).toHaveLength(AUTO_BATCH_SIZE);
    // Priced under the batch's own rule, so a sender the batch will not ask about is not quoted.
    expect(dryRuns()[0]!.body!.automatic, "the opt-in's quote priced the batch as a press").toBe(true);
  });

  it("4 — arms the work and decides nothing: three requests, no mutation, no purchase", async () => {
    await mountShell();
    expect(consentReads).toBeGreaterThan(0);
    const beforePress = calls.length;

    await approveQuote();
    await click(buttonNamed(messages.screener.suggest.autoTurnOn)!);

    expect(storedAt).toBe(TURNED_ON_AT);
    expect(patches()).toHaveLength(1);
    // ONE FIELD ON THE WIRE — assertion 6. A toggle may not carry the dormancy window past.
    expect(patches()[0]!.body).toEqual({ autoSuggest: true });
    expect(patches()[0]!.method).toBe("PATCH");

    // NOTHING DECIDED. No per-sender decision, no real purchase, no engine mutation at all.
    expect(decides()).toHaveLength(0);
    expect(purchases()).toHaveLength(0);
    expect(mutations()).toHaveLength(0);
    // Boot reads consent. After boot, the opt-in only sends a quote and the consent write.
    expect(calls.slice(beforePress).map(({ path }) => path)).toEqual(["/screener/suggest", "/consent/settings"]);

    // The row now states when, from the server's echo.
    expect(switchEl().getAttribute("aria-checked")).toBe("true");
    expect(text()).toContain("On since");
    expect(text()).not.toContain(messages.screener.suggest.autoOff);
  });

  it("4b — a refused write leaves the switch showing the stored value and says so", async () => {
    writeMode = "refuse";
    await mountShell();

    await approveQuote();
    await click(buttonNamed(messages.screener.suggest.autoTurnOn)!);

    expect(storedAt).toBeNull();
    // NOT OPTIMISTIC. The switch renders the database, so a refusal cannot leave it looking armed.
    expect(switchEl().getAttribute("aria-checked")).toBe("false");
    expect(text()).toContain(messages.screener.suggest.autoFailed);
  });

  it("4d — the switch shows what the DATABASE stored, never what the click asked for", async () => {
    writeMode = "storesOff";
    const shell = await mountShell();

    await approveQuote();
    await click(buttonNamed(messages.screener.suggest.autoTurnOn)!);

    // A 200 that stored nothing. Asking for `true` and being told `null` must read as OFF — the
    // switch is the user's only record of whether their money is committed, so it renders the
    // echo. An implementation that set its state from `enabled` would show this armed.
    expect(patches()[0]!.body).toEqual({ autoSuggest: true });
    expect(switchEl().getAttribute("aria-checked")).toBe("false");
    expect(text()).toContain(messages.screener.suggest.autoOff);
    expect(text()).not.toContain("On since");

    // And the spender in the same tab is not armed either — the flag that authorises spending
    // came from the same echo.
    await shell.openScreener();
    expect(purchases()).toHaveLength(0);
  });

  it("4c — a refused QUOTE shows the server's own sentence, not a generic one", async () => {
    quoteMode = "refuse";
    await mountShell();

    await approveQuote();
    expect(text()).toContain("no AI credits remain on this account");
    expect(buttonNamed(messages.screener.suggest.autoTurnOn)!.disabled).toBe(true);
  });

  it("5 — turning it OFF disarms THIS TAB, not just the database", async () => {
    const shell = await mountShell();

    // On, confirmed.
    await approveQuote();
    await click(buttonNamed(messages.screener.suggest.autoTurnOn)!);
    expect(storedAt).toBe(TURNED_ON_AT);

    // Off — no confirm and no quote: removing an authorisation spends nothing.
    const before = dryRuns().length;
    await click(switchEl());
    expect(storedAt).toBeNull();
    expect(patches()).toHaveLength(2);
    expect(patches()[1]!.body).toEqual({ autoSuggest: false });
    expect(dryRuns()).toHaveLength(before);
    expect(switchEl().getAttribute("aria-checked")).toBe("false");

    // NOW OPEN THE SCREENER IN THE SAME TAB, no reload. Nothing may be bought.
    await shell.openScreener();
    expect(purchases()).toHaveLength(0);
    expect(mutations()).toHaveLength(0);
  });

  it("5b — the same tab, left ON, DOES buy: the negative in 5 is not vacuous", async () => {
    const shell = await mountShell();

    await approveQuote();
    await click(buttonNamed(messages.screener.suggest.autoTurnOn)!);
    await shell.openScreener();

    // One batch, bounded, from the front of the same queue — and it happened because the switch
    // and the spender share one consent state. Without this, assertion 5 would pass on a tab
    // where the automatic path never worked at all.
    expect(purchases()).toHaveLength(1);
    expect(purchases()[0]!.body!.senders).toHaveLength(AUTO_BATCH_SIZE);
    expect(purchases()[0]!.body!.senders).toEqual(FIRST_BATCH);
    expect(purchases()[0]!.body!.automatic, "the batch the switch armed went out as a press").toBe(true);
    // Still no decision: it bought work, not an outcome.
    expect(decides()).toHaveLength(0);
    expect(mutations()).toHaveLength(0);
  });

  it("6 — re-confirming is idempotent: same body, same stored state", async () => {
    const shell = await mountShell();

    await approveQuote();
    await click(buttonNamed(messages.screener.suggest.autoTurnOn)!);
    expect(storedAt).toBe(TURNED_ON_AT);

    // Arm it again from a fresh confirm. The route is deliberately not idempotency-keyed, so the
    // property under test is that a replay is the SAME STATE rather than a second effect.
    await shell.openScreener();
    await shell.openSettings();
    expect(switchEl().getAttribute("aria-checked")).toBe("true");
    // Pressing an already-on switch turns it OFF (it is a switch, not a button) — so the replay
    // worth asserting is the write itself, issued twice with the same argument.
    const { consent } = await import("../app/api-client.js");
    await act(async () => { await consent.setAutoSuggest(true); });
    await act(async () => { await consent.setAutoSuggest(true); });
    expect(storedAt).toBe(TURNED_ON_AT);
    expect(patches().every((p) => p.body!.autoSuggest === true)).toBe(true);
  });
});
