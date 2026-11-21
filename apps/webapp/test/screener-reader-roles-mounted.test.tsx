/** @vitest-environment jsdom */
import { fireEvent, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Fragment, createElement, useLayoutEffect } from "react";
import * as screener from "@ohmail/app/screener";
import { screenerMode, type MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import { screenerIntentsKey, type ScreenerIntent } from "@ohmail/app-logic/screener/screener-intents";
import { COMMIT_MS, type ScreenerState } from "@ohmail/app-logic/screener/screener-state";
import { resetStorageOwnerForTest, setStorageOwner } from "@ohmail/app-logic/storage/storage-owner";
import messages from "../messages/en.json";
import german from "../messages/de.json";
import { screenerReport, screenerRow, selectScreenerRow } from "./fixtures/live-screener";
import {
  act,
  answerSyncWith,
  goTo,
  installShellEnv,
  ISO,
  liveAccountResponse,
  mailbox,
  mountShell,
  page,
  teardownShellEnv,
  tick,
} from "./fixtures/live-walk-shell";

const copy = messages.screener;
const holder = "ohmail Cloud";
const consentedAt = "2026-09-02T09:00:00.000Z";
const heldId = "m1";
const account = "acct_live_1";
const activeJournal = screenerIntentsKey(account);
const otherJournal = screenerIntentsKey("acct_reader_other");
const otherIntent: ScreenerIntent = {
  v: 1,
  id: heldId,
  dest: "reads",
  scope: "sender",
  at: Date.parse(ISO),
  read: false,
  quiet: false,
  derived: true,
  heldIds: [],
  applyRetro: false,
  from: { name: null, address: `${heldId}@example.invalid` },
};
const otherIntents = JSON.stringify([otherIntent]);
const reader = (over: Partial<MailboxFacts> = {}) =>
  mailbox({
    organizerRole: "reader",
    organizedBy: { kind: "cloud", name: holder, since: consentedAt },
    organizeConsentedAt: null,
    lastSyncAt: ISO,
    ...over,
  });

interface Write {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
}

interface RosterOptions {
  readonly locale?: "en" | "de";
  readonly observe?: (model: ScreenerState) => void;
  readonly spam?: boolean;
  readonly applied?: boolean;
}

function observeMountedModel(observe: (model: ScreenerState) => void) {
  const Above = screener.ScreenerAbove;
  function Probe() {
    const model = screener.useScreener();
    useLayoutEffect(() => {
      observe(model);
    }, [model]);
    return null;
  }
  // Read the same provider used by the registered panes, including verbs the reader never offers.
  vi.spyOn(screener, "ScreenerAbove").mockImplementation(({ children, ...props }) =>
    createElement(Above, {
      ...props,
      children: createElement(Fragment, null, createElement(Probe), children),
    }),
  );
}

async function withRoster(
  facts: readonly MailboxFacts[],
  check: (shell: HTMLElement, writes: readonly Write[]) => Promise<void>,
  opts: RosterOptions = {},
) {
  installShellEnv();
  window.localStorage.clear();
  setStorageOwner(account);
  window.localStorage.setItem(otherJournal, otherIntents);
  if (opts.observe) observeMountedModel(opts.observe);
  const waiting = page(1, "ohmail/Screener");
  if (opts.spam) {
    const pageWithSpam = await waiting.json();
    const spam = await page(1, "ohmail/Quarantine").json();
    pageWithSpam.changes.creates.push(...spam.changes.creates);
    pageWithSpam.cursor = spam.cursor;
    answerSyncWith(() => Response.json(pageWithSpam));
  } else answerSyncWith(() => waiting.clone());
  const writes: Write[] = [];
  const read = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname;
    const method = init?.method ?? "GET";
    if (method !== "GET" && /^\/api\/(screener|messages|rules|consent)(\/|$)/.test(path)) {
      writes.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (path === `/api/screener/${heldId}` && method === "POST") {
        if (opts.applied)
          return liveAccountResponse(Response.json({ messageId: heldId, appliedFolder: "INBOX", createdRuleId: "filed-rule" }));
        return liveAccountResponse(new Response(
          JSON.stringify({ pending: true, requestId: "held-by-organizer", holder: { name: holder } }),
          {
            status: 202,
            headers: { "content-type": "application/json" },
          },
        ));
      }
    }
    return read(input, init);
  };
  try {
    const roster = facts.map((row, i) => ({
      ...row,
      id: `mb_${i + 1}`,
      address: `mailbox-${i + 1}@example.invalid`,
    }));
    const shell = await mountShell(roster, { locale: opts.locale, suggestWire: "none", junkWire: "none" });
    await goTo("screener");
    await tick(50);
    await selectScreenerRow(shell, heldId);
    await check(shell, writes);
  } finally {
    await teardownShellEnv();
    resetStorageOwnerForTest();
    window.localStorage.clear();
  }
}

function actions(shell: HTMLElement) {
  return within(within(shell).getByRole("toolbar", { name: copy.place.panel }));
}

function journalUntouched() {
  expect(window.localStorage.getItem(activeJournal)).toBeNull();
  expect(window.localStorage.getItem(otherJournal)).toBe(otherIntents);
}

function named(name: string): string {
  return copy.place.decides.replace("{name}", name);
}

async function blocked(
  facts: readonly MailboxFacts[],
  line: string,
  { oauth = false, nobody = false }: { oauth?: boolean; nobody?: boolean } = {},
) {
  await withRoster(facts, async (shell, writes) => {
    const bar = actions(shell);
    expect(bar.getByText(line)).toBeTruthy();
    expect(bar.getByRole("button", { name: copy.readerBarOpenMailboxes })).toBeTruthy();
    expect(bar.queryByRole("button", { name: copy.pileOhbox })).toBeNull();
    expect(bar.queryByRole("button", { name: copy.pileSpam })).toBeNull();
    if (oauth) expect(within(shell).getByText(copy.oauthDecideElsewhere)).toBeTruthy();
    else expect(within(shell).queryByText(copy.oauthDecideElsewhere)).toBeNull();
    if (nobody) expect(within(shell).getByText(copy.readerBarNoneWhy)).toBeTruthy();
    else expect(within(shell).queryByText(copy.readerBarNoneWhy)).toBeNull();
    expect(within(shell).queryByText(copy.pendingBarWhy)).toBeNull();
    await act(async () => {
      fireEvent.keyDown(document, { key: "o" });
    });
    await tick(COMMIT_MS + 50);
    expect(screenerRow(shell, heldId)?.getAttribute("aria-selected")).toBe("true");
    expect(writes).toEqual([]);
    journalUntouched();
  });
}

describe("screenerMode — what the Screener may do on this install", () => {
  it("a lone reader with a named holder is BLOCKED, and names it", async () => {
    const facts = [reader()];
    expect(screenerMode(facts)).toEqual({
      mode: "blocked",
      name: holder,
      reason: "organizer_outdated",
      oauthOnly: false,
    });
    await blocked(facts, named(holder));
  });

  it("EVERY row a reader answers with the first NAMED holder", async () => {
    const facts = [reader({ organizedBy: { kind: "cloud", name: null, since: null } }), reader()];
    expect(screenerMode(facts).name).toBe(holder);
    await blocked(facts, named(holder));
  });

  it("a reader nobody is NAMED for answers with a null name, never an invented one", async () => {
    const facts = [reader({ organizedBy: { kind: "local", name: null, since: null } })];
    expect(screenerMode(facts)).toEqual({
      mode: "blocked",
      name: null,
      reason: "organizer_outdated",
      oauthOnly: false,
    });
    await blocked(facts, copy.place.decidesUnknown);
  });

  it("a RELEASED mailbox does not organize — this account let it go, so nothing files it", async () => {
    const facts = [
      reader({
        organizedBy: null,
        organizerState: null,
        organizeConsentedAt: consentedAt,
        organizerReleasedAt: "2026-09-04T09:12:00.000Z",
      }),
    ];
    expect(screenerMode(facts)).toEqual({
      mode: "blocked",
      name: null,
      reason: "no_organizer",
      oauthOnly: false,
    });
    await blocked(facts, copy.readerBarNoneTitle, { nobody: true });
  });

  it("a reader whose holder ACCEPTS DECISIONS is pending, not blocked", async () => {
    const facts = [reader({ organizerAcceptsRequests: true })];
    expect(screenerMode(facts)).toEqual({ mode: "pending", name: holder, reason: null, oauthOnly: false });
    await withRoster(facts, async (shell, writes) => {
      const bar = actions(shell);
      expect(bar.getByText(copy.pendingBarTitle.replace("{name}", holder))).toBeTruthy();
      expect(within(shell).getByText(copy.pendingBarWhy)).toBeTruthy();
      expect(bar.queryByRole("button", { name: copy.readerBarOpenMailboxes })).toBeNull();
      expect(writes).toEqual([]);
      journalUntouched();
      await act(async () => {
        bar.getByRole("button", { name: copy.pileOhbox }).click();
      });
      expect(writes).toEqual([]);
      expect(JSON.parse(window.localStorage.getItem(activeJournal) ?? "[]")).toMatchObject([
        { id: heldId, dest: "ohbox", scope: "sender", read: false },
      ]);
      await tick(COMMIT_MS + 50);
      expect(writes).toEqual([
        {
          path: `/api/screener/${heldId}`,
          method: "POST",
          body: { decision: "yes", dest: "INBOX", scope: "sender", applyRetro: false },
        },
      ]);
      const list = within(shell).getByRole("listbox", { name: copy.title });
      expect(within(list).getByText(copy.pendingHeading)).toBeTruthy();
      const queued = within(list).getByRole("group", { name: copy.pendingHeading });
      expect(within(queued).getByRole("option").getAttribute("data-id")).toBe(heldId);
      expect(within(list).getAllByRole("option").filter((row) => row.getAttribute("data-id") === heldId))
        .toEqual([within(queued).getByRole("option")]);
      journalUntouched();
    });
  });

  it("ONE reader that cannot take a decision blocks the whole roster", async () => {
    const facts = [reader({ organizerAcceptsRequests: true }), reader({ organizerAcceptsRequests: false })];
    expect(screenerMode(facts).mode).toBe("blocked");
    await blocked(facts, named(holder));
  });

  it("ABSENT is not `true` — a server that cannot say withholds the controls", async () => {
    const facts = [reader()];
    expect(screenerMode(facts).mode).toBe("blocked");
    await blocked(facts, named(holder));
  });

  it("EVERY reader on OAuth is flagged, so the refusal can be said to be permanent", async () => {
    const facts = [reader({ authKind: "oauth" })];
    expect(screenerMode(facts).oauthOnly).toBe(true);
    await blocked(facts, named(holder), { oauth: true });
  });

  it("…and a MIXED roster is not, because the sentence would be wrong about one of them", async () => {
    const mixed = [reader({ authKind: "oauth" }), reader({ authKind: "password" })];
    expect(screenerMode(mixed).oauthOnly).toBe(false);
    await blocked(mixed, named(holder));
    const older = [reader()];
    expect(screenerMode(older).oauthOnly).toBe(false);
    await blocked(older, named(holder));
  });

  it("a holder whose lease LAPSED (stopped) is `no_organizer`: nothing organizes it, so nothing to update", async () => {
    const stopped = [reader({ organizerState: "stopped", organizeConsentedAt: consentedAt })];
    expect(screenerMode(stopped)).toMatchObject({ mode: "blocked", reason: "no_organizer" });
    await blocked(stopped, copy.readerBarNoneTitle, { nobody: true });
    const mixed = [
      reader({ organizedBy: { kind: "local", name: "Laptop", since: null }, organizerState: "stopped" }),
      reader({ organizedBy: { kind: "local", name: "Office", since: null }, organizerState: "held" }),
    ];
    expect(screenerMode(mixed)).toEqual({
      mode: "blocked",
      name: "Office",
      reason: "organizer_outdated",
      oauthOnly: false,
    });
    await blocked(mixed, named("Office"));
    const unchecked = [reader({ organizerState: null })];
    expect(screenerMode(unchecked).reason).toBe("organizer_outdated");
    await blocked(unchecked, named(holder));
  });

  it("a reader with NO holder at all reports `no_organizer`, which is a different sentence", async () => {
    const facts = [reader({ organizedBy: null, organizeConsentedAt: consentedAt })];
    expect(screenerMode(facts)).toEqual({
      mode: "blocked",
      name: null,
      reason: "no_organizer",
      oauthOnly: false,
    });
    await blocked(facts, copy.readerBarNoneTitle, { nobody: true });
  });
});

const decisionRefusal = copy.readerRefused.replace("{name}", holder);
const moveRefusal = copy.readerMoveRefused.replace("{name}", holder);
const decideOhbox = (model: ScreenerState) =>
  model.decide(model.waiting[0]!, "ohbox", { read: false, scope: "sender" });

async function withModel(
  facts: readonly MailboxFacts[],
  check: (shell: HTMLElement, writes: readonly Write[], model: () => ScreenerState) => Promise<void>,
  opts: Omit<RosterOptions, "observe"> = {},
): Promise<void> {
  let live: ScreenerState | undefined;
  const model = (): ScreenerState => {
    if (live === undefined) throw new Error("The registered Screener model did not mount");
    return live;
  };
  await withRoster(facts, (shell, writes) => check(shell, writes, model), {
    ...opts,
    observe: (current) => {
      live = current;
    },
  });
}

describe("the Screener state refuses every write on a mailbox this install does not organize", () => {
  it("`decide` dispatches NOTHING, journals NOTHING, and does not hide the row", async () => {
    await withModel([reader()], async (shell, writes, model) => {
      expect(model().waiting.map((sender) => sender.id)).toEqual([heldId]);
      await act(async () => {
        decideOhbox(model());
      });
      expect(writes).toEqual([]);
      journalUntouched();
      expect(model().isExiting(heldId)).toBe(false);
      expect(model().waitingCount).toBe(1);
      expect(screenerRow(shell, heldId)?.getAttribute("aria-selected")).toBe("true");
      await tick(COMMIT_MS + 50);
      expect(writes).toEqual([]);
      journalUntouched();
    });
  });

  it("…and it SAYS SO, naming who organizes, in place of 'Ohbox — filed'", async () => {
    await withModel([reader()], async (shell, writes, model) => {
      await act(async () => {
        decideOhbox(model());
      });
      expect(screenerReport()).toBe(decisionRefusal);
      expect(within(shell).queryByRole("button", { name: copy.toastUndo })).toBeNull();
      expect(writes).toEqual([]);
      journalUntouched();
    });
  });

  it("a holder with no NAME gets the legacy sentence, never an invented machine name", async () => {
    const unnamed = reader({ organizedBy: { kind: "cloud", name: null, since: consentedAt } });
    await withModel([unnamed], async (_shell, writes, model) => {
      await act(async () => {
        model().decide(model().waiting[0]!, "spam", { read: false, scope: "sender" });
      });
      expect(screenerReport()).toBe(copy.readerRefusedUnknown);
      expect(screenerReport()).not.toContain("{name}");
      expect(writes).toEqual([]);
      journalUntouched();
    });
  });

  it("the refusal is TRANSLATED — German gets German, not the English fallback", async () => {
    await withModel(
      [reader()],
      async (_shell, writes, model) => {
        await act(async () => {
          decideOhbox(model());
        });
        expect(screenerReport()).toBe(german.screener.readerRefused.replace("{name}", holder));
        expect(screenerReport()).not.toBe(decisionRefusal);
        expect(writes).toEqual([]);
        journalUntouched();
      },
      { locale: "de" },
    );
  });

  it("EVERY writing verb is behind the wall — the exact set", async () => {
    await withModel(
      [reader()],
      async (_shell, writes, model) => {
        const waiting = model().waiting[0]!;
        const spam = model().spam[0];
        expect(waiting.id).toBe(heldId);
        expect(spam?.sender.id).toBe("m2");
        const presses: Array<[string, () => void, string]> = [
          ["decide", () => decideOhbox(model()), decisionRefusal],
          ["applyAll", () => model().applyAll(() => "sender"), decisionRefusal],
          ["markAllSpam", () => model().markAllSpam(() => "sender"), decisionRefusal],
          ["allowScreened", () => model().allowScreened(waiting, "ohbox"), moveRefusal],
          ["notSpamToWaiting", () => model().notSpamToWaiting(spam!), moveRefusal],
          ["notSpamToOhbox", () => model().notSpamToOhbox(spam!), moveRefusal],
          ["deleteSpam", () => model().deleteSpam(spam!), moveRefusal],
        ];
        for (const [name, press, expected] of presses) {
          expect(screenerReport(), `${name} would read a previous report`).toBe("");
          await act(async () => {
            press();
          });
          expect(screenerReport(), `${name} raised the wrong refusal`).toBe(expected);
          await tick(3_500);
        }
        await tick(60_000);
        expect(writes).toEqual([]);
        journalUntouched();
        expect(model().waiting.map((sender) => sender.id)).toEqual([heldId]);
        expect(model().spam.map((row) => row.sender.id)).toEqual(["m2"]);
      },
      { spam: true },
    );
  });

  it("CONTROL: with no holder, every one of those verbs works exactly as before", async () => {
    const organizer = mailbox({
      organizerRole: "organizer",
      organizeConsentedAt: consentedAt,
      lastSyncAt: ISO,
    });
    await withModel(
      [organizer],
      async (shell, writes, model) => {
        expect(model().role.mode).toBe("organizer");
        const file = () => actions(shell).getByRole("button", { name: copy.pileOhbox }).click();
        await act(async () => {
          file();
        });
        expect(model().isExiting(heldId)).toBe(true);
        expect(JSON.parse(window.localStorage.getItem(activeJournal) ?? "[]")).toMatchObject([
          { id: heldId, dest: "ohbox", scope: "sender", read: false },
        ]);
        expect(writes).toEqual([]);
        await act(async () => {
          fireEvent.keyDown(document, { key: "z" });
        });
        expect(model().isExiting(heldId)).toBe(false);
        expect(screenerRow(shell, heldId)).toBeTruthy();
        journalUntouched();
        await tick(COMMIT_MS + 50);
        expect(writes).toEqual([]);

        await selectScreenerRow(shell, heldId);
        await act(async () => {
          file();
        });
        await tick(COMMIT_MS + 50);
        expect(writes).toEqual([
          {
            path: `/api/screener/${heldId}`,
            method: "POST",
            body: { decision: "yes", dest: "INBOX", scope: "sender", applyRetro: false },
          },
        ]);
        journalUntouched();
      },
      { applied: true },
    );
  });
});
