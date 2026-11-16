/** @vitest-environment jsdom */
/**
 * THE DOORS' OWN CLASSES ARE THEIR OWN. A door's page stands in a document that loads today's sheets (the old kit's,
 * the web app's), unlayered: a class they style that a door also draws is styled twice, which is how the frame's
 * notice bar once drew as an empty grey band on a phone. Every class a door's page draws, in each of its states, is
 * styled by none of them; the doors' own carry the prefix `way-`.
 */
import { act, cleanup, render } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NONE } from "../../src/host/contract.js";
import { TextProvider } from "../../src/text/index.js";
import { InvitePage, type InviteState } from "../../src/doors/invite/index.js";
import { JoinPage, type JoinDoor, type JoinState } from "../../src/doors/join/index.js";
import { NoPagePage } from "../../src/doors/no-page/index.js";
import { SetupPage, type SetupState } from "../../src/doors/setup/index.js";
import { SignInPage, type SignInState } from "../../src/doors/sign-in/index.js";
import { SignedOutPage, type SignedOutState } from "../../src/doors/signed-out/index.js";
import { DoorStage } from "../../src/doors/stage/index.js";
import { SubscribedPage } from "../../src/doors/subscribed/index.js";
import { VerifyPage, type VerifyState } from "../../src/doors/verify/index.js";
import { StepUpDialog, type StepUpDoor, type StepUpVerified } from "../../src/doors/step-up/index.js";
import { ApprovePage, type ApproveState } from "../../src/doors/approve/index.js";
import { AuthorizeDesktopPage, type AuthorizeDesktopState } from "../../src/doors/authorize-desktop/index.js";
import { LinkDesktopPage, type LinkDesktopState } from "../../src/doors/link-desktop/index.js";
import { DeleteAccountPage, type DeleteAccountState } from "../../src/doors/delete-account/index.js";
import { WallPage, type WallState } from "../../src/doors/wall/index.js";
import { createFeed } from "../../src/host/index.js";
import doors from "../../messages/doors.en.json" with { type: "json" };
import mailboxes from "../../messages/mailboxes.en.json" with { type: "json" };

const REPO = resolve(__dirname, "../../../..");
/** Where today's sheets live; the new kit's own sheet is not one of them. */
const TODAYS_TREES = ["packages/ui/src", "apps/webapp/app"];
const NOT_TODAYS = new Set(["packages/ui/src/base/base.css"]);

function sheetsUnder(dir: string): string[] {
  return readdirSync(join(REPO, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sheetsUnder(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });
}

/** Every class a sheet's selectors name, comments and strings left out. */
function classesStyledBy(css: string): Set<string> {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/"[^"]*"|'[^']*'/g, "");
  const selectors = bare.match(/[^{}]+(?=\{)/g) ?? [];
  return new Set(selectors.flatMap((s) => [...s.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((m) => m[1]!)));
}

const nothing = (): void => {};
const blanks = {
  token: "t",
  code: "OHMAIL-1",
  email: "a@b.example",
  name: "A",
  password: "p".repeat(12),
  otp: "123456",
};
const pending = { said: "The sign-out did not finish.", act: "Sign out", signingOut: false, again: nothing };
const joinDoor = (state: JoinState): JoinDoor => ({
  state,
  stations: ["invite", "account", "verify", "factor", "codes", "plan", "mailbox"],
  note: "managed-open",
  invited: false,
  busy: false,
  refusal: "Refused.",
  fields: blanks,
  suggestion: "a@example.com",
  pending,
  type: nothing,
  redeem: nothing,
  register: nothing,
  toInvite: nothing,
  takeSuggestion: nothing,
  changeAddress: nothing,
  signIn: { href: "/login" },
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
  accountPage: { href: "https://plane.example/manage" },
  later: { href: "/" },
  open: { href: "/#/first-run" },
  retry: nothing,
  leave: { href: "/" },
  signInAgain: { href: "/login?next=join" },
  waitlist: { href: "/#pricing" },
  demo: { href: "/?demo=1" },
  slots: { mailbox: () => <p>form</p>, authenticatorQr: () => <svg /> },
});
const JOIN_STATES: JoinState[] = [
  { at: "unavailable" },
  { at: "resolving" },
  { at: "unreachable" },
  { at: "expired", said: "x" },
  { at: "full", said: "x" },
  { at: "invite" },
  { at: "account" },
  { at: "sent", continuing: true },
  { at: "verify", resent: false },
  { at: "factor", authenticator: null },
  { at: "factor", authenticator: { key: "KEY", copied: "failed" } },
  {
    at: "codes",
    codes: [
      ["AAAA", "1111"],
      ["BBBB", "2222"],
    ].map((c) => c.join("-")),
    copied: "failed",
    saved: false,
  },
  { at: "codes", codes: "elsewhere", copied: null, saved: false },
  { at: "mailbox" },
  { at: "plan", trial: true, chosen: { name: "Plus", interval: "year" }, waiting: true, link: "ready" },
  { at: "plan", trial: false, chosen: { name: null, interval: null }, waiting: false, link: "none" },
  { at: "done", mailbox: "a@b.example", decisionAhead: true },
];
const SIGNED_OUT: SignedOutState[] = [
  { at: "checking", slow: true },
  { at: "busy" },
  { at: "signedOut", reason: "reused" },
  { at: "out" },
  { at: "unchecked", warm: true },
];
const SIGN_IN: SignInState[] = [
  { at: "password", busy: false, refusal: { word: "bad_credentials" } },
  {
    at: "factor",
    factor: "code",
    offered: ["passkey", "code", "recovery"],
    busy: false,
    refusal: { word: "bad_code" },
  },
  { at: "factor", factor: "passkey", offered: ["passkey", "code"], busy: true, refusal: null },
];
const SETUP: SetupState[] = [
  { at: "checking" },
  { at: "unreachable" },
  { at: "settled" },
  { at: "form", busy: false, refusal: "Refused.", tokenRefused: true },
];
const INVITE: InviteState[] = [
  { at: "opening" },
  { at: "missing" },
  { at: "unavailable" },
  { at: "form", busy: false, refusal: "Refused." },
];
const VERIFY: VerifyState[] = [
  { at: "unavailable" },
  { at: "done" },
  { at: "handed" },
  { at: "form", asksCode: true, codeHeld: true, busy: false, refusal: "Refused.", passwordRefused: true },
];

/** A step-up door whose factors are all enrolled and whose every verify is refused with `refusal`. */
const stepUpDoor = (passkey: boolean, refusal: StepUpVerified): StepUpDoor => ({
  factors: () => Promise.resolve({ ok: true, factors: { passkey, code: true, recovery: true } }),
  verify: () => Promise.resolve(refusal),
});
const STEP_UP_REFUSED: StepUpVerified = { ok: false, refusal: { word: "bad_code" } };
const stepUp = (passkey: boolean) => (
  <StepUpDialog
    door={stepUpDoor(passkey, STEP_UP_REFUSED)}
    onVerified={nothing}
    onCancel={nothing}
    onDiscarded={nothing}
  />
);

const answers = { onVerified: nothing, onCancel: nothing, onDiscarded: nothing };
const desktopPress = {
  busy: false,
  retryIn: 8,
  refusal: "Refused.",
  discarded: true,
  signIn: true,
  factor: true,
};
const APPROVE: ApproveState[] = [
  { at: "checking", retryIn: 5 },
  { at: "gone", said: null },
  { at: "done" },
  {
    at: "ask",
    asked: {
      label: "A",
      platform: "Linux",
      minutes: 2,
      network: "n",
      otherNetwork: true,
      account: "a@b.example",
      remaining: 9,
    },
    busy: false,
    retryIn: null,
    refusal: "Refused.",
    factor: true,
  },
];
const AUTHORIZE: AuthorizeDesktopState[] = [
  { at: "signin" },
  { at: "over", said: null },
  {
    at: "ask",
    client: "tf-macos",
    address: "a•••@b.example",
    remaining: 9,
    busy: false,
    refusal: "Refused.",
    factor: true,
  },
];
const LINK: LinkDesktopState[] = [
  { at: "signin" },
  { at: "start", ...desktopPress },
  { at: "code", code: ["K7", "QM-42XD"].join(""), remaining: 9, bound: true, ...desktopPress },
];

const DELETE: DeleteAccountState[] = [
  { at: "checking" },
  { at: "signedout" },
  {
    at: "form",
    email: "a@b.example",
    subscription: true,
    typed: "a@b.example",
    busy: false,
    refusal: "Refused.",
    cancelled: true,
    factor: true,
  },
  { at: "done", subscription: "cancel_failed", unclean: true },
];

const WALL_REFUSED: Extract<WallState, { at: "refused" }> = {
  at: "refused",
  headline: { key: "trialEnded", date: "1 Oct" },
  standing: { kind: "stopped", erasure: { kind: "dated", date: "1 Nov" } },
  check: "pending",
  wayBack: { label: "subscribe", hint: "subscribeHint", minting: false, refusal: "mintFailed" },
  moveOut: { exporting: false, failed: true },
  deleteHint: "deleteHint",
  signingOut: false,
  signOutSaid: "Not finished.",
};
const WALL: WallState[] = [
  WALL_REFUSED,
  { ...WALL_REFUSED, check: "checking" },
  { at: "erased", blocked: true },
];

/** Every door's page, in each of its states, on the stage. */
function pages(): ReactNode[] {
  return [
    ...JOIN_STATES.map((state) => <JoinPage door={joinDoor(state)} />),
    <JoinPage door={NONE} />,
    ...SIGNED_OUT.map((state) => (
      <SignedOutPage door={{ state, tryAgain: nothing, signIn: nothing, demo: nothing }} />
    )),
    ...SIGN_IN.map((state) => (
      <SignInPage
        door={{
          state,
          note: "managed-open",
          continues: "join",
          why: "expired",
          pending,
          fields: { email: "", password: "", code: "" },
          type: nothing,
          begin: nothing,
          passkey: nothing,
          finish: nothing,
          use: nothing,
          restart: nothing,
          join: { href: "/join" },
          demo: { href: "/?demo=1" },
        }}
      />
    )),
    <NoPagePage
      door={{ at: "missing", words: { title: "No page.", note: "Gone.", home: "Home" }, home: nothing }}
    />,
    ...SETUP.map((state) => (
      <SetupPage
        door={{
          state,
          fields: blanks,
          type: nothing,
          submit: nothing,
          retry: nothing,
          signIn: nothing,
          copy: () => Promise.resolve(true),
        }}
      />
    )),
    ...INVITE.map((state) => (
      <InvitePage door={{ state, fields: blanks, type: nothing, submit: nothing, pending }} />
    )),
    ...VERIFY.map((state) => (
      <VerifyPage
        door={{
          state,
          fields: blanks,
          type: nothing,
          submit: nothing,
          signIn: nothing,
          newLink: nothing,
          pending,
        }}
      />
    )),
    <SubscribedPage door={{ state: { at: "continuing" }, open: nothing }} />,
    <SubscribedPage door={{ state: { at: "back" }, open: nothing }} />,
    stepUp(true),
    stepUp(false),
    ...APPROVE.map((state) => (
      <ApprovePage
        door={{
          state,
          confirm: nothing,
          deny: nothing,
          stepUp: stepUpDoor(true, STEP_UP_REFUSED),
          factor: answers,
        }}
      />
    )),
    ...AUTHORIZE.map((state) => (
      <AuthorizeDesktopPage
        door={{
          state,
          confirm: nothing,
          signIn: nothing,
          stepUp: stepUpDoor(false, STEP_UP_REFUSED),
          factor: answers,
        }}
      />
    )),
    ...LINK.map((state) => (
      <LinkDesktopPage
        door={{
          state,
          press: nothing,
          openApp: nothing,
          signIn: nothing,
          stepUp: stepUpDoor(true, STEP_UP_REFUSED),
          factor: answers,
        }}
      />
    )),
    ...WALL.map((state) => (
      <WallPage
        door={{
          state,
          wayBack: nothing,
          checkAgain: nothing,
          moveOut: nothing,
          guide: nothing,
          deleteNow: nothing,
          signOut: nothing,
          changePassword: () => {},
          home: nothing,
        }}
      />
    )),
    ...DELETE.map((state) => (
      <DeleteAccountPage
        door={{
          state,
          service: "managed",
          type: nothing,
          begin: nothing,
          back: nothing,
          home: nothing,
          signIn: nothing,
          privacy: nothing,
          stepUp: stepUpDoor(false, STEP_UP_REFUSED),
          factor: answers,
        }}
      />
    )),
  ];
}

/** Every page of the doors, state by state, drawn on its stage; `read` reads the document each time. */
async function eachPage(read: () => void): Promise<void> {
  const device = () => ({
    window: createFeed({
      width: 390,
      height: 844,
      pointer: "coarse",
      posture: "upright",
      reducedMotion: false,
    } as never),
    appearance: createFeed({ face: "paper", scheme: "light" } as never),
    root: { read: () => null, write: nothing },
  });
  for (const page of pages()) {
    render(
      <TextProvider locale="en" messages={{ ...doors, ...mailboxes } as never} timeZone="UTC">
        <DoorStage device={device}>{page}</DoorStage>
      </TextProvider>,
    );
    /* What a door reads as it opens has answered: the step-up dialog's other ways are drawn. */
    await act(async () => {});
    read();
    cleanup();
  }
}

async function drawnClasses(): Promise<Set<string>> {
  const drawn = new Set<string>();
  await eachPage(() =>
    document.querySelectorAll("[class]").forEach((el) => el.classList.forEach((c) => drawn.add(c))),
  );
  return drawn;
}

beforeEach(() => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("the classes the doors draw", () => {
  it("are styled by none of today's sheets, and the doors' own carry their prefix", async () => {
    const drawn = [...(await drawnClasses())].filter((c) => !c.startsWith("oh-"));
    const sheets = TODAYS_TREES.flatMap(sheetsUnder).filter((p) => !NOT_TODAYS.has(p));
    expect(sheets.length).toBeGreaterThan(20);
    const clashes = sheets.flatMap((path) => {
      const styled = classesStyledBy(readFileSync(join(REPO, path), "utf8"));
      return drawn.filter((c) => styled.has(c)).map((c) => `.${c} in ${relative(REPO, join(REPO, path))}`);
    });
    expect(clashes).toEqual([]);
    expect(drawn.filter((c) => !c.startsWith("way-"))).toEqual([]);
    expect(drawn).toEqual(
      expect.arrayContaining([
        "way-stage",
        "way-join-progress",
        "way-door-fields",
        "way-setup-cmd",
        "way-setup-code",
        "way-step-up-form",
        "way-sheet",
        "way-sheet-title",
        "way-fact-list",
        "way-fact",
        "way-fact-dot",
        "way-fine",
        "way-line",
        "way-heavy",
        "way-note",
        "way-break",
        "way-rows",
        "way-row",
        "way-row-icon",
        "way-row-label",
        "way-row-hint",
        "way-wall-guide",
        "way-nb",
        "way-code",
        "way-unseen",
      ]),
    );
  });

  /*
   * BEFORE THE PAGE'S SCRIPT HAS RUN, A PRESS IS THE BROWSER'S OWN. The document arrives with the form drawn, and the
   * browser sends a form's NAMED blanks as the page's query: on /login that was the address and the password in the
   * address bar, the history and the server's log. No blank a door draws carries a name, as none of the old cards'
   * did, so a press before the script sends nothing that was typed.
   */
  it("no blank a door draws carries a name: a press before the script sends nothing typed", async () => {
    const named: string[] = [];
    let blanks = 0;
    await eachPage(() =>
      document.querySelectorAll("input, textarea, select, button").forEach((control) => {
        if (control.matches("input, textarea")) blanks += 1;
        if (control.hasAttribute("name"))
          named.push(`${control.tagName.toLowerCase()} name="${control.getAttribute("name")}"`);
      }),
    );
    expect(blanks).toBeGreaterThan(15);
    expect(named).toEqual([]);
  });

  it("reads a class out of a selector, not out of a value or a comment", () => {
    expect(
      [...classesStyledBy(`/* .way-a */ .way-b > .x:hover, a.y { width: .5rem; content: ".z" }`)].sort(),
    ).toEqual(["way-b", "x", "y"]);
  });
});
