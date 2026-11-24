/** @vitest-environment jsdom */
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NONE } from "../../src/host/contract.js";
import { TextProvider } from "../../src/text/index.js";
import {
  SetupPage,
  SETUP_STATES,
  type SetupDoor,
  type SetupField,
  type SetupState,
} from "../../src/doors/setup/index.js";
import en from "../../messages/doors.en.json" with { type: "json" };
import de from "../../messages/doors.de.json" with { type: "json" };

/**
 * THE SERVER SETUP draws the state the door's ceremony is at and hands back what a person types; every press is the
 * door's act. The token and the first account are blanks in the page's two sentences, as the design draws them.
 * Controls are found by role and name.
 */
type Words = typeof en;
const S = en.setup;
const EMPTY = { token: "", email: "", name: "", password: "" } as const;

function acts() {
  return {
    submit: vi.fn(),
    retry: vi.fn(),
    signIn: vi.fn(),
    type: vi.fn(),
    copy: vi.fn((_text: string) => Promise.resolve(true)),
  };
}

/** A door whose blanks the page fills, as the shell's ceremony keeps them. */
function Harness(p: {
  state: SetupState;
  acts: ReturnType<typeof acts>;
  start?: Partial<Record<SetupField, string>>;
}) {
  const [fields, setFields] = useState({ ...EMPTY, ...p.start });
  const door: SetupDoor = {
    state: p.state,
    fields,
    type: (field, value) => {
      p.acts.type(field, value);
      setFields((was) => ({ ...was, [field]: value }));
    },
    submit: p.acts.submit,
    retry: p.acts.retry,
    signIn: p.acts.signIn,
    copy: p.acts.copy,
  };
  return <SetupPage door={door} />;
}

function draw(state: SetupState, words: Words = en, locale: "en" | "de" = "en", start = {}) {
  const a = acts();
  const view = render(
    <TextProvider locale={locale} messages={words as never} timeZone="UTC">
      <Harness state={state} acts={a} start={start} />
    </TextProvider>,
  );
  return { view, acts: a };
}

const form = (busy = false, refusal: string | null = null, tokenRefused = false): SetupState => ({
  at: "form",
  busy,
  refusal,
  tokenRefused,
});
const ink = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`^${name}`) }) as HTMLButtonElement;
const blank = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
/** The page's sentences, as a person reads them: what is said to nobody left out. */
const sentences = (): string[] =>
  [...document.querySelectorAll("main p.oh-sentence")].map((p) => {
    const read = p.cloneNode(true) as HTMLElement;
    read.querySelectorAll("[hidden], [aria-hidden='true']").forEach((hidden) => hidden.remove());
    return (read.textContent ?? "").replace(/\s+/g, " ").trim();
  });
const type = (label: string, value: string) => fireEvent.change(blank(label), { target: { value } });
const refused = (label: string): boolean => blank(label).getAttribute("aria-invalid") === "true";
const READY = { token: "tok", email: "op@example.org", name: "Op", password: "p".repeat(12) } as const;

beforeEach(() => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("the setup page", () => {
  it("checking: says it is asking the server, and offers nothing to press or fill", () => {
    const { view } = draw({ at: "checking" });
    expect(view.container.textContent).toContain(S.checking.replace(/\.$/, ""));
    expect(view.container.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(document.querySelectorAll("input")).toHaveLength(0);
  });

  it("unreachable: says the server did not answer, and Try again asks it again", () => {
    const { acts: a } = draw({ at: "unreachable" });
    expect(sentences()).toEqual([S.unreachableTitle]);
    expect(document.body.textContent).toContain(S.unreachableBody);
    fireEvent.click(ink(S.retry));
    expect(a.retry).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll("input")).toHaveLength(0);
  });

  it("settled: says the server is set up, and Sign in is the one way on", () => {
    const { acts: a } = draw({ at: "settled" });
    expect(sentences()).toEqual([S.settledTitle.replace(/\.$/, "")]);
    expect(document.body.textContent).toContain(S.settledBody);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([S.signIn]);
    fireEvent.click(ink(S.signIn));
    expect(a.signIn).toHaveBeenCalledTimes(1);
  });

  it("form: the token and the first account are blanks in two sentences, at the first of five steps, with where the token is", () => {
    const { acts: a } = draw(form());
    expect(sentences()).toEqual(["This server’s setup token is", "I’m , at , with a password of"]);
    expect(document.body.textContent).not.toContain(S.title);
    expect(screen.getByRole("img", { name: "Step 1 of 5, Account, 1 of 3" })).toBeTruthy();
    /* Where the token is: on a sheet beside the form, the command and its Copy, and how to find it in the log. */
    expect(screen.getByRole("heading", { name: S.tokenWhere })).toBeTruthy();
    expect(document.body.textContent).toContain("docker compose logs api");
    expect(document.body.textContent).toContain(S.tokenFine);
    expect(document.body.textContent).toContain(S.signInHere);
    expect(
      [blank(S.tokenLabel), blank(S.nameLabel), blank(S.emailLabel), blank(S.passwordLabel)].map((f) => [
        f.type,
        f.autocomplete,
        f.name,
        f.placeholder,
      ]),
    ).toEqual([
      ["text", "off", "", "paste it"],
      ["text", "name", "", "name"],
      ["text", "email", "", "email address"],
      ["password", "new-password", "", "12 characters or more"],
    ]);
    expect(blank(S.emailLabel).inputMode).toBe("email");
    fireEvent.click(screen.getByRole("button", { name: S.copy }));
    expect(a.copy).toHaveBeenCalledWith("docker compose logs api");
  });

  it("form: Copy says it copied, for a moment, only once the command got there", async () => {
    const { acts: a } = draw(form());
    fireEvent.click(screen.getByRole("button", { name: S.copy }));
    expect(await screen.findByRole("button", { name: S.copied })).toBeTruthy();
    expect(a.copy).toHaveBeenCalledTimes(1);
    cleanup();
    const notCopied = draw(form());
    notCopied.acts.copy.mockImplementation(() => Promise.resolve(false));
    fireEvent.click(screen.getByRole("button", { name: S.copy }));
    await act(async () => {});
    expect(notCopied.acts.copy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: S.copied })).toBeNull();
  });

  it("form: the ink button is live; a press sends nothing until the token, the name, the address and twelve characters are typed, and says which", () => {
    const { acts: a } = draw(form());
    const press = () => ink(S.createAccount);
    expect(press().disabled).toBe(false);
    fireEvent.click(press());
    expect(a.submit).not.toHaveBeenCalled();
    expect(refused(S.tokenLabel)).toBe(true);
    type(S.tokenLabel, "tok");
    type(S.nameLabel, "Op");
    type(S.emailLabel, "op@example.org");
    type(S.passwordLabel, "a".repeat(11));
    fireEvent.click(press());
    expect(a.submit).not.toHaveBeenCalled();
    expect([refused(S.tokenLabel), refused(S.passwordLabel)]).toEqual([false, true]);
    type(S.passwordLabel, " ".repeat(2) + "a".repeat(10));
    // What was typed is handed back as typed: only the ceremony trims.
    expect(a.type).toHaveBeenLastCalledWith("password", "  " + "a".repeat(10));
    fireEvent.click(press());
    expect(a.submit).toHaveBeenCalledTimes(1);
  });

  it("form: Enter in a blank sends the form once, through the door", () => {
    const { acts: a } = draw(form(), en, "en", READY);
    fireEvent.submit(blank(S.passwordLabel).form!);
    expect(a.submit).toHaveBeenCalledTimes(1);
  });

  it("form, while it is sent: the button says so and cannot be pressed again", () => {
    draw(form(true), en, "en", READY);
    expect(ink(S.working).disabled).toBe(true);
  });

  it("badtoken and spent: the refusal is said, the blanks keep what was typed, and a refused token says so", () => {
    for (const [said, tokenRefused] of [
      [S.badToken, true],
      [S.tokenSpent.replace("{email}", "other@example.org"), false],
    ] as const) {
      draw(form(false, said, tokenRefused), en, "en", { token: "kept-token", email: "op@example.org" });
      expect(screen.getByRole("alert").textContent).toBe(said);
      expect(blank(S.tokenLabel).value).toBe("kept-token");
      expect(blank(S.emailLabel).value).toBe("op@example.org");
      expect(refused(S.tokenLabel)).toBe(tokenRefused);
      cleanup();
    }
    expect(S.badToken).toContain("server log");
  });

  it("no server behind this build: says so, and offers nothing", () => {
    render(
      <TextProvider locale="en" messages={en as never} timeZone="UTC">
        <SetupPage door={NONE} />
      </TextProvider>,
    );
    expect(document.body.textContent).toContain(en.gate.lede.replace(/\.$/, ""));
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(document.querySelectorAll("input")).toHaveLength(0);
  });

  it("speaks German where the catalogue is German", () => {
    draw(form(), de, "de");
    expect(sentences()).toEqual(["Das Setup-Token dieses Servers ist", "Ich bin , unter , mit dem Passwort"]);
    expect(blank(de.setup.tokenLabel)).toBeTruthy();
    expect(ink(de.setup.createAccount)).toBeTruthy();
  });

  it("names its states by the reference's address", () => {
    expect([...SETUP_STATES]).toEqual(["checking", "form", "badtoken", "spent", "settled", "unreachable"]);
  });
});
