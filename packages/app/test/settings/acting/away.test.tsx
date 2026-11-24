/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AWAY_START,
  AWAY_STATE_PILES,
  AWAY_STATE_RULES as RULES,
  AwayPane,
  awayPileChoices,
  awayStates,
  awayStep,
  awayUnsaved,
  type AwayEvent,
  type AwayModel,
  type AwayRow,
  type AwayState,
} from "../../../src/settings/away/index.js";
import { drawn, said } from "./words.js";

afterEach(cleanup);

const seen = (words: string) => (document.body.textContent ?? "").includes(words);
const isOff = (el: HTMLElement) => (el as HTMLButtonElement).disabled;
const away = (key: string, lang: "en" | "de" = "en") => said(lang, "away", key);

const ROW: AwayRow = {
  enabled: false,
  body: "Back on Monday.",
  startsAt: null,
  endsAt: null,
  audience: "screened_in",
  throttle: "per_day",
  piles: ["INBOX"],
};
const run = (from: AwayState, ...events: AwayEvent[]) => events.reduce((s, e) => awayStep(s, e, RULES), from);
const loaded = run(AWAY_START, { kind: "loaded", row: ROW, refused: null });
const NOW = Date.parse("2026-11-16T09:00:00Z");
const STATES = awayStates({ body: "Back on Monday.", date: "Fri 20 Nov 2026", host: "the laptop" });

describe("the responder's rules, as the shipped pane holds them", () => {
  it("a press on the switch is an edit: nothing is written, and the stored responder stays off", () => {
    const pressed = run(loaded, { kind: "edit", patch: { enabled: true } });
    expect(pressed.pending).toBe(false);
    expect(pressed.saved?.enabled).toBe(false);
    expect(awayUnsaved(pressed.draft!, pressed.saved!, RULES)).toBe(true);
  });

  it("refuses at Save, before any write, a responder turned on with no message or an end date gone", () => {
    const empty = run(
      loaded,
      { kind: "edit", patch: { enabled: true, body: "  " } },
      { kind: "save", now: NOW },
    );
    expect(empty).toMatchObject({ pending: false, outcome: { kind: "incomplete" } });
    const gone = run(
      loaded,
      { kind: "edit", patch: { enabled: true, endsAt: "2026-11-15T22:59:59Z" } },
      { kind: "save", now: NOW },
    );
    expect(gone).toMatchObject({ pending: false, outcome: { kind: "expired" } });
  });

  it("says Saved for a write here, and not saved here for a change that travelled", () => {
    const on = { ...ROW, enabled: true };
    const asking = run(loaded, { kind: "edit", patch: { enabled: true } }, { kind: "save", now: NOW });
    expect(asking).toMatchObject({ pending: true, asked: on });
    expect(run(asking, { kind: "echoed", row: on, travelled: false }).outcome).toEqual({ kind: "saved" });
    const travelled = run(asking, { kind: "echoed", row: ROW, travelled: true });
    expect(travelled).toMatchObject({ outcome: { kind: "asked" }, saved: ROW, draft: ROW });
  });

  it("keeps a typed message when the write is refused, and says the stored responder", () => {
    const refused = run(
      loaded,
      { kind: "edit", patch: { enabled: true, body: "Away until the 20th." } },
      { kind: "save", now: NOW },
      { kind: "refusedWrite" },
    );
    expect(refused.draft?.body).toBe("Away until the 20th.");
    expect(refused).toMatchObject({ pending: false, outcome: { kind: "failed" }, saved: ROW });
  });

  it("tells the request applied from a row another install changed, and keeps an edit made meanwhile", () => {
    const on = { ...ROW, enabled: true };
    const travelled = run(
      loaded,
      { kind: "edit", patch: { enabled: true } },
      { kind: "save", now: NOW },
      { kind: "echoed", row: ROW, travelled: true },
    );
    expect(run(travelled, { kind: "heard", row: on, refused: null })).toMatchObject({
      outcome: { kind: "applied" },
      draft: on,
    });
    const other = { ...ROW, throttle: "per_week" as const };
    expect(run(travelled, { kind: "heard", row: other, refused: null }).outcome).toEqual({
      kind: "changedElsewhere",
    });
    const editing = run(
      travelled,
      { kind: "edit", patch: { body: "Mine." } },
      { kind: "heard", row: on, refused: null },
    );
    expect(editing.draft?.body).toBe("Mine.");
    expect(editing.saved).toEqual(on);
  });

  it("says the holder's refusal, read at load or while the change travels", () => {
    const by = { holder: "the laptop", refusal: "other" as const };
    expect(run(AWAY_START, { kind: "loaded", row: ROW, refused: by }).outcome).toEqual({
      kind: "refused",
      by,
    });
    expect(run(loaded, { kind: "heard", row: null, refused: by }).outcome).toEqual({ kind: "refused", by });
  });

  it("drops the Screener when the audience narrows to the people let in", () => {
    const everyone = run(loaded, {
      kind: "edit",
      patch: { audience: "everyone", piles: ["INBOX", "ohmail/Screener"] },
    });
    expect(everyone.draft?.piles).toEqual(["INBOX", "ohmail/Screener"]);
    expect(run(everyone, { kind: "edit", patch: { audience: "screened_in" } }).draft?.piles).toEqual([
      "INBOX",
    ]);
  });

  it("takes a discard back to the stored row", () => {
    expect(run(loaded, { kind: "edit", patch: { body: "x" } }, { kind: "discard" }).draft).toEqual(ROW);
  });
});

describe("the piles the control offers", () => {
  it("answers the Screener only with everyone, and the Ohbox always while it is answered", () => {
    const narrow = awayPileChoices(AWAY_STATE_PILES, { ...ROW, piles: ["INBOX", "ohmail/Screener"] }, RULES);
    expect(narrow.find((c) => c.word === "screener")).toMatchObject({ on: false, audienceLocked: true });
    expect(narrow.find((c) => c.word === "ohbox")).toMatchObject({ on: true, fixed: true });
    const wide = awayPileChoices(
      AWAY_STATE_PILES,
      { ...ROW, audience: "everyone", piles: ["INBOX", "ohmail/Screener"] },
      RULES,
    );
    expect(wide.find((c) => c.word === "screener")).toMatchObject({ on: true, audienceLocked: false });
  });
});

describe("the Away pane", () => {
  const model = (more: Partial<AwayModel>): AwayModel => ({ ...STATES.rest.model, ...more });

  it("edits on a press of the switch, never saves, and says the stored responder is off until Save", () => {
    const edit = vi.fn();
    const save = vi.fn();
    drawn(<AwayPane model={model({ edit, save })} rules={RULES} />);
    fireEvent.click(screen.getByRole("switch", { name: away("title") }));
    expect(edit.mock.calls).toEqual([[{ enabled: true }]]);
    expect(save).not.toHaveBeenCalled();
    cleanup();
    drawn(<AwayPane model={STATES.unsavedoff.model} rules={RULES} />);
    expect(seen(away("off"))).toBe(true);
    expect(seen(away("unsavedStillOff"))).toBe(true);
    expect(seen(said("en", "settings", "notSaved"))).toBe(true);
  });

  it("opens and closes the current reply-pile explanation without moving focus", () => {
    const edit = vi.fn();
    drawn(<AwayPane model={model({ edit })} rules={RULES} />);
    const trigger = screen.getByRole("button", { name: away("never") });
    const hint = trigger.closest(".away-piles-hint");
    expect(hint).not.toBeNull();
    const explanation = Array.from(hint!.children).find((node) => node.tagName === "SPAN");
    expect(explanation?.textContent).toBe(away("never"));
    expect(explanation?.hasAttribute("hidden")).toBe(true);

    act(() => trigger.focus());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(explanation?.hasAttribute("hidden")).toBe(false);
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(explanation?.hasAttribute("hidden")).toBe(true);
    expect(document.activeElement).toBe(trigger);
    expect(edit).not.toHaveBeenCalled();
  });

  it("asks before a held leave drops the edit", () => {
    const discard = vi.fn();
    const keep = vi.fn();
    drawn(<AwayPane model={{ ...STATES.leave.model, discard, keep }} rules={RULES} />);
    expect(seen(away("leaveAsk"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: away("leaveKeep") }));
    fireEvent.click(screen.getByRole("button", { name: away("leaveDiscard") }));
    expect(keep).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it("says a refused save by the responder that is stored", () => {
    drawn(<AwayPane model={STATES.failedon.model} rules={RULES} />);
    expect(seen(away("failedStillOn"))).toBe(true);
    cleanup();
    drawn(<AwayPane model={STATES.failedoff.model} rules={RULES} />);
    expect(seen(away("failedStillOff"))).toBe(true);
  });

  it("holds the Screener's pile unless everyone gets a reply, and the Ohbox's while it is answered", () => {
    drawn(<AwayPane model={STATES.rest.model} rules={RULES} />);
    expect(isOff(screen.getByRole("button", { name: away("pileScreener") }))).toBe(true);
    expect(isOff(screen.getByRole("button", { name: away("pileOhbox") }))).toBe(true);
    expect(isOff(screen.getByRole("button", { name: away("pileReads") }))).toBe(false);
  });

  it("adds a pile in the engine's order with a press", () => {
    const edit = vi.fn();
    drawn(<AwayPane model={model({ edit })} rules={RULES} />);
    fireEvent.click(screen.getByRole("button", { name: away("pileReceipts") }));
    expect(edit.mock.calls).toEqual([[{ piles: ["INBOX", "ohmail/Receipts"] }]]);
  });

  it("says nothing but that the row could not be read", () => {
    drawn(<AwayPane model={STATES.unread.model} rules={RULES} />);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(seen(away("unreachable"))).toBe(true);
  });

  it("says where the replies leave from where it is not the service", () => {
    drawn(<AwayPane model={STATES.local.model} rules={RULES} />);
    expect(seen(away("localNote"))).toBe(true);
    cleanup();
    drawn(<AwayPane model={STATES.host.model} rules={RULES} />);
    expect(seen(away("hostNote").replace("{host}", "the laptop"))).toBe(true);
    cleanup();
    drawn(<AwayPane model={STATES.rest.model} rules={RULES} />);
    expect(seen(away("localNote"))).toBe(false);
  });

  it("opens the date picker at its slot, clears a date, and takes a rate from the menu", () => {
    const edit = vi.fn();
    const pickEnd = vi.fn();
    drawn(<AwayPane model={{ ...STATES.past.model, edit, pickEnd }} rules={RULES} />);
    expect(seen(away("untilPast").replace("{date}", "Fri 20 Nov 2026"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: away("untilPick") }));
    expect(pickEnd).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: away("untilClear") }));
    fireEvent.click(screen.getByRole("button", { name: away("throttleLabel") }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: away("per_week") }));
    expect(edit.mock.calls).toEqual([[{ endsAt: null }], [{ throttle: "per_week" }]]);
  });

  it("reads German where the catalogue is German", () => {
    drawn(<AwayPane model={STATES.unsavedon.model} rules={RULES} />, "de");
    expect(seen(away("unsavedStillOn", "de"))).toBe(true);
    expect(screen.getByRole("switch", { name: away("title", "de") })).toBeTruthy();
  });
});
