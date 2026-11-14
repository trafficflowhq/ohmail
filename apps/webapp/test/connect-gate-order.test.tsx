/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import messages from "../messages/en.json";
import type { AccountAccess, MailboxDTO } from "../app/api-client";
import type { ConnectFacts } from "../app/(product)/mailbox/MailboxSection";
import type { MailState } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * THE SUBSCRIPTION GATE FIRED AT THE END OF THE CONNECT FLOW.
 *
 * Seen on the hosted service, 2026-08-04. Someone who answered "Do this
 * later" at the plan step (`JoinScreen`'s plan step links to `/`) lands in the mail client with
 * no `billing_subscriptions` row. Settings → Mailboxes then offered **"Connect a mailbox"** and
 * walked them through every screen it has — provider, credentials, the ohmail account password,
 * and a FRESH SECOND FACTOR — before `POST /mailboxes` answered 402 `no_subscription` from
 * `packages/services/src/mailbox-allowance.ts`.
 *
 * So the product asked for a second factor before telling anyone it was never going to work.
 * That is the worst possible ordering: the most annoying step sat in front of the refusal.
 *
 * ── WHY THIS IS A RENDER DECISION AND NOT A NEW FETCH ON THE HOT PATH ───────────────────
 *
 * Every fact the gate uses was already on the wire, decided by the same code:
 *
 *  · `GET /billing/subscription` is `cost: "read"` with no `stepUp`
 *    (the billing routes), and `BillingService.subscriptionStatus` builds its
 *    `entitlements` by calling the SAME pure `entitlementsFor` over the SAME
 *    `newestSubscriptionOf` read that `readMailboxAllowance` falls back to. The pane reads it
 *    and re-decides nothing.
 *  · `emailVerified` rides on `GET /auth/session`, which this pane ALREADY calls for the
 *    account address.
 *  · the slot count is `GET /mailboxes` filtered exactly as the gate counts it (`status <>
 *    'disabled'`), which the pane already holds.
 *
 * ── AND WHY THE LATE REFUSAL STAYS ──────────────────────────────────────────────────────
 *
 * The pre-flight read is a SNAPSHOT and the gate is a `SELECT … FOR UPDATE` inside the create's
 * own transaction. They can disagree — a webhook can land between them — so the client's answer
 * may only ever WITHHOLD an offer it can prove is dead. It never claims the create will succeed,
 * `connect()`'s catch is untouched, and an entitlement this pane could not read produces NO
 * gate at all: guessing is how you tell somebody with a plan that they have none.
 */

const read = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/** The `mailboxes` copy, indexed loosely so a key this slice adds is a RUNTIME failure. */
const copy = messages.mailboxes as unknown as Record<string, string>;

const QUIET: MailState = {
  key: "quiet", clock: false, count: 0, blockedReason: null, mailboxCount: 0,
  // Explicit, because the cast below means a missing field would read as `undefined` and a
  // pane gated on it would silently render its LOADING arm instead of the one under test.
  settled: true,
  owed: false,
} as unknown as MailState;

/* ── The server, as far as this pane can see it ──────────────────────────────────────── */

/** The port's verdict as `GET /account/access` hands it to the client. */
type Access = NonNullable<ConnectFacts["access"]>;

const access = (over: Partial<Access> = {}): Access => ({
  canAddMailbox: true, mailboxes: 5, ...over,
});

/** What the route answers, which is one field wider than the gate's own facts. */
const answer = (over: Partial<Access> = {}): AccountAccess => ({
  metered: true, ...access(over),
});

/** `mock`-prefixed: `vi.mock`'s factory is hoisted above the imports. */
let mockListed: MailboxDTO[] = [];
let mockVerified = true;
/** `null` ⇒ `GET /account/access` failed, which is a real state and not a refusal. */
let mockStatus: AccountAccess | null = answer();
let mockCreateCalls = 0;
let mockStatusCalls = 0;

vi.mock("../app/api-client", () => ({
  apiConfigured: () => true,
  assertPasskey: async () => ({}),
  webauthnAvailable: () => false,
  codeOf: (e: unknown) => (e as { code?: string }).code ?? null,
  messageOf: (e: unknown) => (e as { message?: string }).message ?? String(e),
  auth: {
    session: async () => ({
      user: { email: "person@example.test", emailVerified: mockVerified },
      scope: "full",
    }),
    // The pane's own ceremony: password → a TOTP challenge. Reaching the input this mints is
    // the defect.
    login: async () => ({ status: "twofa_required", loginToken: "tok", methods: ["totp"] }),
    totpVerify: async () => undefined,
    recoveryVerify: async () => undefined,
    webauthnAssertOptions: async () => ({ options: {} }),
    webauthnAssertVerify: async () => undefined,
  },
  account: {
    access: async () => {
      mockStatusCalls += 1;
      if (!mockStatus) throw new Error("the access read is unreachable");
      return mockStatus;
    },
  },
  mailboxes: {
    list: async () => ({ items: mockListed }),
    create: async () => {
      mockCreateCalls += 1;
      throw Object.assign(new Error("refused"), { code: "no_subscription", status: 402 });
    },
    resync: async () => undefined,
  },
}));

vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: QUIET, refresh: () => {} }),
}));

const dto = (over: Partial<MailboxDTO> = {}): MailboxDTO => ({
  id: "mb1", provider: "icloud", address: "person@example.test",
  displayName: null, status: "connected", lastSyncAt: "2026-08-04T11:00:00.000Z",
  createdAt: "2026-08-04T10:00:00.000Z", ...over,
});

/* ── Mounting the real pane ──────────────────────────────────────────────────────────── */

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function unmount(): Promise<void> {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

async function mount(props: { subscriptionPane?: boolean } = {}): Promise<HTMLDivElement> {
  await unmount();
  const { MailboxSection } = await import("../app/(product)/mailbox/MailboxSection.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, { locale: "en", messages, children: h(MailboxSection, props) }));
  });
  await settle();
  return host;
}

/** A control by its visible text — how a person finds it, not how the DOM is built. */
function byText(el: HTMLElement, text: string): HTMLElement | null {
  return [...el.querySelectorAll("button, a")]
    .find((n) => (n.textContent ?? "").trim() === text) as HTMLElement | undefined ?? null;
}

async function click(el: Element): Promise<void> {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
}

/** React reads the native value, so the descriptor's setter has to be the one used. */
async function typeInto(el: Element | null, value: string): Promise<void> {
  expect(el, "a field the walk needs is not on screen").toBeTruthy();
  const input = el as HTMLInputElement;
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!
    .set!.call(input, value);
  await act(async () => { input.dispatchEvent(new Event("input", { bubbles: true })); });
  await settle();
}

async function submit(form: Element | null): Promise<void> {
  expect(form, "a form the walk needs is not on screen").toBeTruthy();
  await act(async () => {
    form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle();
}

/**
 * Walk the connect flow as far as the pane allows, and report the furthest screen reached.
 *
 * Deliberately tolerant of the button being absent: after the fix there is nothing to click,
 * and a walk that threw would be indistinguishable from a walk that was refused.
 */
async function walk(el: HTMLDivElement): Promise<string> {
  const connect = byText(el, copy.connect!);
  if (!connect) return "gated at screen one";

  await click(connect);
  const tile = el.querySelector('[role="radio"]');
  if (!tile) return "provider";
  await click(tile);

  await typeInto(el.querySelector("#mb-address"), "person@example.test");
  await typeInto(el.querySelector("#mb-pass"), "app-password-here");
  await submit(el.querySelector("form.acct-confirm"));

  // The connect is tried on submit; a closed step-up window opens the prompt instead.
  if (el.querySelector('[data-testid="step-up-prompt"]')) return "step-up prompt";
  return mockCreateCalls > 0 ? "the create" : "credentials";
}

beforeEach(() => {
  mockListed = [];
  mockVerified = true;
  mockStatus = answer();
  mockCreateCalls = 0;
  mockStatusCalls = 0;
});

afterEach(async () => { await unmount(); });

/* ══════════════════════════════════════════════════════════════════════════════════════
   THE REGRESSION
   ══════════════════════════════════════════════════════════════════════════════════════ */

describe("the refusal comes before the second factor, not after it", () => {
  it("THE REGRESSION: an account that may not add a mailbox never reaches the TOTP challenge", async () => {
    mockStatus = answer({ canAddMailbox: false, mailboxes: 0 });
    const el = await mount();

    const furthest = await walk(el);
    expect(
      furthest,
      "the pane asked for a second factor before telling the user it was never going to work",
    ).toBe("gated at screen one");
    expect(mockCreateCalls, "POST /mailboxes was attempted against a dead entitlement").toBe(0);
  });

  it("…and it says why, at screen one, and points somewhere", async () => {
    mockStatus = answer({ canAddMailbox: false, mailboxes: 0 });
    const el = await mount({ subscriptionPane: true });

    expect(copy.blocked_cannot_add, "the gate has no sentence to show").toBeTruthy();
    expect(el.textContent ?? "").toContain(copy.blocked_cannot_add!);
    // NOT a dead end. The remedy is the Subscription entry in the settings nav beside this
    // pane, one visible click away, and the sentence has to say so — naming a remedy with no
    // way to reach it is the shape an earlier report was filed for.
    expect(el.textContent ?? "").toContain(copy.blocked_where!);
    expect(copy.blocked_where).toContain(messages.settings.billing);
  });

  it("…and never points at a Subscription pane Settings does not list", async () => {
    // the pane was missing after a sign-in while this sentence sent people to it.
    mockStatus = answer({ canAddMailbox: false, mailboxes: 0 });
    const el = await mount();
    expect(el.textContent ?? "").toContain(copy.blocked_cannot_add!);
    expect(el.textContent ?? "", "the pointer named a pane that is not there").not.toContain(copy.blocked_where!);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════
   THE NEIGHBOURS — "no subscription" is not the only thing POST /mailboxes refuses with
   ══════════════════════════════════════════════════════════════════════════════════════ */

describe("every refusal the client can know in advance gets its OWN sentence", () => {
  const load = async () =>
    (await import("../app/(product)/mailbox/MailboxSection.js")).connectBlock;

  it("a paid account under its limit is offered the button, and nothing else", async () => {
    const connectBlock = await load();
    expect(connectBlock({
      emailVerified: true, access: access({ mailboxes: 5 }), enabledCount: 2,
    })).toBe(null);
  });

  it("the port saying no ⇒ `cannot_add`, whatever its reason was", async () => {
    // ONE question, and the client does not get told why. The port carries ten refusal reasons
    // and reduces them to two for the lock screen; this gate needs neither, because an account
    // that reaches a settings pane at all has not been refused — it has been told "no more".
    const connectBlock = await load();
    expect(connectBlock({
      emailVerified: true, access: access({ canAddMailbox: false, mailboxes: 0 }), enabledCount: 0,
    })).toBe("cannot_add");
  });

  /*
   * TWO CASES RETIRED HERE, and the reason is the shape they were about.
   *
   * One held that a `no_subscription` REASON with a row present must NOT be refused in advance,
   * because the pane's read and the create's gate were two DIFFERENT reads of the subscription
   * table and could disagree — an abandoned Checkout's dead row out-ranking a live one. The
   * other held that a cancelled subscription must not be told to choose a plan.
   *
   * There is one read now: the gate and this pane both ask the entitlements port, so the
   * divergence the first case defended against cannot occur, and there is no reason string left
   * to mistake for a state. The second case's PROPERTY survives as the sentence assertion below
   * — nothing here may tell an account to choose a plan, because this pane no longer knows or
   * says anything about plans.
   */

  it("an account that may not add another is never told to choose a plan", async () => {
    const connectBlock = await load();
    expect(connectBlock({
      emailVerified: true, access: access({ canAddMailbox: false, mailboxes: 5 }), enabledCount: 1,
    })).toBe("cannot_add");
    // The sentence it will render says nothing about a plan, a price or choosing one.
    expect(copy.blocked_cannot_add, "cannot_add has no sentence").toBeTruthy();
    expect(copy.blocked_cannot_add!, "the gate tells an entitled account to choose a plan")
      .not.toMatch(/plan|tarif|choose|w\u00e4hl/i);
  });

  it("an UNBOUNDED limit never produces an at-limit refusal, whatever the count", async () => {
    // `mailboxes: null` is the port's word for "no ceiling", and it is what an unmetered host
    // reaches too. Comparing a count against it would invent a limit nobody set.
    const connectBlock = await load();
    for (const enabledCount of [0, 5, 5000]) {
      expect(connectBlock({
        emailVerified: true, access: access({ mailboxes: null }), enabledCount,
      }), `count ${enabledCount}`).toBe(null);
    }
  });

  it("at the plan's limit ⇒ `at_limit`, even though the subscription is perfectly live", async () => {
    const connectBlock = await load();
    expect(connectBlock({
      emailVerified: true, access: access({ mailboxes: 5 }), enabledCount: 5,
    })).toBe("at_limit");
  });

  it("a list that has NOT arrived fails OPEN — it never invents an at-limit refusal", async () => {
    // The entitlement can land before `GET /mailboxes` does. Every unknown in this function
    // fails open, and the direction is the whole safety argument: withholding a connect the
    // server would have allowed is worse than the defect being fixed.
    const connectBlock = await load();
    expect(connectBlock({
      emailVerified: true, access: access({ mailboxes: 1 }), enabledCount: null,
    })).toBe(null);
  });

  it("a DISABLED mailbox occupies no slot — the count is the gate's own", async () => {
    // `readMailboxAllowance` counts `status <> 'disabled'`. Counting the tombstones here would
    // refuse an account that has room, which is worse than the defect being fixed: it withholds
    // something the server would have allowed.
    const el = await (async () => {
      mockStatus = answer({ mailboxes: 2 });
      mockListed = [
        dto({ id: "live", address: "a@example.test" }),
        dto({ id: "dead", address: "b@example.test", status: "disabled" }),
        dto({ id: "dead2", address: "c@example.test", status: "disabled" }),
      ];
      return mount();
    })();
    expect(byText(el, copy.connect!), "three rows, two of them tombstones, and the pane refused")
      .toBeTruthy();
  });

  it("an UNVERIFIED address is refused first, because the middleware refuses it first", async () => {
    // `withSpendGate` runs between `withStepUp` and the handler (`packages/api/src/app.ts`), so
    // `POST /mailboxes` answers 403 `email_unverified` BEFORE the allowance gate is reached.
    // A pane that offered "choose a plan" here would be describing a refusal that never fires.
    const connectBlock = await load();
    expect(connectBlock({
      emailVerified: false, access: access({ canAddMailbox: false, mailboxes: 0 }), enabledCount: 0,
    })).toBe("email_unverified");
  });

  it("an entitlement the pane could not READ produces no gate — it never guesses", async () => {
    const connectBlock = await load();
    expect(connectBlock({
      emailVerified: true, access: null, enabledCount: 0,
    })).toBe(null);
    // An unread SESSION is likewise not evidence of an unverified address.
    expect(connectBlock({
      emailVerified: null, access: null, enabledCount: 0,
    })).toBe(null);
  });

  it("…and the mounted pane still offers the button when the access read is unreachable", async () => {
    mockStatus = null;
    const el = await mount();
    expect(
      byText(el, copy.connect!),
      "a failed access read withheld a connect the server would have allowed",
    ).toBeTruthy();
  });

  it("the at-limit pane says it is full and does NOT say choose a plan", async () => {
    mockStatus = answer({ mailboxes: 1 });
    mockListed = [dto()];
    const el = await mount();
    const text = el.textContent ?? "";
    expect(byText(el, copy.connect!)).toBeNull();
    expect(text).toContain(copy.blocked_at_limit!);
    expect(text, "an account that is merely FULL was told it may not add one at all")
      .not.toContain(copy.blocked_cannot_add!);
  });

  it("the entitlement is re-read on every return to the list, not once on mount", async () => {
    // It is mutable from outside this tab — a Checkout finished in the Subscription pane, a
    // cancellation in Stripe's portal, a webhook landing late. A gate that read once would keep
    // a hard block up, with the button gone, after the very purchase it asked for.
    const el = await mount();
    const first = mockStatusCalls;
    expect(first).toBeGreaterThan(0);

    await click(byText(el, copy.connect!)!);
    await click(byText(el, copy.cancel!)!);

    expect(byText(el, copy.connect!), "cancel did not return to the list").toBeTruthy();
    expect(mockStatusCalls, "the pane never asked again").toBeGreaterThan(first);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════
   THE COPY, AND THE ONE THING IT MAY NOT BE
   ══════════════════════════════════════════════════════════════════════════════════════ */

describe("the gate's copy is the CLIENT's, and the refusal stays the server's", () => {
  const BLOCKS = ["email_unverified", "cannot_add", "at_limit"];

  it("every block the pane can render has a sentence", () => {
    // `t(`blocked_${block}`)` is interpolated, so `mailbox-reachable.test.ts`'s key sweep
    // cannot see these — the same hole its own `status_${…}` loop exists to close.
    for (const b of BLOCKS) expect(copy[`blocked_${b}`], `missing mailboxes.blocked_${b}`).toBeTruthy();
    expect(copy.blocked_where, "missing mailboxes.blocked_where").toBeTruthy();
  });

  it("none of it restates a sentence `mailbox-allowance.ts` wrote", () => {
    // The server's sentences are written with the entitlement state in hand and this pane has
    // a snapshot. A second copy here drifts on the first change to the plan table and is then
    // confidently wrong — `onboarding.test.ts` forbids the exact strings; this forbids the
    // shape, over the file that owns them.
    const allowance = read("packages/services/src/mailbox-allowance.ts");
    const sentences = [...allowance.matchAll(/"([A-Z][^"]{30,})"/g)].map((m) => m[1]!);
    expect(sentences.length, "the extraction found no server sentences to compare against")
      .toBeGreaterThan(4);
    const ours = [...BLOCKS.map((b) => copy[`blocked_${b}`]!), copy.blocked_where!];
    for (const server of sentences) {
      for (const mine of ours) {
        expect(mine, `restates \`mailbox-allowance.ts\`: ${JSON.stringify(server)}`)
          .not.toBe(server);
      }
    }
  });

  it("the decision is composed from the server's entitlement, never re-derived", () => {
    const src = read("apps/webapp/app/(product)/mailbox/MailboxSection.tsx");
    /* It reads the server's own verdict, and since 0.19.2 it asks FRESH: the client holds one
       access answer for the session, and this pane's own docblock records why it may not take a
       held one — a stale hard block with the connect button removed is the failure this gate
       must not introduce. */
    expect(src).toMatch(/account\.access\(\{ fresh: true \}\)/);
    expect(src).toMatch(/canAddMailbox/);
    // …and does not reimplement the plan table or the status machine.
    expect(src).not.toMatch(/"trialing"|"past_due"|"incomplete"|PLAN_LIMITS/);
    // …and an unbounded limit is skipped rather than compared against an invented ceiling.
    expect(src).toMatch(/a\.mailboxes !== null/);
  });

  it("the pane still runs the step-up itself — the gate did not become a redirect", () => {
    // This fix must not undo the earlier one. `mailbox-reachable.test.ts` owns that property; this is the
    // half that names WHY it is being restated here: a gate is the right place to be tempted
    // into sending the user somewhere, and `JoinScreen.bootstrap()` would bounce a step-up
    // failure straight back to the step that just expired.
    const src = read("apps/webapp/app/(product)/mailbox/MailboxSection.tsx");
    expect(src).not.toMatch(/href="\/join"/);
    expect(src).toMatch(/<StepUpPrompt\b/);
  });
});
