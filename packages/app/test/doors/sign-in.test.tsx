/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NONE } from "../../src/host/contract.js";
import { TextProvider } from "../../src/text/index.js";
import {
  SignInPage,
  SIGN_IN_STATES,
  signInStateOf,
  type SignInDoor,
  type SignInState,
} from "../../src/doors/sign-in/index.js";
import type { SignupPosture } from "../../src/doors/sign-in/invite-posture.js";
import en from "../../messages/doors.en.json" with { type: "json" };
import de from "../../messages/doors.de.json" with { type: "json" };

/**
 * THE SIGN-IN PAGE draws the step the door's ceremony is at, the blanks as the door holds them, and presses the door's
 * acts; it keeps no typed word of its own. It finds every control by role and name; the frozen names of the journeys
 * (the heading, the two fields and Continue) are the catalogue's `login.title`, `login.emailLabel`,
 * `login.passwordLabel` and `login.continue`. The ways to the join and to the demo are links to the addresses the host
 * hands, or buttons that press where it hands none.
 */
type Words = typeof en;
const L = en.login;
const EMPTY = { email: "", password: "", code: "" };

function doorOf(state: SignInState, over: Partial<SignInDoor> = {}) {
  const acts = {
    type: vi.fn(),
    begin: vi.fn(),
    passkey: vi.fn(),
    finish: vi.fn(),
    use: vi.fn(),
    restart: vi.fn(),
    again: vi.fn(),
  };
  const door: SignInDoor = {
    state,
    note: "managed-invite" as SignupPosture,
    continues: null,
    why: null,
    pending: { said: null, act: "Sign out", signingOut: false, again: acts.again },
    fields: EMPTY,
    type: acts.type,
    begin: acts.begin,
    passkey: acts.passkey,
    finish: acts.finish,
    use: acts.use,
    restart: acts.restart,
    join: { href: "/join" },
    demo: { href: "/?demo=1" },
    ...over,
  };
  return { door, acts };
}

function draw(door: SignInDoor | typeof NONE, words: Words = en, locale: "en" | "de" = "en") {
  return render(
    <TextProvider locale={locale} messages={words as never} timeZone="UTC">
      <SignInPage door={door} />
    </TextProvider>,
  );
}

const named = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) });
const password = (
  busy = false,
  refusal: SignInState extends infer S ? (S extends { refusal: infer R } ? R : never) : never = null,
): SignInState => ({ at: "password", busy, refusal });

afterEach(cleanup);

describe("the password step", () => {
  it("is named by its heading, and takes the email and the password by their names", () => {
    const { door, acts } = doorOf(password());
    draw(door);
    expect(screen.getByRole("heading", { level: 1, name: /^I’m / })).toBeTruthy();
    const email = screen.getByRole("textbox", { name: L.emailLabel }) as HTMLInputElement;
    const pw = screen.getByLabelText(L.passwordLabel) as HTMLInputElement;
    expect([email.autocomplete, pw.autocomplete, pw.type]).toEqual([
      "username",
      "current-password",
      "password",
    ]);
    /* The ids the sign-in's blanks always carried: a password manager that learned them finds them. And no name, as
       the card's had none: a press before the page's script runs sends nothing that was typed. */
    expect([email.id, email.name, pw.id, pw.name]).toEqual(["login-email", "", "login-pw", ""]);
    fireEvent.change(email, { target: { value: "a@b.example" } });
    // A password is handed on as typed, its spaces too: only the ceremony decides what it trims.
    fireEvent.change(pw, { target: { value: " pw typed here " } });
    expect(acts.type.mock.calls).toEqual([
      ["email", "a@b.example"],
      ["password", " pw typed here "],
    ]);
  });

  it("Continue is named by its words alone, as the journeys find it, and by the words it says while it works", () => {
    draw(doorOf(password()).door);
    expect(screen.getByRole("button", { name: L.continue })).toBeTruthy();
    cleanup();
    draw(doorOf(password(true)).door);
    expect(screen.getByRole("button", { name: L.working })).toBeTruthy();
  });

  it("Continue sends the blanks the door holds, once both are filled", () => {
    const { door, acts } = doorOf(password(), {
      fields: { ...EMPTY, email: "a@b.example", password: " pw " },
    });
    draw(door);
    fireEvent.click(named(L.continue));
    expect(acts.begin).toHaveBeenCalledTimes(1);
  });

  it("a press with both blanks empty sends nothing: the address takes the keys and says it is wanted", () => {
    const { door, acts } = doorOf(password());
    draw(door);
    fireEvent.click(named(L.continue));
    expect(acts.begin).not.toHaveBeenCalled();
    const email = screen.getByRole("textbox", { name: L.emailLabel }) as HTMLInputElement;
    expect(document.activeElement).toBe(email);
    expect(document.getElementById(email.getAttribute("aria-describedby")!)?.textContent).toBe(L.emailWanted);
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(L.emailWanted)).toBeTruthy();
    expect(screen.queryByText(L.passwordWanted)).toBeNull();
  });

  it("a press with the address and no password sends nothing: the password takes the keys and says it is wanted", () => {
    const { door, acts } = doorOf(password(), { fields: { ...EMPTY, email: "a@b.example" } });
    draw(door);
    fireEvent.click(named(L.continue));
    expect(acts.begin).not.toHaveBeenCalled();
    const pw = screen.getByLabelText(L.passwordLabel) as HTMLInputElement;
    expect(document.activeElement).toBe(pw);
    expect(pw.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(L.passwordWanted)).toBeTruthy();
    /* Typing in it takes the mark away. */
    fireEvent.change(pw, { target: { value: "x" } });
    expect(screen.queryByText(L.passwordWanted)).toBeNull();
  });

  it("keeps no typed word of its own: the blanks are the door's, so a password the door empties is gone", () => {
    const filled = { ...EMPTY, email: "a@b.example", password: "Correct horse battery" };
    const { door } = doorOf(password(true), { fields: filled });
    const view = draw(door);
    expect((screen.getByLabelText(L.passwordLabel) as HTMLInputElement).value).toBe("Correct horse battery");
    view.rerender(
      <TextProvider locale="en" messages={en as never} timeZone="UTC">
        <SignInPage door={{ ...door, fields: { ...filled, password: "" } }} />
      </TextProvider>,
    );
    expect((screen.getByLabelText(L.passwordLabel) as HTMLInputElement).value).toBe("");
    expect((screen.getByRole("textbox", { name: L.emailLabel }) as HTMLInputElement).value).toBe(
      "a@b.example",
    );
  });

  it("names the service and keeps the route to account setup for each posture", () => {
    for (const [note, service] of [
      ["managed-invite", L.whereCloud],
      ["managed-open", L.whereCloud],
      ["selfhost", L.whereServer],
    ] as const) {
      const view = draw(doorOf(password(), { note }).door);
      expect(view.container.textContent).toContain(service);
      expect(view.container.textContent).not.toMatch(
        /invite code is not required|accounts are by invitation/i,
      );
      expect(screen.getByRole("link", { name: L.createAccount }).getAttribute("href")).toBe("/join");
      expect(screen.queryByRole("link", { name: "Have an invite code?" })).toBeNull();
      cleanup();
    }
  });

  it("where the host hands no address, a way to the join is a button that presses", () => {
    const join = vi.fn();
    const { door } = doorOf(password(), { note: "managed-open", join: { press: join } });
    draw(door);
    expect(screen.queryByRole("link")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: L.createAccount }));
    expect(join).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["wrong", { word: "bad_credentials" }, L.badCredentials],
    ["locked", { word: "locked" }, L.tooManyAttempts],
    ["slowed", { word: "slowed" }, L.signInSlowed],
    [
      "busy",
      { word: "said", said: "Another tab is finishing a sign-in." },
      "Another tab is finishing a sign-in.",
    ],
  ] as const)("%s: the refusal is said in this page's words, and the form stays", (_id, refusal, said) => {
    const { door } = doorOf(password(false, refusal));
    draw(door);
    expect(screen.getByRole("alert").textContent).toBe(said);
    expect(screen.getByRole("textbox", { name: L.emailLabel })).toBeTruthy();
  });

  it("slowed: names the email address the throttle holds, as the design says it", () => {
    expect(L.signInSlowed).toBe(
      "Sign-in to this email address is slowed after many failed attempts from different places. Wait a few minutes and try again.",
    );
  });

  it("is busy while the ceremony runs: Continue says so and cannot be pressed again", () => {
    const { door, acts } = doorOf(password(true));
    draw(door);
    const busy = named(L.working) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    fireEvent.click(busy);
    expect(acts.begin).not.toHaveBeenCalled();
  });

  it("shows no notice on an account-page continuation without a sign-out reason", () => {
    const { door } = doorOf(password(), { continues: "manage" });
    draw(door);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.body.textContent).not.toContain(en.resume.expiredBody);
    expect(screen.getByRole("button", { name: L.continue })).toBeTruthy();
  });

  describe.each([
    { locale: "en", words: en },
    { locale: "de", words: de },
  ] as const)("the previous sign-in in $locale", ({ locale, words }) => {
    it.each(["revoked", "expired", "absent", "pending"] as const)("says why it ended (%s)", (why) => {
      const { door } = doorOf(password(), { why, continues: "manage" });
      draw(door, words, locale);
      expect(screen.getByText(words.resume[`${why}Body`])).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByRole("button", { name: words.login.continue })).toBeTruthy();
    });

    it("says once what happened when a sign-in was reused, beside a refused press", () => {
      const { door } = doorOf(password(false, { word: "bad_credentials" }), { why: "reused" });
      draw(door, words, locale);
      expect(screen.getAllByRole("alert").map((alert) => alert.textContent)).toEqual([
        words.resume.reusedBody,
        words.login.badCredentials,
      ]);
    });
  });

  it("a sign-out that ended unconfirmed is said, with Sign out to ask again, and holds Continue", () => {
    const { door, acts } = doorOf(password(), {
      pending: {
        said: "The sign-out could not be ended.",
        act: "Sign out",
        signingOut: true,
        again: vi.fn(),
      },
    });
    draw(door);
    expect(screen.getByRole("alert").textContent).toBe("The sign-out could not be ended.");
    expect((named(L.continue) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Sign out" }) as HTMLButtonElement).disabled).toBe(true);
    expect(acts.begin).not.toHaveBeenCalled();
  });
});

describe("the second factor", () => {
  const factor = (
    f: "passkey" | "code" | "recovery",
    refusal: { word: "bad_code" } | { word: "bad_passkey" } | null = null,
  ): SignInState => ({
    at: "factor",
    factor: f,
    offered: ["passkey", "code", "recovery"],
    busy: false,
    refusal,
  });

  it("a passkey: Continue with passkey runs it; the other factors and Start over stand beside it", () => {
    const { door, acts } = doorOf(factor("passkey"));
    const view = draw(door);
    expect(view.container.textContent).toContain(L.confirmWith.replace("<how></how>.", L.factorPasskey));
    expect(view.container.textContent).not.toContain("nothing to type and nothing to leak");
    fireEvent.click(screen.getByRole("button", { name: L.passkey }));
    expect(acts.passkey).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: L.factorPasskey }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: L.factorCode }));
    expect(acts.use).toHaveBeenCalledWith("code");
    fireEvent.click(screen.getByRole("button", { name: L.startOver }));
    expect(acts.restart).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menuitemradio", { name: L.factorPasskey })).toBeNull();
  });

  it.each([
    ["code", L.totpLabel, "numeric"],
    ["recovery", L.recoveryLabel, "text"],
  ] as const)(
    "a %s: its one field takes the focus and its keyboard, and Verify sends what the door holds",
    async (f, label, keys) => {
      const { door, acts } = doorOf(factor(f));
      const view = draw(door);
      const field = screen.getByRole("textbox", { name: label }) as HTMLInputElement;
      expect(document.activeElement).toBe(field);
      expect(field.autocomplete).toBe("one-time-code");
      /* An authenticator's six digits open the number pad on a phone; a recovery code has letters. */
      expect(field.inputMode).toBe(keys);
      expect(field.id).toBe("login-code");
      expect((named(L.totpVerify) as HTMLButtonElement).disabled).toBe(true);
      await act(async () => {
        fireEvent.change(field, { target: { value: "482913" } });
      });
      expect(acts.type).toHaveBeenCalledWith("code", "482913");
      view.rerender(
        <TextProvider locale="en" messages={en as never} timeZone="UTC">
          <SignInPage door={{ ...door, fields: { ...EMPTY, code: "482913" } }} />
        </TextProvider>,
      );
      fireEvent.click(named(L.totpVerify));
      expect(acts.finish).toHaveBeenCalledTimes(1);
    },
  );

  it("offers only the factors the door offers", () => {
    const { door } = doorOf({ at: "factor", factor: "code", offered: ["code"], busy: false, refusal: null });
    draw(door);
    expect(screen.queryByRole("menuitemradio", { name: L.factorPasskey })).toBeNull();
    expect(screen.queryByRole("menuitemradio", { name: L.factorRecovery })).toBeNull();
  });

  it.each([
    ["refused", "code", { word: "bad_code" }, L.badCode],
    ["passkey", "passkey", { word: "bad_passkey" }, L.badPasskey],
  ] as const)("%s: the factor's refusal is said", (_id, f, refusal, said) => {
    draw(doorOf(factor(f, refusal)).door);
    expect(screen.getByRole("alert").textContent).toBe(said);
  });
});

describe("with no server behind the build", () => {
  it("says so, and opens the demo where there is one: a link to the address the host handed, or a press", () => {
    const { door } = doorOf({ at: "unavailable" });
    const view = draw(door);
    expect(view.container.textContent).toContain(en.gate.body);
    expect(screen.getByRole("link", { name: en.gate.openDemo }).getAttribute("href")).toBe("/?demo=1");
    cleanup();
    const demo = vi.fn();
    draw(doorOf({ at: "unavailable" }, { demo: { press: demo } }).door);
    fireEvent.click(screen.getByRole("button", { name: en.gate.openDemo }));
    expect(demo).toHaveBeenCalledTimes(1);
    cleanup();
    draw(NONE);
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.queryAllByRole("link")).toEqual([]);
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

describe("its states and its German", () => {
  it("names each state by the reference's address", () => {
    expect(signInStateOf({ at: "password", busy: false, refusal: null }, true)).toBe("server");
    expect(
      signInStateOf(
        { at: "factor", factor: "code", offered: [], busy: false, refusal: { word: "bad_code" } },
        false,
      ),
    ).toBe("refused");
    expect(SIGN_IN_STATES).toContain("locked");
  });

  it("says the German catalogue's words, with no key on the page", () => {
    const { door } = doorOf({ at: "password", busy: false, refusal: { word: "slowed" } });
    const view = draw(door, de as unknown as Words, "de");
    expect(screen.getByRole("heading", { level: 1, name: /^Ich bin / })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe(de.login.signInSlowed);
    expect(view.container.textContent).not.toMatch(/\blogin\.[a-zA-Z]+/);
  });
});
