/** @vitest-environment jsdom */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import en from "../../messages/en.json";
import {
  markDecisionAsked, resetDecisionAskedForTests,
} from "@ohmail/app-logic/mailboxes/first-run/decision-asked";
import {
  nothingOrganizesOf, notOrganizingYetOf, readerStandDown, type MailboxFacts,
} from "@ohmail/app-logic/mail-state/mail-state";
import {
  ACCOUNT, ISO, act, installConfirmEnv, mountCloudShell, refresh204, rememberOwner,
  scriptRefresh, scriptSession, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "../fixtures/cloud-confirm-shell";

/**
 * A MAILBOX NOBODY AGREED TO ORGANIZE IS NOT CALLED SCREENED (self-host 0.25.19): the first run left
 * before "Agree and start organizing", a never-seen sender landed in the Ohbox, and the Screener said "First-time
 * senders appear here before anything reaches the Ohbox". Where every mailbox is such a one, the Screener's empty
 * state, its header count and the Ohbox's doorbell say ohmail is not organizing it yet, with the press that opens the
 * organize decision. A mailbox another install holds, a consented one and an unread lease keep what they said.
 */

const HINT = en.screener.empty.waiting.hint;
const NOT_YET_ONE = "ohmail is not organizing this mailbox yet.";

function fact(over: Partial<MailboxFacts> & { id: string }): MailboxFacts {
  return {
    address: `${over.id}@family.example`, status: "connected", errorCode: null, disabledReason: null,
    syncBlockedReason: null, syncBlockedSince: null, lastSyncAt: null, createdAt: "2026-10-09T10:00:00.000Z",
    organizerRole: "reader", organizedBy: null, organizerState: null, organizeConsentedAt: null,
    ...over,
  } as MailboxFacts;
}

describe("notOrganizingYetOf — the rows it names", () => {
  it("names a connected reader nobody agreed to and nothing holds, and says when it is every one", () => {
    expect(notOrganizingYetOf([fact({ id: "a" })])).toEqual({
      mailboxes: [{ id: "a", address: "a@family.example" }], every: true,
    });
  });

  it("CONTROL: a consented mailbox, an organizer, a live holder, an unread lease and absent consent name nothing", () => {
    expect(notOrganizingYetOf([fact({ id: "a", organizeConsentedAt: "2026-10-09T10:01:00.000Z" })])).toBeNull();
    expect(notOrganizingYetOf([fact({ id: "a", organizerRole: "organizer" })])).toBeNull();
    expect(notOrganizingYetOf([fact({
      id: "a", organizedBy: { kind: "desktop", name: "Laptop", since: null }, organizerState: "held",
    })])).toBeNull();
    expect(notOrganizingYetOf([fact({ id: "a", organizerChecked: false })])).toBeNull();
    const absent = fact({ id: "a" }) as Partial<MailboxFacts>;
    delete absent.organizeConsentedAt;
    expect(notOrganizingYetOf([absent as MailboxFacts])).toBeNull();
    expect(notOrganizingYetOf(null)).toBeNull();
  });

  it("a holder whose lease lapsed organizes nothing, so the mailbox is named", () => {
    expect(notOrganizingYetOf([fact({
      id: "a", organizedBy: { kind: "desktop", name: "Laptop", since: null }, organizerState: "stopped",
    })])?.every).toBe(true);
  });

  it("one roster, one answer: the shell asks in its render and the views keep a stable object", () => {
    const rows = [fact({ id: "a" })];
    expect(notOrganizingYetOf(rows)).toBe(notOrganizingYetOf(rows));
    expect(notOrganizingYetOf([fact({ id: "a" })])).not.toBe(notOrganizingYetOf(rows));
  });

  it("a mixed account names only the unorganized one, and is not every; a removed row is not counted", () => {
    const got = notOrganizingYetOf([
      fact({ id: "a" }), fact({ id: "b", organizeConsentedAt: "2026-10-09T10:01:00.000Z", organizerRole: "organizer" }),
      fact({ id: "gone", status: "disabled" }),
    ]);
    expect(got).toEqual({ mailboxes: [{ id: "a", address: "a@family.example" }], every: false });
  });
});

const text = (el: HTMLElement) => el.textContent ?? "";
const head = (el: HTMLElement) => within(el).getByRole("heading", { name: "Screener" }).closest("header")!;
const pressNamed = (el: HTMLElement, name: string) => within(el).queryAllByRole("button", { name });

let mounted = false;
beforeAll(warmCloudShell);
afterEach(async () => {
  if (mounted) await teardownConfirmEnv();
  resetDecisionAskedForTests();
  mounted = false;
});

async function screener(...roster: MailboxFacts[]): Promise<HTMLElement> {
  installConfirmEnv();
  mounted = true;
  window.localStorage.clear();
  markDecisionAsked(ACCOUNT);
  rememberOwner();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
  const fixture = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname;
    if (path === "/api/mailboxes") {
      return Response.json({ items: roster.map((box) => ({
        initialImportCompletedAt: ISO, ...box, lastSyncAt: ISO,
      })) });
    }
    return fixture(input, init);
  };
  window.location.hash = "#/screener";
  const frame = await mountCloudShell();
  await tick(3000);
  return frame;
}

const organized = (id: string) => fact({ id, organizerRole: "organizer", organizeConsentedAt: ISO });
const EVERY = fact({ id: "mb-1", address: ["family", "example.invalid"].join("@") });
const MIXED = fact({ id: "mb-2", address: ["work", "example.invalid"].join("@") });

describe("the Screener over a mailbox nothing organizes", () => {
  it("says it is not organizing yet, never the screening sentence, and its header is not 'all clear'", async () => {
    const el = await screener(EVERY);
    expect(text(el)).toContain(NOT_YET_ONE);
    expect(text(el)).toContain(en.screener.notYetWhy);
    expect(text(el), "the screening claim over a mailbox nothing screens").not.toContain(HINT);
    expect(text(el)).not.toContain("all clear");
    expect(text(head(el))).toContain(en.screener.metaNotYet);
  });

  it("its press opens the organize decision for that mailbox — the re-run, which opens on the consent statement", async () => {
    const el = await screener(EVERY);
    const press = pressNamed(el, en.screener.notYetPress);
    expect(press).toHaveLength(1);
    await act(async () => { press[0]!.click(); });
    await tick(200);
    expect(window.location.hash).toBe("#/first-run/again?mailbox=mb-1");
  });

  it("a mixed account keeps the screening sentence for the organized mailboxes and names the other, never 'all clear'", async () => {
    const el = await screener(organized("mb-1"), MIXED);
    expect(text(el)).toContain(HINT);
    expect(within(el).getByText(en.screener.empty.waiting.mixedHint)).toBeTruthy();
    expect(text(el)).toContain(`ohmail is not organizing ${MIXED.address} yet`);
    expect(pressNamed(el, en.screener.notYetPress)).toHaveLength(1);
    expect(text(el), "'all clear' over a mailbox nothing organizes").not.toContain("all clear");
    expect(text(head(el))).toContain(`not organizing ${MIXED.address}`);
  });

  it("CONTROL: an organized account reads exactly as before", async () => {
    const el = await screener(organized("mb-1"));
    expect(text(el)).toContain(HINT);
    expect(text(head(el))).toContain("all clear");
    expect(text(el)).not.toContain("not organizing");
    expect(pressNamed(el, en.screener.notYetPress)).toHaveLength(0);
  });
});

/**
 * A MAILBOX HANDED BACK, OR WHOSE HOLDER STOPPED, IS NOT SCREENED EITHER. After "Hand the mailbox back" a stranger
 * landed in the Ohbox while the Screener said "all clear · First-time senders appear here before anything reaches the
 * Ohbox" and the Ohbox showed no line at all. Consent stands there, so the press is Organize here, in Mailboxes, and
 * the line is a standing state rather than a notice somebody can dismiss.
 */
const T = "2026-10-09T10:01:00.000Z";
const HANDED_BACK = { ...EVERY, organizeConsentedAt: T, organizerReleasedAt: T };
const STOPPED = fact({
  ...EVERY, organizeConsentedAt: T, organizerState: "stopped",
  organizedBy: { kind: "desktop", name: "Laptop", since: T },
});

describe("nothingOrganizesOf — every mailbox nothing organizes, and why", () => {
  it("names a handed-back mailbox and one whose holder stopped, beside the never-agreed one", () => {
    expect(nothingOrganizesOf([
      fact({ id: "a", organizeConsentedAt: T, organizerReleasedAt: T }),
      fact({ id: "b", organizeConsentedAt: T, organizedBy: { kind: "mobile", name: "Pixel", since: T }, organizerState: "stopped" }),
      fact({ id: "c" }),
    ])).toEqual({
      mailboxes: [
        { id: "a", address: "a@family.example", why: "handed_back" },
        { id: "b", address: "b@family.example", why: "stopped" },
        { id: "c", address: "c@family.example", why: "never_agreed" },
      ],
      every: true,
    });
  });

  it("CONTROL: an organizer, a live holder, an unread lease, a removal and a pause name nothing", () => {
    expect(nothingOrganizesOf([fact({ id: "a", organizerRole: "organizer", organizeConsentedAt: T })])).toBeNull();
    expect(nothingOrganizesOf([fact({
      id: "a", organizeConsentedAt: T, organizedBy: { kind: "local", name: "Laptop", since: null }, organizerState: "held",
    })])).toBeNull();
    expect(nothingOrganizesOf([fact({ id: "a", organizeConsentedAt: T, organizerChecked: false })])).toBeNull();
    expect(nothingOrganizesOf([fact({ id: "a", status: "disabled", organizeConsentedAt: T, organizerReleasedAt: T })])).toBeNull();
    expect(nothingOrganizesOf([fact({ id: "a", organizeConsentedAt: T, organizerReleasedAt: T, organizerParkedAt: T })])).toBeNull();
    // The decision reopen asks the never-agreed reading, which a hand-back is not.
    expect(notOrganizingYetOf([fact({ id: "a", organizeConsentedAt: T, organizerReleasedAt: T })])).toBeNull();
  });

  it("the stand-down the Mailboxes row reads is unchanged for a hand-back, and a pending Organize here keeps it", () => {
    const back = fact({ id: "a", organizeConsentedAt: T, organizerReleasedAt: T });
    expect(readerStandDown(back)).toBe("released");
    expect(readerStandDown({ ...back, takeoverAuthorizedAt: T } as MailboxFacts)).toBe("released");
    expect(readerStandDown({ ...back, organizerChecked: false } as MailboxFacts)).toBe("released");
  });
});

describe("the Screener over a mailbox handed back or whose holder stopped", () => {
  it("says it was handed back, never the screening sentence, and its header is not 'all clear'", async () => {
    const el = await screener(HANDED_BACK);
    expect(text(el)).toContain("You handed this mailbox back.");
    expect(text(el)).toContain(en.screener.notOrganizingWhy);
    expect(text(el), "the screening claim over a mailbox nothing screens").not.toContain(HINT);
    expect(text(el)).not.toContain(en.screener.empty.waiting.title);
    expect(text(el)).not.toContain("all clear");
    expect(text(head(el))).toContain(en.screener.metaHandedBack);
  });

  it("its press opens Mailboxes, where Organize here is, and never the consent statement", async () => {
    const el = await screener(HANDED_BACK);
    expect(pressNamed(el, en.screener.notYetPress)).toHaveLength(0);
    const press = pressNamed(el, en.screener.notOrganizingPress);
    expect(press).toHaveLength(1);
    await act(async () => { press[0]!.click(); });
    await tick(200);
    expect(window.location.hash).toBe("#/settings/mailboxes");
  });

  it("a holder that stopped says nothing organizes the mailbox", async () => {
    const el = await screener(STOPPED);
    expect(text(el)).toContain("Nothing organizes this mailbox.");
    expect(text(el)).not.toContain("all clear");
    expect(text(head(el))).toContain(en.screener.metaNotOrganizing);
  });

  it("a mixed account names the handed-back mailbox beside the screening sentence, never 'all clear'", async () => {
    const el = await screener(organized("mb-1"), {
      ...MIXED, organizeConsentedAt: T, organizerReleasedAt: T,
    });
    expect(text(el)).toContain(HINT);
    expect(within(el).getByText(en.screener.empty.waiting.mixedHint)).toBeTruthy();
    expect(text(el)).toContain(`You handed ${MIXED.address} back`);
    expect(text(el)).not.toContain("all clear");
    expect(text(head(el))).toContain(`not organizing ${MIXED.address}`);
  });
});

