"use client";

/**
 * `/join`: the join's page over the join's own ceremony (`use-join-door.ts`, lifted from the old card, which has
 * left); `page.tsx` hands it what it handed the card. The ceremony's own ways on (to `/join`'s steps) are
 * its router's and state's; the ways out are links, as the card's were, to the addresses written here, and the plan
 * step's to the account page the ceremony was handed. The mailbox step is the one connect form, over this shell's
 * connect wire; the wizard stays what says whose browser this is and what a refused connect means for the setup. The
 * authenticator's picture is the shell's QR code.
 */
import { useMemo, useRef } from "react";
import { useTranslations } from "next-intl";
import { signupPosture } from "@ohmail/app/doors";
import { JoinPage, type JoinDoor, type JoinField, type JoinState, type JoinStation } from "@ohmail/app/doors/join";
import { ConnectForm, type ConnectAsk, type ConnectGuard } from "@ohmail/app/mailboxes/connect";
import { ApiError, apiConfigured, codeOf } from "../../api-client";
import { SELF_HOST_BUILD } from "../../hello";
import { PLAN_NAMES } from "../../plan-hint";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { QrCode } from "../../shell/QrCode";
import { WebDoor } from "../door-device";
import { JOIN_FRESH_SIGN_IN } from "../login/continuation";
import { usePendingDoor } from "../login/use-pending-door";
import { webConnectWire } from "../mailbox/connect-wire";
import { gatedRefusal } from "../mailbox/gated-refusal";
import { StepUp } from "../mailbox/StepUp";
import {
  RAIL_BASE, RAIL_OPEN, RAIL_OPEN_LATE_VERIFY, useJoinDoor, type JoinCeremony, type JoinProps,
} from "./use-join-door";

/** A press the card handled as a form's submit: the ceremony's handlers take the event they always took. */
const PRESS = { preventDefault() {} } as React.FormEvent;

type AccountOffer = Extract<JoinState, { at: "account" }>["offer"];

function stateOf(c: JoinCeremony, offer: AccountOffer): JoinState {
  if (!apiConfigured()) return { at: "unavailable" };
  if (c.fatal) return c.fatalAction === "waitlist" ? { at: "full", said: c.fatal } : { at: "expired", said: c.fatal };
  if (c.unreachable) return { at: "unreachable" };
  if (c.resolving) return { at: "resolving" };
  switch (c.step) {
    case "invite": return { at: "invite" };
    case "account": return { at: "account", offer };
    case "sent": return { at: "sent", continuing: c.continuing };
    case "verify": return { at: "verify", resent: c.resent };
    case "factor":
      return { at: "factor", authenticator: c.totp === null ? null : { key: c.totp.secret, copied: c.secretCopied } };
    case "codes":
      return {
        at: "codes",
        codes: c.recovery ?? (c.codesElsewhere ? "elsewhere" : c.error && !c.busy ? "failed" : "making"),
        copied: c.codesCopied,
        saved: c.codesSaved,
      };
    case "mailbox": return { at: "mailbox" };
    case "plan":
      return {
        at: "plan",
        trial: c.trialOffer,
        chosen: { name: c.hint.plan ? PLAN_NAMES[c.hint.plan] : null, interval: c.hint.interval ?? null },
        waiting: c.waiting,
        link: c.manageUrl ? "ready" : c.planLinkFailed ? "none" : "asking",
      };
    case "done":
      return {
        at: "done",
        mailbox: c.connected === null ? null : displayAddress(c.connected.address),
        decisionAhead: c.connected !== null && !c.connected.organizeConsentedAt,
      };
  }
}

/** The ten codes as a text file, the card's download: they never leave this device. */
function download(header: string, codes: readonly string[]): void {
  const a = document.createElement("a");
  a.download = "ohmail-recovery-codes.txt";
  a.href = `data:text/plain;charset=utf-8,${encodeURIComponent(`${header}\n\n${codes.join("\n")}\n`)}`;
  a.click();
}

/** Where "do this later" leaves for: the app, with the setup marked as offered in this tab. */
const LATER = "/?setup=later";
/** Where a mail to support is written to. */
const SUPPORT = "support@ohmail.app";

/**
 * The refusals of a connect that the wizard answers itself, by its runner's own arms (`use-join-door.ts`, `run`): a
 * session that ended or never finished enrolling, a session that changed under the press, a second factor refused
 * again, a full service, a plan that is owed. The form says every other refusal.
 */
const WIZARDS_OWN: ReadonlySet<string> = new Set([
  "enrollment_incomplete", "session_conflict", "step_up_required", "signup_capacity", "payment_required",
]);
const wizardsOwn = (thrown: unknown): boolean =>
  (thrown instanceof ApiError && thrown.status === 401) || WIZARDS_OWN.has(codeOf(thrown) ?? "");

/**
 * THE MAILBOX STEP'S ASK: the one connect form, opened for the join. The wizard's part is what it always was. Whose
 * browser this is, asked before every press that carries a credential, through the wizard's own runner, so a session
 * that ended there is the wizard's screen. What a refused connect means for the setup: the refusals the wizard
 * answers itself reach its runner as they did, but the first one that asks the second factor, which the form asks in
 * place. And the wizard's own sentence stands at the form until the next press.
 */
function useMailboxAsk(c: JoinCeremony): { ask: ConnectAsk; door: ReturnType<typeof webConnectWire> } {
  const t = useTranslations("join");
  const now = useRef(c);
  now.current = c;
  /* Made once: its first read takes what a provider's sign-in handed back to this page. */
  const door = useMemo(
    () =>
      webConnectWire({
        owner: () => now.current.wizardOwner.current,
        returned: "join",
        heard: {
          connected: (row) => now.current.setConnected(row),
          refused: (thrown, press) => {
            if (gatedRefusal(thrown, press.resent) === "factor" || !wizardsOwn(thrown)) return;
            void now.current.run(() => Promise.reject(thrown));
          },
        },
      }),
    [],
  );
  const guard: ConnectGuard = {
    before: async () => {
      let same = false;
      await now.current.run(async () => {
        same = await now.current.sameAccount();
      });
      return same;
    },
    said: c.error,
    clear: () => c.setError(null),
  };
  const ask: ConnectAsk = {
    purpose: { kind: "join" },
    kept: c.mailboxForm,
    guard,
    onDone: (result) => {
      if (result.kind !== "connected") return;
      c.setError(null);
      c.setStep("done");
    },
    later: () => window.location.assign(LATER),
    /* The mail to support is ohmail Cloud's: a self-hosted server's people are its operator's to help. */
    ...(SELF_HOST_BUILD
      ? {}
      : {
          help: ({ provider, reason }) => {
            const subject = t("mailboxHelpSubject", { preset: provider ?? "none", reason: reason ?? "none" });
            window.location.assign(`mailto:${SUPPORT}?subject=${encodeURIComponent(subject)}`);
          },
        }),
  };
  return { ask, door };
}

export function JoinRoute(props: JoinProps) {
  const t = useTranslations("join");
  const c = useJoinDoor(props);
  const pricing = useTranslations("pricing");
  const { plan, interval } = props.planHint ?? {};
  let offer: AccountOffer;
  if (c.step === "account" && !SELF_HOST_BUILD && props.publicSignup && !c.needsInvite && !props.initialCode) {
    if (plan === undefined) {
      offer = "trial";
    } else {
      const priceKey = interval === undefined ? null : `${plan}Price${interval === "year" ? "Annual" : ""}`;
      const price = priceKey !== null && pricing.has(priceKey) ? pricing(priceKey) : undefined;
      offer = { name: PLAN_NAMES[plan], interval: interval ?? null, price };
    }
  }
  const pending = usePendingDoor(c.pending);
  const mailbox = useMailboxAsk(c);
  const set: Record<JoinField, (v: string) => void> = {
    code: c.setCode, email: c.setEmail, name: c.setDisplayName, password: c.setPassword, otp: c.setTotpCode,
  };
  const rail = c.needsInvite ? RAIL_BASE : c.step === "verify" ? RAIL_OPEN_LATE_VERIFY : RAIL_OPEN;
  const door: JoinDoor = {
    state: stateOf(c, offer),
    stations: rail as readonly JoinStation[],
    note: signupPosture(SELF_HOST_BUILD, props.publicSignup ?? false),
    invited: c.needsInvite,
    busy: c.busy,
    refusal: c.error,
    fields: { code: c.code, email: c.email, name: c.displayName, password: c.password, otp: c.totpCode },
    suggestion: c.suggestedAddress,
    pending,
    type: (field, value) => set[field](value),
    redeem: () => c.submitInvite(PRESS),
    register: () => c.submitAccount(PRESS),
    toInvite: () => c.setStep("invite"),
    takeSuggestion: () => { if (c.suggestedAddress !== null) c.setEmail(c.suggestedAddress); },
    changeAddress: () => { c.setError(null); c.setStep("account"); },
    signIn: { href: "/login" },
    resend: c.resendVerification,
    recheck: () => { void c.bootstrap(); },
    addPasskey: c.enrollPasskey,
    useAuthenticator: c.startTotp,
    copyKey: c.copySecret,
    openAuthenticator: () => { if (c.totp !== null) window.location.assign(c.totp.otpauthUrl); },
    activate: () => c.activateTotp(PRESS),
    leaveAuthenticator: () => c.setTotp(null),
    copyCodes: () => { if (c.recovery !== null) c.copyCodes(c.recovery); },
    downloadCodes: () => { if (c.recovery !== null) download(t("codesFileHeader"), c.recovery); },
    save: c.setCodesSaved,
    codesDone: () => {
      if (c.codesElsewhere && c.recovery === null) { c.setCodesElsewhere(false); void c.bootstrap(); }
      // Self-host has no plan to choose: the mailbox is the next real question.
      else c.setStep(SELF_HOST_BUILD ? "mailbox" : "plan");
    },
    retryCodes: c.fetchCodes,
    /* The account page's address is the one the server handed the ceremony for this step, as the card linked it. */
    accountPage: c.manageUrl === null ? null : { href: c.manageUrl },
    later: { href: "/" },
    open: { href: "/#/first-run" },
    retry: () => { c.setUnreachable(false); c.setResolving(true); void c.bootstrap(); },
    leave: { href: LATER },
    signInAgain: { href: c.fatalAction === "freshSignIn" ? JOIN_FRESH_SIGN_IN : "/login?next=join" },
    waitlist: { href: "/#pricing" },
    demo: { href: "/?demo=1" },
    slots: {
      mailbox: (page) => (
        <ConnectForm ask={mailbox.ask} door={mailbox.door} factor={(ask) => <StepUp {...ask} />} page={page} />
      ),
      authenticatorQr: () => (c.totp === null ? null : <QrCode value={c.totp.otpauthUrl} ariaLabel={t("totpQrAria")} />),
    },
  };
  return (
    <WebDoor>
      <JoinPage door={door} />
    </WebDoor>
  );
}
