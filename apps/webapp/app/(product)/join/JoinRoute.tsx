"use client";

/**
 * `/join`: the join's page over the join's own ceremony (`use-join-door.ts`, lifted from the old card, which has
 * left); `page.tsx` hands it what it handed the card. The ceremony's own ways on (to `/join`'s steps) are
 * its router's and state's; the ways out are links, as the card's were, to the addresses written here, and the plan
 * step's to the account page the ceremony was handed. The mailbox step is `MailboxStep.tsx`, drawn as it stands, and
 * the authenticator's picture the shell's QR code.
 */
import { useTranslations } from "next-intl";
import { signupPosture } from "@ohmail/app/doors";
import { JoinPage, type JoinDoor, type JoinField, type JoinState, type JoinStation } from "@ohmail/app/doors/join";
import { apiConfigured } from "../../api-client";
import { SELF_HOST_BUILD } from "../../hello";
import { PLAN_NAMES } from "../../plan-hint";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { QrCode } from "../../shell/QrCode";
import { WebDoor } from "../door-device";
import { usePendingDoor } from "../login/use-pending-door";
import { MailboxStep } from "./MailboxStep";
import "../../shell/today-tokens.generated.css";
import {
  RAIL_BASE, RAIL_OPEN, RAIL_OPEN_LATE_VERIFY, useJoinDoor, type JoinCeremony, type JoinProps,
} from "./use-join-door";

/** A press the card handled as a form's submit: the ceremony's handlers take the event they always took. */
const PRESS = { preventDefault() {} } as React.FormEvent;

function stateOf(c: JoinCeremony): JoinState {
  if (!apiConfigured()) return { at: "unavailable" };
  if (c.fatal) return c.fatalAction === "waitlist" ? { at: "full", said: c.fatal } : { at: "expired", said: c.fatal };
  if (c.unreachable) return { at: "unreachable" };
  if (c.resolving) return { at: "resolving" };
  switch (c.step) {
    case "invite": return { at: "invite" };
    case "account": return { at: "account" };
    case "sent": return { at: "sent", continuing: c.continuing };
    case "verify": return { at: "verify", resent: c.resent };
    case "factor":
      return { at: "factor", authenticator: c.totp === null ? null : { key: c.totp.secret, copied: c.secretCopied } };
    case "codes":
      return {
        at: "codes",
        codes: c.codesElsewhere ? "elsewhere" : c.recovery ?? (c.error && !c.busy ? "failed" : "making"),
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

export function JoinRoute(props: JoinProps) {
  const t = useTranslations("join");
  const c = useJoinDoor(props);
  const pending = usePendingDoor(c.pending);
  const set: Record<JoinField, (v: string) => void> = {
    code: c.setCode, email: c.setEmail, name: c.setDisplayName, password: c.setPassword, otp: c.setTotpCode,
  };
  const rail = c.needsInvite ? RAIL_BASE : c.step === "verify" ? RAIL_OPEN_LATE_VERIFY : RAIL_OPEN;
  const door: JoinDoor = {
    state: stateOf(c),
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
      if (c.codesElsewhere) { c.setCodesElsewhere(false); void c.bootstrap(); }
      // Self-host has no plan to choose: the mailbox is the next real question.
      else c.setStep(SELF_HOST_BUILD ? "mailbox" : "plan");
    },
    retryCodes: c.fetchCodes,
    /* The account page's address is the one the server handed the ceremony for this step, as the card linked it. */
    accountPage: c.manageUrl === null ? null : { href: c.manageUrl },
    later: { href: "/" },
    open: { href: "/#/first-run" },
    retry: () => { c.setUnreachable(false); c.setResolving(true); void c.bootstrap(); },
    leave: { href: "/" },
    signInAgain: { href: "/login?next=join" },
    waitlist: { href: "/#pricing" },
    demo: { href: "/?demo=1" },
    slots: {
      /* TODAY'S FORM INSIDE THE DOOR'S STAGE. The stage declares the new design's meaning of the names both designs
         define (`--float` is a shadow there and a ground in today's sheets, so the provider tiles lost theirs);
         `.today` with today's seam sheet declares today's again for this part, the way the frame stands today's
         views. It has no box of its own, and it is a `section`: the mail's own root is the one `div.today`. Leaves
         with the step (task `mailboxes`). */
      mailbox: () => (
        <section className="today" style={{ display: "contents" }}>
          <MailboxStep
            form={c.mailboxForm} busy={c.busy} error={c.error} setError={c.setError} run={c.run} sameAccount={c.sameAccount}
            owner={() => c.wizardOwner.current} onConnected={(dto) => { c.setConnected(dto); c.setStep("done"); }}
          />
        </section>
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
