/** @vitest-environment jsdom */
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NONE } from "../../src/host/contract.js";
import { TextProvider } from "../../src/text/index.js";
import {
  InvitePage,
  INVITE_STATES,
  type InviteDoor,
  type InviteField,
  type InviteState,
} from "../../src/doors/invite/index.js";
import en from "../../messages/doors.en.json" with { type: "json" };
import de from "../../messages/doors.de.json" with { type: "json" };

/**
 * THE HOUSEHOLD INVITE draws the state the door's ceremony is at and hands back what a person types. The link's
 * secret is the ceremony's: no door hands it to the page. The account's three blanks stand in the page's sentence, as
 * the design draws it. Controls are found by role and name.
 */
type Words = typeof en;
const I = en.joinInvite;
const READY = { email: "mara@family.example", name: "Mara", password: "p".repeat(12) } as const;
const SIGN_OUT = "Sign out";
const PENDING_SAID = "The sign-out did not reach the server.";

function acts() {
  return { submit: vi.fn(), type: vi.fn(), again: vi.fn() };
}

function Harness(p: {
  state: InviteState;
  acts: ReturnType<typeof acts>;
  start?: Partial<Record<InviteField, string>>;
  pending?: { said: string | null; signingOut?: boolean };
}) {
  const [fields, setFields] = useState({ email: "", name: "", password: "", ...p.start });
  const door: InviteDoor = {
    state: p.state,
    fields,
    type: (field, value) => {
      p.acts.type(field, value);
      setFields((was) => ({ ...was, [field]: value }));
    },
    submit: p.acts.submit,
    pending: {
      said: p.pending?.said ?? null,
      act: SIGN_OUT,
      signingOut: p.pending?.signingOut ?? false,
      again: p.acts.again,
    },
  };
  return <InvitePage door={door} />;
}

function draw(
  state: InviteState,
  o: {
    words?: Words;
    locale?: "en" | "de";
    start?: Partial<Record<InviteField, string>>;
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

const form = (busy = false, refusal: string | null = null): InviteState => ({ at: "form", busy, refusal });
const named = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`^${name}`) }) as HTMLButtonElement;
const blank = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const type = (label: string, value: string) => fireEvent.change(blank(label), { target: { value } });
/** The page's sentences, as a person reads them: what is said to nobody left out. */
const sentences = (): string[] =>
  [...document.querySelectorAll("main p.oh-sentence")].map((p) => {
    const read = p.cloneNode(true) as HTMLElement;
    read.querySelectorAll("[hidden], [aria-hidden='true']").forEach((hidden) => hidden.remove());
    return (read.textContent ?? "").replace(/\s+/g, " ").trim();
  });
const refused = (label: string): boolean => blank(label).getAttribute("aria-invalid") === "true";

beforeEach(() => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("the household invite", () => {
  it("opening: says the invite is being opened, ending in the waiting dot, with nothing to press or fill", () => {
    const { view } = draw({ at: "opening" });
    expect(sentences()).toEqual(["Opening your invite"]);
    expect(view.container.querySelector("main p .oh-dot")).not.toBeNull();
    expect(view.container.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(document.querySelectorAll("input")).toHaveLength(0);
  });

  it("form: one sentence holds the account's three blanks, under the invite's tag, at the first of five steps", () => {
    draw(form());
    expect(document.body.textContent).toContain("You're invited to this ohmail server");
    /* The blanks hold no words of their own; the closing full stop is the drawn dot. */
    expect(sentences()).toEqual(["I’m , at , with a password of"]);
    expect(document.querySelector("main p.oh-sentence .oh-dot")).not.toBeNull();
    expect(
      [blank(I.nameLabel), blank(I.emailLabel), blank(I.passwordLabel)].map((f) => [
        f.type,
        f.autocomplete,
        f.name,
        f.placeholder,
      ]),
    ).toEqual([
      ["text", "name", "", "name"],
      ["text", "email", "", "email address"],
      ["password", "new-password", "", "12 characters or more"],
    ]);
    expect(blank(I.emailLabel).inputMode).toBe("email");
    expect(screen.getByRole("img", { name: "Step 1 of 5, Account, 1 of 3" })).toBeTruthy();
    expect(document.body.textContent).toContain(
      "This is your sign-in for this server, not a new email address.",
    );
  });

  it("form: Create my account is live; a press with a blank short or empty sends nothing and says which; ready, it sends once", () => {
    const { acts: a } = draw(form());
    expect(named(I.createAccount).disabled).toBe(false);
    type(I.nameLabel, READY.name);
    type(I.emailLabel, READY.email);
    type(I.passwordLabel, "short");
    fireEvent.click(named(I.createAccount));
    expect(a.submit).not.toHaveBeenCalled();
    expect(refused(I.passwordLabel)).toBe(true);
    expect(refused(I.nameLabel)).toBe(false);
    type(I.passwordLabel, READY.password);
    fireEvent.click(named(I.createAccount));
    expect(a.submit).toHaveBeenCalledTimes(1);
    expect(a.type).toHaveBeenCalledWith("email", READY.email);
  });

  it("form: Enter in a blank sends through the door; while it is sent the button cannot be pressed again", () => {
    const { acts: a } = draw(form(), { start: READY });
    fireEvent.submit(blank(I.passwordLabel).form!);
    expect(a.submit).toHaveBeenCalledTimes(1);
    cleanup();
    draw(form(true), { start: READY });
    expect(named(I.working).disabled).toBe(true);
  });

  it("dead and used: the refusal is said and the blanks keep what was typed", () => {
    for (const said of [I.badToken, I.tokenSpent.replace("{email}", "other@family.example")]) {
      draw(form(false, said), { start: READY });
      expect(screen.getByRole("alert").textContent).toBe(said);
      expect(blank(I.emailLabel).value).toBe(READY.email);
      cleanup();
    }
    expect(I.badToken).toBe(
      "This invite link does not work any more. Links work once and expire, so ask the person who invited you for a new one.",
    );
  });

  it("a sign-out that ended unconfirmed is said first, and Sign out asks again; nothing is sent meanwhile", () => {
    const { acts: a } = draw(form(false, I.badToken), { start: READY, pending: { said: PENDING_SAID } });
    expect(screen.getAllByRole("alert").map((p) => p.textContent)).toEqual([PENDING_SAID, I.badToken]);
    fireEvent.click(named(SIGN_OUT));
    expect(a.again).toHaveBeenCalledTimes(1);
    cleanup();
    draw(form(), { start: READY, pending: { said: PENDING_SAID, signingOut: true } });
    expect(named(I.createAccount).disabled).toBe(true);
    expect(named(SIGN_OUT).disabled).toBe(true);
  });

  it("incomplete: says the link lost its secret, whom to ask as its line and why as its note, with no form", () => {
    draw({ at: "missing" });
    expect(sentences()).toEqual([I.missingTitle]);
    expect(document.body.textContent).toContain("Ask the person who invited you to send the link again.");
    expect(document.body.textContent).toContain(
      "The invite’s secret part is missing from the address. It usually gets lost when a link is copied by hand.",
    );
    expect(document.querySelectorAll("input")).toHaveLength(0);
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("incomplete, under a sign-out that did not finish: says it and offers Sign out", () => {
    const { acts: a } = draw({ at: "missing" }, { pending: { said: PENDING_SAID } });
    expect(screen.getByRole("alert").textContent).toBe(PENDING_SAID);
    fireEvent.click(named(SIGN_OUT));
    expect(a.again).toHaveBeenCalledTimes(1);
  });

  it("unavailable, and a build with no server: not available here, and nothing to fill", () => {
    for (const door of ["state", "none"] as const) {
      if (door === "state") draw({ at: "unavailable" });
      else
        render(
          <TextProvider locale="en" messages={en as never} timeZone="UTC">
            <InvitePage door={NONE} />
          </TextProvider>,
        );
      expect(sentences()).toEqual([I.unavailableTitle]);
      expect(document.body.textContent).toContain(I.unavailableBody);
      expect(document.querySelectorAll("input")).toHaveLength(0);
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
    draw(form(), { words: de, locale: "de" });
    expect(sentences()).toEqual(["Ich bin , unter , mit dem Passwort"]);
    expect(blank(de.joinInvite.passwordLabel)).toBeTruthy();
    expect(named(de.joinInvite.createAccount)).toBeTruthy();
    expect(screen.getByRole("img", { name: de.joinInvite.progress })).toBeTruthy();
  });

  it("names its states by the reference's address", () => {
    expect([...INVITE_STATES]).toEqual(["opening", "form", "dead", "used", "incomplete", "unavailable"]);
  });
});
