/**
 * THE DOORS' REGISTERED STATES, drawn by address over fake doors: the page the comparison's subjects open. The
 * address carries the reference's own words (`screen=verify&state=badpw`, `device=phone`, `face=ohmarchy`,
 * `scheme=dark`) and `lang`. A screen's address without a state is its first state, as the reference draws it.
 * Refusals are the shell's sentences, said here in the catalogue's words where it has them.
 */
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createFeed } from "../../src/host/index.js";
import { TextProvider } from "../../src/text/index.js";
import { DoorStage } from "../../src/doors/stage/index.js";
import { ApprovePage, type ApproveState } from "../../src/doors/approve/index.js";
import { AuthorizeDesktopPage, type AuthorizeDesktopState } from "../../src/doors/authorize-desktop/index.js";
import { DeleteAccountPage, type DeleteAccountState } from "../../src/doors/delete-account/index.js";
import { InvitePage, type InviteState } from "../../src/doors/invite/index.js";
import { LinkDesktopPage, type LinkDesktopState } from "../../src/doors/link-desktop/index.js";
import { NoPagePage } from "../../src/doors/no-page/index.js";
import { SetupPage, type SetupState } from "../../src/doors/setup/index.js";
import { SignedOutPage, type SignedOutState } from "../../src/doors/signed-out/index.js";
import type { StepUpDoor } from "../../src/doors/step-up/index.js";
import { SubscribedPage } from "../../src/doors/subscribed/index.js";
import { VerifyPage, type VerifyState } from "../../src/doors/verify/index.js";
import { WallPage, type WallState } from "../../src/doors/wall/index.js";
import accountDe from "../../messages/account.de.json" with { type: "json" };
import accountEn from "../../messages/account.en.json" with { type: "json" };
import doorsDe from "../../messages/doors.de.json" with { type: "json" };
import doorsEn from "../../messages/doors.en.json" with { type: "json" };
import frameDe from "../../messages/frame.de.json" with { type: "json" };
import frameEn from "../../messages/frame.en.json" with { type: "json" };

type Words = Record<string, Record<string, string>>;
const q = new URLSearchParams(location.search);
const lang = q.get("lang") === "de" ? "de" : "en";
const words = (lang === "de" ? doorsDe : doorsEn) as unknown as Words;
/* The shell says a refusal in its own namespaces' words (the account's, the frame's), handed to the page as text. */
const shellWords = {
  ...((lang === "de" ? frameDe : frameEn) as unknown as Words),
  ...((lang === "de" ? accountDe : accountEn) as unknown as Words),
};
const say = (ns: string, key: string): string => words[ns]?.[key] ?? shellWords[ns]?.[key] ?? key;
const screen = q.get("screen") ?? "";
const state = q.get("state");
const ROOMS = {
  phone: { width: 390, height: 844, pointer: "coarse" },
  fold: { width: 719, height: 781, pointer: "coarse" },
  foldl: { width: 841, height: 673, pointer: "coarse" },
  desktop: { width: 1440, height: 900, pointer: "fine" },
} as const;
const room = ROOMS[(q.get("device") as keyof typeof ROOMS | null) ?? "desktop"] ?? ROOMS.desktop;
const face = q.get("face") === "ohmarchy" ? "ohmarchy" : "paper";
const scheme = q.get("scheme") === "dark" ? "dark" : "light";

const nothing = (): void => {};
const ACCOUNT = "mila@lichtgrat.example";
/* The reference's two dates: when the trial ended, when what ohmail keeps is erased. */
const ENDED = "Wed 18 Nov";
const ERASE = "Fri 18 Dec";
const pending = { said: null, act: say("account", "signOut"), signingOut: false, again: nothing };
const answers = { onVerified: nothing, onCancel: nothing, onDiscarded: nothing };
const stepUp: StepUpDoor = {
  factors: () => Promise.resolve({ ok: true, factors: { passkey: true, code: true, recovery: true } }),
  verify: () => new Promise(() => {}),
};
const press = { busy: false, retryIn: null, refusal: null, discarded: false, signIn: false, factor: false };

const signedOut: Record<string, SignedOutState> = {
  out: { at: "out" },
  unchecked: { at: "unchecked", warm: false },
  checking: { at: "checking", slow: true },
  revoked: { at: "signedOut", reason: "revoked" },
  pending: { at: "signedOut", reason: "pending" },
  expired: { at: "signedOut", reason: "expired" },
  absent: { at: "signedOut", reason: "absent" },
  reused: { at: "signedOut", reason: "reused" },
  busy: { at: "busy" },
};
const form = (o: Partial<Extract<VerifyState, { at: "form" }>> = {}): VerifyState => ({
  at: "form",
  asksCode: false,
  codeHeld: true,
  busy: false,
  refusal: null,
  passwordRefused: false,
  ...o,
});
const verify: Record<string, VerifyState> = {
  form: form(),
  code: form({ asksCode: true, codeHeld: false }),
  badlink: form({ codeHeld: false, refusal: say("verify", "refusedLink") }),
  badpw: form({ refusal: say("verify", "refusedPassword"), passwordRefused: true }),
  locked: form({ refusal: say("login", "tooManyAttempts") }),
  slowed: form({ refusal: say("login", "signInSlowed") }),
  done: { at: "done" },
  handed: { at: "handed" },
  unavailable: { at: "unavailable" },
};
/* What the reference types into a refused form: the person, and a token (made here, never written as a literal). */
const PERSON = "Mila Brunner";
const typedSetup = (id: string) => ({
  token: id === "badtoken" ? "wrong" : ["st", "7K2M", "QX4D"].join("-"),
  email: ACCOUNT,
  name: PERSON,
  password: "a".repeat(14),
});
const setup: Record<string, SetupState> = {
  checking: { at: "checking" },
  form: { at: "form", busy: false, refusal: null, tokenRefused: false },
  badtoken: { at: "form", busy: false, refusal: say("setup", "badToken"), tokenRefused: true },
  spent: {
    at: "form",
    busy: false,
    /* The reference's other address: the second mailbox of its account. */
    refusal: say("setup", "tokenSpent").replace("{email}", "hello@milabrunner.example"),
    tokenRefused: false,
  },
  settled: { at: "settled" },
  unreachable: { at: "unreachable" },
};
const invite: Record<string, InviteState> = {
  opening: { at: "opening" },
  form: { at: "form", busy: false, refusal: null },
  dead: { at: "form", busy: false, refusal: say("joinInvite", "badToken") },
  used: {
    at: "form",
    busy: false,
    refusal: say("joinInvite", "tokenSpent").replace("{email}", ACCOUNT),
  },
  incomplete: { at: "missing" },
  unavailable: { at: "unavailable" },
};
/* The reference's own facts (`screens/doors.js`, its first lines): the computer, where it asked from, the time left. */
const asked = {
  label: "Lichtgrat laptop",
  platform: "Linux",
  minutes: 0,
  network: "203.0.113.0/24",
  otherNetwork: false,
  account: ACCOUNT,
  remaining: 280,
};
const ask = (o: Partial<Extract<ApproveState, { at: "ask" }>> = {}): ApproveState => ({
  at: "ask",
  asked,
  busy: false,
  retryIn: null,
  refusal: null,
  factor: false,
  ...o,
});
const approve: Record<string, ApproveState> = {
  ask: ask(),
  othernet: ask({ asked: { ...asked, otherNetwork: true } }),
  factor: ask({ factor: true }),
  busy: ask({ busy: true, retryIn: 8 }),
  stillbusy: ask({ refusal: say("approve", "busyGaveUp") }),
  discarded: ask({ refusal: say("approve", "stepUpDiscarded") }),
  done: { at: "done" },
  denied: { at: "denied" },
  expired: { at: "gone", said: say("approve", "expired") },
  used: { at: "gone", said: say("approve", "used") },
  none: { at: "gone", said: say("approve", "notFound") },
  bare: { at: "bare" },
  unchecked: { at: "unchecked" },
  closed: { at: "closed" },
};
const authorizeAsk = (factor: boolean): AuthorizeDesktopState => ({
  at: "ask",
  client: "tf-macos",
  address: ACCOUNT,
  remaining: 112,
  busy: false,
  refusal: null,
  factor,
});
const authorize: Record<string, AuthorizeDesktopState> = {
  ask: authorizeAsk(false),
  factor: authorizeAsk(true),
  done: { at: "done" },
  over: { at: "over", said: say("authorizeDesktop", "expired") },
  signin: { at: "signin" },
};
const linkDesktop: Record<string, LinkDesktopState> = {
  start: { at: "start", ...press },
  code: { at: "code", code: ["K7", "QM-42XD"].join(""), remaining: 108, bound: true, ...press },
  factor: { at: "start", ...press, factor: true },
  cancelled: { at: "start", ...press, discarded: true },
  busy: { at: "start", ...press, busy: true, retryIn: 8 },
  stillbusy: { at: "start", ...press, refusal: say("linkDesktop", "busyGaveUp") },
  signin: { at: "signin" },
};
const deleteForm = (o: Partial<Extract<DeleteAccountState, { at: "form" }>> = {}): DeleteAccountState => ({
  at: "form",
  /* The session's own address; a case may name another (`email=`), as a long one a person may have. */
  email: q.get("email") ?? ACCOUNT,
  subscription: true,
  typed: "",
  busy: false,
  refusal: null,
  cancelled: false,
  factor: false,
  ...o,
});
const deleteAccount: Record<string, DeleteAccountState> = {
  facts: deleteForm(),
  typed: deleteForm({ typed: ACCOUNT }),
  factor: deleteForm({ typed: ACCOUNT, factor: true }),
  erasing: deleteForm({ typed: ACCOUNT, busy: true }),
  done: { at: "done", subscription: "cancelled", unclean: false },
  donepay: { at: "done", subscription: "cancel_failed", unclean: false },
  donetab: { at: "done", subscription: "none", unclean: true },
  refused: deleteForm({ typed: ACCOUNT, refusal: say("account", "eraseRefused") }),
  refusedsub: deleteForm({ typed: ACCOUNT, refusal: say("account", "eraseRefusedSubCancelled") }),
  unconfirmed: deleteForm({ typed: ACCOUNT, refusal: say("account", "eraseUnconfirmed") }),
  cancelled: deleteForm({ typed: ACCOUNT, cancelled: true }),
  window: deleteForm({ typed: ACCOUNT, refusal: say("devices", "stepUpExpired") }),
  own: deleteForm(),
  signedout: { at: "signedout" },
};
const refused = (o: Partial<Extract<WallState, { at: "refused" }>> = {}): WallState => ({
  at: "refused",
  headline: { key: "trialEnded", date: ENDED },
  standing: { kind: "stopped", erasure: { kind: "dated", date: ERASE } },
  check: "idle",
  wayBack: { label: "subscribe", hint: "subscribeHint", minting: false, refusal: null },
  moveOut: { exporting: false, failed: false },
  deleteHint: "deleteHint",
  signingOut: false,
  signOutSaid: null,
  ...o,
});
const wall: Record<string, WallState> = {
  trial: refused(),
  canceled: refused({ headline: { key: "canceled", date: ENDED } }),
  unpaid: refused({ headline: { key: "unpaid", date: ENDED } }),
  suspended: refused({
    headline: { key: "suspendedTitle" },
    standing: { kind: "stopped", erasure: { kind: "held" } },
    wayBack: { label: "openAccount", hint: null, minting: false, refusal: null },
    deleteHint: "deleteHintUndated",
  }),
  plain: refused({
    headline: { key: "title" },
    standing: { kind: "kept" },
    wayBack: { label: "manage", hint: null, minting: false, refusal: null },
    deleteHint: "deleteHintUndated",
  }),
  never: refused({
    headline: { key: "neverStartedTitle" },
    standing: { kind: "fresh" },
    wayBack: { label: "startTrial", hint: "startTrialHint", minting: false, refusal: null },
    moveOut: null,
    deleteHint: "deleteHintNeverStarted",
  }),
  pending: refused({ check: "pending" }),
  checking: refused({ check: "checking" }),
  nolink: refused({
    wayBack: { label: "subscribe", hint: "subscribeHint", minting: false, refusal: "mintFailed" },
  }),
  unverified: refused({
    wayBack: { label: "subscribe", hint: "subscribeHint", minting: false, refusal: "mintUnverified" },
  }),
  undated: refused({
    standing: { kind: "stopped", erasure: { kind: "unknown" } },
    deleteHint: "deleteHintUndated",
  }),
  nofile: refused({ moveOut: { exporting: false, failed: true } }),
  erased: { at: "erased", blocked: false },
  erasedtab: { at: "erased", blocked: true },
};

/** Each screen: its first state, and its page over a fake door in the state the address names. */
const SCREENS: Record<string, { first: string; draw(id: string): ReactNode | null }> = {
  signedout: {
    first: "out",
    draw: (id) =>
      signedOut[id] ? (
        <SignedOutPage door={{ state: signedOut[id], tryAgain: nothing, signIn: nothing, demo: nothing }} />
      ) : null,
  },
  nopage: {
    first: "missing",
    draw: (id) =>
      id === "missing" ? (
        <NoPagePage
          door={{
            at: "missing",
            words: {
              title: say("gate", "missingTitle"),
              note: say("gate", "missingNote"),
              home: say("gate", "missingHome"),
            },
            home: nothing,
          }}
        />
      ) : id === "noserver" ? (
        <NoPagePage
          door={{
            at: "noserver",
            words: {
              title: say("gate", "lede"),
              body: say("gate", "body"),
              note: say("gate", "note"),
              demo: say("gate", "openDemo"),
              signIn: say("gate", "signIn"),
            },
            demo: nothing,
            signIn: nothing,
          }}
        />
      ) : null,
  },
  subscribed: {
    first: "continuing",
    draw: (id) =>
      id === "continuing" || id === "back" ? (
        <SubscribedPage door={{ state: { at: id }, open: nothing }} />
      ) : null,
  },
  verify: {
    first: "form",
    draw: (id) =>
      verify[id] ? (
        <VerifyPage
          door={{
            state: verify[id],
            /* The reference types a wrong password where the password was refused. */
            fields: { code: "", password: id === "badpw" ? "wrong" : "" },
            type: nothing,
            submit: nothing,
            signIn: nothing,
            newLink: nothing,
            pending,
          }}
        />
      ) : null,
  },
  serversetup: {
    first: "form",
    draw: (id) =>
      setup[id] ? (
        <SetupPage
          door={{
            state: setup[id],
            fields: id === "form" ? { token: "", email: "", name: "", password: "" } : typedSetup(id),
            type: nothing,
            submit: nothing,
            retry: nothing,
            signIn: nothing,
            copy: () => Promise.resolve(true),
          }}
        />
      ) : null,
  },
  invite: {
    first: "form",
    draw: (id) =>
      invite[id] ? (
        <InvitePage
          door={{
            state: invite[id],
            /* The reference fills the blanks of a refused form. */
            fields:
              id === "dead" || id === "used"
                ? { email: ACCOUNT, name: PERSON, password: "a".repeat(14) }
                : { email: "", name: "", password: "" },
            type: nothing,
            submit: nothing,
            pending,
          }}
        />
      ) : null,
  },
  approve: {
    first: "ask",
    draw: (id) =>
      approve[id] ? (
        <ApprovePage
          door={{ state: approve[id], confirm: nothing, deny: nothing, stepUp, factor: answers }}
        />
      ) : null,
  },
  authorize: {
    first: "ask",
    draw: (id) =>
      authorize[id] ? (
        <AuthorizeDesktopPage
          door={{ state: authorize[id], confirm: nothing, signIn: nothing, stepUp, factor: answers }}
        />
      ) : null,
  },
  linkdesktop: {
    first: "start",
    draw: (id) =>
      linkDesktop[id] ? (
        <LinkDesktopPage
          door={{
            state: linkDesktop[id],
            press: nothing,
            openApp: nothing,
            signIn: nothing,
            stepUp,
            factor: answers,
          }}
        />
      ) : null,
  },
  deleteaccount: {
    first: "facts",
    draw: (id) =>
      deleteAccount[id] ? (
        <DeleteAccountPage
          door={{
            state: deleteAccount[id],
            service: id === "own" ? "self" : "managed",
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
      ) : null,
  },
  wall: {
    first: "trial",
    draw: (id) =>
      wall[id] ? (
        <WallPage
          door={{
            state: wall[id],
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
      ) : null,
  },
};

const entry = SCREENS[screen];
const drawn = entry ? entry.draw(state ?? entry.first) : null;
const root = document.documentElement;
/* What the old theme provider stamps in the product: the face and today's theme, beside the scheme the stage writes. */
root.setAttribute("data-face", face);
root.setAttribute("data-theme", scheme);
root.setAttribute("lang", lang);
const device = () => ({
  window: createFeed({ ...room, posture: "flat", reducedMotion: false } as never),
  appearance: createFeed({ face, scheme } as never),
  root: {
    read: (name: string) => root.getAttribute(name),
    write: (name: string, value: string | null) =>
      value === null ? root.removeAttribute(name) : root.setAttribute(name, value),
  },
});
createRoot(document.getElementById("root")!).render(
  <TextProvider locale={lang} messages={words as never} timeZone="Europe/Zurich">
    <DoorStage device={device}>{drawn ?? <p>{`no such state: ${screen} ${state ?? ""}`}</p>}</DoorStage>
  </TextProvider>,
);
