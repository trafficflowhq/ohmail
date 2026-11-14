/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";
import type { MailboxDTO, SubscriptionStatus } from "../app/api-client";
import type { MailState } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * ═══ BOTH SIDES BELIEVED THE OTHER ONE HELD IT, FOR THREE DAYS ═══════════════════════════════
 *
 * ── THE STATE, AND WHY IT IS STABLE RATHER THAN TRANSIENT ───────────────────────────────────
 *
 * An install can stop organizing a mailbox without its CLAIM being taken out of the mailbox. The
 * claim is a record in the customer's own IMAP folder and only the process holding it can remove
 * it, so once that process has stood down the record simply stays. Every other install reads it
 * and concludes somebody is organizing the mailbox, so each of them stands down too — and the one
 * that left it reads THEIR absence the same way. Nothing files the mailbox, and every row on
 * every screen says something else does. It does not decay: the claim sits there until a process
 * that holds it gives it up.
 *
 * ── WHAT THE PANE DID ABOUT IT ──────────────────────────────────────────────────────────────
 *
 * The release block was gated on `standDown === null && organizerRole !== "reader"` — which is a
 * test for "this install organizes this mailbox". A stranded row fails it, so the only control on
 * offer was the check-then-confirm TAKEOVER: a ceremony written for displacing a live competing
 * install, pointed at this install's own claim. The one press that resolves the state — the
 * release, which takes the claim off the mailbox — could not be reached from the row at all.
 *
 * ── WHAT IS PINNED HERE ─────────────────────────────────────────────────────────────────────
 *
 * That the release verb is reachable whenever THIS install's claim is on the mailbox, whatever
 * the local stand-down state says, and that it is NOT offered over a claim belonging to somebody
 * else — those are the two halves of one rule and the second is the one a careless fix loses.
 * `mail-state`'s own suite owns what `claimLeftBehind` answers; this file is the render half, in
 * both languages, because a branch resolved in one catalogue and not the other renders a key path.
 *
 * ── HOW TO WATCH THESE FAIL ─────────────────────────────────────────────────────────────────
 *
 *  · restore `standDown === null` as the sole first clause of the gate → every stranded case here
 *    goes red and both control cases stay green;
 *  · drop the `organizedBy.kind === "cloud"` test from `claimLeftBehind` → "somebody else's
 *    mailbox keeps the ceremony" goes red, which is the fix offering to release a claim that is
 *    not this install's;
 *  · point the stranded branch back at the organizing sentence → the sentence case goes red.
 */

const copy = en.mailboxes as unknown as Record<string, string>;
const copyDe = (de as unknown as { mailboxes: Record<string, string> }).mailboxes;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const QUIET: MailState = {
  mailboxes: null, mirrored: 0, freshness: { state: "unknown", asOf: null },
} as unknown as MailState;

const healthy = { status: "active", plan: "pro", credits: 100 } as unknown as SubscriptionStatus;

let mockListed: MailboxDTO[] = [];
/** Every id `POST /mailboxes/:id/release` was asked for — the press this row must be able to make. */
let mockReleaseCalls: string[] = [];
/** And every id the takeover was asked for, which a hand-back must never fire. */
let mockOrganizeCalls: string[] = [];

vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return {
    ...actual,
    apiConfigured: () => true,
    webauthnAvailable: () => false,
    auth: {
      session: async () => ({
        user: { email: "person@example.test", emailVerified: true, accountId: "acc1" },
        scope: "full",
      }),
    },
    billing: { subscription: async () => ({ entitlements: null, subscription: healthy }) },
    mailboxes: {
      list: async () => ({ items: mockListed }),
      organizer: async () => ({ holders: [], unreadable: 0 }),
      organize: async (id: string) => { mockOrganizeCalls.push(id); return { outcome: "authorized" }; },
      release: async (id: string) => { mockReleaseCalls.push(id); return { outcome: "requested" }; },
    },
  };
});

vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: QUIET, refresh: () => {} }),
}));

/**
 * THE STRANDED ROW, as the read reports it: a reader whose consent still stands, and a holder
 * named `cloud` — which on this pane is this install itself. `organizerState: "stopped"` is the
 * mailbox saying the claim is no longer being renewed, which is what three days of silence looks
 * like; the fix does not read it, and it is here so the fixture is the row that was actually seen
 * rather than the smallest one that passes.
 */
const stranded = (over: Partial<MailboxDTO> = {}): MailboxDTO => ({
  id: "mb1", provider: "icloud", address: "person@example.test",
  displayName: null, status: "connected",
  lastSyncAt: "2026-09-04T09:20:00.000Z", createdAt: "2026-08-01T10:00:00.000Z",
  organizerRole: "reader",
  organizedBy: { kind: "cloud", name: null, since: "2026-09-01T08:00:00.000Z" },
  /* THE SERVER'S OWN COMPARISON. The pane used to re-derive this from `kind`, which says `cloud`
     for a SECOND Cloud deployment's claim as readily as for our own — so the hand-back was offered
     over a claim this install could not remove. The id is not on the wire; the answer is. */
  organizedByThisInstall: true,
  organizerState: "stopped",
  organizeConsentedAt: "2026-08-01T10:05:00.000Z",
  organizerReleasedAt: null,
  ...over,
} as MailboxDTO);

/** The ordinary organizer row — the control that must keep the wording it always had. */
const organizing = (over: Partial<MailboxDTO> = {}): MailboxDTO => stranded({
  organizerRole: "organizer", organizedBy: null, organizerState: "held", ...over,
});

/** Somebody ELSE's claim. The control that must keep the ceremony and gain no release. */
const foreign = (over: Partial<MailboxDTO> = {}): MailboxDTO => stranded({
  organizedBy: { kind: "local", name: "a laptop", since: "2026-09-01T08:00:00.000Z" },
  organizedByThisInstall: false,
  organizerState: "held", ...over,
});

/**
 * ANOTHER CLOUD DEPLOYMENT'S CLAIM — the same KIND as ours, and not ours.
 *
 * The hosted organizer's id is scoped by environment, so a staging deployment pointed at a
 * production mailbox is a different organizer. This row is what a category comparison read as
 * "ours": it says `cloud`, and the server says it is not this install's.
 */
const foreignCloud = (over: Partial<MailboxDTO> = {}): MailboxDTO => stranded({
  organizedBy: { kind: "cloud", name: null, since: "2026-09-01T08:00:00.000Z" },
  organizedByThisInstall: false,
  organizerState: "held", ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function unmount(): Promise<void> {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
}

async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); });
}

async function mount(locale: "en" | "de", ...items: MailboxDTO[]): Promise<HTMLDivElement> {
  await unmount();
  mockListed = items;
  const { MailboxSection } = await import("../app/(product)/mailbox/MailboxSection.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale, messages: (locale === "en" ? en : de) as never, children: h(MailboxSection),
    }));
  });
  await settle();
  return host;
}

function button(el: HTMLElement, text: string): HTMLElement | null {
  return [...el.querySelectorAll("button, a")]
    .find((n) => (n.textContent ?? "").trim() === text) as HTMLElement | undefined ?? null;
}

async function click(el: Element): Promise<void> {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
}

beforeEach(() => { mockListed = []; mockReleaseCalls = []; mockOrganizeCalls = []; });
afterEach(async () => { await unmount(); });

describe("a claim this install left behind can be given up from the row", () => {
  it("THE REGRESSION: the release verb is on the row at all", async () => {
    const el = await mount("en", stranded());
    expect(button(el, copy.releaseClaim!), "the stranded row offers no hand-back").toBeTruthy();
  });

  it("and the press reaches the release, never the takeover", async () => {
    const el = await mount("en", stranded());
    await click(button(el, copy.releaseClaim!)!);
    await click(button(el, copy.releaseClaimConfirm!)!);
    expect(mockReleaseCalls, "the hand-back did not ask for the release").toEqual(["mb1"]);
    /* THE TAKEOVER IS THE ASSERTION, not a detail: the state's whole shape is that the only
       control on offer was one that displaces the holder, and the holder is this install. */
    expect(mockOrganizeCalls, "giving up a claim authorized a takeover instead").toEqual([]);
  });

  it("says what is true — reading only, with a claim still on the mailbox", async () => {
    const el = await mount("en", stranded());
    const said = el.textContent ?? "";
    expect(said, "the stranded row does not explain the claim").toContain(copy.stateClaimLeftBehind!);
    /* The sentence the organizer row carries asserts this install FILES the mailbox, which is
       exactly what is false here. A branch that reused it would read as correct and be a lie. */
    expect(said, "a row that organizes nothing claimed it files the mailbox")
      .not.toContain(copy.stateOrganizingCloud!);
  });

  it("ONE REMEDY, NOT TWO — the takeover ceremony is not drawn beside the hand-back", async () => {
    /* `readerStandDown` answers non-null for a reader with a holder, and a stranded row IS one —
       so the stand-down branch and the hand-back block are both eligible and both rendered. The
       row offered "another ohmail Cloud install has claimed this mailbox" plus check-then-confirm
       DIRECTLY ABOVE "give up the claim": two controls pointing opposite ways at one mailbox, and
       the ceremony pointed at a claim of this install's own.

       The original test asserted the hand-back was PRESENT and never that the ceremony was gone,
       which is why it passed. */
    const el = await mount("en", stranded());
    const said = el.textContent ?? "";
    expect(said, "the stand-down sentence is still drawn over a row we hold the claim on")
      .not.toContain(copy.standDown_organized_elsewhere_cloud!);
    expect(button(el, copy.organizerCheck!), "the takeover ceremony is drawn beside the hand-back")
      .toBeNull();
    expect(said, "the ceremony's explanation survived its control").not.toContain(copy.standDownHow!);
    // …and the remedy that IS right is still there.
    expect(button(el, copy.releaseClaim!)).toBeTruthy();
  });

  it("and the cost sentence is the claim's, not the organizer's", async () => {
    const el = await mount("en", stranded());
    await click(button(el, copy.releaseClaim!)!);
    const said = el.textContent ?? "";
    expect(said).toContain(copy.releaseClaimWhat!);
    expect(said).not.toContain(copy.stopOrganizingWhatCloud!);
  });
});

describe("THE CONTROLS — the two rows either side of it are untouched", () => {
  it("an organizer row keeps the wording and the verb it always had", async () => {
    const el = await mount("en", organizing());
    const said = el.textContent ?? "";
    expect(said).toContain(copy.stateOrganizingCloud!);
    expect(button(el, copy.stopOrganizingHandBack!), "the organizer row lost its release")
      .toBeTruthy();
    expect(button(el, copy.releaseClaim!), "the stranded wording reached an organizer row").toBeNull();
  });

  it("somebody else's mailbox keeps the ceremony and gains no release", async () => {
    /* THE MUTATION THIS CASE EXISTS FOR. A fix that offered the release on every reader row would
       put "give up the claim" over a claim written by another machine — a press that asks the
       server to release something this install does not hold, on a row whose actual remedy is
       the takeover. */
    const el = await mount("en", foreign());
    expect(button(el, copy.releaseClaim!), "the release was offered over a foreign claim").toBeNull();
    expect(button(el, copy.organizerCheck!), "a live foreign holder lost its check").toBeTruthy();
    expect(el.textContent ?? "").toContain(copy.standDown_organized_elsewhere_local!);
  });

  it("ANOTHER CLOUD DEPLOYMENT'S CLAIM keeps the ceremony and gains no hand-back", async () => {
    /* The row a `kind === "cloud"` test got wrong in BOTH directions at once: it offered a
       hand-back that could not remove the claim, and — once the hand-back suppressed the ceremony —
       took away the takeover, which is the remedy that actually works on somebody else's claim. */
    const el = await mount("en", foreignCloud());
    expect(button(el, copy.releaseClaim!), "the hand-back was offered over a foreign Cloud claim")
      .toBeNull();
    expect(button(el, copy.organizerCheck!),
      "the takeover was taken from the row whose only working remedy it is").toBeTruthy();
    expect(el.textContent ?? "").toContain(copy.standDown_organized_elsewhere_cloud!);
  });

  it("a reader that never consented is a fresh mailbox, not a stranded one", async () => {
    const el = await mount("en", stranded({ organizeConsentedAt: null }));
    expect(button(el, copy.releaseClaim!), "a mailbox nobody agreed to organize offered a release")
      .toBeNull();
  });
});

describe("both languages resolve, so neither renders a key path", () => {
  it("German draws the sentence and both steps of the hand-back", async () => {
    const el = await mount("de", stranded());
    expect(el.textContent ?? "").toContain(copyDe.stateClaimLeftBehind!);
    await click(button(el, copyDe.releaseClaim!)!);
    expect(el.textContent ?? "").toContain(copyDe.releaseClaimWhat!);
    expect(button(el, copyDe.releaseClaimConfirm!)).toBeTruthy();
  });

  for (const locale of ["en", "de"] as const) {
    it(`${locale}: no key path reaches the screen`, async () => {
      const el = await mount(locale, stranded());
      await click(button(el, (locale === "en" ? copy : copyDe).releaseClaim!)!);
      const said = el.textContent ?? "";
      expect(said, "an unresolved message key rendered as its own path")
        .not.toMatch(/\bmailboxes\.[a-zA-Z]/);
      expect(said).not.toContain("MISSING_MESSAGE");
    });
  }
});
