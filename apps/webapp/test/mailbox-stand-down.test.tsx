/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import messages from "../messages/en.json";
import type { MailboxDTO } from "../app/api-client";
import {
  STAND_DOWN_REASONS,
  deriveMailState,
  seedGrowth,
  standDownToken,
  type MailState,
  type MailStateInputs,
  type MailboxFacts,
} from "@ohmail/app-logic/mail-state/mail-state";

/**
 * THREE STATEMENTS ABOUT ONE MAILBOX, ON ONE SCREEN, AND NO TWO OF THEM AGREED.
 *
 * Walked on the hosted service, 2026-08-04. A mailbox connect was accepted
 * end to end — provider, credentials, account password, TOTP — and then the worker's organizer
 * gate found a foreign `local` claim in `ohmail/_meta` whose heartbeat was THREE HOURS stale.
 * `decideLease` arm 8 (`packages/core/src/adapters/organizer-lease.ts:446-448`) answers a stale
 * foreign claim with `available`, not `organize`, unless a human authorized a takeover — so
 * `markMailboxStoodDown` (`apps/worker/src/mailboxes.ts:810`) wrote
 * `status='disabled'`, `disabled_reason='organized_elsewhere:local'` and cleared BOTH the four
 * failure columns and the two sync-block columns, because a stand-down is neither a failure nor
 * an infrastructure block.
 *
 * What the customer then saw, simultaneously:
 *
 *  1. the row said **disconnected** — true;
 *  2. the same row said **"No mail yet — added 3 minutes ago"**, with a spinner — false, nothing
 *     is coming;
 *  3. the shell strip said **"No mailbox connected, so nothing can arrive"** — false, they had
 *     just connected one.
 *
 * And nothing anywhere said WHY, because `disabled_reason` — the one column that held the fact —
 * was not on the wire at all.
 *
 * ── WHAT THIS FILE HOLDS DOWN ───────────────────────────────────────────────────────────
 *
 * The banner half is pure (`deriveMailState`). The row half needs the real pane mounted, which
 * `mailbox-status-honesty.test.tsx` established is possible — and is why the note in
 * `mail-state.test.ts` ("a render harness for this pane is owed") is now answered for a second
 * fact rather than left as a source-grep.
 *
 * ── AND WHAT IT DELIBERATELY DOES NOT ASSERT ────────────────────────────────────────────
 *
 * That the user can DO anything about it from Cloud. Nothing in `packages/api/src`,
 * `packages/services/src` or `apps/webapp/app` writes `takeover_authorized_at`; only
 * `apps/sidecar/src/organize-here.ts` does. The project's design notes sanctions a Cloud takeover
 * prompt — "ohmail on <machine> organizes this mailbox. Cloud will take over." — and it is NOT
 * BUILT (`packages/db/test/journal-split.test.ts:231` says so in as many words). So the copy
 * says what is true today and offers no button, and the last test in this file is what stops a
 * later slice adding the sentence without the mechanism.
 */

const read = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const NOW = Date.parse("2026-08-04T12:00:00.000Z");

/* ══════════════════════════════════════════════════════════════════════════════════════════
   HALF ONE — THE BANNER. Pure, so the precedence is exercised without a DOM.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

const facts = (over: Partial<MailboxFacts> = {}): MailboxFacts => ({
  id: "mb1",
  address: "person@example.test",
  status: "connected",
  errorCode: null,
  disabledReason: null,
  syncBlockedReason: null,
  syncBlockedSince: null,
  lastSyncAt: null,
  initialImportCompletedAt: new Date(NOW - 180_000).toISOString(),
  createdAt: new Date(NOW - 180_000).toISOString(),
  ...over,
});

/** The row the worker's gate actually wrote, column for column. */
const stoodDown = (over: Partial<MailboxFacts> = {}): MailboxFacts =>
  facts({
    status: "disabled",
    disabledReason: "organized_elsewhere:local",
    // `markMailboxStoodDown` clears all six of these in the SAME statement. A fixture that left
    // an errorCode or a syncBlockedSince behind would be reachable by no writer, and would let
    // an existing ladder arm answer this case for the wrong reason.
    errorCode: null,
    syncBlockedReason: null,
    syncBlockedSince: null,
    ...over,
  });

/** The resting mirror size. Named so the `pulled` default below cannot drift from it. */
const MIRRORED_DEFAULT = 0;

const inputs = (over: Partial<MailStateInputs> = {}): MailStateInputs => ({
  sync: { bootstrapping: false, failures: 0, terminal: false, refused: false, ownerLost: false },
  failureStreak: 3,
  mailboxes: [stoodDown()],
  mirrored: MIRRORED_DEFAULT,
  growth: seedGrowth(MIRRORED_DEFAULT),
  // The resting freshness: current, stamped moments ago. The stale arm's own tests perturb it.
  freshness: { state: "current" as const, asOf: new Date(NOW - 30_000).toISOString() },
  engineFreshness: { state: "current" as const, asOf: new Date(NOW - 30_000).toISOString() },
  now: NOW,
  demo: false,
  ...over,
  /* `pulled` follows `mirrored` unless a case names it: that is the shape wherever no producer
     answered a count, which is every test here but the import numerator's own. */
  pulled: over.pulled ?? over.mirrored ?? MIRRORED_DEFAULT,
});

describe("the strip may not tell a customer they have no mailbox when they have one", () => {
  it("THE REGRESSION: a mailbox stood down by the organizer lease is not `noMailbox`", () => {
    const s = deriveMailState(inputs());
    expect(
      s.key,
      'the strip said "No mailbox connected, so nothing can arrive" to somebody who connected ' +
        "one three minutes earlier — the mailbox was filtered out for being `disabled` and the " +
        "reason it was disabled never reached the client",
    ).not.toBe("noMailbox");
    expect(s.key).toBe("blocked");
    expect(s.reason, "the stand-down reason is the whole of what this state has to say")
      .toBe("organized_elsewhere_local");
    expect(s.address).toBe("person@example.test");
  });

  it("THE COPY TOKENS ARE THE OWNED SET, member for member", () => {
    /**
     * The guard `SYNC_BLOCK_REASONS` already carries, for the second closed set on this row.
     *
     * `MAILBOX_DISABLED_REASONS` (`packages/db/src/mailbox-errors.ts`) is the wire vocabulary and
     * `STAND_DOWN_REASONS` is this client's COPY vocabulary — the same members with the colon
     * replaced, because `MailState.reason` is interpolated straight into an i18n key and a
     * server-owned string has no business in the message namespace. Two hand-written lists are
     * how they drift, so the mapping is checked against the owning module rather than trusted.
     *
     * This app declares no dependency on `@trafficflow/db`, so the members are read as TEXT —
     * the technique `mail-state.test.ts` established. `constArray`'s own extractor cannot be
     * reused: its member regex is `/"([a-z_]+)"/g`, which silently matches NOTHING here because
     * every member contains a colon. A borrowed guard that extracts an empty set is a guard that
     * passes for ever, so this one asserts it found as many as the client declares before it
     * compares. The COUNT is the client list's, not a literal here: mail 0103 added a fourth
     * member and two literals in this one case were what had to be edited to say so.
     */
    // `read`, not `import.meta.url`: under the jsdom environment that is not a file URL. The
    // same accommodation `mailbox-status-honesty.test.tsx` records at the top of this directory.
    const src = read("packages/db/src/mailbox-errors.ts");
    const block = /export const MAILBOX_DISABLED_REASONS = \[([\s\S]*?)\] as const;/.exec(src);
    expect(block, "MAILBOX_DISABLED_REASONS is no longer an `export const … as const` — rewrite this guard")
      .not.toBeNull();
    const owned = [...block![1]!.matchAll(/"([a-z_:]+)"/g)].map((m) => m[1]!);
    // THE LITERAL IS ON THE CLIENT LIST, ONCE. Counting `owned` against a literal here meant two
    // numbers to move per widening and mail 0103 moved neither; counting it against
    // `STAND_DOWN_REASONS` alone would let BOTH lists shrink together unnoticed. So the client's
    // members are pinned by name and everything else is derived from them.
    expect([...STAND_DOWN_REASONS]).toEqual([
      "organized_elsewhere_cloud",
      "organized_elsewhere_local",
      "organized_elsewhere_mobile",
      "organized_elsewhere_unknown",
    ]);
    expect(owned.length, "extracted no members — the guard is broken, not the code")
      .toBe(STAND_DOWN_REASONS.length);

    // Order matters and is the same guard `mail-state.test.ts` makes for the other set. The
    // distinctness check below is the one that bites hardest: `standDownToken` maps ANYTHING
    // unrecognised onto `:unknown`, so a member it has simply forgotten would still return a
    // token, and only "one DIFFERENT token per member" notices.
    expect(
      owned.map((wire) => standDownToken(wire)),
      "a wire member has no copy token of its own",
    ).toEqual([...STAND_DOWN_REASONS]);
    expect(
      new Set(owned.map((w) => standDownToken(w))).size,
      "two wire members collapsed onto one sentence",
    ).toBe(STAND_DOWN_REASONS.length);

    // …and every token has a sentence on BOTH surfaces. A member with no copy renders the literal
    // key path, which the brief records this product shipping once already.
    const sync = messages.sync as unknown as Record<string, string>;
    const mb = messages.mailboxes as unknown as Record<string, string>;
    for (const token of STAND_DOWN_REASONS) {
      expect(sync[`blocked_${token}`], `sync.blocked_${token} is missing`).toBeTruthy();
      expect(mb[`standDown_${token}`], `mailboxes.standDown_${token} is missing`).toBeTruthy();
    }
  });

  it("THE CONTROL: an ordinary disconnect is still `noMailbox` — the old test, re-stated", () => {
    // `mail-state.test.ts` already holds this ("a `disabled` mailbox is not a mailbox for any of
    // this"). It is repeated here because the new arm is the thing that could swallow it: a
    // user who disconnected their only mailbox HAS no mailbox, and must still be told so.
    const s = deriveMailState(inputs({ mailboxes: [facts({ status: "disabled" })] }));
    expect(s.key, "a deliberate disconnect was dressed up as an organizer conflict").toBe("noMailbox");
  });

  it("a stand-down outranks a healthy sibling — the account-wide strip must not hide it", () => {
    // Same rule the `blocked` arm already follows: a mailbox nobody is syncing is not syncing,
    // whatever a second mailbox is doing to the mirror.
    const s = deriveMailState(inputs({
      mailboxes: [
        stoodDown({ address: "dead@example.test" }),
        facts({ address: "live@example.test", lastSyncAt: new Date(NOW - 30_000).toISOString() }),
      ],
      mirrored: 495,
      growth: seedGrowth(495),
    }));
    expect(s.key).toBe("blocked");
    expect(s.address).toBe("dead@example.test");
  });

  it("A PROBE THAT OMITS THE FIELD IS NOT AN ORGANIZER CONFLICT", () => {
    /**
     * The defect this arm produced on its first run, kept as the guard for it.
     *
     * The field is typed `string | null`, so `m.disabledReason !== null` reads as the obvious
     * predicate — and it is wrong, because a Cloud bundle compiled before that change omits the field
     * entirely and `undefined !== null` is TRUE. Every ordinary disconnect on every stale client
     * would have become "another ohmail install has claimed this mailbox": a brand-new false
     * sentence, in the exact place a false sentence was being removed.
     *
     * The cast is the point — this is a shape TypeScript forbids and a network does not.
     */
    const omitted = { ...facts({ status: "disabled" }) } as Partial<MailboxFacts>;
    delete omitted.disabledReason;
    const s = deriveMailState(inputs({ mailboxes: [omitted as MailboxFacts] }));
    expect(s.key, "an absent field was read as a stand-down reason").toBe("noMailbox");
  });

  it("a stand-down outranks a SYNC BLOCK — terminal beats retrying", () => {
    /**
     * Both are true and both say "this mailbox is not syncing", so the order has to be argued.
     *
     * A sync block is our own infrastructure declining AND RETRYING: `reconcileSyncBlocks`
     * rewrites it every roster pass and it clears itself when the fault does. A stand-down is
     * terminal from the product's side — `loadEnabledMailboxes` filters `status <> 'disabled'`,
     * so the row is off the roster and no amount of waiting moves it. Between two true
     * sentences, the one that will not stop being true wins.
     */
    const s = deriveMailState(inputs({
      mailboxes: [
        facts({
          address: "blocked@example.test",
          syncBlockedReason: "at_capacity",
          syncBlockedSince: new Date(NOW - 420_000).toISOString(),
        }),
        stoodDown({ address: "claimed@example.test" }),
      ],
    }));
    expect(s.key).toBe("blocked");
    expect(s.reason, "the retrying state outranked the terminal one").toBe("organized_elsewhere_local");
    expect(s.address).toBe("claimed@example.test");
  });

  it("a stand-down reason this build does not know still gets the state, never silence", () => {
    // The lesson one column over: the service narrows to the closed set on read, so a newer
    // server's fourth member arrives as `null` beside a `disabled` status. Silence would be the
    // original defect restored by deploy order.
    const s = deriveMailState(inputs({
      mailboxes: [stoodDown({ disabledReason: "organized_elsewhere:something_newer" })],
    }));
    expect(s.key, "an unrecognised stand-down reason was answered with silence").toBe("blocked");
    // NOT `null`, and this is the inverse of the rule one column over. `syncBlockedReason` may
    // narrow to null because `syncBlockedSince` carries the predicate beside it; here the
    // predicate is `status === 'disabled'`, under which `null` means THE ORDINARY DISCONNECT.
    // Narrowing to null would file a newer worker's stand-down as "the user removed this".
    expect(s.reason, "a member this build does not know was filed as an ordinary disconnect")
      .toBe("organized_elsewhere_unknown");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   HALF TWO — THE ROW. The real pane, mounted.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

const QUIET: MailState = {
  key: "quiet", clock: false, count: 0, total: null, reason: null, errorCode: null, asOf: null,
  address: null, minutes: null, slow: false, screenerCandidate: false, pending: 0, filing: null, continuesAtFolder: null, settled: true, owed: false,
};

/**
 * Mutable so the SAME file can mount the strip over a derived state, which is the only way to
 * prove the copy key actually RESOLVES. `mock`-prefixed because `vi.mock`'s factory is hoisted
 * above the imports and Vitest permits an outer reference only under that prefix.
 */
let mockMailState: MailState = QUIET;

const listed: MailboxDTO[] = [];

vi.mock("../app/api-client", () => ({
  apiConfigured: () => true,
  assertPasskey: async () => ({}),
  webauthnAvailable: () => false,
  codeOf: (e: unknown) => (e as { code?: string }).code ?? null,
  messageOf: (e: unknown) => String(e),
  auth: {
    session: async () => ({
      user: { email: "owner@example.test", emailVerified: true }, scope: "full",
    }),
  },
  // the pane reads the server's entitlement before it offers a connect. A plan with room
  // on it, so the button is offered and this file keeps testing what it was written for.
  billing: {
    subscription: async () => ({
      subscription: {
        plan: "solo", status: "active", mailboxLimit: 5, monthlyCredits: 500,
        currentPeriodEnd: null, cancelAtPeriodEnd: false, graceUntil: null,
      },
      balance: 0,
      plans: {},
      entitlements: {
        mailboxLimit: 5, canAddMailbox: true, aiEnabled: false, syncEnabled: true,
        reason: "active",
      },
    }),
  },
  mailboxes: {
    list: async () => ({ items: listed }),
    create: async () => listed[0]!,
    resync: async () => undefined,
  },
}));

vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: mockMailState, refresh: () => {} }),
}));

const dto = (over: Partial<MailboxDTO>): MailboxDTO => ({
  id: "mb1", provider: "icloud", address: "person@example.test",
  displayName: null, status: "connected", lastSyncAt: null,
  createdAt: new Date(NOW - 180_000).toISOString(), ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function unmount(): Promise<void> {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
}

/** Mount the real pane over the given list and return its host element. */
async function mount(...items: MailboxDTO[]): Promise<HTMLDivElement> {
  await unmount();
  listed.splice(0, listed.length, ...items);
  const { MailboxSection } = await import("../app/(product)/mailbox/MailboxSection.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, { locale: "en", messages, children: h(MailboxSection) }));
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return host;
}

afterEach(async () => { mockMailState = QUIET; await unmount(); });

/**
 * THE STRIP, over a state this slice derives — and the ONLY thing that proves the copy key
 * resolves at all.
 *
 * `sync.blocked_organized_elsewhere:local` carries a COLON, which no other message key in this
 * file does. next-intl walks a key by splitting on `.`, so a colon should be an ordinary
 * character — "should be" is not evidence, and a key that does not resolve renders the literal
 * key path, which is the exact defect the brief records this product shipping once already.
 *
 * `SyncBar` itself is not edited by this slice (it was held): the new state re-uses the
 * `blocked` arm it already has, which is why widening `MailState.reason` was the design rather
 * than adding a seventh key — the switch's `default:` arm renders the `awaiting` copy, so an
 * unknown key would silently say "Waiting for the first mail to arrive" about a stand-down.
 */
async function strip(state: MailState): Promise<string> {
  await unmount();
  mockMailState = state;
  const { SyncBar } = await import("../app/shell/SyncBar.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, { locale: "en", messages, children: h(SyncBar) }));
  });
  return host.textContent ?? "";
}

describe("the strip renders the stand-down sentence it is handed", () => {
  it("the state this slice derives resolves to a sentence, not a key path", async () => {
    const text = await strip({
      ...QUIET, key: "blocked", reason: "organized_elsewhere_local",
      address: "person@example.test",
    });
    const sync = messages.sync as unknown as Record<string, string>;
    expect(text, "the copy key did not resolve — the strip rendered the key path")
      .not.toContain("blocked_organized_elsewhere");
    expect(text).toContain(sync.blocked_organized_elsewhere_local!);
    expect(text).toContain("person@example.test");
    expect(text, "and the false sentence must be nowhere near it").not.toContain(sync.noMailbox!);
  });

  it("no spinner: a claimed mailbox is a CONDITION, not work in progress", async () => {
    // `sync-bar-loader.test.ts` owns this rule for the four condition states. The new arm reaches
    // `blocked`, which is already on the right side of it — asserted here because reaching it
    // through a different route is exactly how a state ends up on the wrong side.
    await strip({ ...QUIET, key: "blocked", reason: "organized_elsewhere_local", address: "a@b.test" });
    expect(host!.querySelector(".mbx-spin"), "a stand-down turned a spinner").toBeNull();
  });
});

describe("the row says WHY, and never claims mail is on its way", () => {
  it("THE REGRESSION: a stood-down row does not render the first-sync sentence", async () => {
    const el = await mount(dto({ status: "disabled", disabledReason: "organized_elsewhere:local" }));
    // "No mail yet — added {when}" beside a spinner, on a mailbox nothing will ever sync. It is
    // reached because `status === 'disabled'` matches none of the row's branches and falls
    // through to the `stamp === null` arm.
    expect(
      el.textContent ?? "",
      "the row promised a first sync on a mailbox the worker has stopped serving",
    ).not.toContain("No mail yet");
    expect(el.querySelector(".mbx-spin"), "…and turned a spinner over it").toBeNull();
  });

  it("…and it says which one, in a sentence", async () => {
    const el = await mount(dto({ status: "disabled", disabledReason: "organized_elsewhere:local" }));
    const mb = messages.mailboxes as unknown as Record<string, string>;
    expect(el.textContent ?? "").toContain(mb.standDown_organized_elsewhere_local!);
    expect(el.textContent ?? "", "and what a person can actually do about it")
      .toContain(mb.standDownHow!);
  });

  it("THE COPY IS TRUE OF A DEAD CLAIM AS WELL AS A LIVE ONE", () => {
    /**
     * The distinction the COLUMN cannot make, and the reason the wording is what it is.
     *
     * `standDownReason` (`apps/worker/src/lease.ts:167`) maps BOTH verdicts onto the same three
     * values: `stand_down` (a FRESH foreign claim — somebody is organizing it right now) and
     * `available` (a STALE one — nobody is, and we refuse to self-promote). the observed case
     * was the second: a local worker three hours dead. So "another install IS ORGANIZING this
     * mailbox" — the first draft of this copy, and the wording the project's design notes proposes — is FALSE
     * in the case that produced the gap.
     *
     * A claim is a claim whether or not anybody is home, so the sentence speaks about the claim.
     */
    const mb = messages.mailboxes as unknown as Record<string, string>;
    const sync = messages.sync as unknown as Record<string, string>;
    for (const token of STAND_DOWN_REASONS) {
      for (const [where, text] of [["mailboxes.standDown", mb[`standDown_${token}`]!], ["sync.blocked", sync[`blocked_${token}`]!]] as const) {
        expect(text, `${where}_${token} claims an activity the row cannot know is happening`)
          .not.toMatch(/is organi[sz]ing|currently|right now/i);
        expect(text, `${where}_${token} should say what the claim IS`).toMatch(/claimed|holds/i);
      }
    }
    // ── THE HALF OF THIS THAT FLIPPED, AND THE HALF THAT DID NOT ─────────────────────────
    //
    // This used to require `standDownHow` to say "ohmail Cloud never takes a mailbox over on its
    // own", because the display name of a foreign claim was on no wire and nothing on this side
    // could stamp an authorization. Both premises are now false: `GET /mailboxes/:id/organizer`
    // carries the name, and `MailboxService.takeover` writes the stamp.
    //
    // What did NOT change is the rule above it — the ROW may not claim an activity it cannot know
    // is happening, because the stored reason is a snapshot of the moment Cloud stood down and
    // nothing re-reads the mailbox afterwards. So the sentence that is allowed to say "is
    // organizing this mailbox" is the one rendered from the FRESH read, and it lives in the
    // takeover panel rather than on the row. The row still speaks about the claim.
    expect(mb.standDownHow, "the row now asserts something only a fresh read can know")
      .not.toMatch(/is organi[sz]ing|currently|right now/i);
    // And the row's line may not name the machine: the row is rendered from the DTO, which does
    // not carry a display name and must not appear to.
    expect(mb.standDownHow, "the row's line cannot name a machine it was never told about")
      .not.toMatch(/\{machine\}/);
  });

  it("an ordinary disconnect is untouched — no reason, no explanation invented", async () => {
    const el = await mount(dto({ status: "disabled" }));
    const mb = messages.mailboxes as unknown as Record<string, string>;
    expect(el.textContent ?? "").toContain(mb.status_disabled!);
    for (const token of STAND_DOWN_REASONS) {
      expect(el.textContent ?? "", "a mailbox the user disconnected was blamed on another install")
        .not.toContain(mb[`standDown_${token}`]!);
    }
    expect(el.textContent ?? "").not.toContain(mb.standDownHow!);
    expect(el.textContent ?? "").not.toContain("No mail yet");
  });

  it("the earlier fix SURVIVES: a never-synced live mailbox still reads `connecting`", async () => {
    const el = await mount(dto({ status: "connected", lastSyncAt: null }));
    const mb = messages.mailboxes as unknown as Record<string, string>;
    expect(el.querySelector(".mbx-sub")?.textContent ?? "").toContain(mb.status_connecting!);
    expect(el.textContent ?? "", "the status-honesty fix was undone").not.toMatch(/\bconnected\b/i);
  });
});

describe("a dead row is never a peer of the live one at the same address", () => {
  it("THE REGRESSION: two rows for one address collapse to one", async () => {
    const el = await mount(
      dto({ id: "mb-dead", status: "disabled", disabledReason: "organized_elsewhere:local" }),
      dto({
        id: "mb-live", status: "connected",
        lastSyncAt: new Date(NOW - 30_000).toISOString(),
        createdAt: new Date(NOW - 60_000).toISOString(),
      }),
    );
    expect(
      el.querySelectorAll(".mbx-row").length,
      "the disabled row stayed listed beside the live one, same address, for ever",
    ).toBe(1);
    const mb = messages.mailboxes as unknown as Record<string, string>;
    expect(el.textContent ?? "", "…and the fact that there had been an earlier one was simply lost")
      .toContain(mb.superseded!);
    // The live row's own state is what shows. The dead row's stand-down reason is HISTORY once
    // something else is organizing the address, and repeating it would be the contradiction again.
    expect(el.textContent ?? "").not.toContain(mb.standDown_organized_elsewhere_local!);
  });

  it("case folds, because the index folds — and `trim` does NOT, because the index does not", async () => {
    /**
     * The grouping key is exactly `mailboxes_active_address_uq`'s: `lower(address)`, no trim.
     *
     * Case first, which is the real shape: the index folds it, so two rows differing only by
     * case cannot both be active and collapsing them is safe.
     */
    const folded = await mount(
      dto({ id: "mb-dead", address: "Person@Example.TEST", status: "disabled" }),
      dto({ id: "mb-live", address: "person@example.test", status: "connected" }),
    );
    expect(folded.querySelectorAll(".mbx-row").length).toBe(1);

    /**
     * And whitespace NOT, which is the part worth a test rather than a comment. `lower()` does
     * not trim, so Postgres considers `" a@x "` and `"a@x"` distinct keys and will happily keep
     * BOTH active. A presentation grouping may be narrower than the constraint; wider, it hides
     * a mailbox the database is still syncing. (`canonicalAddress` trims on write, so this is
     * unreachable through the product — which is exactly why nothing but a test would notice a
     * `trim()` creeping into the key.)
     */
    const spaced = await mount(
      dto({ id: "mb-a", address: " person@example.test", status: "connected" }),
      dto({ id: "mb-b", address: "person@example.test", status: "connected" }),
    );
    expect(
      spaced.querySelectorAll(".mbx-row").length,
      "the grouping folded whitespace the unique index does not, and hid a live mailbox",
    ).toBe(2);
  });

  it("THE CONTROL: two DIFFERENT addresses are two rows", async () => {
    const el = await mount(
      dto({ id: "mb-a", address: "a@example.test", status: "connected" }),
      dto({ id: "mb-b", address: "b@example.test", status: "connected" }),
    );
    expect(el.querySelectorAll(".mbx-row").length, "the grouping swallowed a real mailbox").toBe(2);
  });

  it("a disabled row with NO live sibling still gets its own row", async () => {
    const el = await mount(dto({ id: "mb-dead", status: "disabled", disabledReason: "organized_elsewhere:local" }));
    expect(el.querySelectorAll(".mbx-row").length, "the only mailbox on the account vanished").toBe(1);
  });
});

describe("the copy may not promise a takeover Cloud cannot perform, and may not deny one it can", () => {
  /**
   * THE PREMISE OF THE COPY, CHECKED RATHER THAN REMEMBERED — AND IT HAS NOW FLIPPED ONCE.
   *
   * This guard used to assert that NOTHING in the Cloud tier stamped `takeover_authorized_at`,
   * because at the time nothing did: the column was written only by the desktop's own
   * `organize here` command. The copy beside the stand-down therefore told people to go and stop
   * the other install by hand, or to delete a bookkeeping message out of their own `ohmail/_meta`
   * folder — and it said in as many words that "ohmail Cloud never takes a mailbox over on its
   * own."
   *
   * `MailboxService.takeover` makes that false, so the old guard went red exactly as its own
   * comment predicted it would, and the response it prescribed was taken: **the copy changed, the
   * guard did not get deleted.** It now checks the other direction, because that is the direction
   * a claim can now be false in.
   */
  it("the stand-down copy no longer tells people to stop the other install by hand", () => {
    const copy = JSON.stringify(messages.mailboxes ?? {});
    // The two false promises, by their load-bearing phrases rather than whole sentences, so a
    // reworded version of the same claim is still caught.
    expect(copy, "the copy still claims Cloud never takes a mailbox over").not.toMatch(/never takes a mailbox over/i);
    expect(
      copy,
      "the copy still sends the user into ohmail/_meta to delete a message by hand — there is an " +
      "action for this now",
    ).not.toMatch(/_meta/);
  });

  it("THE ACTION THE COPY NOW PROMISES EXISTS, end to end", () => {
    // A sentence that names an action nobody wired is the same defect in a new coat, and this
    // repository has shipped a control whose ON position had no server behind it before. Each link
    // in the chain is asserted from source, and the chain is short on purpose: copy → client →
    // route → service.
    const copy = JSON.stringify(messages.mailboxes ?? {});
    expect(copy, "the takeover control has no copy").toMatch(/organizerConfirm/);

    const pane = read("apps/webapp/app/(product)/mailbox/MailboxSection.tsx");
    expect(pane, "the pane never calls the check").toMatch(/mailboxApi\.organizer\(/);
    // RENAMED to `organize` when the ceremony grew its second half — the FIRST consent, where
    // there is nobody to take a mailbox over from. Same one call, same one stamp; the old name
    // was true of the only case that existed when this pin was written.
    expect(pane, "the pane never calls the claim").toMatch(/mailboxApi\.organize\(/);

    const client = read("apps/webapp/app/api-client.ts");
    expect(client, "the client has no organizer read").toMatch(/organizer:/);
    expect(client, "the client has no claim").toMatch(/organize:/);

    const routes = read("packages/api/src/routes/mailboxes.ts");
    expect(routes, "no route serves the organizer read").toMatch(/\/mailboxes\/:id\/organizer/);
    // THE `pattern:` DECLARATION, not the bare path: this file NAMES the route in prose a dozen
    // times, so a search for the path alone is satisfied by a comment about a route that has
    // been deleted. Both this and the slice below learned that the same way.
    expect(routes, "no route serves the claim")
      .toMatch(/pattern:\s*"\/mailboxes\/:id\/organize"/);

    const svc = read("packages/services/src/mailbox-service.ts");
    // The stamp, which is the whole of what the confirm does. Asserted as an ASSIGNMENT so a
    // mention in a comment cannot satisfy it.
    expect(svc, "the service does not stamp an authorization").toMatch(/takeoverAuthorizedAt:\s*ctx\.now\(\)/);
  });

  it("and the confirm still writes ONLY a stamp — the API never becomes the organizer", () => {
    /* Organization lands in real folders and the WORKER is what puts it there. The route may not
     * reach for a full adapter on the claim path.
     *
     * ── THE PROBE IS NOW ALLOWED HERE, AND THAT IS A REAL CHANGE RATHER THAN A LOOSENING ────
     *
     * When this guard was written the claim carried no body and touched no network, so "opens
     * nothing" was the whole rule and `makeImapProbe` belonged in the refused set. The ceremony
     * now accepts a password — a claim-back whose stored login the provider has since revoked is
     * otherwise a stamp that looks like it worked and leaves the mailbox quarantined — and a
     * password that is stored without being PROVED is the defect that change exists to close. So
     * the handler builds a probe, deliberately.
     *
     * What stays refused is what would make the API the organizer: `makeOpenAdapter`, which is
     * the full mailbox connection every write path uses, and `makeOrganizerPeek`, which reads
     * the lease. A probe dials, proves a login and hangs up; it ensures no folder, moves no
     * message and APPENDs nothing to `ohmail/_meta`. The invariant is unchanged — this route
     * may probe, never APPEND — and the assertion now says that instead of a proxy for it.
     *
     * Found by watching this guard fail, after it was fixed: it had been vacuously green through
     * the whole rename and the first thing it did on waking up was report a true fact. */
    const routes = read("packages/api/src/routes/mailboxes.ts");
    /* ── THE INDEX IS ASSERTED BEFORE IT IS SLICED, AND THAT IS THE POINT ──────────────────
     *
     * This guard was VACUOUSLY GREEN for the whole life of the `takeover` → `organize` rename.
     * `indexOf` answered `-1`, `slice(-1)` took the file's LAST CHARACTER, the inner `indexOf`
     * then answered `-1` as well, and `not.toMatch` passed over an empty string — so the check
     * that the claim handler opens no IMAP adapter was asserting nothing at all, on a route
     * whose whole danger is that it might. A stale name in a `not.toMatch` does not fail; it
     * stops looking.
     *
     * The repair needed TWO passes, which is the part worth writing down. Asserting the index
     * first still passed a mutation that renamed the route, because `indexOf` on the bare path
     * matched one of the dozen COMMENTS in this file that mention it. Only anchoring on the
     * `pattern:` declaration — the thing that actually mounts a handler — goes red when the
     * route moves. Watched: renaming the pattern to `/mailboxes/:id/claimit` reddens this. */
    const at = routes.indexOf('pattern: "/mailboxes/:id/organize"');
    expect(at, "the claim route is not in this file under this name").toBeGreaterThan(-1);
    const handler = routes.slice(at + 1);
    const end = handler.indexOf('pattern: "/mailboxes');
    expect(end, "the claim handler has no next route to bound it").toBeGreaterThan(-1);
    const body = handler.slice(0, end);
    expect(body, "the claim handler opens a full mailbox connection or reads the lease")
      .not.toMatch(/makeOpenAdapter|makeOrganizerPeek/);
    // ANTI-VACUITY: the slice really does contain the handler, so the refusal above is looking
    // at something. Without this the whole check is one stale name away from asserting nothing
    // again — which is exactly how it spent the last rename.
    expect(body, "the slice does not contain the claim handler").toMatch(/handler:\s*async/);
  });

  it("THE WIRING: the Cloud probe actually carries the field (SOURCE — a weaker guard)", () => {
    /**
     * A perfect ladder nobody feeds is exactly that defect, and this change has the seam for it: the
     * derivation lives in `app/shell/**` (published to the Desktop mirror, which may not import
     * `app/api-client`), so `mailbox-facts.ts` is the ONLY place a `MailboxDTO` becomes a
     * `MailboxFacts`. Drop this one line and every test above still passes on hand-built facts
     * while no customer ever sees the sentence.
     *
     * THE MAPPING MOVED OUT OF `CloudShell.tsx` into its own module, and this pin followed it
     * rather than being deleted. That move is what made the seam testable directly — every
     * component test injects `MailboxFacts` through a mocked provider and none of them reaches
     * the mapping — so the module now has its own unit tests and this stays as the census that
     * the FORWARD is still there.
     *
     * Asserted from SOURCE, and that is strictly weaker than a render — mounting `CloudShell`
     * needs `AppShell`, an engine and a session probe. Said out loud so the next reader does not
     * mistake it for proof that a customer sees anything. The compiler is the real guard here:
     * `MailboxFacts.disabledReason` is NOT optional, so deleting the line is a typecheck error —
     * and `apps/webapp` typechecks, which is what actually holds this down.
     */
    const src = read("apps/webapp/app/(product)/mailbox/mailbox-facts.ts");
    expect(
      /disabledReason:\s*m\.disabledReason/.test(src),
      "the DTO → MailboxFacts seam no longer forwards the stand-down reason",
    ).toBe(true);
  });

  it("the stand-down row offers EXACTLY ONE action, and it is the check rather than the takeover", async () => {
    /**
     * ── THIS ASSERTION USED TO BE `toBe(0)`, AND THE REASON IT CHANGED IS THE SLICE ──────────
     *
     * "The stand-down row offers no action, because there is none to offer" was true while nothing
     * on this side could stamp an authorization. There is one now, so the row has one button.
     *
     * The number is still asserted, and TIGHTLY, because the failure mode has moved rather than
     * gone: the danger is no longer a button that cannot work, it is a button that takes a mailbox
     * over on one click. So the row's single control must be the CHECK — it opens a read-only
     * connection and reports what is holding the mailbox — and the confirm may only appear after
     * somebody has been shown that answer.
     */
    const el = await mount(dto({ status: "disabled", disabledReason: "organized_elsewhere:local" }));
    const buttons = [...(el.querySelector(".mbx-row")?.querySelectorAll("button") ?? [])];
    expect(buttons.length, "the stand-down row grew a second control").toBe(1);
    const label = buttons[0]?.textContent ?? "";
    const mb = messages.mailboxes as unknown as Record<string, string>;
    expect(label, "the row's one control is not the check").toBe(mb.organizerCheck);
    // AND THE CONFIRM IS NOT ON THE ROW. A single click must never be able to take a mailbox from
    // another install: the effect sentence has to be on screen first.
    expect(label, "the row offers the takeover itself, with nothing read first")
      .not.toBe(mb.organizerConfirm);
  });
});
