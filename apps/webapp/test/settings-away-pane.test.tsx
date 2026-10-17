/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import de from "../messages/de.json";

import { PANE_IDS, SettingsView, initialPaneFromUrl } from "../app/views/SettingsView";
import { AwayResponderRow, type AwayTransport } from "../app/shell/AwayResponderRow";
import type { AwayResponderSaveWire, AwayResponderWire } from "../app/api-client";
import { setActiveCatalog, setActiveFormatZone } from "../app/shell/locale";

/**
 * THE AWAY RESPONDER HAS ITS OWN SETTINGS PANE.
 *
 * It shipped as the last row of the SCREENER pane — filed there because its one real decision is
 * whether a sender the Screener is still holding gets answered. That is true and it is not where
 * anybody looks: the responder is the single state in which this product sends mail on its own, and
 * "where do I turn that off" is a question people ask of a menu, not of a pane about who reaches
 * their Ohbox. So it is a section in the nav with a pane of its own.
 *
 * ── WHAT MUST BE TRUE ────────────────────────────────────────────────────────────────────────
 *
 *  1. A HOST THAT WIRES THE NODE GETS A NAV ENTRY, and choosing it renders the node.
 *  2. THE SCREENER PANE NO LONGER DRAWS IT — a move, not a copy. Two live controls over one
 *     `PUT /away-responder` would each hold their own draft, and the second Save would silently
 *     overwrite the first with a stale one.
 *  3. THE SCREENER PANE NO LONGER DEPENDS ON IT for its existence. `awaySection` used to be one of
 *     the five nodes that could summon that pane; a surface wiring ONLY the responder must now get
 *     the away entry and NO Screener entry, or the nav grows a pane that renders nothing.
 *  4. THE DEEP LINK LANDS HERE. `?settings=away` is what the Ohbox notice's affordance writes, and
 *     an id the pane switch does not have renders an empty settings screen.
 *  5. NO NODE ⇒ NO ENTRY AND NO PANE. A standalone install has no hosted worker to send the reply,
 *     so the control is absent by construction rather than present and dead.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const h = React.createElement;

let host: HTMLDivElement;
let root: Root;

async function mount(props: Parameters<typeof SettingsView>[0], locale: "en" | "de" = "en") {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale,
        messages: locale === "de" ? (de as never) : messages,
        timeZone: "UTC",
        children: h(ThemeProvider, null, h(ToastHost, null, h(SettingsView, props))),
      }),
    );
  });
}

const BASE: Parameters<typeof SettingsView>[0] = {
  notifications: null,
  tags: [],
  tagCounts: {},
};

/** The responder's control, as the shell injects it: one node, opaque to this view. */
const AWAY = h("p", { className: "away-probe" }, "Away responder controls");

const navLabels = () =>
  [...host.querySelectorAll(".set-nav button")].map((b) => b.textContent?.trim());

const choose = async (label: string): Promise<void> => {
  const entry = [...host.querySelectorAll(".set-nav button")].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!entry) throw new Error(`no settings nav entry labelled ${label}`);
  await act(async () => { entry.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
};

afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  window.history.replaceState(null, "", "/");
});

describe("Settings → Away responder, as its own section", () => {
  it("is a nav entry of its own, and choosing it renders the injected control", async () => {
    await mount({ ...BASE, awaySection: AWAY });
    expect(navLabels()).toContain("Away responder");
    // Not the pane on screen until it is chosen — General still is.
    expect(host.querySelector(".away-probe")).toBeNull();
    await choose("Away responder");
    expect(host.querySelector(".away-probe")?.textContent).toBe("Away responder controls");
  });

  it("is NOT drawn in the Screener pane any more — one control, one draft, one Save", async () => {
    await mount({
      ...BASE,
      awaySection: AWAY,
      screeningSection: h("p", { className: "screening-probe" }, "posture"),
    });
    await choose("Screener");
    expect(host.querySelector(".screening-probe")).not.toBeNull();
    expect(host.querySelector(".away-probe")).toBeNull();
  });

  it("no longer summons the Screener pane: the responder alone is ONE entry, not two", async () => {
    await mount({ ...BASE, awaySection: AWAY });
    expect(navLabels()).toContain("Away responder");
    // The Screener pane's own four nodes are absent, so an entry here would open a blank pane.
    expect(navLabels()).not.toContain("Screener");
  });

  it("sits beside the Screener, before Rules — it is about the mail a mailbox brings", async () => {
    await mount({
      ...BASE,
      awaySection: AWAY,
      screeningSection: h("p", null, "posture"),
      rules: { items: [], onRevoke: async () => "ok" as never, onRetarget: async () => "ok" as never, pastMail: () => null },
    });
    const labels = navLabels();
    expect(labels.indexOf("Away responder")).toBeGreaterThan(labels.indexOf("Screener"));
    expect(labels.indexOf("Away responder")).toBeLessThan(labels.indexOf("Rules"));
  });

  it("no node ⇒ no entry, and the words are nowhere — a standalone install draws nothing", async () => {
    await mount({ ...BASE, screeningSection: h("p", null, "posture") });
    expect(navLabels()).not.toContain("Away responder");
    expect(host.querySelector(".away-probe")).toBeNull();
    expect(host.textContent).not.toMatch(/Away responder/);
  });

  it("carries a German label — the nav is the one surface a shim could not reach", async () => {
    await mount({ ...BASE, awaySection: AWAY }, "de");
    expect(navLabels()).toContain("Abwesenheitsantwort");
  });
});

describe("`?settings=away` — the deep link the Ohbox notice writes", () => {
  it("is an id the pane switch has, and it opens the pane at mount with no click", async () => {
    expect(PANE_IDS).toContain("away");
    window.history.replaceState(null, "", "/mailbox?settings=away#/settings");
    expect(initialPaneFromUrl()).toBe("away");
    await mount({ ...BASE, awaySection: AWAY, screeningSection: h("p", null, "posture") });
    expect(host.querySelector(".away-probe")).not.toBeNull();
  });
});

/**
 * ═══ A SAVE THAT LEFT THIS INSTALL DOES NOT SAY "Saved." ═══════════════════════════════════
 *
 * On an account whose mailboxes another install organizes, `PUT /away-responder` writes nothing
 * here: it answers 202 with the UNCHANGED row plus `pending: true`, and a request travels to the
 * machine that organizes them. The pane set its controls from that echo — correctly, it is what
 * this install still holds — and then announced "Saved." over the values it had just put back.
 * So the one control in the product that decides what strangers are told reported a save that
 * had not happened, and the reverted values read as a setting that undid itself.
 *
 * The pair below is the whole property: the pending answer says what is waiting, the ordinary one
 * still says "Saved.".
 */
async function mountRow(
  /* The PARAMETER is the transport's own — `Omit<AwayResponderWire, "updatedAt">`, the row a PUT
     sends — and only the ANSWER carries `pending`. Typed as the save wire on both sides this stub
     was not assignable to `AwayTransport.save` (a parameter is contravariant), and the error lands
     on `createElement` falling through to its last overload, which names `Attributes` and not this
     line. Same cases, same fixture; the type says which half the field belongs to. */
  save: (next: Omit<AwayResponderWire, "updatedAt">) => Promise<AwayResponderSaveWire>,
  /** What the server currently holds, for the cases that are about a stored field. */
  row: Partial<AwayResponderSaveWire> = {},
  locale: "en" | "de" = "en",
  /**
   * WHAT `state()` ANSWERS, when the case is about the answer CHANGING. The default is the stored
   * row every other case wants; the `asked` watcher's cases need a read whose answer moves, which
   * is the whole discriminator the pane turns on.
   */
  state?: () => Promise<AwayResponderSaveWire>,
): Promise<void> {
  const stored: AwayResponderSaveWire = {
    enabled: false, body: "Back Monday", startsAt: null, endsAt: null,
    audience: "screened_in", throttle: "per_day", piles: ["INBOX"], updatedAt: null,
    ...row,
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale, messages: locale === "de" ? (de as never) : messages, timeZone: "UTC",
        children: h(ThemeProvider, null, h(ToastHost, null, h(
          /* NARROWED TO THE PROPS THIS MOUNT USES, and that is the honest cast rather than the
             `as never` the sibling test reaches for: the row declares every prop optional with a
             defaulted parameter, so `createElement` cannot match it as a `FunctionComponent` and
             falls through to its last overload — whose error names `Attributes` and not this line.
             Naming the component's transport prop keeps the object below TYPE-CHECKED against
             `AwayTransport`, which is where a real mistake in this fixture would be. */
          AwayResponderRow as React.FunctionComponent<{ transport: AwayTransport }>,
          { transport: { state: state ?? (async () => stored), save } },
        ))),
      }),
    );
  });
  // The row loads its own state on mount; the chain settles a tick later (see away-notice.test).
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

/**
 * Turn the RESPONDER's own switch on — the edit that makes a save's request differ from the row.
 *
 * BY ITS ACCESSIBLE NAME, with a count that refuses anything but one. The pane also carries a
 * checkbox per answerable pile, so the first `input[type=checkbox]` in the DOM is a PILE: a
 * position-based selector here ticked Reads and left the responder off, which then read as
 * somebody else's edit — the very state the case beside it is about.
 */
const switchOn = async (): Promise<void> => {
  const name = messages.away.title;
  const found = [...host.querySelectorAll('[role=switch], input[type=checkbox]')]
    .filter((el) => el.getAttribute("aria-label") === name
      || el.getAttribute("name") === name
      || (el.id !== "" && host.querySelector(`label[for="${el.id}"]`)?.textContent?.trim() === name));
  if (found.length !== 1) throw new Error(`away switch: expected 1 control named ${name}, found ${found.length}`);
  await act(async () => { found[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

const press = async (label: string): Promise<void> => {
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  if (!button) throw new Error(`no button labelled ${label}`);
  await act(async () => { button.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE END DATE (mail 0101)

   `endsAt` has been in the row, the wire and this control's draft since the responder shipped —
   the pass stops answering past it — and there was no control for it, so the only writer was the
   API. What the pane adds is the field, the sentence that says what the stored date means right
   now, and a local refusal for the one save the server answers 400 for.

   The ZONE is pinned to UTC for these cases: the field resolves a picked day to the END of that
   day where the reader is, so an unpinned zone would make the stored instant depend on the
   machine running the suite.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

const dateTrigger = (): HTMLButtonElement =>
  host.querySelector("#away-until") as HTMLButtonElement;

const findButton = (label: string): HTMLButtonElement | undefined =>
  [...host.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === label,
  ) as HTMLButtonElement | undefined;

describe("the away responder's end date", () => {
  beforeEach(() => { setActiveFormatZone("UTC"); setActiveCatalog("en", null); });
  afterEach(() => { setActiveFormatZone(null); setActiveCatalog("en", null); });

  it("rests on `No end date`, and says nothing about a date it does not have", async () => {
    await mountRow(async (next) => ({ ...next, updatedAt: null }), { enabled: true });
    expect(dateTrigger(), "no end-date field on the pane").not.toBeNull();
    expect(dateTrigger().textContent).toBe(messages.away.untilNone);
    expect(host.textContent).not.toContain("On until");
    expect(findButton(messages.away.untilClear), "a clear button with nothing to clear")
      .toBeUndefined();
  });

  it("names a stored date and says the responder is on until it", async () => {
    await mountRow(async (next) => ({ ...next, updatedAt: null }),
      { enabled: true, endsAt: "2036-09-14T23:59:59.000Z" });
    expect(dateTrigger().textContent).toBe("Sep 14, 2036");
    expect(host.textContent).toContain("On until Sep 14, 2036.");
  });

  /**
   * A DATE THAT HAS PASSED WITH THE RESPONDER STILL ON — the state the pass's sweep clears on its
   * next cycle, and until it does the pane says which it is rather than "On.". The save is refused
   * HERE, with the field's own sentence, because the server's 400 reaches this pane as the bare
   * "That did not save." and would not say which field.
   */
  it("says the date has passed, and refuses the save with the field's own sentence", async () => {
    let puts = 0;
    await mountRow(
      async (next) => { puts += 1; return { ...next, updatedAt: null }; },
      { enabled: true, endsAt: "2020-01-02T23:59:59.000Z" },
    );
    expect(host.textContent).toContain("The end date passed on Jan 2, 2020.");
    expect(host.textContent).not.toContain("On until");
    await press("Save");
    expect(puts, "the pane sent a save the server answers 400 for").toBe(0);
    expect(host.textContent).toContain(messages.away.untilExpired);
    expect(host.textContent).not.toContain(messages.away.saved);
  });

  /** …and the same stored date with the responder OFF is not refused: that save is the way out. */
  it("does not refuse the save when the responder is off — the positive control", async () => {
    let puts = 0;
    await mountRow(
      async (next) => { puts += 1; return { ...next, updatedAt: null }; },
      { enabled: false, endsAt: "2020-01-02T23:59:59.000Z" },
    );
    await press("Save");
    expect(puts).toBe(1);
    expect(host.textContent).toContain(messages.away.saved);
  });

  it("clears the date, and the save carries the null", async () => {
    let sent: Omit<AwayResponderWire, "updatedAt"> | null = null;
    await mountRow(
      async (next) => { sent = next; return { ...next, updatedAt: null }; },
      { enabled: true, endsAt: "2036-09-14T23:59:59.000Z" },
    );
    await press(messages.away.untilClear);
    expect(dateTrigger().textContent).toBe(messages.away.untilNone);
    await press("Save");
    expect(sent!.endsAt).toBeNull();
  });

  /**
   * THE PICKER WRITES THE END OF THE CHOSEN DAY, and that is the whole of the conversion: the
   * window is inclusive (`ends_at >= now`), so the last instant a reply may go out on the day
   * somebody named is 23:59:59 where they are.
   */
  it("a picked day is stored as the end of that day, and reads back as the same day", async () => {
    let sent: Omit<AwayResponderWire, "updatedAt"> | null = null;
    await mountRow(
      async (next) => { sent = next; return { ...next, updatedAt: null }; },
      { enabled: true },
    );
    await press(messages.away.untilNone);          // opens the picker
    /* THE PICKER'S OWN GRID, and the day is taken FROM it rather than named: it opens on the
       current month, whose days move with the calendar, and `min` floors it at tomorrow. The first
       enabled cell is therefore tomorrow, whatever today is. */
    /* `aria-disabled`, not the `disabled` ATTRIBUTE: the picker keeps an out-of-range day
       focusable and refuses its press, so a filter on `.disabled` accepts every cell in the grid
       — including the ones before `min`, which is how this case first picked a day in August. */
    const cells = [...host.querySelectorAll<HTMLButtonElement>("[data-day]")]
      .filter((b) => b.getAttribute("aria-disabled") === null);
    expect(cells.length, "the picker drew no pickable day").toBeGreaterThan(0);
    const day = cells[0]!.getAttribute("data-day")!;
    await act(async () => {
      cells[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // END of that day, in the zone this block pinned — the last instant a reply may go out on it.
    expect(dateTrigger().textContent, "the trigger does not read the picked day back")
      .toBe(new Date(`${day}${"T"}23:59:59.000Z`).toLocaleDateString("en", {
        dateStyle: "medium", timeZone: "UTC",
      }));
    await press("Save");
    expect(sent!.endsAt).toBe(`${day}${"T"}23:59:59.000Z`);
  });

  it("carries the German field label and status sentence", async () => {
    setActiveCatalog("de", de as never);
    await mountRow(async (next) => ({ ...next, updatedAt: null }),
      { enabled: true, endsAt: "2036-09-14T23:59:59.000Z" }, "de");
    expect(host.textContent).toContain(de.away.untilLabel);
    expect(host.textContent).toContain("An bis 14.09.2036.");
  });
});

describe("the away responder's answer when the save had to travel", () => {
  it("a 202 `pending` save says what is waiting, and never that it saved", async () => {
    await mountRow(async (next) => ({ ...next, updatedAt: null, pending: true }));
    await press("Save");
    expect(host.textContent, "the sentence for a save that left this install")
      .toContain(messages.away.asked);
    expect(host.textContent, "and not a claim that anything was stored here")
      .not.toContain(messages.away.saved);
  });

  it("an ordinary save still says Saved. — the positive control", async () => {
    await mountRow(async (next) => ({ ...next, updatedAt: null }));
    await press("Save");
    expect(host.textContent).toContain(messages.away.saved);
    expect(host.textContent).not.toContain(messages.away.asked);
  });
});

/**
 * ═══ …AND `asked` IS A STATE THAT HAS TO END ═══════════════════════════════════════════════
 *
 * The sentence says the organizing machine "applies it on its next pass". Nothing here could ever
 * learn that it had: no poll, no sync subscription, no acknowledgement. So a pane left open showed
 * the OLD values under a note about a request that had already landed — the same false state the
 * 202 discriminator was added to remove, one step later in the same sequence.
 *
 * The discriminator is the one the pane already carries. A 202 answers the row UNCHANGED, so the
 * first read whose `updatedAt` differs is the organizer's write. Bounded, because an unbounded
 * timer on a settings row is the shape another lane is removing elsewhere.
 */
describe("the away responder's `asked` state ends when the organizer applies the request", () => {
  /* `shouldAdvanceTime`, because the mount and the press both await a real `setTimeout(0)` to let
     React settle: a frozen clock never resolves those and the case times out before it starts.
     The 20-second jumps below are still explicit — auto-advance moves the clock at wall-clock
     speed, which reaches nowhere near one poll interval inside a case. */
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  /** The stored row, and the same row after the organizing machine has applied the request. */
  const WAITING: AwayResponderSaveWire = {
    enabled: false, body: "Back Monday", startsAt: null, endsAt: null,
    audience: "screened_in", throttle: "per_day", piles: ["INBOX"], updatedAt: null,
  };
  const APPLIED: AwayResponderSaveWire = {
    ...WAITING, enabled: true, updatedAt: "2026-09-10T12:00:00.000Z",
  };

  it("replaces the waiting note with the applied one, and shows the applied values", async () => {
    /* THE REAL SEQUENCE, and the case used to skip the first step of it. The reader TURNS THE
       RESPONDER ON and saves; the 202 echoes the row UNCHANGED, so the pane shows OFF under the
       waiting note; the organizer then writes what was asked and the next read carries it. Without
       the switch press the request was `enabled: false` while the row that came back was `true` —
       somebody else's edit, which is the case below, not this one. */
    let answer = WAITING;
    let reads = 0;
    await mountRow(
      async (next) => ({ ...next, updatedAt: null, pending: true }),
      {}, "en",
      async () => { reads += 1; return answer; },
    );
    await switchOn();
    await press("Save");
    expect(host.textContent, "the save's own answer").toContain(messages.away.asked);
    expect(host.textContent).not.toContain(messages.away.applied);

    // The organizing machine applies it. Nothing tells this pane; the next read is what does.
    answer = APPLIED;
    const before = reads;
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });

    expect(reads, "the pane never asked again").toBeGreaterThan(before);
    expect(host.textContent, "the pane still says a request is waiting")
      .not.toContain(messages.away.asked);
    expect(host.textContent).toContain(messages.away.applied);
    /* AND THE VALUES, which is the half that makes this a false STATE rather than a stale note:
       the switch was OFF under the waiting note and the applied row has it ON. */
    const box = host.querySelector("input[type=checkbox]") as HTMLInputElement | null;
    expect(box?.checked ?? [...host.querySelectorAll("button[role=switch]")]
      .some((b) => b.getAttribute("aria-checked") === "true")).toBeTruthy();
  });

  it("keeps saying it is waiting while the answer has not moved — and stops asking", async () => {
    /* THE BOUND, from both sides. While nothing changes the note is unchanged, which is TRUE: the
       request is waiting. And the asking stops, so a pane left open overnight holds no timer. */
    let reads = 0;
    await mountRow(
      async (next) => ({ ...next, updatedAt: null, pending: true }),
      {}, "en",
      async () => { reads += 1; return WAITING; },
    );
    await press("Save");
    const afterPress = reads;
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000 * 12 + 1_000); });
    const spent = reads;
    expect(spent, "the watcher asked").toBeGreaterThan(afterPress);
    expect(host.textContent, "the waiting note is still the true one").toContain(messages.away.asked);
    expect(host.textContent).not.toContain(messages.away.applied);

    await act(async () => { await vi.advanceTimersByTimeAsync(20_000 * 12); });
    expect(reads, "the watcher is still asking past its bound").toBe(spent);
  });

  /**
   * ═══ AND `applied` MEANS *OUR* REQUEST, NOT "THE ROW MOVED" ═════════════════════════════
   *
   * `updatedAt` moving says the row changed; it does not say WHOSE change it was. A reader whose
   * own request was dropped, while somebody at another install edited the same row, was shown
   * "the machine has applied it" about a state nobody here asked for — a false statement about
   * what strangers are being told, which is the defect the 202 discriminator exists to prevent.
   *
   * So the read-back state is compared FIELD BY FIELD against the request this install sent.
   * Equal ⇒ applied. Different ⇒ the true sentence, that it changed somewhere else. The values
   * are shown in both cases: they are what the row now holds either way.
   */
  it("says it changed elsewhere when the row that came back is NOT what was asked for", async () => {
    let answer = WAITING;
    await mountRow(
      async (next) => ({ ...next, updatedAt: null, pending: true }),
      {}, "en",
      async () => answer,
    );
    await press("Save");
    expect(host.textContent, "the save's own answer").toContain(messages.away.asked);

    /* SOMEBODY ELSE'S EDIT. The request pressed Save on the stored row unchanged; this row has a
       different message in it, which nothing here asked for. */
    answer = { ...WAITING, body: "On sabbatical", updatedAt: "2026-09-10T12:00:00.000Z" };
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });

    expect(host.textContent, "a request nobody here made was reported as applied")
      .not.toContain(messages.away.applied);
    expect(host.textContent).toContain(messages.away.changedElsewhere);
    expect(host.textContent).not.toContain(messages.away.asked);
    // AND THE VALUES ARE THE ROW'S. The pane states what is true, whoever wrote it.
    const area = host.querySelector("textarea") as HTMLTextAreaElement | null;
    expect(area?.value).toBe("On sabbatical");
  });

  it("compares against the REQUEST, not the 202's echo of the unchanged row", async () => {
    /**
     * THE FIXTURE THE OTHER CASES GET WRONG, and it is the one that makes the kept request
     * load-bearing. A travelled save answers 202 with the row AS IT STANDS HERE — UNCHANGED, which
     * is why the pane puts the old values back under the waiting note. The stubs above echo the
     * request instead, so for them "compare against the echo" and "compare against the request"
     * are the same expression and neither can tell the two apart.
     *
     * Here the echo is the stored row. Comparing against it would ask "did the organizer write the
     * values we already had", which is the question backwards: it reports the request applied only
     * when nothing happened, and somebody else's edit whenever it did.
     */
    const STORED: AwayResponderSaveWire = { ...WAITING };
    let answer = STORED;
    await mountRow(
      // The real 202: the row unchanged, with the discriminator. NOT an echo of `next`.
      async () => ({ ...STORED, pending: true }),
      {}, "en",
      async () => answer,
    );
    await switchOn();
    await press("Save");
    // The documented behaviour: the OLD values under the waiting note.
    expect(host.textContent).toContain(messages.away.asked);

    // The organizer writes exactly what was asked for.
    answer = { ...STORED, enabled: true, updatedAt: "2026-09-10T12:00:00.000Z" };
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });

    expect(host.textContent, "the request that landed was reported as somebody else's edit")
      .toContain(messages.away.applied);
    expect(host.textContent).not.toContain(messages.away.changedElsewhere);
  });

  it("says applied when the row that came back IS what was asked for", async () => {
    /* THE POSITIVE CONTROL for the comparison — without it a comparator that never matched would
       report "changed elsewhere" for every successful request and read as a working guard. */
    let answer = WAITING;
    await mountRow(
      async (next) => ({ ...next, updatedAt: null, pending: true }),
      {}, "en",
      async () => answer,
    );
    await press("Save");
    answer = { ...WAITING, updatedAt: "2026-09-10T12:00:00.000Z" };
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });

    expect(host.textContent).toContain(messages.away.applied);
    expect(host.textContent).not.toContain(messages.away.changedElsewhere);
  });

  it("compares dates as INSTANTS and piles as a SET — the server re-spells both", async () => {
    /* The endpoint stores a date through `new Date(v).toISOString()` and collapses piles to a set
       whose order it does not preserve. A string/array comparison would call a request that landed
       exactly as asked "changed elsewhere" — a new false state in place of the old one. */
    const asked: Partial<AwayResponderSaveWire> = {
      enabled: true, body: "Back Monday",
      startsAt: "2026-09-14T00:00:00+02:00",
      piles: ["ohmail/News", "INBOX"],
    };
    let answer = { ...WAITING, ...asked } as AwayResponderSaveWire;
    await mountRow(
      async (next) => ({ ...next, updatedAt: null, pending: true }),
      asked, "en",
      async () => answer,
    );
    await press("Save");
    answer = {
      ...WAITING, ...asked,
      startsAt: new Date("2026-09-14T00:00:00+02:00").toISOString(),
      piles: ["INBOX", "ohmail/News"],
      updatedAt: "2026-09-10T12:00:00.000Z",
    } as AwayResponderSaveWire;
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });

    expect(host.textContent, "a re-spelled date or pile order read as somebody else's edit")
      .toContain(messages.away.applied);
    expect(host.textContent).not.toContain(messages.away.changedElsewhere);
  });

  it("an EARLIER save's watcher cannot report applied once a later save is waiting", async () => {
    /**
     * TWO REQUESTS IN FLIGHT. Turn the responder on and save; the 202 leaves a watcher comparing
     * against request A. Turn it off and save; a second 202 leaves a watcher comparing against B.
     * Nothing cancelled A, so when A lands its watcher matches, says "applied" and puts A's values
     * back — announcing the request the user has already replaced, and showing the responder ON
     * while the pending request is the one that turns it OFF.
     */
    const STORED: AwayResponderSaveWire = { ...WAITING };
    let answer = STORED;
    let reads = 0;
    await mountRow(
      async () => ({ ...STORED, pending: true }),
      {}, "en",
      async () => { reads += 1; return answer; },
    );
    await switchOn();
    await press("Save");          // request A: enabled true
    /* THE 202 ECHOED THE UNCHANGED ROW, so the pane is showing OFF again — pressing the switch
       here would ask for `true` a second time. Saving what the pane now holds is request B, and it
       asks for `false`, which is what makes the two requests tell each other apart. */
    await press("Save");          // request B: enabled false — the live one
    expect(host.textContent).toContain(messages.away.asked);

    /* THE MECHANISM, not the sentence. Both watchers ask on the same interval and BOTH would
       decide; the pane's final state is then whichever `setState` ran last, which is an ordering
       and not a guarantee — with the guard removed the sentence assertion below stays green for
       that reason alone. What the fix actually does is leave ONE watcher: A's pending tick is
       cleared at the second save and its generation is stale, so it does not even ask. */
    const before = reads;
    answer = { ...STORED, enabled: true, updatedAt: "2026-09-10T12:00:00.000Z" };
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(reads - before, "a superseded watcher is still polling").toBe(1);

    expect(host.textContent, "a superseded request was announced as applied")
      .not.toContain(messages.away.applied);
  });

  it("an edit made while the request travels is kept when it lands, and leaving asks", async () => {
    /* AWAY-RELAYED-SAVE-OVERWRITES-A-LATER-EDIT: the landing put the row's values over the field
       and the hold released, so words typed during the wait were gone without a question. */
    window.history.replaceState(null, "", "/mailbox#/settings/away");
    let answer = WAITING;
    await mountRow(
      async (next) => ({ ...next, updatedAt: null, pending: true }),
      {}, "en",
      async () => answer,
    );
    await switchOn();
    await press("Save");
    const field = host.querySelector("#away-body") as HTMLTextAreaElement;
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => { set.call(field, "Back Tuesday"); field.dispatchEvent(new Event("input", { bubbles: true })); });

    answer = APPLIED;
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(host.textContent).toContain(messages.away.applied);
    expect((host.querySelector("#away-body") as HTMLTextAreaElement).value, "the later edit was overwritten")
      .toBe("Back Tuesday");
    expect(host.textContent).toContain(messages.away.unsavedStillOn);

    const { go } = await import("../app/shell/routing");
    await act(async () => { go("ohbox"); });
    expect(host.querySelector("[role=alertdialog]"), "the hold released without a question").not.toBeNull();
    expect(window.location.hash).toBe("#/settings/away");
  });

  it("an untouched draft takes the landed row and holds nothing — the control", async () => {
    window.history.replaceState(null, "", "/mailbox#/settings/away");
    let answer = WAITING;
    await mountRow(
      async (next) => ({ ...next, updatedAt: null, pending: true }),
      {}, "en",
      async () => answer,
    );
    await switchOn();
    await press("Save");
    answer = APPLIED;
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(host.textContent).toContain(messages.away.on);
    expect(host.textContent).not.toContain(messages.away.unsavedStillOn);
    const { go } = await import("../app/shell/routing");
    await act(async () => { go("ohbox"); });
    expect(host.querySelector("[role=alertdialog]")).toBeNull();
    expect(window.location.hash).toBe("#/ohbox");
  });

  it("an ORDINARY save starts no watcher at all — the positive control", async () => {
    /* The watcher belongs to the travelled save and to nothing else. A save written HERE has its
       answer already, and a timer armed on it would be a settings row polling for no reason. */
    let reads = 0;
    await mountRow(
      async (next) => ({ ...next, updatedAt: "2026-09-10T12:00:00.000Z" }),
      {}, "en",
      async () => { reads += 1; return WAITING; },
    );
    await press("Save");
    expect(host.textContent).toContain(messages.away.saved);
    const afterPress = reads;
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000 * 13); });
    expect(reads, "an ordinary save armed a poll").toBe(afterPress);
  });
});
