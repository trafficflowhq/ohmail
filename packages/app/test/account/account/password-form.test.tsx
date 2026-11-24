/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createTranslator } from "use-intl/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FactorSlot, GatedAsk } from "../../../src/account/contract.js";
import type { PasswordDoor, PasswordModel } from "../../../src/account/account/password.js";
import { PasswordForm } from "../../../src/account/account/PasswordForm.js";
import { PASSWORD_STATES } from "../../../src/account/account/states.js";
import { usePassword } from "../../../src/account/account/use-password.js";
import type { StepUpDoor } from "../../../src/doors/step-up/door.js";
import { StepUpDialog } from "../../../src/doors/step-up/StepUpDialog.js";
import { fillOver, TextProvider, type Messages } from "../../../src/text/index.js";
import accountDe from "../../../messages/account.de.json" with { type: "json" };
import accountEn from "../../../messages/account.en.json" with { type: "json" };
import ownDe from "../../../messages/account-account.de.json" with { type: "json" };
import ownEn from "../../../messages/account-account.en.json" with { type: "json" };
import doorsEn from "../../../messages/doors.en.json" with { type: "json" };
import { changed, FACTOR, fakePasswordDoor, held, type ChangeAnswer } from "./fake-door.js";

afterEach(cleanup);

type Lang = "en" | "de";
const EN: Messages = { ...accountEn, ...ownEn };
const WORDS: Readonly<Record<Lang, Messages>> = { en: EN, de: fillOver(EN, { ...accountDe, ...ownDe }) };
/** A sentence by its namespace and key, filled by the catalogue's own formatter: a case names it, never words it. */
function said(
  namespace: string,
  key: string,
  values: Record<string, number> = {},
  lang: Lang = "en",
): string {
  if (typeof (WORDS[lang][namespace] as Record<string, unknown> | undefined)?.[key] !== "string")
    throw new Error(`no sentence ${namespace}.${key} in ${lang}`);
  const t = createTranslator({
    locale: lang,
    messages: WORDS[lang] as Parameters<typeof createTranslator>[0]["messages"],
    namespace: namespace as never,
    timeZone: "Europe/Zurich",
  });
  return t(key as never, values as never);
}
const pc = (key: string, values: Record<string, number> = {}, lang: Lang = "en") =>
  said("passwordChange", key, values, lang);
const seen = (words: string): boolean => (document.body.textContent ?? "").includes(words);

/* What a person types. Each is unlike the other and unlike any sentence, so a kept copy is found by its letters. */
const CURRENT = "kestrel-over-the-quarry-41";
const NEXT = "nine-lamps-in-a-wet-harbour";

const noFactor: FactorSlot = () => null;
const blank = (key: "currentLabel" | "nextLabel" | "repeatLabel", lang: Lang = "en") =>
  screen.getByLabelText(pc(key, {}, lang)) as HTMLInputElement;
const blanks = () => [blank("currentLabel"), blank("nextLabel"), blank("repeatLabel")];
const theVerb = () => screen.getByRole("button", { name: pc("submit") }) as HTMLButtonElement;
const type = (current: string, next: string, again = next) => {
  fireEvent.change(blank("currentLabel"), { target: { value: current } });
  fireEvent.change(blank("nextLabel"), { target: { value: next } });
  fireEvent.change(blank("repeatLabel"), { target: { value: again } });
};
/** A press on Change, and every answer it brings taken in. */
const press = () =>
  act(async () => {
    fireEvent.click(theVerb());
  });
/** Everything the page holds in an attribute or as words: where a typed value would be if it stayed. */
const onThePage = (): string => document.body.innerHTML;

function drawn(
  model: PasswordModel,
  { factor = noFactor, lang = "en" as Lang, onCancel = undefined as (() => void) | undefined } = {},
) {
  return render(
    <TextProvider locale={lang} messages={WORDS[lang]} timeZone="Europe/Zurich">
      <PasswordForm model={model} factor={factor} onCancel={onCancel} />
    </TextProvider>,
  );
}
/** The form over its hook and a door, as a shell mounts it. */
function Form({ door, factor }: { door: PasswordDoor; factor: FactorSlot }) {
  return <PasswordForm model={usePassword(door)} factor={factor} />;
}
function over(door: PasswordDoor, factor: FactorSlot = noFactor) {
  return render(
    <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
      <Form door={door} factor={factor} />
    </TextProvider>,
  );
}

describe("the form before the page's script has taken it", () => {
  it("is one form with no address and no method, and its blanks carry no name", () => {
    const { container } = drawn(PASSWORD_STATES.rest.model);
    const forms = container.querySelectorAll("form");
    expect(forms).toHaveLength(1);
    expect(forms[0]!.hasAttribute("action")).toBe(false);
    expect(forms[0]!.hasAttribute("method")).toBe(false);
    expect(container.querySelectorAll("[name]")).toHaveLength(0);
    expect(container.querySelectorAll("a[href], [data-testid]")).toHaveLength(0);
  });

  it("a password manager finds the blanks by their type and what each may be filled with", () => {
    drawn(PASSWORD_STATES.rest.model);
    expect(blanks().map((b) => [b.type, b.getAttribute("autocomplete")])).toEqual([
      ["password", "current-password"],
      ["password", "new-password"],
      ["password", "new-password"],
    ]);
    expect(new Set(blanks().map((b) => b.id)).size).toBe(3);
  });

  it("its press never leaves by the browser's own submit, and Enter in a blank presses Change", async () => {
    const door = fakePasswordDoor([changed(0)]);
    const { container } = over(door);
    type(CURRENT, NEXT);
    let browserSubmits = true;
    await act(async () => {
      browserSubmits = fireEvent.submit(container.querySelector("form")!);
    });
    expect(browserSubmits).toBe(false);
    expect(door.sent()).toEqual([[CURRENT, NEXT]]);
  });

  it("draws the factor's real dialog beside the form, never inside it: the dialog's form is its own", async () => {
    const door: StepUpDoor = {
      factors: () => Promise.resolve({ ok: true, factors: { passkey: false, code: true, recovery: false } }),
      verify: () => new Promise(() => {}),
    };
    const parked: PasswordModel = {
      sending: false,
      refusal: null,
      changed: null,
      nothingChanged: false,
      ask: { onVerified() {}, onCancel() {}, onDiscarded() {} },
      change() {},
    };
    const { container } = render(
      <TextProvider locale="en" messages={{ ...WORDS.en, ...doorsEn }} timeZone="Europe/Zurich">
        <PasswordForm model={parked} factor={(ask) => <StepUpDialog door={door} {...ask} />} />
      </TextProvider>,
    );
    await act(async () => {});
    // Control: the dialog is drawn, with its own form.
    expect(container.querySelectorAll("[role=dialog] form")).toHaveLength(1);
    expect(container.querySelectorAll("form form")).toHaveLength(0);
  });
});

describe("every attempt empties the three blanks", () => {
  it("when a typed check fails, and nothing is sent", async () => {
    const door = fakePasswordDoor([changed(0)]);
    over(door);
    type(CURRENT, NEXT, `${NEXT}x`);
    await press();
    expect(blanks().map((b) => b.value)).toEqual(["", "", ""]);
    expect(seen(pc("mismatch"))).toBe(true);
    expect(door.sent()).toEqual([]);
    expect(onThePage()).not.toContain(CURRENT);
    expect(onThePage()).not.toContain(NEXT);
  });

  it("when the server refuses, when it asks the factor, and when the change lands", async () => {
    const door = fakePasswordDoor([{ ok: false, word: "wrong_current" }, FACTOR, changed(2)]);
    const slot = { asked: null as GatedAsk | null };
    over(door, (ask) => {
      slot.asked = ask;
      return null;
    });
    type(CURRENT, NEXT);
    await press();
    expect(blanks().map((b) => b.value)).toEqual(["", "", ""]);
    expect(seen(pc("wrongCurrent"))).toBe(true);

    type(CURRENT, NEXT);
    await press();
    expect(blanks().map((b) => b.value)).toEqual(["", "", ""]);
    expect(slot.asked).not.toBeNull();
    expect(onThePage()).not.toContain(CURRENT);
    expect(onThePage()).not.toContain(NEXT);

    await act(async () => slot.asked!.onVerified());
    expect(door.sent()).toEqual([
      [CURRENT, NEXT],
      [CURRENT, NEXT],
      [CURRENT, NEXT],
    ]);
    expect(blanks().map((b) => b.value)).toEqual(["", "", ""]);
    expect(seen(pc("done", { count: 2 }))).toBe(true);
  });
});

describe("what the form says", () => {
  const at = (key: "currentLabel" | "nextLabel" | "repeatLabel") => blank(key).getAttribute("aria-invalid");

  it("a refusal about a blank at that blank", () => {
    for (const [state, key, where] of [
      [PASSWORD_STATES.needCurrent, "needCurrent", "currentLabel"],
      [PASSWORD_STATES.wrong, "wrongCurrent", "currentLabel"],
      [PASSWORD_STATES.tooShort, "tooShort", "nextLabel"],
      [PASSWORD_STATES.tooLong, "tooLong", "nextLabel"],
      [PASSWORD_STATES.same, "same", "nextLabel"],
      [PASSWORD_STATES.mismatch, "mismatch", "repeatLabel"],
    ] as const) {
      drawn(state.model);
      expect(seen(pc(key)), key).toBe(true);
      expect(at(where), key).toBe("true");
      expect(screen.queryByRole("status"), key).toBeNull();
      cleanup();
    }
  });

  it("any other refusal over its answer, said as it appears: the wait with its minutes", () => {
    for (const [state, sentence] of [
      [PASSWORD_STATES.locked, pc("locked", { minutes: 14 })],
      [PASSWORD_STATES.slowed, pc("slowed")],
      [PASSWORD_STATES.conflict, pc("conflict")],
      [PASSWORD_STATES.refused, pc("refused")],
      [PASSWORD_STATES.windowClosed, said("devices", "stepUpExpired")],
      [PASSWORD_STATES.cancelled, pc("cancelled")],
    ] as const) {
      drawn(state.model);
      expect(screen.getByRole("status").textContent, sentence).toContain(sentence);
      for (const key of ["currentLabel", "nextLabel", "repeatLabel"] as const) expect(at(key)).toBeNull();
      cleanup();
    }
  });

  it("the shell's own sentence as the shell said it", () => {
    drawn({ ...PASSWORD_STATES.rest.model, refusal: { word: "said", said: "You are offline." } });
    expect(screen.getByRole("status").textContent).toContain("You are offline.");
  });

  it("what a change costs while nothing is refused, and how many sessions a change ended", () => {
    drawn(PASSWORD_STATES.rest.model);
    expect(seen(pc("lead"))).toBe(true);
    expect(seen(pc("nextHint"))).toBe(true);
    cleanup();
    for (const [state, count] of [
      [PASSWORD_STATES.done, 2],
      [PASSWORD_STATES.doneOne, 1],
      [PASSWORD_STATES.doneNone, 0],
    ] as const) {
      drawn(state.model);
      expect(seen(pc("done", { count })), String(count)).toBe(true);
      cleanup();
    }
  });

  it("is off while the change is on its way, and says so", async () => {
    const answer = held<ChangeAnswer>();
    const door = fakePasswordDoor([answer.promise]);
    over(door);
    type(CURRENT, NEXT);
    await press();
    const working = screen.getByRole("button", { name: pc("working") }) as HTMLButtonElement;
    expect(working.disabled).toBe(true);
    // A password blank of the kit always takes keys unless it is disabled: off takes no keys and is said unavailable.
    expect(blanks().map((b) => b.disabled)).toEqual([true, true, true]);
    await act(async () => answer.settle(changed(0)));
    expect(theVerb().disabled).toBe(false);
    expect(blanks().map((b) => b.disabled)).toEqual([false, false, false]);
  });

  it("hands the factor's dialog the line that says the change leaves the moment it verifies", () => {
    const factor: FactorSlot = vi.fn(() => <p>the factor</p>);
    drawn(PASSWORD_STATES.rest.model, { factor });
    expect(factor).not.toHaveBeenCalled();
    cleanup();
    drawn(PASSWORD_STATES.factor.model, { factor });
    expect(factor).toHaveBeenCalledWith({ ...PASSWORD_STATES.factor.model.ask, line: pc("factorBody") });
    expect(seen("the factor")).toBe(true);
  });

  it("offers a way out only where the place that draws it has one", () => {
    drawn(PASSWORD_STATES.rest.model);
    expect(screen.queryByRole("button", { name: said("accountOwn", "cancel") })).toBeNull();
    cleanup();
    const onCancel = vi.fn();
    drawn(PASSWORD_STATES.rest.model, { onCancel });
    fireEvent.click(screen.getByRole("button", { name: said("accountOwn", "cancel") }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("reads German where the catalogue is German", () => {
    drawn(PASSWORD_STATES.locked.model, { lang: "de" });
    expect(blank("currentLabel", "de")).toBeTruthy();
    expect(seen(pc("locked", { minutes: 14 }, "de"))).toBe(true);
    expect(seen(pc("locked", { minutes: 14 }))).toBe(false);
  });
});
