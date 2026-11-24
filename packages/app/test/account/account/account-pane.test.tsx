/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createTranslator } from "use-intl/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FactorSlot, GatedAsk } from "../../../src/account/contract.js";
import { AccountPane } from "../../../src/account/account/AccountPane.js";
import type { AccountDoor } from "../../../src/account/account/model.js";
import type { PasswordDoor } from "../../../src/account/account/password.js";
import {
  accountPaneStates,
  PASSWORD_STATES,
  type AccountDrawn,
} from "../../../src/account/account/states.js";
import { useAccount } from "../../../src/account/account/use-account.js";
import { usePassword } from "../../../src/account/account/use-password.js";
import { fillOver, TextProvider, type Messages } from "../../../src/text/index.js";
import accountDe from "../../../messages/account.de.json" with { type: "json" };
import accountEn from "../../../messages/account.en.json" with { type: "json" };
import ownDe from "../../../messages/account-account.de.json" with { type: "json" };
import ownEn from "../../../messages/account-account.en.json" with { type: "json" };
import doorsDe from "../../../messages/doors.de.json" with { type: "json" };
import doorsEn from "../../../messages/doors.en.json" with { type: "json" };
/* The states the comparison registers, by address. */
import registry from "../../../../../test/compare/registry.json" with { type: "json" };
import {
  changed,
  FACTOR,
  fakeAccountDoor,
  fakePasswordDoor,
  held,
  signedIn,
  type ChangeAnswer,
} from "./fake-door.js";

afterEach(cleanup);

type Lang = "en" | "de";
const EN: Messages = { ...accountEn, ...doorsEn, ...ownEn };
const WORDS: Readonly<Record<Lang, Messages>> = {
  en: EN,
  de: fillOver(EN, { ...accountDe, ...doorsDe, ...ownDe }),
};
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
const acc = (key: string, lang: Lang = "en") => said("account", key, {}, lang);
const own = (key: string, lang: Lang = "en") => said("accountOwn", key, {}, lang);
const pc = (key: string, values: Record<string, number> = {}) => said("passwordChange", key, values);
const pair = (key: string) => said("pairLanding", key);
const seen = (words: string): boolean => (document.body.textContent ?? "").includes(words);
const button = (name: string) => screen.queryByRole("button", { name }) as HTMLButtonElement | null;

/* The page's own fixtures: no source file holds an address. */
const ADDRESS = "mila@lichtgrat.example";
const FAILED = "The server could not be reached.";
const STATES = accountPaneStates({ address: ADDRESS, failed: FAILED });
type Drawn = { readonly model: AccountDrawn; readonly body?: "pane" | "signOutOnly" };

const noFactor: FactorSlot = () => null;
/** A state drawn as a shell draws it: the whole pane, or the sign-out alone. */
function drawn(state: Drawn, { factor = noFactor, lang = "en" as Lang } = {}) {
  const { account, password, formOpen } = state.model;
  return render(
    <TextProvider locale={lang} messages={WORDS[lang]} timeZone="Europe/Zurich">
      {state.body === "signOutOnly" ? (
        <AccountPane body="signOutOnly" model={account} />
      ) : (
        <AccountPane body="pane" model={account} password={password} factor={factor} formOpen={formOpen} />
      )}
    </TextProvider>,
  );
}
/** A state with the verbs a case listens on. */
const listening = (state: Drawn, verbs: Partial<AccountDrawn["account"]>): Drawn => ({
  ...state,
  model: { ...state.model, account: { ...state.model.account, ...verbs } },
});

describe("the whole pane, signed in", () => {
  it("says who is signed in, and offers the three verbs by the names the journeys find", () => {
    drawn(STATES.rest);
    expect(screen.getByRole("heading", { name: ADDRESS })).toBeTruthy();
    expect(seen(own("signedIn"))).toBe(true);
    expect(button(acc("signOut"))).toBeTruthy();
    expect(button(pc("submit"))).toBeTruthy();
    expect(button(acc("begin"))!.disabled).toBe(false);
    expect(screen.getByRole("heading", { name: acc("title") })).toBeTruthy();
    expect(seen(acc("lead"))).toBe(true);
    expect(seen(acc("signOutBody"))).toBe(true);
  });

  it("the sign-out is one press on the model's verb, and says it is on its way", () => {
    const signOut = vi.fn();
    drawn(listening(STATES.rest, { signOut }));
    fireEvent.click(button(acc("signOut"))!);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    cleanup();
    drawn(STATES.signingOut);
    expect(button(acc("signOutBusy"))!.disabled).toBe(true);
    expect(button(acc("signOut"))).toBeNull();
  });

  it("a sign-out that stayed says why by the sentence it has today, and keeps the verb", () => {
    drawn(STATES.blocked);
    expect(seen(acc("signOutBlocked"))).toBe(true);
    expect(button(acc("signOut"))!.disabled).toBe(false);
    cleanup();
    drawn(STATES.unverified);
    expect(seen(acc("signOutUnverified"))).toBe(true);
    expect(seen(acc("signOutBlocked"))).toBe(false);
  });

  it("the one verb about erasure leaves for its page: the pane takes no address and erases nothing", () => {
    const toErase = vi.fn();
    drawn(listening(STATES.rest, { toErase }));
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    fireEvent.click(button(acc("begin"))!);
    expect(toErase).toHaveBeenCalledTimes(1);
  });

  it("reads German where the catalogue is German", () => {
    drawn(STATES.blocked, { lang: "de" });
    expect(seen(acc("signOutBlocked", "de"))).toBe(true);
    expect(button(acc("signOut", "de"))).toBeTruthy();
    expect(seen(own("signedIn", "de"))).toBe(true);
  });
});

describe("the whole pane, before or without a session", () => {
  const sessionOnly = () => {
    expect(button(acc("signOut"))).toBeNull();
    expect(button(acc("begin"))).toBeNull();
    expect(screen.queryByRole("heading", { name: acc("title") })).toBeNull();
    // The password change stands whatever the read said, as it always did.
    expect(button(pc("submit"))).toBeTruthy();
  };

  it("while the read is out: says so, and offers neither sign-out nor the way to erase", () => {
    drawn(STATES.loading);
    expect(seen(acc("loading"))).toBe(true);
    sessionOnly();
  });

  it("a read that failed: its reason and no remedy", () => {
    drawn(STATES.unread);
    expect(seen(own("notRead"))).toBe(true);
    expect(seen(FAILED)).toBe(true);
    expect(button(acc("signIn"))).toBeNull();
    sessionOnly();
  });

  it("nobody signed in: says so, with the way to sign in", () => {
    const toSignIn = vi.fn();
    drawn(listening(STATES.signedOut, { toSignIn }));
    expect(seen(acc("signedOutBody"))).toBe(true);
    fireEvent.click(button(acc("signIn"))!);
    expect(toSignIn).toHaveBeenCalledTimes(1);
    sessionOnly();
  });
});

describe("the password, on its line", () => {
  it("opens by its verb and closes by Cancel, and what was typed goes with it", () => {
    drawn(STATES.rest);
    expect(screen.queryByLabelText(pc("currentLabel"))).toBeNull();
    fireEvent.click(button(pc("submit"))!);
    const current = screen.getByLabelText(pc("currentLabel")) as HTMLInputElement;
    fireEvent.change(current, { target: { value: "kestrel-over-the-quarry-41" } });
    fireEvent.click(button(own("cancel"))!);
    expect(screen.queryByLabelText(pc("currentLabel"))).toBeNull();
    expect(document.body.innerHTML).not.toContain("kestrel-over-the-quarry-41");
    fireEvent.click(button(pc("submit"))!);
    expect((screen.getByLabelText(pc("currentLabel")) as HTMLInputElement).value).toBe("");
  });

  it("draws each state of the form open, and a change that landed closed with what it ended", () => {
    drawn(STATES.passwordLocked);
    expect(screen.getByLabelText(pc("currentLabel"))).toBeTruthy();
    expect(seen(pc("locked", { minutes: 14 }))).toBe(true);
    cleanup();
    drawn(STATES.passwordDoneOne);
    expect(screen.queryByLabelText(pc("currentLabel"))).toBeNull();
    expect(seen(pc("done", { count: 1 }))).toBe(true);
    expect(button(pc("submit"))).toBeTruthy();
  });

  it("a change that lands closes the form and is said on the line", async () => {
    const password = fakePasswordDoor([changed(2)]);
    const account = fakeAccountDoor({ who: [signedIn(ADDRESS)] });
    function Pane() {
      return (
        <AccountPane
          body="pane"
          model={useAccount(account)}
          password={usePassword(password)}
          factor={noFactor}
        />
      );
    }
    render(
      <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
        <Pane />
      </TextProvider>,
    );
    await act(async () => {});
    fireEvent.click(button(pc("submit"))!);
    fireEvent.change(screen.getByLabelText(pc("currentLabel")), {
      target: { value: "kestrel-over-the-quarry-41" },
    });
    fireEvent.change(screen.getByLabelText(pc("nextLabel")), {
      target: { value: "nine-lamps-in-a-wet-harbour" },
    });
    fireEvent.change(screen.getByLabelText(pc("repeatLabel")), {
      target: { value: "nine-lamps-in-a-wet-harbour" },
    });
    await act(async () => {
      fireEvent.click(button(pc("submit"))!);
    });
    expect(password.sent()).toHaveLength(1);
    expect(screen.queryByLabelText(pc("currentLabel"))).toBeNull();
    expect(seen(pc("done", { count: 2 }))).toBe(true);
  });
});

describe("the sign-out alone", () => {
  it("draws the verb and what it does, and nothing else of the account", () => {
    drawn(STATES.alone);
    expect(button(pair("signOut"))).toBeTruthy();
    expect(seen(pair("signOutBody"))).toBe(true);
    expect(screen.queryAllByRole("heading")).toHaveLength(0);
    expect(button(pc("submit"))).toBeNull();
    expect(button(acc("begin"))).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks before it signs out: what this browser kept goes with it", () => {
    const signOut = vi.fn();
    const confirmSignOut = vi.fn();
    const cancelSignOut = vi.fn();
    drawn(listening(STATES.alone, { signOut, confirmSignOut, cancelSignOut }));
    fireEvent.click(button(pair("signOut"))!);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(confirmSignOut).not.toHaveBeenCalled();
    cleanup();

    drawn(listening(STATES.aloneAsked, { signOut, confirmSignOut, cancelSignOut }));
    const question = screen.getByRole("dialog");
    expect(question.textContent).toContain(pair("signOutConfirm"));
    fireEvent.click(within(question).getByRole("button", { name: pair("signOutCancel") }));
    expect(cancelSignOut).toHaveBeenCalledTimes(1);
    fireEvent.click(within(question).getByRole("button", { name: pair("signOut") }));
    expect(confirmSignOut).toHaveBeenCalledTimes(1);
  });
});

describe("the pane over its doors", () => {
  function Pane(p: { account: AccountDoor; password: PasswordDoor; factor: FactorSlot }) {
    return (
      <AccountPane
        body="pane"
        model={useAccount(p.account)}
        password={usePassword(p.password)}
        factor={p.factor}
      />
    );
  }

  it("signs out with no factor asked, stays when the copy is still here, and says so", async () => {
    const factor: FactorSlot = vi.fn(() => null);
    const account = fakeAccountDoor({
      who: [signedIn(ADDRESS)],
      signOuts: ["blocked", "unverified", "left"],
    });
    render(
      <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
        <Pane account={account} password={fakePasswordDoor()} factor={factor} />
      </TextProvider>,
    );
    await act(async () => {});
    await act(async () => {
      fireEvent.click(button(acc("signOut"))!);
    });
    expect(account.calls()).toEqual(["who", "signOut"]);
    expect(seen(acc("signOutBlocked"))).toBe(true);
    await act(async () => {
      fireEvent.click(button(acc("signOut"))!);
    });
    expect(seen(acc("signOutUnverified"))).toBe(true);
    await act(async () => {
      fireEvent.click(button(acc("signOut"))!);
    });
    expect(button(acc("signOutBusy"))!.disabled).toBe(true);
    expect(factor).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the press on Delete my account leaves once, and reaches the door for nothing else", async () => {
    const account = fakeAccountDoor({ who: [signedIn(ADDRESS)] });
    render(
      <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
        <Pane account={account} password={fakePasswordDoor()} factor={noFactor} />
      </TextProvider>,
    );
    await act(async () => {});
    fireEvent.click(button(acc("begin"))!);
    expect(account.calls()).toEqual(["who", "toErase"]);
  });

  /* The form's Cancel and a change that is owed: the hook lives above the form, so closing it drops nothing. */
  const ASKED = "the factor is asked";
  async function changeAsked(password: PasswordDoor) {
    const asks: GatedAsk[] = [];
    const factor: FactorSlot = (ask) => {
      asks.push(ask);
      return <p>{ASKED}</p>;
    };
    render(
      <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
        <Pane account={fakeAccountDoor({ who: [signedIn(ADDRESS)] })} password={password} factor={factor} />
      </TextProvider>,
    );
    await act(async () => {});
    fireEvent.click(button(pc("submit"))!);
    fireEvent.change(screen.getByLabelText(pc("currentLabel")), {
      target: { value: "kestrel-over-the-quarry-41" },
    });
    fireEvent.change(screen.getByLabelText(pc("nextLabel")), {
      target: { value: "nine-lamps-in-a-wet-harbour" },
    });
    fireEvent.change(screen.getByLabelText(pc("repeatLabel")), {
      target: { value: "nine-lamps-in-a-wet-harbour" },
    });
    await act(async () => {
      fireEvent.click(button(pc("submit"))!);
    });
    return asks;
  }

  it("the form's Cancel while the change is on its way leaves nothing parked: no factor is asked for it, none sends it", async () => {
    const first = held<ChangeAnswer>();
    const password = fakePasswordDoor([first.promise, changed(1)]);
    const asks = await changeAsked(password);
    expect(password.sent()).toHaveLength(1);
    const cancel = button(own("cancel"));
    expect(cancel).not.toBeNull();
    // A Cancel that is off while the change is on its way cancels nothing: nothing more to read then.
    if (cancel!.disabled) return;
    fireEvent.click(cancel!);
    expect(screen.queryByLabelText(pc("currentLabel"))).toBeNull();
    await act(async () => {
      first.settle(FACTOR);
    });
    const askedWhileClosed = asks.length;
    // Opened again for a new attempt.
    fireEvent.click(button(pc("submit"))!);
    const askedOnOpening = screen.queryByText(ASKED) !== null;
    for (const ask of [...asks]) {
      await act(async () => {
        ask.onVerified();
      });
    }
    expect({ askedWhileClosed, askedOnOpening, sent: password.sent().length }).toEqual({
      askedWhileClosed: 0,
      askedOnOpening: false,
      sent: 1,
    });
  });

  it("the form's Cancel while its factor is asked leaves nothing parked either: only the dialog answers it", async () => {
    const password = fakePasswordDoor([FACTOR, changed(1)]);
    const asks = await changeAsked(password);
    expect(screen.queryByText(ASKED)).not.toBeNull();
    const cancel = button(own("cancel"));
    expect(cancel).not.toBeNull();
    // A Cancel that is off while the factor is asked leaves the dialog the one way out: nothing more to read then.
    if (cancel!.disabled) return;
    fireEvent.click(cancel!);
    // Opened again for a new attempt.
    fireEvent.click(button(pc("submit"))!);
    const askedOnOpening = screen.queryByText(ASKED) !== null;
    for (const ask of [...asks]) {
      await act(async () => {
        ask.onVerified();
      });
    }
    expect({ askedOnOpening, sent: password.sent().length }).toEqual({ askedOnOpening: false, sent: 1 });
  });
});

describe("before the page's script, in every state", () => {
  it("at most the one form, with no address and no method; no named control, no link, no handler, no test id", () => {
    for (const [name, state] of Object.entries(STATES) as [string, Drawn][]) {
      const { container } = drawn(state);
      const forms = [...container.querySelectorAll("form")];
      expect(forms.length, name).toBeLessThanOrEqual(1);
      for (const form of forms) {
        expect(form.hasAttribute("action"), name).toBe(false);
        expect(form.hasAttribute("method"), name).toBe(false);
      }
      expect(container.querySelectorAll("a[href], [name], [data-testid]"), name).toHaveLength(0);
      const written = [...container.querySelectorAll("*")].flatMap((el) =>
        el.getAttributeNames().filter((attribute) => attribute.startsWith("on")),
      );
      expect(written, name).toEqual([]);
      cleanup();
    }
  });
});

describe("the pane's states", () => {
  const registered = new Set((registry as { states: { key: string }[] }).states.map((state) => state.key));
  const addresses = Object.values(STATES).flatMap((state) => (state.address === null ? [] : [state.address]));

  it("each address is a state the comparison registers, once", () => {
    expect(addresses.filter((address) => !registered.has(address))).toEqual([]);
    expect(new Set(addresses).size).toBe(addresses.length);
  });

  it("cover every picture of the pane itself, the password form's among them", () => {
    const pictured = [...registered].filter((key) => {
      const parts = key.split("&");
      return (
        parts.includes("screen=settings") && parts.includes("sec=account") && !parts.includes("door=cloud")
      );
    });
    expect([...addresses].sort()).toEqual(pictured.sort());
    const forms = Object.values(PASSWORD_STATES).flatMap((state) =>
      state.address === null ? [] : [state.address],
    );
    expect(forms.filter((address) => !addresses.includes(address))).toEqual([]);
  });

  it("the sign-out alone is the one state drawn by the other body", () => {
    const alone = Object.entries(STATES as Record<string, Drawn>).filter(
      ([, state]) => state.body === "signOutOnly",
    );
    expect(alone.map(([name]) => name).sort()).toEqual(["alone", "aloneAsked"]);
  });
});
