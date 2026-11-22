/** @vitest-environment jsdom */
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NONE } from "../../src/host/contract.js";
import { TextProvider } from "../../src/text/index.js";
import {
  VerifyPage,
  VERIFY_STATES,
  type VerifyDoor,
  type VerifyField,
  type VerifyState,
} from "../../src/doors/verify/index.js";
import en from "../../messages/doors.en.json" with { type: "json" };
import de from "../../messages/doors.de.json" with { type: "json" };

/**
 * THE EMAIL CONFIRMATION draws the state the door's ceremony is at and hands back what a person types. The link's
 * code is the ceremony's: a blank for a code stands only where the link brought none. The password is a blank in the
 * page's sentence, as the design draws it. Controls are found by role and name.
 */
type Words = typeof en;
const V = en.verify;
const PASSWORD = ["a", "long", "password", "typed"].join("-");
const SIGN_OUT = "Sign out";
const PENDING_SAID = "The sign-out did not reach the server.";

function acts() {
  return { submit: vi.fn(), type: vi.fn(), again: vi.fn(), signIn: vi.fn(), newLink: vi.fn() };
}

function Harness(p: {
  state: VerifyState;
  acts: ReturnType<typeof acts>;
  start?: Partial<Record<VerifyField, string>>;
  pending?: { said: string | null; signingOut?: boolean };
}) {
  const [fields, setFields] = useState({ code: "", password: "", ...p.start });
  const door: VerifyDoor = {
    state: p.state,
    fields,
    type: (field, value) => {
      p.acts.type(field, value);
      setFields((was) => ({ ...was, [field]: value }));
    },
    submit: p.acts.submit,
    signIn: p.acts.signIn,
    newLink: p.acts.newLink,
    pending: {
      said: p.pending?.said ?? null,
      act: SIGN_OUT,
      signingOut: p.pending?.signingOut ?? false,
      again: p.acts.again,
    },
  };
  return <VerifyPage door={door} />;
}

function draw(
  state: VerifyState,
  o: {
    words?: Words;
    locale?: "en" | "de";
    start?: Partial<Record<VerifyField, string>>;
    pending?: { said: string | null; signingOut?: boolean };
  } = {},
) {
  const a = acts();
  const view = render(
    <TextProvider locale={o.locale ?? "en"} messages={(o.words ?? en) as never} timeZone="UTC">
      <Harness state={state} acts={a} start={o.start} pending={o.pending} />
    </TextProvider>,
  );
  return { view, acts: a };
}

/** The form, as the link opened it (the link brought its code), or as the person must paste the code. */
const form = (o: Partial<Omit<Extract<VerifyState, { at: "form" }>, "at">> = {}): VerifyState => ({
  at: "form",
  asksCode: false,
  codeHeld: true,
  busy: false,
  refusal: null,
  passwordRefused: false,
  ...o,
});
const named = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`^${name}`) }) as HTMLButtonElement;
const blank = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const type = (label: string, value: string) => fireEvent.change(blank(label), { target: { value } });
/** The page's sentences, as a person reads them: what is said to nobody left out. */
const sentences = (): string[] =>
  [...document.querySelectorAll("main p.oh-sentence")].map((p) => {
    const read = p.cloneNode(true) as HTMLElement;
    read.querySelectorAll("[hidden], [aria-hidden='true']").forEach((hidden) => hidden.remove());
    return (read.textContent ?? "").trim();
  });
const refused = (label: string): boolean => blank(label).getAttribute("aria-invalid") === "true";

beforeEach(() => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("the email confirmation", () => {
  it("form: one sentence with the password as its blank, where the link brought its code, and why it is asked", () => {
    draw(form());
    expect(sentences()).toEqual(["Confirm my email address with password"]);
    const password = blank(V.passwordLabel);
    /* The blank keeps the shipped name: the kept sign-up run finds it by it (signup-journey.e2e.test.ts). */
    expect(V.passwordLabel).toBe("Your password");
    expect([password.type, password.autocomplete, password.name, password.placeholder]).toEqual([
      "password",
      "current-password",
      "",
      "type it",
    ]);
    expect(screen.queryByLabelText(V.tokenLabel)).toBeNull();
    expect(document.body.textContent).toContain("It is the password you chose when you signed up.");
    // Why a password is asked on a mailed link: an honest page says it, or it reads as a phishing page.
    expect(document.body.textContent).not.toContain("the link on its own is not enough");
  });

  it("form: Confirm is live; a press with nothing typed sends nothing and says what is wanted; typed, it sends once", () => {
    const { acts: a } = draw(form());
    expect(named(V.confirm).disabled).toBe(false);
    fireEvent.click(named(V.confirm));
    expect(a.submit).not.toHaveBeenCalled();
    expect(refused(V.passwordLabel)).toBe(true);
    type(V.passwordLabel, PASSWORD);
    expect(a.type).toHaveBeenCalledWith("password", PASSWORD);
    fireEvent.click(named(V.confirm));
    expect(a.submit).toHaveBeenCalledTimes(1);
  });

  it("form: Enter in the blank sends through the door; while it is sent the button cannot be pressed again", () => {
    const { acts: a } = draw(form(), { start: { password: PASSWORD } });
    fireEvent.submit(blank(V.passwordLabel).form!);
    expect(a.submit).toHaveBeenCalledTimes(1);
    cleanup();
    draw(form({ busy: true }), { start: { password: PASSWORD } });
    expect(named(V.working).disabled).toBe(true);
  });

  it("code: where the link brought none, two sentences, the code first, and nothing is sent without both halves", () => {
    const { acts: a } = draw(form({ asksCode: true, codeHeld: false }), { start: { password: PASSWORD } });
    expect(sentences()).toEqual(["The code from my email is", "My password is"]);
    const code = blank(V.tokenLabel);
    expect([code.type, code.autocomplete, code.placeholder]).toEqual(["text", "off", "paste it"]);
    fireEvent.click(named(V.confirm));
    expect(a.submit).not.toHaveBeenCalled();
    expect(refused(V.tokenLabel)).toBe(true);
    type(V.tokenLabel, "abc123");
    expect(a.type).toHaveBeenCalledWith("code", "abc123");
    cleanup();
    const both = draw(form({ asksCode: true, codeHeld: true }), {
      start: { code: "abc123", password: PASSWORD },
    });
    expect(blank(V.tokenLabel).value).toBe("abc123");
    fireEvent.click(named(V.confirm));
    expect(both.acts.submit).toHaveBeenCalledTimes(1);
  });

  it("badlink: the one sentence for every dead link, Confirm off whatever is typed, and the sign-in for a new link", () => {
    const { acts: a } = draw(form({ codeHeld: false, refusal: V.refusedLink }), {
      start: { password: PASSWORD },
    });
    expect(screen.getByRole("alert").textContent).toBe(V.refusedLink);
    expect(named(V.confirm).disabled).toBe(true);
    fireEvent.submit(blank(V.passwordLabel).form!);
    expect(a.submit).not.toHaveBeenCalled();
    expect(V.signIn).toBe("Sign in for a new link");
    fireEvent.click(named(V.signIn));
    expect(a.newLink).toHaveBeenCalledTimes(1);
    expect(a.signIn).not.toHaveBeenCalled();
  });

  it("badpw: the refusal is said, the blank says it was refused, the password typed is kept, and Confirm presses again", () => {
    const { acts: a } = draw(form({ refusal: V.refusedPassword, passwordRefused: true }), {
      start: { password: PASSWORD },
    });
    expect(screen.getByRole("alert").textContent).toBe(V.refusedPassword);
    expect(refused(V.passwordLabel)).toBe(true);
    expect(blank(V.passwordLabel).value).toBe(PASSWORD);
    fireEvent.click(named(V.confirm));
    expect(a.submit).toHaveBeenCalledTimes(1);
  });

  it("locked, slowed: the refusal is said, the blank is not the one at fault, and Confirm presses again", () => {
    for (const said of [en.login.tooManyAttempts, en.login.signInSlowed]) {
      const { acts: a } = draw(form({ refusal: said }), { start: { password: PASSWORD } });
      expect(screen.getByRole("alert").textContent).toBe(said);
      expect(refused(V.passwordLabel)).toBe(false);
      fireEvent.click(named(V.confirm));
      expect(a.submit).toHaveBeenCalledTimes(1);
      cleanup();
    }
  });

  it("a sign-out that ended unconfirmed is said first, and Sign out asks again; nothing is sent meanwhile", () => {
    const { acts: a } = draw(form({ refusal: V.refusedPassword, passwordRefused: true }), {
      start: { password: PASSWORD },
      pending: { said: PENDING_SAID },
    });
    expect(screen.getAllByRole("alert").map((p) => p.textContent)).toEqual([PENDING_SAID, V.refusedPassword]);
    fireEvent.click(named(SIGN_OUT));
    expect(a.again).toHaveBeenCalledTimes(1);
    cleanup();
    draw(form(), { start: { password: PASSWORD }, pending: { said: PENDING_SAID, signingOut: true } });
    expect(named(V.confirm).disabled).toBe(true);
    expect(named(SIGN_OUT).disabled).toBe(true);
  });

  it("done: my email address is confirmed, and Sign in is the one way on", () => {
    const { acts: a } = draw({ at: "done" });
    expect(sentences()).toEqual(["My email address is confirmed"]);
    expect(document.body.textContent).toContain("Sign in to carry on where you left off.");
    expect(screen.queryAllByRole("textbox")).toEqual([]);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Sign in"]);
    fireEvent.click(named(V.signInDone));
    expect(a.signIn).toHaveBeenCalledTimes(1);
    expect(a.newLink).not.toHaveBeenCalled();
  });

  it("handed: the setup goes on in the other tab, said as it appears, and nothing to press", () => {
    draw({ at: "handed" });
    expect(sentences()).toEqual(["My email address is confirmed"]);
    expect(document.body.textContent).toContain("Setup carries on in the tab where you started it.");
    expect(document.body.textContent).toContain("You can close this one.");
    expect(screen.getByRole("status").textContent).toBe(V.handedOff);
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(document.querySelectorAll("input")).toHaveLength(0);
  });

  it("unavailable, and a build with no server: not available here, and nothing to fill or press", () => {
    for (const door of ["state", "none"] as const) {
      if (door === "state") draw({ at: "unavailable" });
      else
        render(
          <TextProvider locale="en" messages={en as never} timeZone="UTC">
            <VerifyPage door={NONE} />
          </TextProvider>,
        );
      expect(sentences()).toEqual([V.unavailableTitle]);
      expect(document.body.textContent).toContain(V.unavailableBody);
      expect(document.querySelectorAll("input")).toHaveLength(0);
      expect(screen.queryAllByRole("button")).toEqual([]);
      cleanup();
    }
  });

  it("carries the small mark of a page opened cold at its top, said to nobody", () => {
    draw(form());
    const mark = screen.getByText("oh");
    expect(mark.closest("header")).not.toBeNull();
    expect(mark.closest("[aria-hidden='true']")).not.toBeNull();
  });

  it("speaks German where the catalogue is German", () => {
    draw(form({ asksCode: true, codeHeld: false }), { words: de, locale: "de" });
    expect(sentences()).toEqual(["Der Code aus meiner E-Mail ist", "Mein Passwort ist"]);
    expect(blank(de.verify.tokenLabel)).toBeTruthy();
    expect(blank(de.verify.passwordLabel)).toBeTruthy();
    expect(named(de.verify.confirm)).toBeTruthy();
    expect(named(de.verify.signIn)).toBeTruthy();
  });

  it("names its states by the reference's address", () => {
    expect([...VERIFY_STATES]).toEqual([
      "form",
      "code",
      "badlink",
      "badpw",
      "locked",
      "slowed",
      "done",
      "handed",
      "unavailable",
    ]);
  });
});
