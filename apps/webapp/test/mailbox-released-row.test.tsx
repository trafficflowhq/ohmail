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
 * ═══ A MAILBOX YOU RELEASED SAYS SO, AND OFFERS THE ONE PRESS THAT UNDOES IT ═══════════════
 *
 * ── THE DEFECT, MEASURED LIVE 2026-09-04 ────────────────────────────────────────────────────
 *
 * `POST /mailboxes/:id/release` completed on the hosted service and the worker's next pass landed
 * it. `GET /mailboxes/:id` then reported the row this file's fixture copies: `organizerRole:
 * "reader"`, `organizedBy: null`, `organizerState: null`, `organizerReleasedAt` stamped,
 * `organizeConsentedAt` still set.
 *
 * Settings → Mailboxes rendered, over that row, in both languages:
 *
 *   **"Another ohmail organizer has claimed this mailbox … it will not start again on its own"**
 *
 * followed by the check-then-confirm takeover ceremony — a control written for displacing a LIVE
 * competing install. Pressing its first step opened a connection, read the claim folder, and
 * answered **"No other ohmail install is organizing this mailbox."** The row was arguing with its
 * own button, about a mailbox nobody held, and the person who had just released it on purpose was
 * being told a stranger had taken it.
 *
 * The transient notice above the Ohbox said "You stopped organizing … here" for the SAME row at
 * the SAME instant, from `organizerNotices`, so the fact was never in doubt — only this surface
 * had no branch for it.
 *
 * ── WHAT IS PINNED HERE ─────────────────────────────────────────────────────────────────────
 *
 * The RENDER, not the derivation: `reader-stand-down.test.ts` owns what `readerStandDown`
 * answers, including why the release is keyed on the marker and not on the absent holder. This
 * file is the other half — that the answer reaches the screen as the released sentence and one
 * plain press, and that neither half of the takeover ceremony is drawn beside it. Both languages,
 * because a branch resolved in one catalogue and not the other renders the key path.
 *
 * ── HOW TO WATCH THESE FAIL ─────────────────────────────────────────────────────────────────
 *
 *  · delete the `standDown === "released"` arm from `MailboxSection.tsx` → every case here goes
 *    red, with the "claimed this mailbox" sentence and `organizerCheck` back on the row;
 *  · make the released arm in `readerStandDown` return `"organized_elsewhere_unknown"` again →
 *    the same, which is the production defect exactly.
 */

const copy = en.mailboxes as unknown as Record<string, string>;
const copyDe = (de as unknown as { mailboxes: Record<string, string> }).mailboxes;

/**
 * The fixed half of an interpolated sentence, read out of the catalogue rather than restated.
 *
 * The whole sentence with `{when}` merely deleted does NOT appear on screen — "You stopped
 * organizing this here on ." is not what renders, and a `.toContain` of it fails while a
 * `.not.toContain` of it passes over any row at all, which is a guard that checks nothing. The
 * text BEFORE the placeholder is the longest fragment that is genuinely on the page in every
 * language: English continues after it and German continues after it with different words.
 */
const before = (sentence: string): string => sentence.slice(0, sentence.indexOf("{when}"));
const RELEASED_EN = before(copy.stateReleased!);
const RELEASED_DE = before(copyDe.stateReleased!);

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const QUIET: MailState = {
  mailboxes: null, mirrored: 0, freshness: { state: "unknown", asOf: null },
} as unknown as MailState;

const healthy = { status: "active", plan: "pro", credits: 100 } as unknown as SubscriptionStatus;

let mockListed: MailboxDTO[] = [];
/** Every id `POST /mailboxes/:id/organize` was asked for — the press this row's button makes. */
let mockOrganizeCalls: string[] = [];
/** And every id the CHECK was asked for, which on a released row must stay empty. */
let mockPeekCalls: string[] = [];

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
      organizer: async (id: string) => {
        mockPeekCalls.push(id);
        return { holders: [], unreadable: 0 };
      },
      organize: async (id: string) => {
        mockOrganizeCalls.push(id);
        return { outcome: "authorized" };
      },
    },
  };
});

vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ state: QUIET, refresh: () => {} }),
}));

/** The production row, field for field. */
const released = (over: Partial<MailboxDTO> = {}): MailboxDTO => ({
  id: "mb1", provider: "icloud", address: "person@example.test",
  displayName: null, status: "connected",
  lastSyncAt: "2026-09-04T09:20:00.000Z", createdAt: "2026-08-01T10:00:00.000Z",
  organizerRole: "reader",
  organizedBy: null,
  organizerState: null,
  organizeConsentedAt: "2026-08-01T10:05:00.000Z",
  organizerReleasedAt: "2026-09-04T09:12:00.000Z",
  ...over,
} as MailboxDTO);

/** The same row while somebody else genuinely holds it — the control for every case below. */
const stoodDown = (over: Partial<MailboxDTO> = {}): MailboxDTO => released({
  organizedBy: { kind: "local", name: "a laptop", since: "2026-09-01T08:00:00.000Z" },
  organizerState: "held",
  organizerReleasedAt: null,
  ...over,
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
      locale,
      messages: (locale === "en" ? en : de) as never,
      children: h(MailboxSection),
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

beforeEach(() => {
  mockListed = [];
  mockOrganizeCalls = [];
  mockPeekCalls = [];
});
afterEach(async () => { await unmount(); });

describe("the row says what happened, in the second person", () => {
  it("names the release and the day it happened", async () => {
    const el = await mount("en", released());
    const said = el.textContent ?? "";
    // The catalogue's own sentence, up to the date — read out of `en.json` rather than restated,
    // so re-wording it does not quietly stop this from checking anything.
    expect(said, "the row does not say the mailbox was released here").toContain(RELEASED_EN);
    // `dayStamp` renders a DATE and no clock. The month is enough to pin that it is a real
    // formatted date rather than the raw instant or an em dash.
    expect(said, "the release has no date on it").toMatch(/Sep(tember)? 2026|2026/);
    expect(said, "the raw instant reached the screen").not.toContain("2026-09-04T09:12:00.000Z");
    expect(said, "the date rendered as the unparseable placeholder").not.toContain("on —");
  });

  it("does NOT say another organizer claimed it", async () => {
    const el = await mount("en", released());
    const said = el.textContent ?? "";
    // The production sentence, and the reason this file exists.
    expect(said, "the released row still claims somebody else took the mailbox")
      .not.toContain(copy.standDown_organized_elsewhere_unknown!);
    expect(said).not.toContain(copy.standDown_organized_elsewhere_cloud!);
    expect(said).not.toContain(copy.standDown_organized_elsewhere_local!);
  });

  it("is not styled as a failure — nothing here is broken", async () => {
    const el = await mount("en", released());
    const alarmed = [...el.querySelectorAll(".mbx-bad")].map((n) => n.textContent ?? "");
    expect(alarmed.join(" "), "a deliberate release was drawn as an error")
      .not.toContain(RELEASED_EN);
  });
});

describe("the remedy is one press, not the takeover ceremony", () => {
  it("offers Organize here and neither step of the check-then-confirm", async () => {
    const el = await mount("en", released());
    expect(button(el, copy.organizeHere!), "the released row offers no way back").toBeTruthy();
    expect(button(el, copy.organizerCheck!), "the check is for displacing a live holder").toBeNull();
    expect(el.textContent ?? "", "the row still explains a ceremony it does not run")
      .not.toContain(copy.standDownHow!);
  });

  it("the press authorizes the takeover directly, and peeks at nothing", async () => {
    const el = await mount("en", released());
    await click(button(el, copy.organizeHere!)!);
    expect(mockOrganizeCalls, "the press did not ask for the mailbox").toEqual(["mb1"]);
    /* THE PEEK IS THE POINT OF THE ASSERTION, not a detail. The check opens an IMAP connection to
       read who holds the mailbox; on a released row the answer is known before it is asked, and
       the ceremony's own copy would then describe displacing an install that does not exist. */
    expect(mockPeekCalls, "the released row opened a connection to ask who holds it").toEqual([]);
  });

  it("THE PRESS IS SPENT — a second one cannot authorize the same takeover again", async () => {
    /* The row does NOT move when the press lands: the worker changes the role on its next pass,
       up to a minute later, and the poll brings it back after that. So the sentence and the button
       both sit there beside the "asked for" answer, and without a guard a second press fires
       another authorization for a mailbox already asked for. Every other write on this pane
       collapses after one press — the ceremony's confirm lives in a panel that is removed on the
       way out, and the check carries its own `disabled` — so this was the one control that
       survived itself.

       Watch it fail: drop `disabled={takingOver.has(m.id)}` and the second press lands, giving
       two ids. */
    const el = await mount("en", released());
    const press = button(el, copy.organizeHere!)!;
    await click(press);
    expect(mockOrganizeCalls).toEqual(["mb1"]);
    await click(press);
    expect(mockOrganizeCalls, "the spent press authorized the takeover twice").toEqual(["mb1"]);
  });

  it("and the answer under it is the queued sentence, not a claim it is done", async () => {
    const el = await mount("en", released());
    await click(button(el, copy.organizeHere!)!);
    // The worker decides on its next pass; the copy has always said so and must keep saying so.
    expect(el.textContent ?? "").toContain(copy.organizerQueued!);
  });
});

describe("THE CONTROL — a row somebody else really holds keeps the ceremony", () => {
  it("a stood-down row still checks before it confirms", async () => {
    const el = await mount("en", stoodDown());
    const said = el.textContent ?? "";
    expect(said, "a genuine stand-down lost its explanation")
      .toContain(copy.standDown_organized_elsewhere_local!);
    expect(button(el, copy.organizerCheck!), "a live holder is displaced without a check")
      .toBeTruthy();
    expect(button(el, copy.organizeHere!), "the released row's plain press reached a held mailbox")
      .toBeNull();
    expect(said).not.toContain(RELEASED_EN);
  });

  it("…and a holder that decayed to nothing WITHOUT a release marker keeps it too", async () => {
    /* The case the marker exists to tell apart. The per-cycle peek writes all four holder columns
       NULL when it finds an empty claim folder, so a genuine stand-down takes this shape on its
       own once the install that won is removed — with nobody having released anything. Saying
       "you stopped organizing this here" over it would be a false claim about the person's own
       act, which is the mirror of the defect this file closes. */
    const el = await mount("en", stoodDown({ organizedBy: null, organizerState: null }));
    const said = el.textContent ?? "";
    expect(said, "a decayed stand-down was reported as a release you performed")
      .not.toContain(RELEASED_EN);
    /* Nothing is named, so nothing organizes it — the refusal's own decider (`holderIsLive`), and
       the sentence it takes; "another organizer has claimed" was false once the folder emptied. */
    expect(said).toContain(copy.standDownLapsed!);
    expect(said).not.toContain(copy.standDown_organized_elsewhere_unknown!);
    expect(button(el, copy.organizerCheck!), "the check went with the sentence").toBeTruthy();
  });
});

describe("a mailbox the wall paused says so, and offers nothing (mail 0135)", () => {
  // The park's own row: the release stamp and the marker at one instant.
  const parked = (): MailboxDTO => released({ organizerParkedAt: "2026-09-04T09:12:00.000Z" });

  for (const locale of ["en", "de"] as const) {
    it(`${locale}: the paused sentence, and neither the release nor its press`, async () => {
      const el = await mount(locale, parked());
      const words = locale === "en" ? copy : copyDe;
      const said = el.textContent ?? "";
      expect(said, "the paused row has no sentence").toContain(words.stateParked!);
      expect(said, "the paused row says the person stopped it").not.toContain(locale === "en" ? RELEASED_EN : RELEASED_DE);
      expect(button(el, words.organizeHere!), "a press over a mailbox that resumes on its own").toBeNull();
      expect(said).not.toMatch(/\bmailboxes\.[a-zA-Z]/);
    });
  }

  it("CONTROL: the marker null keeps the release and its press", async () => {
    const el = await mount("en", released({ organizerParkedAt: null }));
    expect(el.textContent ?? "").toContain(RELEASED_EN);
    expect(el.textContent ?? "").not.toContain(copy.stateParked!);
    expect(button(el, copy.organizeHere!)).toBeTruthy();
  });
});

describe("both languages resolve, so neither renders a key path", () => {
  it("German draws the released sentence and the press", async () => {
    const el = await mount("de", released());
    const said = el.textContent ?? "";
    expect(said).toContain(RELEASED_DE);
    expect(button(el, copyDe.organizeHere!), "the German row offers no way back").toBeTruthy();
  });

  /* A MISSING KEY RENDERS ITS OWN PATH in this stack ("mailboxes.stateReleased"), which is a
     sentence nobody can read and a defect no snapshot of English would ever show. Asserted over
     the whole pane rather than one node, so a key missed anywhere in the released branch — the
     sentence, the button, the answer under it — is caught by one case per language. */
  for (const locale of ["en", "de"] as const) {
    it(`${locale}: no key path reaches the screen`, async () => {
      const el = await mount(locale, released());
      await click(button(el, (locale === "en" ? copy : copyDe).organizeHere!)!);
      const said = el.textContent ?? "";
      expect(said, "an unresolved message key rendered as its own path")
        .not.toMatch(/\bmailboxes\.[a-zA-Z]/);
      expect(said).not.toContain("MISSING_MESSAGE");
    });
  }
});
