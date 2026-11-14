/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { FirstRun } from "../app/shell/FirstRun";
import { KeymapProvider } from "../app/shell/keymap";
import {
  accountOrganizer, firstRunCounts, screenerForMailbox,
} from "@ohmail/app-logic/doors/first-run-subject";
import type { FirstRunHost } from "@ohmail/app-logic/doors/first-run-host";
import type { OnboardingFacts } from "@ohmail/app-logic/doors/onboarding";

/**
 * ═══ THE NUMBERS AND THE SENTENCE ARE ABOUT THIS MAILBOX ═══════════════════════════════════
 *
 * ── THE COUNTERS (FIRSTRUN-COUNTS-ARE-THE-INSTALL'S) ───────────────────────────────────────
 *
 * The pull screen's "Screened so far" and "Listed under History", and the two summary rows fed by
 * the same pair, were the INSTALL's: the mirror's whole row count minus the whole History list,
 * handed to a run whose own truth-condition is one mailbox's `initialImportCompletedAt`. So the
 * second mailbox's setup printed the first's work as its own — usually reading "already finished"
 * seconds after the create — and the summary then reported that work as this mailbox's.
 *
 * The fixture is two mailboxes whose numbers DIFFER in both directions. One where they agree
 * measures alignment, not the property.
 *
 * ── THE DOOR (FIRSTRUN-DOOR-READER-UNANNOUNCED) ────────────────────────────────────────────
 *
 * A mailbox connected from this door while something else organizes the account starts as a
 * READER — reads, searches, sends, moves nothing — and the only surface that said so was
 * Settings → Mailboxes, which nobody setting up a mailbox has a reason to open. Read off the
 * RENDERED form, never off a comment.
 *
 * MUTATIONS WATCHED RED, RESTORED BY `cmp`:
 *  · `firstRunCounts`'s per-mailbox filter → the install's totals   → the counter cases;
 *  · the door's banner dropped from the connect form                 → the door cases.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const t = messages.onboarding;

/** Two mailboxes, and the mirror they share. Mailbox two is the newcomer. */
const MIRROR = [
  ...Array.from({ length: 900 }, () => ({ mailboxId: "mb-1" })),
  ...Array.from({ length: 12 }, () => ({ mailboxId: "mb-2" })),
];
const HISTORY = [
  ...Array.from({ length: 140 }, () => ({ mailboxId: "mb-1" })),
  ...Array.from({ length: 3 }, () => ({ mailboxId: "mb-2" })),
];
/** What the mount handed every run, whichever mailbox it was about. */
const INSTALL_WIDE = {
  screened: MIRROR.length - HISTORY.length, history: HISTORY.length,
};

/** Consented, connected, import still running — `deriveOnboardingStep` row 7, "pull". */
const midImport = (): OnboardingFacts => ({
  door: "local",
  mailbox: {
    organizerRole: "organizer",
    organizedBy: null,
    organizerState: null,
    organizeConsentedAt: "2026-09-16T10:00:00.000Z",
    initialImportCompletedAt: null,
  },
  account: { onboardingCompletedAt: null },
  ai: "on",
  queuedSenders: 0,
});

const roots: Root[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) r.unmount();
  document.body.innerHTML = "";
});

async function mount(o: {
  facts: OnboardingFacts;
  pull?: { screened: number; history: number; pulled: number };
  accountOrganizer?: { kind: string | null; name: string | null } | null;
  add?: boolean;
}): Promise<HTMLElement> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);

  const host: FirstRunHost = {
    door: o.facts.door,
    ai: o.facts.ai,
    probe: async () => ({ host: "h", user: "u", folders: 1 }),
    connect: async () => ({ id: "mb-2" }),
    organize: async () => "stored",
    complete: async () => {},
    probeReason: () => null,
    probeMessage: () => null,
  };

  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(KeymapProvider, {
        children: h(FirstRun, {
          host,
          facts: o.facts,
          onRefresh: () => {},
          onLeave: () => {},
          pull: o.pull ?? { screened: 0, history: 0, pulled: 0 },
          decide: null,
          mailboxId: "mb-2",
          ...(o.accountOrganizer !== undefined ? { accountOrganizer: o.accountOrganizer } : {}),
          ...(o.add ? { add: true } : {}),
        }),
      }),
    }));
  });
  return el;
}

const said = (el: HTMLElement) => (el.textContent ?? "").replace(/\s+/g, " ");
const counters = (el: HTMLElement) => [...el.querySelectorAll(".ob-counter b")]
  .map((b) => (b.textContent ?? "").trim());

describe("the pull screen counts THIS mailbox", () => {
  it("THE FIXTURE DIFFERS — the two mailboxes and the install disagree, or this measures nothing", () => {
    const mine = firstRunCounts(MIRROR, HISTORY, "mb-2");
    const other = firstRunCounts(MIRROR, HISTORY, "mb-1");
    expect(mine).not.toEqual(other);
    expect(mine.screened).not.toBe(INSTALL_WIDE.screened);
    expect(mine.history).not.toBe(INSTALL_WIDE.history);
  });

  it("prints the new mailbox's numbers, not the install's", async () => {
    const mine = firstRunCounts(MIRROR, HISTORY, "mb-2");
    const el = await mount({
      facts: midImport(), pull: { ...mine, pulled: mine.screened + mine.history },
    });
    expect(said(el)).toContain(t.pullTitle);
    expect(counters(el)).toEqual([
      mine.screened.toLocaleString("en-US"), mine.history.toLocaleString("en-US"),
    ]);
    // And the install's numbers are nowhere on the screen that names one mailbox.
    expect(counters(el)).not.toContain(INSTALL_WIDE.screened.toLocaleString("en-US"));
    expect(counters(el)).not.toContain(INSTALL_WIDE.history.toLocaleString("en-US"));
  });

  it("the basis sentence says whose mail it is, on the rendered screen", async () => {
    const el = await mount({ facts: midImport(), pull: { screened: 9, history: 3, pulled: 12 } });
    const basis = el.querySelector(".ob-basis");
    expect(basis).not.toBeNull();
    const line = (basis!.textContent ?? "").replace(/\s+/g, " ");
    expect(line).toContain("this mailbox's mail");
    expect(line).toContain("on this device");
  });

  it("the summary reports the same pair — one wrong number, two wrong screens", async () => {
    const mine = firstRunCounts(MIRROR, HISTORY, "mb-2");
    const done = midImport();
    done.mailbox!.initialImportCompletedAt = "2026-09-16T12:00:00.000Z";
    const el = await mount({
      facts: done, pull: { ...mine, pulled: mine.screened + mine.history },
    });
    // The summary's own two rows, read as rendered — the same pair the pull screen printed.
    expect(said(el)).toContain(`${mine.screened} messages screened`);
    expect(said(el)).toContain(`${mine.history} messages listed under History`);
    // And never the install's, which is what those rows used to report as this mailbox's work.
    expect(said(el)).not.toContain(`${INSTALL_WIDE.screened} messages screened`);
  });
});

describe("the door says what the connection will be", () => {
  /** An add run, before its create: the connect form, on an account Cloud organizes. */
  const atTheDoor = (): OnboardingFacts => ({ ...midImport(), mailbox: null });

  it("names the holder and says the new mailbox reads", async () => {
    const el = await mount({
      facts: atTheDoor(), add: true,
      accountOrganizer: { kind: "cloud", name: "ohmail Cloud" },
    });
    // The form, or this case is about another screen.
    expect(el.querySelector("input[type=email]")).not.toBeNull();
    expect(said(el)).toContain(t.doorReader);
    expect(said(el)).toContain("ohmail Cloud");
    expect(said(el)).toContain("it moves nothing and screens nothing");
  });

  it("a holder with no name gets the legacy sentence, never an invented one", async () => {
    const el = await mount({
      facts: atTheDoor(), add: true, accountOrganizer: { kind: "desktop", name: null },
    });
    expect(said(el)).toContain(t.doorReaderWhyLegacy);
    expect(said(el)).not.toContain(t.doorReaderWhy.slice(0, 12));
  });

  it("POSITIVE CONTROL — with nobody organizing anything the door says nothing extra", async () => {
    const el = await mount({ facts: atTheDoor(), add: true, accountOrganizer: null });
    expect(el.querySelector("input[type=email]")).not.toBeNull();
    expect(said(el)).not.toContain(t.doorReader);
  });

  it("a holder whose lease lapsed organizes nothing: the door says nothing extra (the decider)", async () => {
    const row = { organizedBy: { kind: "local", name: "Studio laptop" }, organizerState: "stopped" as const };
    const el = await mount({ facts: atTheDoor(), add: true, accountOrganizer: accountOrganizer([row]) });
    expect(el.querySelector("input[type=email]")).not.toBeNull();
    expect(said(el), "a machine that stopped was called this account's organizer").not.toContain(t.doorReader);
    expect(said(el)).not.toContain("Studio laptop");
  });

  it("CONTROL — the same holder still renewing is named at the door", async () => {
    const row = { organizedBy: { kind: "local", name: "Studio laptop" }, organizerState: "held" as const };
    const el = await mount({ facts: atTheDoor(), add: true, accountOrganizer: accountOrganizer([row]) });
    expect(said(el)).toContain(t.doorReaderWhy.replace("{name}", "Studio laptop"));
  });

  it("and the holder it reads is the account's own, by the derivation's rule", () => {
    // `{null,null,null}` names nobody — the object's presence is not the condition.
    expect(accountOrganizer([{ organizedBy: { kind: null, name: null } }])).toBeNull();
    expect(accountOrganizer([
      { organizedBy: null }, { organizedBy: { kind: "cloud", name: "ohmail Cloud" } },
    ])).toEqual({ kind: "cloud", name: "ohmail Cloud" });
  });
});

describe("the guided decision is about a sender who wrote HERE", () => {
  const rows = [
    { id: "m-a", held: [{ id: "m-a" }] },
    { id: "m-b", held: [{ id: "m-b" }] },
    { id: "m-c", held: [{ id: "m-c" }] },
  ];
  const mailboxOf = (id: string) => (
    { "m-a": "mb-1", "m-b": "mb-2", "m-c": "mb-1" } as Record<string, string>
  )[id];

  it("on a two-mailbox install the head of the queue is this mailbox's", () => {
    const mine = screenerForMailbox(rows, mailboxOf, "mb-2", true);
    expect(mine.map((r) => r.id)).toEqual(["m-b"]);
    // What the flow used to ask about: whoever was first, whichever mailbox they wrote to.
    expect(rows[0]!.id).toBe("m-a");
  });

  it("on a ONE-mailbox install nothing is filtered — no lookup can cost a row", () => {
    expect(screenerForMailbox(rows, () => undefined, "mb-1", false)).toHaveLength(3);
  });

  it("a row the mirror cannot place is left out rather than claimed", () => {
    expect(screenerForMailbox(rows, () => undefined, "mb-2", true)).toEqual([]);
  });

  it("with no mailbox to be about, a multi-mailbox install claims no sender at all", () => {
    expect(screenerForMailbox(rows, mailboxOf, null, true)).toEqual([]);
  });
});
