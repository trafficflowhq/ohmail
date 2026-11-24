/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { chromium, pageOf } from "../../../packages/app/test/support/browser-page";
import { fireEvent, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AWAY_ANSWERABLE_PILES, AWAY_PILE_VIEW, type AwayPile } from "@ohmail/app-logic/away";
import * as awaySettings from "@ohmail/app/settings/away";
import messages from "../messages/en.json";
import {
  act, installConfirmEnv, ISO, mountCloudShell, refresh204, rememberOwner, scriptRefresh, scriptSession,
  sessionEnrollment, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

type AwayRow = Awaited<ReturnType<import("@ohmail/app/host").AwayWire["state"]>>;
let stored: AwayRow & { piles: AwayPile[] };
let reads: number;
let writes: number;
let host: HTMLElement;

beforeAll(warmCloudShell);
beforeEach(() => {
  stored = {
    enabled: false, body: null, startsAt: null, endsAt: null,
    audience: "screened_in", throttle: "per_day", piles: ["INBOX"], updatedAt: null,
  };
  reads = 0;
  writes = 0;
});
afterEach(async () => {
  await teardownConfirmEnv();
  window.history.replaceState(null, "", "/");
});

const ui = () => within(host);
const notice = () => ui().queryAllByRole("status").find(
  (status) => status.textContent?.startsWith("Away responder is on"),
) ?? null;

async function click(control: HTMLElement) {
  await act(async () => { fireEvent.click(control); });
  await tick(0);
}

async function surfaceNotice() {
  if (notice()) return;
  const more = ui().queryByRole("button", { name: /more notices?$/ });
  if (!more) return;
  await click(more);
  const away = ui().queryByRole("menuitem", { name: /^Away responder is on/ });
  if (away) await click(away);
  else await act(async () => { fireEvent.keyDown(more, { key: "Escape" }); });
}

async function mount({ active, withRow = false, demo = false, firstRead, hydration }: {
  active: boolean; withRow?: boolean; demo?: boolean; firstRead?: Promise<Response>; hydration?: Parameters<typeof mountCloudShell>[1];
}) {
  installConfirmEnv();
  rememberOwner();
  scriptRefresh(refresh204);
  scriptSession(active ? sessionFull : sessionEnrollment);
  const cloud = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), window.location.origin).pathname;
    if (path === "/api/away-responder") {
      if (init?.method === "PUT") {
        writes++;
        stored = { ...JSON.parse(String(init.body)), updatedAt: ISO };
      } else {
        reads++;
        if (reads === 1 && firstRead) return firstRead;
      }
      return Response.json(stored);
    }
    if (path === "/api/mailboxes") {
      return Response.json({ items: [{
        id: "mb-1", address: ["mailbox", "example.invalid"].join("@"), status: "connected",
        organizerRole: "organizer", initialImportCompletedAt: ISO, organizeConsentedAt: ISO,
        lastSyncAt: ISO, createdAt: ISO,
      }] });
    }
    return cloud(input, init);
  };
  const hash = withRow ? "#/settings/away" : "#/ohbox";
  window.history.replaceState(null, "", demo ? `/?demo=1${hash}` : `/${hash}`);
  host = await mountCloudShell(undefined, hydration);
  await tick(3000);
  if (!demo) await surfaceNotice();
}

const pane = () => within(ui().getByRole("region", { name: messages.settings.away }));
const openSettings = async () => {
  await surfaceNotice();
  await click(within(notice()!).getByRole("button", { name: messages.away.noticeSettings }));
  await tick(3000);
};

async function returnToOhbox() {
  await act(async () => { window.location.hash = "#/ohbox"; });
  await tick(3000);
  await surfaceNotice();
}

const save = async () => {
  await click(pane().getAllByRole("button", { name: messages.away.save })[0]!);
  await surfaceNotice();
};

describe("the away responder's Ohbox notice", () => {
  it("responder ON → one quiet line in the Ohbox, naming the narrow audience", async () => {
    stored.enabled = true;
    stored.audience = "screened_in";
    await mount({ active: true });
    const el = notice();
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain("Away responder is on");
    // The audience is part of the claim: `screened_in` answers only senders already let in.
    expect(el!.textContent).toContain("let in");
    expect(el!.textContent).not.toContain("Everyone");
  });

  it("responder ON for EVERYONE → the sentence widens with the audience", async () => {
    stored.enabled = true;
    stored.audience = "everyone";
    await mount({ active: true });
    const el = notice();
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain("Away responder is on");
    expect(el!.textContent).toContain("veryone who writes");
  });

  /**
   * THE RATE IS THE SECOND HALF OF THE CLAIM, and it is asserted per member rather than once.
   *
   * The notice is ONE ICU message with two `select`s, so the failure this covers is specific to
   * that shape: an arm whose label is wrong, or missing (which ICU resolves to `other` — the
   * once-a-day sentence) is a line that describes a responder behaving differently from the one
   * that is running. `per_week` reading as "at most once a day" would be the notice quietly
   * understating how often a stranger hears from this address by a factor of seven.
   *
   * Both selects are exercised together in the last case, because their arms are interpolated into
   * one sentence and a template that renders each correctly in isolation can still produce a
   * mangled combination.
   */
  it("each throttle names its own rate in the notice — every arm of the select", async () => {
    const rates: ReadonlyArray<[typeof stored.throttle, string]> = [
      ["always", "every message"],
      ["per_message", "until you change the text"],
      ["per_day", "at most once a day"],
      ["per_week", "at most once a week"],
    ];
    for (const [throttle, sentence] of rates) {
      stored.enabled = true;
      stored.audience = "screened_in";
      stored.throttle = throttle;
      await mount({ active: true });
      const el = notice();
      expect(el, `throttle=${throttle} rendered no notice`).not.toBeNull();
      expect(el!.textContent, `throttle=${throttle}`).toContain(sentence);
      await teardownConfirmEnv();
    }
  });

  it("the widened audience and the loosest rate compose into one sentence", async () => {
    stored.enabled = true;
    stored.audience = "everyone";
    stored.throttle = "always";
    await mount({ active: true });
    const el = notice();
    expect(el).not.toBeNull();
    // One sentence, both variable parts resolved — not a fragment and not a leftover `{throttle}`.
    expect(el!.textContent).toContain("everyone who writes");
    expect(el!.textContent).toContain("every message");
    expect(el!.textContent).not.toContain("{");
  });

  /* ══════════════════════════════════════════════════════════════════════════════════════════
     THE SCOPE IS THE THIRD HALF OF THE CLAIM (0.16 owner feedback item 4)
     ══════════════════════════════════════════════════════════════════════════════════════════

     What was reported: a banner reading "people you've let in get a reply at most once a day"
     over a responder that had answered eight shop and notification senders. Every word of it was
     true and it still did not describe what was happening, because the sentence named WHO and the
     surprise was WHICH MAIL. So the scope is in the sentence now, and these cases are what stop
     it from being decoration: the wrong scope word is a claim about mail leaving somebody's
     account, and it is the kind that reads perfectly.
     ══════════════════════════════════════════════════════════════════════════════════════════ */

  it("the DEFAULT scope names the Ohbox — the sentence the reported banner was missing", async () => {
    stored.enabled = true;
    stored.audience = "screened_in";
    stored.throttle = "per_day";
    stored.piles = ["INBOX"];
    await mount({ active: true });
    const el = notice();
    expect(el).not.toBeNull();
    // The whole sentence, assembled — four interpolations and no leftover placeholder.
    expect(el!.textContent).toContain(
      "Away responder is on — people you've let in whose mail lands in Ohbox get a reply at most "
      + "once a day.",
    );
  });

  it("News opted in widens the scope clause, and only the scope clause", async () => {
    stored.enabled = true;
    stored.piles = ["INBOX", "ohmail/News"];
    await mount({ active: true });
    const el = notice();
    expect(el!.textContent).toContain("whose mail lands in Ohbox or in News");
    expect(el!.textContent).toContain("at most once a day");
    expect(el!.textContent).toContain("let in");
  });

  it("News WITHOUT the Ohbox says News, and does not claim the Ohbox is answered", async () => {
    // Reachable through the API rather than the control, and the reason the clause is a LIST of
    // what is answered: a fixed sentence would name a pile that is NOT being answered.
    stored.enabled = true;
    stored.piles = ["ohmail/News"];
    await mount({ active: true });
    const el = notice();
    expect(el!.textContent).toContain("whose mail lands in News");
    expect(el!.textContent).not.toContain("Ohbox");
  });

  /**
   * A RESPONDER ANSWERING NOBODY GETS ITS OWN SENTENCE. Given a `none` arm inside the main
   * sentence, every wording that fits its grammar is false — naming a pile claims replies are
   * going out, and an empty clause claims it more quietly by leaving the scope unsaid.
   */
  it("an EMPTY scope says nothing is sent, and never names a pile", async () => {
    stored.enabled = true;
    stored.piles = [];
    await mount({ active: true });
    const el = notice();
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain("no pile is set to get a reply");
    expect(el!.textContent).toContain("nothing is sent");
    expect(el!.textContent).not.toContain("Ohbox");
    expect(el!.textContent).not.toContain("at most once a day");
  });

  /**
   * A SERVER ONE RELEASE OLDER answers no `piles` at all. The notice must not invent a scope it
   * was not told — there is no path from "I do not know" to a sentence about which mail is being
   * answered — so an absent field reads as the empty scope and the line says nothing is sent.
   */
  it("a server that does not send `piles` yields no scope claim", async () => {
    stored.enabled = true;
    delete (stored as { piles?: unknown }).piles;
    await mount({ active: true });
    const el = notice();
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain("nothing is sent");
    expect(el!.textContent).not.toContain("{");
  });

  /**
   * THE TWO PILES ADDED IN 0.16.1 REACH THE SENTENCE, joined in the reader's own language. The
   * clause is a `Intl.ListFormat` DISJUNCTION over what is answered — one message lands in one
   * pile — so a fifth pile needs one word and no new sentence.
   */
  it("Receipts and the Screener are named in the clause, and the list reads as a list", async () => {
    stored.enabled = true;
    stored.audience = "everyone";
    stored.piles = ["INBOX", "ohmail/Receipts", "ohmail/Screener"];
    await mount({ active: true });
    /* THE PLATFORM'S OWN LIST, measured rather than guessed: `Intl.ListFormat`'s English
       disjunction of three carries the serial comma. */
    expect(notice()!.textContent)
      .toContain("whose mail lands in Ohbox, in Receipts, or in the Screener");
  });

  /**
   * AND THE SCREENER IS NOT NAMED BESIDE THE NARROW AUDIENCE, even when the row holds it: the
   * audience is asked first in the rule, so no waiting stranger is answered and a sentence naming
   * that pile would state a reply going out where none is. The projection is
   * `awayEffectivePiles`, the same one the settings control reads.
   */
  it("a stored Screener pile beside `screened_in` is not named — it answers nobody", async () => {
    stored.enabled = true;
    stored.audience = "screened_in";
    stored.piles = ["INBOX", "ohmail/Screener"];
    await mount({ active: true });
    const text = notice()!.textContent ?? "";
    expect(text).toContain("whose mail lands in Ohbox");
    expect(text, "the banner named a pile the responder does not answer")
      .not.toContain("Screener");
  });


  it("the scope sentence is the Banner's own text (a named scope)", async () => {
    stored.enabled = true;
    stored.piles = ["INBOX", "ohmail/News"];
    await mount({ active: true });
    expect(within(notice()!).getByText(/whose mail lands in Ohbox or in News/)).toBeTruthy();
  });

  it("the scope sentence is the Banner's own text (the empty scope)", async () => {
    stored.enabled = true;
    stored.piles = [];
    await mount({ active: true });
    expect(notice()!.textContent).toContain(messages.away.noticeNone);
    expect(notice()!.textContent).not.toContain("whose mail lands in");
  });

  it("stands in a box of its own, distinct from the pile sublines under it", async () => {
    const width = 420;
    const snapshots: { html: string; root: string; expected: string }[] = [];
    for (const piles of [[], [...AWAY_ANSWERABLE_PILES]]) {
      vi.stubGlobal("innerWidth", width);
      stored.enabled = true;
      stored.audience = "everyone";
      stored.piles = piles;
      await mount({ active: true });
      const status = notice()!;
      const expected = piles.length === 0 ? messages.away.noticeNone : "whose mail lands in Ohbox, in News, in Receipts, or in the Screener";
      expect(status.textContent).toContain(expected);
      expect(status.getAttribute("data-place")).toBe("bar");
      const root = [...document.documentElement.attributes].map(({ name, value }) => `${name}="${value}"`).join(" ");
      snapshots.push({ html: document.body.innerHTML, root, expected });
      await teardownConfirmEnv();
    }
    try {
      vi.useRealTimers();
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width, height: 844 } });
        page.setDefaultTimeout(5000);
        for (const { html, root, expected } of snapshots) {
          await page.setContent(pageOf({ html, root }));
          const box = page.getByRole("status").filter({ hasText: /^Away responder is on/ });
          await expect(box.count()).resolves.toBe(1);
          expect(await box.textContent()).toContain(expected);
          expect(await box.getByRole("button", { name: messages.away.noticeSettings }).isVisible()).toBe(true);
          const measured = await box.evaluate((el) => {
            const sentence = el.querySelector(".oh-notice-say")!;
            const walker = document.createTreeWalker(sentence, NodeFilter.SHOW_TEXT);
            const fragments: DOMRect[] = [];
            for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
              const range = document.createRange();
              range.selectNodeContents(node);
              fragments.push(...[...range.getClientRects()].filter((rect) => rect.width > 0));
            }
            const rect = el.getBoundingClientRect();
            const bar = el.closest(".fr-noticebar")!.getBoundingClientRect();
            const list = document.querySelector(".ob-scroll")!;
            return {
              wraps: fragments.some((fragment) => fragment.top > fragments[0]!.top + 1),
              textFits: fragments.every((fragment) =>
                fragment.left >= rect.left && fragment.right <= rect.right && fragment.bottom <= rect.bottom),
              boxFits: rect.left >= bar.left && rect.right <= bar.right && rect.right <= window.innerWidth &&
                el.scrollWidth <= el.clientWidth,
              outsideScroller: !list.contains(el),
              aboveScroller: bar.bottom <= list.getBoundingClientRect().top + 1,
              calm: el.closest('[role="alert"]') === null,
            };
          });
          expect(measured).toEqual({
            wraps: true, textFits: true, boxFits: true,
            outsideScroller: true, aboveScroller: true, calm: true,
          });
        }
      } finally {
        await browser.close();
      }
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30_000);

  it("responder OFF → nothing renders", async () => {
    await mount({ active: true });
    expect(reads).toBe(1);
    expect(notice()).toBeNull();
  });

  it("no server to ask → nothing renders AND no read is issued", async () => {
    stored.enabled = true;
    await mount({ active: false });
    expect(notice()).toBeNull();
    expect(reads).toBe(0);
  });

  it("A SAVE THAT LANDS FIRST WINS — the in-flight initial read must not undo it", async () => {
    const feeds = vi.spyOn(awaySettings, "awayFeedOver");
    stored = { ...stored, enabled: true, body: "Back Monday." };
    const stale = { ...stored };
    const first = Promise.withResolvers<Response>();
    try {
      await mount({ active: true, firstRead: first.promise });
      expect(reads).toBe(1);
      await act(async () => { window.location.hash = "#/settings/away"; });
      await tick(3000);
      expect(reads).toBe(1);
      // The pane waits for the same read. Drive the save through the wire it uses.
      const feed = feeds.mock.results.at(-1)?.value;
      expect(feed).toBeDefined();
      await act(async () => { await feed.wire.save({ ...stored, audience: "everyone", throttle: "per_week" }); });
      expect(writes).toBe(1);
      expect(stored.audience).toBe("everyone");
      expect(stored.throttle).toBe("per_week");
      await act(async () => { first.resolve(Response.json(stale)); });
      await tick(0);
      await returnToOhbox();
      expect(notice()?.textContent).toContain("everyone who writes");
      expect(notice()?.textContent).toContain("at most once a week");
      expect(reads).toBe(1);
    } finally {
      feeds.mockRestore();
    }
  });

  it("the settings row's save echo flips the notice in the SAME tab, without a refetch", async () => {
    await mount({ active: true, withRow: true });
    const opened = reads;
    expect(opened).toBe(1);
    expect(notice()).toBeNull();
    await click(pane().getByRole("switch", { name: messages.away.title }));
    expect(pane().queryByRole("textbox", { name: "Subject" })).toBeNull();
    await act(async () => {
      fireEvent.change(pane().getByRole("textbox", { name: messages.away.bodyLabel }), { target: { value: "Back Monday." } });
    });
    await save();
    await returnToOhbox();
    expect(notice()).not.toBeNull();
    expect(stored.body).toBe("Back Monday.");
    expect(writes).toBe(1);
    expect(reads).toBe(opened);
  });

  it("the hosted notice opens Away Settings without an intermediate route", async () => {
    stored.enabled = true;
    await mount({ active: true });
    const settingsWrites: string[] = [];
    const record = (event: HashChangeEvent) => {
      const hash = new URL(event.newURL || window.location.href).hash;
      if (hash.startsWith("#/settings")) settingsWrites.push(hash);
    };
    window.addEventListener("hashchange", record);
    try {
      await openSettings();
    } finally {
      window.removeEventListener("hashchange", record);
    }
    expect(settingsWrites[0]).toBe("#/settings/away");
    expect(settingsWrites).not.toContain("#/settings");
    expect(window.location.hash).toBe("#/settings/away");
    expect(pane().getByRole("switch", { name: messages.away.title })).toBeTruthy();
    expect(writes).toBe(0);
  });
});

describe("the away responder's pile control — which mail gets a reply", () => {
  const group = () => pane().getByRole("group", { name: messages.away.pilesLabel });
  const buttons = () => within(group()).getAllByRole<HTMLButtonElement>("button")
    .filter((control) => control.hasAttribute("aria-pressed"));
  const WORD: Record<(typeof AWAY_PILE_VIEW)[AwayPile], string> = {
    ohbox: messages.away.pileOhbox, reads: messages.away.pileReads,
    receipts: messages.away.pileReceipts, screener: messages.away.pileScreener,
  };
  const pile = (id: AwayPile) => within(group()).getByRole<HTMLButtonElement>("button", { name: WORD[AWAY_PILE_VIEW[id]] });
  const checked = (id: AwayPile) => pile(id).getAttribute("aria-pressed") === "true";
  const ohbox = "INBOX";
  const news = "ohmail/News";
  const receipts = "ohmail/Receipts";
  const screener = "ohmail/Screener";
  const note = (id: AwayPile, text: string) => pane().queryByText(`${WORD[AWAY_PILE_VIEW[id]]}: ${text}`);

  beforeEach(() => {
    stored.enabled = true;
    stored.body = "Back Monday.";
  });

  it("offers exactly the engine's answerable piles, in the engine's order, each under its pile word", async () => {
    await mount({ active: true, withRow: true });
    expect(buttons()).toEqual(AWAY_ANSWERABLE_PILES.map(pile));
    const note = document.getElementById(group().getAttribute("aria-describedby")!);
    expect(note?.textContent).toBe(messages.away.pilesNote);
  });

  it("under the default scope the Ohbox is checked and cannot be switched off; News is opt-in", async () => {
    await mount({ active: true, withRow: true });
    expect(checked(ohbox)).toBe(true);
    expect(pile(ohbox).disabled).toBe(true);
    expect(note(ohbox, messages.away.pileOhboxNote)).not.toBeNull();
    expect(checked(news)).toBe(false);
    expect(pile(news).disabled).toBe(false);
  });

  it("ticking Reads reaches the draft, Save writes it, and the banner names both piles from the echo", async () => {
    await mount({ active: true, withRow: true });
    expect(notice()!.textContent).toContain("whose mail lands in Ohbox get");
    await click(pile(news));
    expect(checked(news)).toBe(true);
    expect(stored.piles).toEqual([ohbox]);
    expect(writes).toBe(0);
    await save();
    expect(stored.piles).toEqual([ohbox, news]);
    expect(notice()!.textContent).toContain("whose mail lands in Ohbox or in News");
    await click(pile(news));
    await save();
    expect(stored.piles).toEqual([ohbox]);
    expect(notice()!.textContent).toContain("whose mail lands in Ohbox get");
  });

  it("draws four rows in the engine's order, each under its pile word", async () => {
    stored.audience = "everyone";
    await mount({ active: true, withRow: true });
    expect(buttons()).toEqual(([ohbox, news, receipts, screener] as const).map(pile));
  });

  it("the Screener row is pressable under `everyone`, and its press reaches the PUT", async () => {
    stored.audience = "everyone";
    await mount({ active: true, withRow: true });
    expect(pile(screener).disabled).toBe(false);
    expect(note(screener, messages.away.pileScreenerNote)).toBeNull();
    await click(pile(screener));
    await save();
    expect(stored.piles).toEqual([ohbox, screener]);
    expect(notice()!.textContent).toContain("whose mail lands in Ohbox or in the Screener");
  });

  it("…and is locked with its reason under `screened_in`, whatever the row holds", async () => {
    stored.piles = [ohbox, screener];
    await mount({ active: true, withRow: true });
    expect(pile(screener).disabled).toBe(true);
    expect(checked(screener)).toBe(false);
    expect(note(screener, messages.away.pileScreenerNote)).not.toBeNull();
  });

  it("switching to `screened_in` drops the Screener from the draft and from the save", async () => {
    stored.audience = "everyone";
    stored.piles = [ohbox, screener];
    await mount({ active: true, withRow: true });
    expect(checked(screener)).toBe(true);
    await click(pane().getByRole("button", { name: messages.away.screenedIn }));
    expect(checked(screener)).toBe(false);
    await save();
    expect(stored.piles).toEqual([ohbox]);
    expect(stored.audience).toBe("screened_in");
  });

  it("Receipts is selectable outright — no audience condition on that row", async () => {
    await mount({ active: true, withRow: true });
    expect(pile(receipts).disabled).toBe(false);
    await click(pile(receipts));
    await save();
    expect(stored.piles).toEqual([ohbox, receipts]);
    expect(notice()!.textContent).toContain("whose mail lands in Ohbox or in Receipts");
  });

  it("a stored scope WITHOUT the Ohbox shows the truth: unticked and pressable, no 'always answered'", async () => {
    stored.piles = [news];
    await mount({ active: true, withRow: true });
    expect(checked(ohbox)).toBe(false);
    expect(pile(ohbox).disabled).toBe(false);
    expect(note(ohbox, messages.away.pileOhboxNote)).toBeNull();
    expect(checked(news)).toBe(true);
    await click(pile(ohbox));
    expect(checked(ohbox)).toBe(true);
    expect(pile(ohbox).disabled).toBe(true);
    expect(note(ohbox, messages.away.pileOhboxNote)).not.toBeNull();
  });

  it("the never-list is stated once, in full, as the gloss beside the label — and the group is named by the label alone", async () => {
    await mount({ active: true, withRow: true });
    const gloss = within(group()).getByRole("button", { name: messages.away.never });
    await click(gloss);
    expect(gloss.getAttribute("aria-expanded")).toBe("true");
    expect(pane().getAllByText(messages.away.never)).toHaveLength(1);
    expect(group().getAttribute("aria-labelledby")).not.toBeNull();
    const label = document.getElementById(group().getAttribute("aria-labelledby")!);
    expect(label?.textContent).toBe(messages.away.pilesLabel);
  });

  it("reads WHO, then WHICH MAIL, then HOW OFTEN — the banner sentence's order", async () => {
    await mount({ active: true, withRow: true });
    const audience = pane().getByRole("button", { name: messages.away.screenedIn });
    const rate = pane().getByRole("button", { name: messages.away.throttleLabel });
    expect(audience.compareDocumentPosition(group()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(group().compareDocumentPosition(rate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("the mounted Away notice and Settings wiring", () => {
  it("the shell's ONE away read is gated on the RESOLVED demo answer, not the hydration one", async () => {
    stored.enabled = true;
    const onError = vi.fn();
    await mount({ active: true, demo: true, hydration: { from: "/#/ohbox", onError } });
    expect(onError).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?demo=1");
    expect(reads).toBe(0);
    expect(notice()).toBeNull();
    expect(ui().getByRole("navigation", { name: "Places" })).toBeTruthy();
  });

  it("support is the hosted client OR a host's own wire — never a bare `apiConfigured()`", () => {
    const read = (file: string) => readFileSync(file, "utf8");
    expect(read("apps/webapp/app/(product)/mailbox/web-supplies.tsx"))
      .toMatch(/apiConfigured\(\) && scope !== null && scope === confirmed\s*\? awayFeedOver/);
    expect(read("apps/desktop/src/DesktopFrame.tsx")).toContain("awayDoor === null ? null : awayFeedOver(awayOverBridge)");
  });

  it("the Ohbox notice is gated on demo, support, and the responder actually being on", async () => {
    stored.enabled = true;
    await mount({ active: true });
    expect(notice()).not.toBeNull();
    expect(reads).toBe(1);
    // Re-entering Ohbox keeps the tab's original read and the hosted sentence.
    await returnToOhbox();
    expect(notice()).not.toBeNull();
    expect(reads).toBe(1);
  });

  it("the standingNotice block itself passes the scope to <AwayNotice>", async () => {
    stored.enabled = true;
    stored.piles = ["INBOX", "ohmail/Receipts"];
    await mount({ active: true });
    const status = notice();
    expect(status).not.toBeNull();
    expect(within(status!).getByText(/whose mail lands in Ohbox or in Receipts/)).toBeTruthy();
  });

  it("`ohx-standing` names nothing any more — no element, no rule", async () => {
    stored.enabled = true;
    await mount({ active: true });
    expect(notice()).not.toBeNull();
    expect(host.querySelector(".ohx-standing")).toBeNull();
    const css = readFileSync("apps/webapp/app/app.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/\.ohx-standing\s*[{,>:.\s]/);
  });

  it("the settings row reports its echo into the same held state, down the same wire", async () => {
    stored.enabled = true;
    stored.body = "Back Monday.";
    await mount({ active: true });
    expect(reads).toBe(1);
    await openSettings();
    await click(pane().getByRole("switch", { name: messages.away.title }));
    await save();
    await returnToOhbox();
    expect(writes).toBe(1);
    expect(reads).toBe(2);
    expect(stored.enabled).toBe(false);
    expect(notice()).toBeNull();
  });

  it("the responder's pane is the injected node itself — absent ⇒ no pane and no nav entry", async () => {
    stored.enabled = true;
    await mount({ active: true, demo: true, withRow: true });
    expect(ui().queryByRole("region", { name: messages.settings.away })).toBeNull();
    expect(ui().queryByRole("link", { name: messages.settings.away })).toBeNull();
    expect(ui().queryByRole("switch", { name: messages.away.title })).toBeNull();
    expect(reads).toBe(0);
  });
});
