/** @vitest-environment jsdom */
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NONE } from "../../src/host/contract.js";
import { TextProvider } from "../../src/text/index.js";
import {
  JoinPage,
  JOIN_STATES,
  type JoinDoor,
  type JoinField,
  type JoinState,
  type JoinStation,
} from "../../src/doors/join/index.js";
import doorsEn from "../../messages/doors.en.json" with { type: "json" };
import doorsDe from "../../messages/doors.de.json" with { type: "json" };
import mailboxesEn from "../../messages/mailboxes.en.json" with { type: "json" };
import mailboxesDe from "../../messages/mailboxes.de.json" with { type: "json" };

/**
 * THE JOIN draws the step its door's ceremony is at, as steps on one stage, and hands back what a person types; every
 * press is the door's act. Controls are found by role and name; the list of stations is named `join.progress`, the
 * name the first run's journey arrives by.
 */
const en = { ...doorsEn, ...mailboxesEn };
const de = { ...doorsDe, ...mailboxesDe };
const J = en.join;
/** An invite code as the join's blank takes it. */
const INVITE = ["OHMAIL", "1234"].join("-");
const O = en.onboarding;
const MANAGED: readonly JoinStation[] = ["account", "verify", "factor", "codes", "plan", "mailbox"];
const READY = { email: "mila@example.org", name: "Mila", password: "p".repeat(12) } as const;
const PENDING_SAID = "The sign-out did not reach the server.";
/** The ways out, as the web's route hands them; the account page as the server handed it. */
const WAYS = {
  signIn: { href: "/login" },
  later: { href: "/" },
  open: { href: "/#/first-run" },
  leave: { href: "/" },
  signInAgain: { href: "/login?next=join" },
  waitlist: { href: "/#pricing" },
  demo: { href: "/?demo=1" },
} as const;
const ACCOUNT_PAGE = "https://plane.example/manage?token=t";

const ACTS = [
  "redeem",
  "register",
  "toInvite",
  "takeSuggestion",
  "changeAddress",
  "resend",
  "recheck",
  "addPasskey",
  "useAuthenticator",
  "copyKey",
  "openAuthenticator",
  "activate",
  "leaveAuthenticator",
  "copyCodes",
  "downloadCodes",
  "save",
  "codesDone",
  "retryCodes",
  "retry",
  "type",
  "again",
] as const;
type Acts = Record<(typeof ACTS)[number], ReturnType<typeof vi.fn>>;

interface Over {
  stations?: readonly JoinStation[];
  invited?: boolean;
  busy?: boolean;
  refusal?: string | null;
  suggestion?: string | null;
  start?: Partial<Record<JoinField, string>>;
  pending?: { said: string | null; signingOut?: boolean };
  demo?: boolean;
}

function Harness({ state, acts, o }: { state: JoinState; acts: Acts; o: Over }) {
  const [fields, setFields] = useState({ code: "", email: "", name: "", password: "", otp: "", ...o.start });
  const door: JoinDoor = {
    state,
    stations: o.stations ?? MANAGED,
    note: "managed-open",
    invited: o.invited ?? false,
    busy: o.busy ?? false,
    refusal: o.refusal ?? null,
    fields,
    suggestion: o.suggestion ?? null,
    pending: {
      said: o.pending?.said ?? null,
      act: "Sign out",
      signingOut: o.pending?.signingOut ?? false,
      again: acts.again,
    },
    type: (field, value) => {
      acts.type(field, value);
      setFields((was) => ({ ...was, [field]: value }));
    },
    redeem: acts.redeem,
    register: acts.register,
    toInvite: acts.toInvite,
    takeSuggestion: acts.takeSuggestion,
    changeAddress: acts.changeAddress,
    signIn: WAYS.signIn,
    resend: acts.resend,
    recheck: acts.recheck,
    addPasskey: acts.addPasskey,
    useAuthenticator: acts.useAuthenticator,
    copyKey: acts.copyKey,
    openAuthenticator: acts.openAuthenticator,
    activate: acts.activate,
    leaveAuthenticator: acts.leaveAuthenticator,
    copyCodes: acts.copyCodes,
    downloadCodes: acts.downloadCodes,
    save: acts.save,
    codesDone: acts.codesDone,
    retryCodes: acts.retryCodes,
    accountPage: { href: ACCOUNT_PAGE },
    later: WAYS.later,
    open: WAYS.open,
    retry: acts.retry,
    leave: WAYS.leave,
    signInAgain: WAYS.signInAgain,
    waitlist: WAYS.waitlist,
    demo: o.demo === false ? NONE : WAYS.demo,
    slots: {
      mailbox: (page) => page(<form aria-label="the connect form">connect form</form>, () => {}),
      authenticatorQr: () => <svg role="img" aria-label={J.totpQrAria} />,
    },
  };
  return <JoinPage door={door} />;
}

/** A door at `state` whose acts do nothing, with the ways the web hands. */
function doorWith(state: JoinState): JoinDoor {
  const nothing = (): void => {};
  return {
    state,
    stations: MANAGED,
    note: "managed-open",
    invited: false,
    busy: false,
    refusal: null,
    fields: { code: "", email: "", name: "", password: "", otp: "" },
    suggestion: null,
    pending: { said: null, act: "Sign out", signingOut: false, again: nothing },
    type: nothing,
    redeem: nothing,
    register: nothing,
    toInvite: nothing,
    takeSuggestion: nothing,
    changeAddress: nothing,
    signIn: WAYS.signIn,
    resend: nothing,
    recheck: nothing,
    addPasskey: nothing,
    useAuthenticator: nothing,
    copyKey: nothing,
    openAuthenticator: nothing,
    activate: nothing,
    leaveAuthenticator: nothing,
    copyCodes: nothing,
    downloadCodes: nothing,
    save: nothing,
    codesDone: nothing,
    retryCodes: nothing,
    accountPage: { href: ACCOUNT_PAGE },
    later: WAYS.later,
    open: WAYS.open,
    retry: nothing,
    leave: WAYS.leave,
    signInAgain: WAYS.signInAgain,
    waitlist: WAYS.waitlist,
    demo: WAYS.demo,
    slots: { mailbox: () => null, authenticatorQr: () => null },
  };
}

function draw(
  state: JoinState,
  o: Over = {},
  words: Record<string, unknown> = en,
  locale: "en" | "de" = "en",
  pending = false,
) {
  const acts = Object.fromEntries(ACTS.map((a) => [a, vi.fn()])) as Acts;
  const view = render(
    <TextProvider locale={locale} messages={words as never} timeZone="UTC" pending={pending}>
      <Harness state={state} acts={acts} o={o} />
    </TextProvider>,
  );
  return { view, acts };
}

const button = (name: string) =>
  screen.getByRole("button", {
    name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  }) as HTMLButtonElement;
const noButton = (name: string) =>
  expect(
    screen.queryByRole("button", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }),
  ).toBeNull();
/** A way out, by its name: a link to the address the host handed. */
const link = (name: string) => screen.getByRole("link", { name }) as HTMLAnchorElement;
const blank = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const type = (label: string, value: string) => fireEvent.change(blank(label), { target: { value } });
const heading = () => screen.getByRole("heading", { level: 1 }).textContent;
const progress = () => screen.getByRole("img", { name: /^Step \d of 5|^Setup complete$/ });
const dots = () => [...progress().querySelectorAll(".oh-dot")].map((dot) => dot.getAttribute("data-kind"));

afterEach(cleanup);

describe("the stages", () => {
  it("the second factor is screen three of the Account stage", () => {
    draw({ at: "factor", authenticator: null });
    expect(progress().getAttribute("aria-label")).toBe("Step 1 of 5, Account, 3 of 5");
    expect(progress().previousElementSibling?.textContent).toBe("3/5");
    expect(dots()).toEqual(["hot", "todo", "todo", "todo", "todo"]);
  });

  it("shows the confirmation as screen two, and completed setup as complete", () => {
    draw({ at: "sent", continuing: false });
    expect(progress().getAttribute("aria-label")).toBe("Step 1 of 5, Account, 2 of 5");
    cleanup();
    draw({ at: "done", mailbox: READY.email, decisionAhead: false });
    expect(progress().getAttribute("aria-label")).toBe(J.progressComplete);
    expect(dots()).toEqual(["ink", "ink", "ink", "ink", "ink"]);
  });

  it("the organize decision ahead is the third stage", () => {
    draw({ at: "done", mailbox: READY.email, decisionAhead: true });
    expect(progress().getAttribute("aria-label")).toBe("Step 3 of 5, Organize");
    expect(dots()).toEqual(["ink", "ink", "hot", "todo", "todo"]);
  });

  it("an invite starts the Account stage", () => {
    draw({ at: "invite" }, { invited: true, stations: ["invite", "account", "factor", "codes", "mailbox"] });
    expect(progress().getAttribute("aria-label")).toBe("Step 1 of 5, Account, 1 of 5");
    expect(dots()).toEqual(["hot", "todo", "todo", "todo", "todo"]);
  });
});

describe("the invite code and the account", () => {
  it("invite: says which sentence about codes is true here, and Continue hands the code on", () => {
    const { acts } = draw({ at: "invite" }, { invited: true });
    expect(heading()).toBe(J.myInvite.replace("<blank></blank>.", J.inviteLabel));
    expect(document.body.textContent).not.toMatch(/paste it exactly as your invite mail shows it/i);
    type(J.inviteLabel, INVITE);
    fireEvent.click(button(J.continue));
    expect(acts.type).toHaveBeenCalledWith("code", INVITE);
    expect(acts.redeem).toHaveBeenCalledTimes(1);
  });

  it("account: takes three blanks by name; Create account stays off until they are ready, then sends once", () => {
    const { acts } = draw({ at: "account" });
    expect(heading()).toBe(
      J.account
        .replace("<name>,</name>", `${J.nameLabel},`)
        .replace("<email>,</email>", `${J.emailLabel},`)
        .replace("<password></password>.", J.passwordLabel),
    );
    expect(
      [blank(J.emailLabel), blank(J.nameLabel), blank(J.passwordLabel)].map((f) => [f.type, f.autocomplete]),
    ).toEqual([
      ["email", "email"],
      ["text", "name"],
      ["password", "new-password"],
    ]);
    expect(blank(J.emailLabel).placeholder).toBe(J.emailBlank);
    expect(document.body.textContent).not.toContain("Where we will reach you about your account.");
    expect(button(J.continue).disabled).toBe(true);
    type(J.emailLabel, READY.email);
    type(J.nameLabel, READY.name);
    type(J.passwordLabel, READY.password.slice(1));
    expect(button(J.continue).disabled).toBe(true);
    type(J.passwordLabel, READY.password);
    fireEvent.click(button(J.continue));
    expect(acts.register).toHaveBeenCalledTimes(1);
  });

  it("account, open path: an invite code is one press away, and it opens by itself when one was carried in", () => {
    draw({ at: "account" });
    expect(screen.queryByLabelText(J.inviteLabel)).toBeNull();
    fireEvent.click(button(J.inviteLabel));
    expect(blank(J.inviteLabel)).toBeTruthy();
    expect(button(J.inviteLabel).getAttribute("aria-pressed")).toBe("true");
    cleanup();
    draw({ at: "account" }, { start: { code: INVITE } });
    expect(blank(J.inviteLabel).value).toBe(INVITE);
  });

  it("account, invited: the address the invite went to, and Back to the code", () => {
    const { acts } = draw({ at: "account" }, { invited: true });
    expect(blank(J.emailLabel)).toBeTruthy();
    expect(document.body.textContent).not.toContain("Use the address your invite was sent to.");
    noButton(J.inviteLabel);
    fireEvent.click(button(J.back));
    expect(acts.toInvite).toHaveBeenCalledTimes(1);
  });

  it("account: a likely typo is offered mended, and Already have an account is a link to the sign-in", () => {
    const { acts } = draw({ at: "account" }, { suggestion: "mila@example.com" });
    fireEvent.click(button(J.didYouMean.replace("{address}", "mila@example.com")));
    expect(acts.takeSuggestion).toHaveBeenCalledTimes(1);
    expect(link(J.signIn).getAttribute("href")).toBe("/login");
  });

  it("account: its blanks keep the ids the card's carried, the optional code's too", () => {
    draw({ at: "account" }, { start: { code: INVITE } });
    expect(
      [blank(J.emailLabel), blank(J.nameLabel), blank(J.passwordLabel), blank(J.inviteLabel)].map(
        (f) => f.id,
      ),
    ).toEqual(["join-email", "join-name", "join-pw", "join-code-opt"]);
    cleanup();
    draw({ at: "invite" }, { invited: true });
    expect(blank(J.inviteLabel).id).toBe("join-code");
  });

  it("account: a refusal is said and the blanks keep what was typed; while it is sent the button cannot be pressed", () => {
    draw({ at: "account" }, { refusal: J.refusedTaken, start: READY, busy: true });
    expect(screen.getByRole("alert").textContent).toBe(J.refusedTaken);
    expect(blank(J.emailLabel).value).toBe(READY.email);
    expect(button(J.working).disabled).toBe(true);
  });

  it("a sign-out that ended unconfirmed is said first, Sign out asks again, and nothing is made meanwhile", () => {
    const { acts } = draw(
      { at: "account" },
      { start: READY, pending: { said: PENDING_SAID }, refusal: J.refusedTaken },
    );
    expect(screen.getAllByRole("alert").map((p) => p.textContent)).toEqual([PENDING_SAID, J.refusedTaken]);
    fireEvent.click(button("Sign out"));
    expect(acts.again).toHaveBeenCalledTimes(1);
    cleanup();
    draw({ at: "account" }, { start: READY, pending: { said: PENDING_SAID, signingOut: true } });
    expect(button(J.continue).disabled).toBe(true);
  });
});

describe("the address", () => {
  it("sent: names the address the mail went to; the address can be mended, or the person signs in", () => {
    const { acts } = draw({ at: "sent", continuing: false }, { start: { email: " mila@example.org " } });
    expect(heading()).toContain(J.openLink.split("<a>")[0]!.trim());
    expect(heading()).toBe(J.openLink.replace("<a>{email}</a>.", "mila@example.org"));
    expect(document.body.textContent).not.toContain(J.sentContinuing);
    fireEvent.click(button(J.changeAddress));
    expect(acts.changeAddress).toHaveBeenCalledTimes(1);
    expect(link(J.signIn).getAttribute("href")).toBe("/login");
  });

  it("sent, once the link was opened in another tab: says the setup carries on here", () => {
    draw({ at: "sent", continuing: true });
    expect(screen.getByRole("status").textContent).toBe(J.sentContinuing);
  });

  it("verify: I have confirmed it asks again; a new link is asked once", () => {
    const { acts } = draw({ at: "verify", resent: false }, { start: { email: "mila@example.org" } });
    expect(heading()).toBe(J.openLink.replace("<a>{email}</a>.", "mila@example.org"));
    fireEvent.click(button(J.verifyRecheck));
    fireEvent.click(button(J.verifyResend));
    expect([acts.recheck.mock.calls.length, acts.resend.mock.calls.length]).toEqual([1, 1]);
    cleanup();
    draw({ at: "verify", resent: true });
    expect(button(J.verifyResent).disabled).toBe(true);
  });
});

describe("the second factor", () => {
  it("a passkey first, and an authenticator app instead", () => {
    const { acts } = draw({ at: "factor", authenticator: null });
    expect(heading()).toBe(J.lockWith.replace("<how></how>.", J.factorPasskeyWord));
    expect(document.body.textContent).not.toContain("The key itself never leaves the device.");
    fireEvent.click(button(J.addPasskey));
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(J.factorApp) }));
    expect([acts.addPasskey.mock.calls.length, acts.useAuthenticator.mock.calls.length]).toEqual([1, 1]);
  });

  it("the authenticator: its picture, its key in groups, Copy and the app on this device", () => {
    const key = "JBSWY3DPEHPK3PXP";
    const manualKey = key.match(/.{4}/g)!.join(" ");
    const { acts } = draw({ at: "factor", authenticator: { key, copied: null } });
    expect(screen.getByRole("img", { name: J.totpQrAria })).toBeTruthy();
    expect(screen.getByRole("code").textContent === manualKey).toBe(true);
    fireEvent.click(button(J.totpCopy));
    fireEvent.click(button(J.totpOpenApp));
    expect([acts.copyKey.mock.calls.length, acts.openAuthenticator.mock.calls.length]).toEqual([1, 1]);
    cleanup();
    draw({ at: "factor", authenticator: { key, copied: null } }, {}, de, "de");
    expect(screen.getByRole("code").textContent === manualKey).toBe(true);
    expect(button(de.join.totpCopy)).toBeTruthy();
    cleanup();
    draw({ at: "factor", authenticator: { key: "K", copied: "failed" } });
    expect(screen.getByRole("status").textContent).toBe(J.totpCopyFailed);
  });

  it("the authenticator's code takes six digits; Activate waits for them; Back leaves the app", () => {
    const { acts } = draw({ at: "factor", authenticator: { key: "K", copied: "copied" } });
    expect(button(J.totpCopied)).toBeTruthy();
    const code = blank(J.totpLabel);
    expect(code.autocomplete).toBe("one-time-code");
    /* The card's id, and the number pad: an authenticator's code is six digits. */
    expect([code.id, code.inputMode]).toEqual(["join-totp", "numeric"]);
    expect(button(J.activate).disabled).toBe(true);
    type(J.totpLabel, "12a 34-5");
    expect(acts.type).toHaveBeenLastCalledWith("otp", "12345");
    type(J.totpLabel, "1234567");
    expect(acts.type).toHaveBeenLastCalledWith("otp", "123456");
    fireEvent.click(button(J.activate));
    expect(acts.activate).toHaveBeenCalledTimes(1);
    fireEvent.click(button(J.factorAppWord));
    fireEvent.click(screen.getByRole("menuitemradio", { name: J.factorPasskey }));
    expect(acts.leaveAuthenticator).toHaveBeenCalledTimes(1);
  });

  it("a refused code is said under the code it is about, which takes the focus", () => {
    draw(
      { at: "factor", authenticator: { key: "K", copied: null } },
      { refusal: J.refusedTotpCode, start: { otp: "000000" } },
    );
    const code = blank(J.totpLabel);
    expect(code.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(code.getAttribute("aria-describedby")!)?.textContent).toBe(
      J.refusedTotpCode,
    );
    expect(document.activeElement).toBe(code);
  });
});

describe("the recovery codes", () => {
  const TEN = Array.from({ length: 10 }, (_, i) => `ABCD-EF${i}${i}`);

  it("shows the ten once; Continue waits until they are said to be kept", () => {
    const { acts } = draw({ at: "codes", codes: TEN, copied: null, saved: false });
    expect(heading()).toBe(J.step_codes_title.replace(/\.$/, ""));
    expect(
      screen
        .getAllByRole("listitem")
        .map((li) => li.textContent)
        .filter((t) => TEN.includes(t ?? "")),
    ).toEqual(TEN);
    fireEvent.click(button(J.codesCopy));
    fireEvent.click(button(J.codesDownload));
    expect(screen.queryByRole("switch")).toBeNull();
    expect(acts.codesDone).not.toHaveBeenCalled();
    fireEvent.click(button(J.codesSaved));
    expect(acts.save).toHaveBeenCalledWith(true);
    expect(acts.codesDone).toHaveBeenCalledTimes(1);
    expect([acts.copyCodes.mock.calls.length, acts.downloadCodes.mock.calls.length]).toEqual([1, 1]);
    cleanup();
    const again = draw({ at: "codes", codes: TEN, copied: "copied", saved: true });
    expect(button(J.codesCopied)).toBeTruthy();
    fireEvent.click(button(J.codesSaved));
    expect(again.acts.codesDone).toHaveBeenCalledTimes(1);
  });

  it("codes made elsewhere are never made here: it says so and goes on", () => {
    const { acts } = draw({ at: "codes", codes: "elsewhere", copied: null, saved: false });
    expect(screen.getByRole("status").textContent).toBe(J.codesElsewhere);
    expect(screen.queryByRole("switch")).toBeNull();
    fireEvent.click(button(J.continue));
    expect(acts.codesDone).toHaveBeenCalledTimes(1);
  });

  it("a make that failed says why and offers Try again; one under way says it is working", () => {
    const { acts } = draw(
      { at: "codes", codes: "failed", copied: null, saved: false },
      { refusal: "The server said no." },
    );
    expect(screen.getByRole("alert").textContent).toBe("The server said no.");
    fireEvent.click(button(J.codesRetry));
    expect(acts.retryCodes).toHaveBeenCalledTimes(1);
    cleanup();
    draw({ at: "codes", codes: "making", copied: null, saved: false });
    expect(screen.getByRole("status").textContent).toBe(J.working);
  });

  it("a copy the clipboard refused says so, and the codes stay on screen", () => {
    draw({ at: "codes", codes: TEN, copied: "failed", saved: false });
    expect(screen.getByRole("status").textContent).toBe(J.codesCopyFailed);
  });
});

describe("the plan, the mailbox and set up", () => {
  const CHOSEN = { name: null, interval: null } as const;

  it("the plan with a trial: one way on, a link to the account page; no Not now", () => {
    draw({
      at: "plan",
      trial: true,
      chosen: { name: "Plus", interval: "year" },
      waiting: false,
      link: "ready",
    });
    expect(heading()).toBe("Start 14 days on Plus");
    expect(document.body.textContent).toContain(J.planYearly);
    expect(document.body.textContent).toContain("No card");
    expect(link(J.planStartTrial).getAttribute("href")).toBe(ACCOUNT_PAGE);
    noButton(J.planLater);
    expect(document.body.textContent).not.toContain(J.planLaterHint);
  });

  it("the plan with no trial to offer: the account page's own words", () => {
    draw({ at: "plan", trial: false, chosen: CHOSEN, waiting: false, link: "ready" });
    expect(heading()).toBe(J.step_plan_title);
    expect(document.body.textContent).not.toContain("No card");
    expect(link(J.planContinue).getAttribute("href")).toBe(ACCOUNT_PAGE);
  });

  it("the plan's waits: the account page being opened, the trial starting after paying", () => {
    draw({ at: "plan", trial: null, chosen: CHOSEN, waiting: false, link: "asking" });
    expect(screen.getByRole("status").textContent).toBe(J.planLoading);
    expect(screen.queryAllByRole("button")).toEqual([]);
    cleanup();
    draw({ at: "plan", trial: true, chosen: CHOSEN, waiting: true, link: "ready" });
    expect(screen.getByRole("status").textContent).toBe(J.planStarting);
    cleanup();
    draw({ at: "plan", trial: false, chosen: CHOSEN, waiting: true, link: "ready" });
    expect(screen.getByRole("status").textContent).toBe(J.planWaiting);
  });

  it("no account page to open: says so, and Do this later is the one way out", () => {
    draw({ at: "plan", trial: true, chosen: CHOSEN, waiting: false, link: "none" });
    expect(screen.getByRole("status").textContent).toBe(J.planUnavailable);
    expect(screen.queryByRole("link", { name: J.planStartTrial })).toBeNull();
    expect(link(J.later).getAttribute("href")).toBe("/");
  });

  it("the plan says why it is back on this step", () => {
    draw(
      { at: "plan", trial: true, chosen: CHOSEN, waiting: false, link: "ready" },
      { refusal: J.planPending },
    );
    expect(screen.getByRole("alert").textContent).toBe(J.planPending);
  });

  it("the mailbox step draws the shell's connect form at its step", () => {
    draw({ at: "mailbox" });
    expect(heading()).toBe(J.step_mailbox_title);
    expect(screen.getByRole("form", { name: "the connect form" })).toBeTruthy();
  });

  it("set up, the organize decision ahead: names the mailbox, and Continue opens the first run", () => {
    draw({ at: "done", mailbox: "mila@example.org", decisionAhead: true });
    expect(heading()).toBe(J.myMailboxes.replace(/\.$/, ""));
    expect(document.body.textContent).toContain(J.connected);
    expect(document.body.textContent).toContain("mila@example.org");
    expect(link(J.continue).getAttribute("href")).toBe("/#/first-run");
  });

  it("set up, agreed: You're set up, and Open ohmail", () => {
    draw({ at: "done", mailbox: null, decisionAhead: false });
    expect(heading()).toBe(J.step_done_title);
    expect(link(J.openOhmail).getAttribute("href")).toBe("/#/first-run");
  });
});

describe("the pages around the steps", () => {
  it("expired: says why, and Sign in carries the setup on", () => {
    draw({ at: "expired", said: J.expiredOpen });
    expect(heading()).toBe(J.expiredTitle);
    expect(document.body.textContent).toContain(J.expiredOpen);
    expect(document.body.textContent).toContain(J.expiredNote);
    expect(screen.queryByRole("img", { name: /^Step \d of 5/ })).toBeNull();
    expect(link(J.signIn).getAttribute("href")).toBe("/login?next=join");
  });

  it("full: the list is the one way on", () => {
    draw({ at: "full", said: J.refusedFull });
    expect(heading()).toBe(J.capacityTitle.replace(/\.$/, ""));
    expect(document.body.textContent).toContain(J.refusedFull);
    expect(link(J.capacityCta).getAttribute("href")).toBe("/#pricing");
  });

  it("unreachable: says nothing was changed; Try again asks again, and the way back to ohmail", () => {
    const { acts } = draw({ at: "unreachable" });
    expect(heading()).toBe(O.resumeUnreachableTitle);
    expect(document.body.textContent).toContain(O.resumeUnreachableBody);
    fireEvent.click(button(O.resumeRetry));
    expect(acts.retry).toHaveBeenCalledTimes(1);
    /* The way back is a link, as the card's: the address the host handed. */
    expect(link(O.resumeLeave).getAttribute("href")).toBe("/");
  });

  it("resolving: says where the setup stands is being found; wordless, and with nothing to press, until its words arrive", () => {
    const { view } = draw({ at: "resolving" });
    /* "One moment", and under it what is being read, as the card said them. */
    expect(heading()).toBe(O.resumeCheckingTitle);
    expect(screen.getByRole("status").textContent).toBe(O.resumeChecking);
    expect(view.container.querySelector("[aria-busy='true']")).not.toBeNull();
    cleanup();
    const { onboarding: _held, ...cut } = en;
    const later = draw({ at: "resolving" }, {}, cut, "en", true);
    expect(later.view.container.textContent).toBe("");
    cleanup();
    const unreached = draw({ at: "unreachable" }, {}, cut, "en", true);
    expect(unreached.view.container.textContent).toBe("");
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("unavailable, and a build with no server: no account can be made here; the demo only where there is one", () => {
    draw({ at: "unavailable" });
    expect(heading()).toBe(en.gate.lede.replace(/\.$/, ""));
    expect(link(J.openDemo).getAttribute("href")).toBe("/?demo=1");
    cleanup();
    draw({ at: "unavailable" }, { demo: false });
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.queryByRole("link", { name: en.gate.openDemo })).toBeNull();
    expect(link(en.gate.signIn).getAttribute("href")).toBe("/login");
    cleanup();
    render(
      <TextProvider locale="en" messages={en as never} timeZone="UTC">
        <JoinPage door={NONE} />
      </TextProvider>,
    );
    expect(heading()).toBe(en.gate.lede.replace(/\.$/, ""));
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("where the host hands no address, a way out is a button that presses", () => {
    const press = vi.fn();
    render(
      <TextProvider locale="en" messages={en as never} timeZone="UTC">
        <JoinPage door={{ ...doorWith({ at: "full", said: J.refusedFull }), waitlist: { press } }} />
      </TextProvider>,
    );
    expect(screen.queryByRole("link")).toBeNull();
    fireEvent.click(button(J.capacityCta));
    expect(press).toHaveBeenCalledTimes(1);
  });

  it("speaks German where the catalogue is German", () => {
    draw({ at: "account" }, {}, de, "de");
    expect(heading()).toBe(
      de.join.account
        .replace("<name>,</name>", `${de.join.nameLabel},`)
        .replace("<email>,</email>", `${de.join.emailLabel},`)
        .replace("<password></password>.", de.join.passwordLabel),
    );
    expect(blank(de.join.passwordLabel)).toBeTruthy();
    expect(screen.getByRole("img", { name: "Schritt 1 von 5, Account, 1 von 5" })).toBeTruthy();
  });

  it("names its states by the reference's address", () => {
    expect(JOIN_STATES).toContain("account");
    expect(JOIN_STATES).toContain("nopage");
    expect(new Set(JOIN_STATES).size).toBe(JOIN_STATES.length);
  });
});
