"use client";

/**
 * The wizard's mailbox step: the provider picker, the credential fields, the connect and its step-up.
 * `JoinScreen` holds the form ({@link useMailboxForm}) for the wizard's whole life, so a trip to
 * another step keeps what was typed, and renders {@link MailboxStep} while this step is on screen.
 * The wizard's own `run` and `sameAccount` are handed in: every refusal and every account check
 * here is the wizard's, said the wizard's way.
 *
 * Where the server runs the Microsoft sign-in (`microsoft-door.ts`), the Microsoft tile connects by it,
 * as Settings → Mailboxes does; the return comes back to this step (`oauth-return.ts`, landing `join`).
 * The server's availability is read, never assumed: whether a personal Microsoft address can sign in
 * is the registration's to say, and this screen promises nothing about it.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button } from "@ohmail/ui";
import { codeOf, mailboxes, type MailboxDTO } from "../../api-client";
import { authHintPreset, authHintWantsLinks, hostsFor, providerById, type AuthHint, type ProviderPreset } from "../../shell/providers";
import { ProviderHelpLinks, ProviderPicker } from "../../shell/ProviderPicker";
import { probeCopyKey, refusalAuthHint, refusalTransport } from "../../shell/local-server-host";
import { noPortProbeSentence, plaintextOfferOf, probeReasonOf } from "../../shell/probe-refusal";
import { splitHostPort } from "../host-port";
import { useRefusalAtThePress } from "../../shell/refusal-at-the-press";
import { SELF_HOST_BUILD } from "../../hello";
import { StepUpPrompt } from "../mailbox/StepUpPrompt";
import { gatedRefusal } from "../mailbox/gated-refusal";
import { connectsBySignIn, startMicrosoftSignIn, useMicrosoftDoor } from "../mailbox/microsoft-door";
import {
  JOIN_FAILURE_REASONS, OAUTH_REASONS, takeJoinOAuthOutcome, type JoinOAuthOutcome,
} from "../mailbox/oauth-return";

/** The connect's body, as `mailboxes.create` takes it. */
type ConnectBody = Parameters<typeof mailboxes.create>[0];

/** A refusal's code as the support mail's subject may carry it: an identifier, or nothing. */
const REASON_CODE = /^[a-z0-9_]{1,48}$/;
const reasonCode = (raw: string | null): string | null => (raw !== null && REASON_CODE.test(raw) ? raw : null);

/** The form state, kept across steps so a refusal never loses typed input. */
export function useMailboxForm() {
  // `null` until the user chooses — choosing the provider is the mailbox step's primary
  // act, so nothing is pre-answered and the credential fields only appear once it is.
  const [provider, setProvider] = useState<ProviderPreset | null>(null);
  const [mbAddress, setMbAddress] = useState("");
  const [mbUser, setMbUser] = useState("");
  const [mbPass, setMbPass] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [smtpHost, setSmtpHost] = useState("");
  /**
   * THE PLAINTEXT CONSENT, per protocol. A line renders only after the server refused that
   * protocol as `tls_unavailable` on a host on a private network (`plaintextOfferOf`), and both
   * the line and the tick go when a host or the provider changes: a consent is about one server.
   */
  const [offer, setOffer] = useState<{ imap: boolean; smtp: boolean }>({ imap: false, smtp: false });
  const [plain, setPlain] = useState<{ imap: boolean; smtp: boolean }>({ imap: false, smtp: false });
  /** Why Google refused the last connect, when it said: the App Password links ride its sentence. */
  const [authHelp, setAuthHelp] = useState<AuthHint | null>(null);
  /** A connect the step-up window refused, held as sent until a factor is verified; `null` otherwise. */
  const [parked, setParked] = useState<ConnectBody | null>(null);
  /** The Microsoft tile's "use an app password instead", taken; a new provider choice resets it. */
  const [appPassword, setAppPassword] = useState(false);
  /** The last refusal's code, for the support mail's subject. */
  const [lastReason, setLastReason] = useState<string | null>(null);
  /** What a Microsoft sign-in started here came back with, read once per page load. */
  const [returned, setReturned] = useState<JoinOAuthOutcome | null>(null);
  useEffect(() => { setReturned(takeJoinOAuthOutcome()); }, []);
  return {
    provider, setProvider, mbAddress, setMbAddress, mbUser, setMbUser, mbPass, setMbPass,
    imapHost, setImapHost, smtpHost, setSmtpHost, offer, setOffer, plain, setPlain,
    authHelp, setAuthHelp, parked, setParked, appPassword, setAppPassword,
    lastReason, setLastReason, returned, setReturned,
  };
}

export type MailboxForm = ReturnType<typeof useMailboxForm>;

export function MailboxStep({ form, busy, error, setError, run, sameAccount, owner, onConnected }: {
  form: MailboxForm;
  busy: boolean;
  error: string | null;
  setError: (sentence: string | null) => void;
  /** The wizard's press runner: `sentenceOf` puts this step's words on a refusal it knows. */
  run: (fn: () => Promise<void>, sentenceOf?: (err: unknown) => string | null) => Promise<void>;
  /** Is the browser still signed in as the account this wizard is for? Says so when not. */
  sameAccount: () => Promise<boolean>;
  /** The account this wizard is for, recorded with a Microsoft sign-in for its return. */
  owner: () => string | null;
  onConnected: (dto: MailboxDTO) => void;
}) {
  const t = useTranslations("join");
  const tm = useTranslations("mailboxes");
  const td = useTranslations("devices");
  const {
    provider, setProvider, mbAddress, setMbAddress, mbUser, setMbUser, mbPass, setMbPass,
    imapHost, setImapHost, smtpHost, setSmtpHost, offer, setOffer, plain, setPlain,
    authHelp, setAuthHelp, parked, setParked, appPassword, setAppPassword,
    lastReason, setLastReason, returned, setReturned,
  } = form;
  const retireConsent = (): void => {
    setOffer({ imap: false, smtp: false });
    setPlain({ imap: false, smtp: false });
  };

  /** The Microsoft doors this server has. The wizard runs only the redirect one; see `afterSetup`. */
  const door = useMicrosoftDoor();
  const signIn = connectsBySignIn(provider?.id, door.available, appPassword);
  /** A server with only the device-code door: that ceremony runs in Settings → Mailboxes, after setup. */
  const afterSetup = provider?.id === "microsoft" && !door.available && door.device;
  /** A settled outcome that is not a fault (a declined consent): said as a status, never as an alert. */
  const [notice, setNotice] = useState<string | null>(null);
  /** The browser is on its way to Microsoft: the press is spent. */
  const [leaving, setLeaving] = useState(false);
  /** Which sign-in press is the newest; a provider change retires one still waiting on the server. */
  const signInSeq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const pickProvider = (id: string) => {
    const p = providerById(id);
    setProvider(p);
    // The generic entry has no hosts to impose, and writing its emptiness over a typed one is how
    // this form used to lose it — but a NAMED preset's host must never survive into a manual
    // attempt either, so the previous choice goes in too. `providers.ts` carries both reasons.
    setImapHost((cur) => hostsFor(p, { imapHost: cur, smtpHost: "" }, provider).imapHost);
    setSmtpHost((cur) => hostsFor(p, { imapHost: "", smtpHost: cur }, provider).smtpHost);
    retireConsent();
    // A fresh choice offers the Microsoft sign-in first again, and retires a start in flight.
    setAppPassword(false);
    signInSeq.current += 1;
    setNotice(null);
  };

  /**
   * CONNECT WITH MICROSOFT. Whose browser this is first, like every press on this wizard; the start then
   * records this wizard's account and the `join` landing for the return, and leaves for Microsoft. No
   * step-up: the consent screen is Microsoft's own interactive sign-in, and the address comes from its token.
   */
  const startSignIn = (): void => {
    setNotice(null);
    const seq = ++signInSeq.current;
    void run(async () => {
      if (!await sameAccount()) return;
      const left = await startMicrosoftSignIn({
        landing: "join", owner, stillWanted: () => mounted.current && seq === signInSeq.current,
      });
      if (left) setLeaving(true);
    }, (err) => { setLastReason(reasonCode(codeOf(err))); return null; });
  };

  /* BACK FROM MICROSOFT with nothing connected: the Microsoft tile again, and what happened, in this
     step's words. A connected return never shows this step; the wizard reads the mailbox back. */
  useEffect(() => {
    if (returned === null) return;
    setReturned(null);
    if (returned.kind === "connected") return;
    pickProvider("microsoft");
    setLastReason(reasonCode(returned.reason));
    if (returned.kind === "refused" && returned.reason === "consent_declined") {
      setNotice(tm("oauth_consent_declined"));
      return;
    }
    setError(returned.kind === "refused"
      ? tm(OAUTH_REASONS.has(returned.reason) ? `oauth_${returned.reason}` : "oauth_consent_failed")
      : returned.reason !== null && JOIN_FAILURE_REASONS.has(returned.reason)
        ? t(`mailboxOauth_${returned.reason}`)
        : returned.message ?? tm("oauth_consent_failed"));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per outcome; the setters are the wizard's
  }, [returned]);

  /** What `POST /mailboxes` is sent: built from the form at the press, and re-sent as it was after a step-up. */
  const connectBodyOf = (chosen: ProviderPreset): ConnectBody => {
    const address = mbAddress.trim();
    return {
      provider: chosen.id,
      address,
      imap: {
        // A manual provider sends no TLS mode, and a port only when one follows the name — the
        // server's probe walks the standard ladder (993 implicit TLS, then 143 STARTTLS) and
        // stores what it proved. A refusal is said in this screen's words where it has them
        // (see `mailboxSentence`), else in the server's.
        ...(chosen.manual ? splitHostPort(imapHost) : { host: imapHost.trim(), port: chosen.imap.port, secure: chosen.imap.secure }),
        user: (mbUser.trim() || address), pass: mbPass,
        // Each consent only after the server refused THAT protocol on a private host.
        ...(offer.imap && plain.imap ? { allowInsecure: true } : {}),
      },
      smtp: {
        ...(chosen.manual ? splitHostPort(smtpHost) : { host: smtpHost.trim(), port: chosen.smtp.port, secure: chosen.smtp.secure }),
        user: (mbUser.trim() || address), pass: mbPass,
        ...(offer.smtp && plain.smtp ? { allowInsecure: true } : {}),
      },
    };
  };

  /** A refused connect in this screen's words, or `null` for the server's own sentence. */
  const mailboxSentence = (err: unknown, chosen: ProviderPreset): string | null => {
    // A refusal on a private host with no TLS opens that protocol's consent line.
    const opens = plaintextOfferOf(err);
    if (opens) setOffer((o) => ({ ...o, [opens]: true }));
    setLastReason(reasonCode(probeReasonOf(err) ?? codeOf(err)));
    // This form has no port field, so a refusal that would tell the person to check one says
    // what the form holds instead: the server name on the generic entry, nothing behind a preset.
    const said = noPortProbeSentence(err, chosen.manual === true);
    if (said) return tm(said.key, { field: said.field });
    // The reasons whose sentence names no port: the Settings pane's own lines, in the reader's language.
    const reason = probeReasonOf(err);
    // Microsoft refused the password where this server runs the sign-in: the way that works, not app-password advice.
    if (reason === "auth" && chosen.id === "microsoft" && door.available) {
      setAuthHelp(null);
      return t("mailboxMicrosoftRefused");
    }
    // Google's refused sign-in says why (`probe_auth_gmail_*`); every other auth, the pane's own line.
    const hint = reason === "auth" ? refusalAuthHint(err) : null;
    setAuthHelp(hint);
    if (reason === "auth") return tm(probeCopyKey(reason, false, refusalTransport(err), hint) as "probe_auth");
    if (reason === "storage" || reason === "sync" || reason === "unknown") return tm(`probe_${reason}`);
    return null;
  };

  /**
   * One connect. Every refusal stays on this step with what was typed. The five-minute step-up window
   * closing is not a refusal of the mailbox: making an app password takes longer than that, so the
   * factor is asked for HERE (`StepUpPrompt`, Settings' own) and this exact connect runs again once.
   * A second window refusal right after a verified factor is the sign-in screen, whose link resumes
   * `/join` (`gatedRefusal`'s rule: a second prompt would loop).
   */
  const connect = (chosen: ProviderPreset, body: ConnectBody, afterFactor: boolean): void => {
    setNotice(null);
    void run(async () => {
      // Mail credentials typed for one account must not be attached to another.
      if (!await sameAccount()) return;
      let dto: MailboxDTO;
      try {
        dto = await mailboxes.create(body);
      } catch (err) {
        if (gatedRefusal(err, afterFactor) === "factor") { setParked(body); return; }
        throw err;
      }
      // The password leaves this component's memory the moment the server has it. It is
      // already envelope-encrypted at rest (RC1) and is never echoed back in the DTO.
      setMbPass("");
      setParked(null);
      onConnected(dto);
    }, (err) => mailboxSentence(err, chosen));
  };

  const submitMailbox = (e: React.FormEvent) => {
    e.preventDefault();
    // The credential fields (and with them this form's submit) only render once a
    // provider is chosen, so this guard is structural rather than reachable.
    const chosen = provider;
    if (!chosen) return;
    if (signIn) { startSignIn(); return; }
    connect(chosen, connectBodyOf(chosen), false);
  };

  /* The step-up prompt opens under a long form: it is brought into view and its first control is
     focused once the prompt has read which factor the account has, as the refusal at the press is. */
  const stepUpAt = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (parked === null) return;
    const el = stepUpAt.current;
    el?.scrollIntoView?.({ block: "nearest" });
    const timer = setTimeout(() => el?.querySelector<HTMLElement>("input, button")?.focus(), 50);
    return () => clearTimeout(timer);
  }, [parked]);

  /* The mailbox step's refusal sits beside Connect, and is brought into view and focused. */
  const mailboxRefusalAt = useRefusalAtThePress<HTMLParagraphElement>(error);
  /* The App Password links under Google's sentence, while that sentence is the one on screen. */
  const authLinks = authHelp !== null && authHintWantsLinks(authHelp)
    && error === tm(probeCopyKey("auth", false, "imap", authHelp) as "probe_auth")
    ? <ProviderHelpLinks preset={authHintPreset()} /> : null;
  /* The sign-in beside Microsoft's refused password, while that sentence is the one on screen. */
  const signInInstead = !signIn && door.available && provider?.id === "microsoft"
    && error === t("mailboxMicrosoftRefused") ? (
      <div className="join-actions join-actions-tight">
        <Button type="button" onClick={startSignIn} disabled={busy || leaving}>{tm("oauthContinue")}</Button>
      </div>
    ) : null;
  const mailboxRefusal = error ? (
    <>
      <p ref={mailboxRefusalAt} className="join-error at-press" role="alert" tabIndex={-1}>{error}</p>
      {authLinks}
      {signInInstead}
    </>
  ) : notice ? <p className="join-hint" role="status">{notice}</p> : null;

  /* A mail to support from the person's own mailbox: the provider picked and the last refusal's code. */
  const helpSubject = t("mailboxHelpSubject", { preset: provider?.id ?? "none", reason: reasonCode(lastReason) ?? "none" });

  return (
    <>
      <form onSubmit={submitMailbox}>
        <p className="sub">{t("step_mailbox_lead")}</p>
        {/* Said BEFORE the trip to the provider's settings. `POST /mailboxes` is step-up gated on
            a second factor used within `stepUpWindowMs` (5 minutes), and fetching an app password
            from Gmail or Microsoft reliably takes longer than that; `connect` asks for the factor
            in place when it does, so this says what will happen rather than racing a clock. */}
        <p className="join-note">{t("appPasswordReady")}</p>

        {/* The picker owns the choice, the provider's note and the help link; the
            credential fields below only exist once a provider is chosen, so the step
            opens on its one real question. On the sign-in path the app-password note would be
            a false instruction, so the sign-in sentence stands in and the help link goes. */}
        <ProviderPicker
          value={provider?.id ?? null}
          onChange={pickProvider}
          note={signIn ? tm("microsoftOauthNote") : afterSetup ? t("mailboxMicrosoftAfterSetup") : undefined}
          showHelp={!signIn}
        />

        {provider && (
          <>
            {signIn ? (
              /* No fields: the sign-in supplies the address and there is no password. Secondary,
                 for a tenant that blocks the sign-in. */
              <Button variant="ghost" type="button" onClick={() => { setError(null); setAppPassword(true); }}>
                {tm("microsoftUseAppPassword")}
              </Button>
            ) : (
              <>
                <label className="join-label" htmlFor="join-mb-address">{t("mailboxAddress")}</label>
                <input
                  id="join-mb-address" className="join-input" type="email" autoComplete="off"
                  value={mbAddress} onChange={(e) => setMbAddress(e.target.value)} required
                />

                {provider.manual && (
                  <>
                    <label className="join-label" htmlFor="join-imap">{t("imapHost")}</label>
                    <input
                      id="join-imap" className="join-input" autoComplete="off"
                      value={imapHost} onChange={(e) => { setImapHost(e.target.value); retireConsent(); }} required
                    />
                    <label className="join-label" htmlFor="join-smtp">{t("smtpHost")}</label>
                    <input
                      id="join-smtp" className="join-input" autoComplete="off"
                      value={smtpHost} onChange={(e) => { setSmtpHost(e.target.value); retireConsent(); }} required
                    />
                  </>
                )}

                <label className="join-label" htmlFor="join-mb-user">{t("mailboxUser")}</label>
                <input
                  id="join-mb-user" className="join-input" autoComplete="off"
                  placeholder={mbAddress || t("mailboxUserPlaceholder")}
                  value={mbUser} onChange={(e) => setMbUser(e.target.value)}
                />

                <label className="join-label" htmlFor="join-mb-pass">{t("appPasswordLabel")}</label>
                <input
                  id="join-mb-pass" className="join-input" type="password" autoComplete="off"
                  value={mbPass} onChange={(e) => setMbPass(e.target.value)} required
                />
                <p className="join-hint">{t("appPasswordHint")}</p>

                {offer.imap || offer.smtp ? (
                  <>
                    {(["imap", "smtp"] as const).filter((k) => offer[k]).map((k) => (
                      <label key={k} className="join-label" htmlFor={`join-insecure-${k}`}>
                        <input
                          id={`join-insecure-${k}`} type="checkbox" checked={plain[k]}
                          onChange={(e) => setPlain((v) => ({ ...v, [k]: e.target.checked }))}
                        />{" "}
                        {tm(k === "imap" ? "insecureConsentLabel" : "insecureConsentLabelSmtp")}
                      </label>
                    ))}
                    <p className="join-note">{tm("insecureConsentWarning")}</p>
                  </>
                ) : null}
              </>
            )}

            {mailboxRefusal}
            <div className="join-actions">
              <Button variant="primary" type="submit" disabled={busy || parked !== null || (signIn && leaving)}>
                {busy ? t("working") : signIn ? tm("oauthContinue") : t("connectMailbox")}
              </Button>
            </div>
          </>
        )}
        {provider ? null : mailboxRefusal}
      </form>

      {/* The step-up, asked beside the form it unblocks — outside it, because the prompt is a form of
          its own. A verified factor re-sends the parked connect once; Cancel keeps everything typed. */}
      {parked !== null ? (
        <div ref={stepUpAt}>
          <StepUpPrompt
            onVerified={() => {
              const body = parked;
              const chosen = provider;
              setParked(null);
              if (chosen) connect(chosen, body, true);
            }}
            onCancel={() => setParked(null)}
            onDiscarded={() => { setParked(null); setError(td("stepUpCancelledNothingRan")); }}
          />
        </div>
      ) : null}

      {/* THE WAYS OUT. Later opens the app with the setup marked as offered in this tab. The mail to
          support is ohmail Cloud's: a self-hosted server's people are its operator's to help. */}
      <div className="join-actions join-actions-tight">
        <Link className="join-alt" href="/?setup=later">{t("later")}</Link>
        {SELF_HOST_BUILD ? null : (
          <a className="join-alt" href={`mailto:support@ohmail.app?subject=${encodeURIComponent(helpSubject)}`}>
            {t("mailboxWriteUs")}
          </a>
        )}
      </div>
    </>
  );
}
