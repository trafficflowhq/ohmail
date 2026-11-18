/**
 * ONE NAMED STATE OF EVERY DOOR'S PAGE, over doors that answer nothing: a field, a key hint, a list, a refusal and the
 * small mark among them. Drawn by `under-todays-sheets.test.tsx` in jsdom for its markup, and live in a browser by
 * `doors-harness.tsx`, so that both read the same pages.
 */
import type { ReactNode } from "react";
import { ApprovePage } from "../../src/doors/approve/index.js";
import { AuthorizeDesktopPage } from "../../src/doors/authorize-desktop/index.js";
import { DeleteAccountPage } from "../../src/doors/delete-account/index.js";
import { InvitePage } from "../../src/doors/invite/index.js";
import { JoinPage, type JoinDoor } from "../../src/doors/join/index.js";
import { LinkDesktopPage } from "../../src/doors/link-desktop/index.js";
import { NoPagePage } from "../../src/doors/no-page/index.js";
import { SetupPage } from "../../src/doors/setup/index.js";
import { SignedOutPage } from "../../src/doors/signed-out/index.js";
import { SignInPage } from "../../src/doors/sign-in/index.js";
import { StepUpDialog, type StepUpDoor } from "../../src/doors/step-up/index.js";
import { SubscribedPage } from "../../src/doors/subscribed/index.js";
import { VerifyPage } from "../../src/doors/verify/index.js";
import { WallPage } from "../../src/doors/wall/index.js";
import doors from "../../messages/doors.en.json" with { type: "json" };

export const nothing = (): void => {};
const pending = { said: null, act: "Sign out", signingOut: false, again: nothing };
const answers = { onVerified: nothing, onCancel: nothing, onDiscarded: nothing };
const stepUp: StepUpDoor = {
  factors: () => Promise.resolve({ ok: true, factors: { passkey: true, code: true, recovery: true } }),
  verify: () => Promise.resolve({ ok: false, refusal: { word: "bad_code" } }),
};
const blanks = { token: "", code: "", email: "mila@lichtgrat.example", name: "Mila", password: "", otp: "" };
const press = { busy: false, retryIn: null, refusal: null, discarded: false, signIn: false, factor: false };
const joinDoor = (): JoinDoor => ({
  state: { at: "account" },
  stations: ["account", "verify", "factor", "codes", "plan", "mailbox"],
  note: "managed-open",
  invited: false,
  busy: false,
  refusal: null,
  fields: blanks,
  suggestion: null,
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
  slots: { mailbox: () => null, authenticatorQr: () => null },
});

/** One named state of every door's page, by the door's name. */
export const PAGES: Record<string, () => ReactNode> = {
  "signed-out": () => (
    <SignedOutPage door={{ state: { at: "busy" }, tryAgain: nothing, signIn: nothing, demo: nothing }} />
  ),
  "no-page": () => (
    <NoPagePage
      door={{
        at: "missing",
        words: { title: "No page here.", note: "Nothing.", home: "Home" },
        home: nothing,
      }}
    />
  ),
  "sign-in": () => (
    <SignInPage
      door={{
        state: { at: "password", busy: false, refusal: { word: "bad_credentials" } },
        note: "managed-open",
        continues: null,
        why: null,
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
  ),
  verify: () => (
    <VerifyPage
      door={{
        state: {
          at: "form",
          asksCode: true,
          codeHeld: false,
          busy: false,
          refusal: doors.verify.refusedLink,
          passwordRefused: false,
        },
        fields: { code: "", password: "" },
        type: nothing,
        submit: nothing,
        signIn: nothing,
        newLink: nothing,
        pending,
      }}
    />
  ),
  setup: () => (
    <SetupPage
      door={{
        state: { at: "form", busy: false, refusal: null, tokenRefused: false },
        fields: blanks,
        type: nothing,
        submit: nothing,
        retry: nothing,
        signIn: nothing,
        copy: () => Promise.resolve(true),
      }}
    />
  ),
  invite: () => (
    <InvitePage
      door={{
        state: { at: "form", busy: false, refusal: null },
        fields: blanks,
        type: nothing,
        submit: nothing,
        pending,
      }}
    />
  ),
  subscribed: () => <SubscribedPage door={{ state: { at: "back" }, open: nothing }} />,
  join: () => <JoinPage door={joinDoor()} />,
  "step-up": () => <StepUpDialog door={stepUp} {...answers} />,
  approve: () => (
    <ApprovePage
      door={{
        state: {
          at: "ask",
          asked: {
            label: "Mila's laptop",
            platform: "Linux",
            minutes: 2,
            network: "n",
            otherNetwork: false,
            account: "mila@lichtgrat.example",
            remaining: 9,
          },
          busy: false,
          retryIn: null,
          refusal: null,
          factor: false,
        },
        confirm: nothing,
        deny: nothing,
        stepUp,
        factor: answers,
      }}
    />
  ),
  "authorize-desktop": () => (
    <AuthorizeDesktopPage
      door={{
        state: {
          at: "ask",
          client: "tf-macos",
          address: "m•••@lichtgrat.example",
          remaining: 9,
          busy: false,
          refusal: null,
          factor: false,
        },
        confirm: nothing,
        signIn: nothing,
        stepUp,
        factor: answers,
      }}
    />
  ),
  "link-desktop": () => (
    <LinkDesktopPage
      door={{
        state: { at: "code", code: ["K7", "QM-42XD"].join(""), remaining: 540, bound: true, ...press },
        press: nothing,
        openApp: nothing,
        signIn: nothing,
        stepUp,
        factor: answers,
      }}
    />
  ),
  "delete-account": () => (
    <DeleteAccountPage
      door={{
        state: {
          at: "form",
          email: "mila@lichtgrat.example",
          subscription: true,
          typed: "",
          busy: false,
          refusal: null,
          cancelled: false,
          factor: false,
        },
        service: "managed",
        type: nothing,
        begin: nothing,
        back: nothing,
        home: nothing,
        signIn: nothing,
        privacy: nothing,
        stepUp,
        factor: answers,
      }}
    />
  ),
  wall: () => (
    <WallPage
      door={{
        state: {
          at: "refused",
          headline: { key: "trialEnded", date: "1 October 2026" },
          standing: { kind: "stopped", erasure: { kind: "dated", date: "31 October 2026" } },
          check: "idle",
          wayBack: { label: "subscribe", hint: "subscribeHint", minting: false, refusal: null },
          moveOut: { exporting: false, failed: false },
          deleteHint: "deleteHint",
          signingOut: false,
          signOutSaid: null,
        },
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
  ),
};
