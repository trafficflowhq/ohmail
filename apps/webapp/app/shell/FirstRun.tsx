"use client";

/**
 * THE FIRST-RUN STAGE — the screens a person meets between installing ohmail and taking their
 * first Screener decision.
 *
 * ── WHAT MAKES THIS ONE COMPONENT AND NOT ELEVEN ROUTES ───────────────────────────────────
 *
 * It is a DIALOG over the app, at `#/first-run`, and the app is behind it the whole time. That
 * is not decoration: "Open ohmail meanwhile" on the pull screen has to leave the flow without
 * ending it, and a person who wanders into Settings and comes back has to find the same run
 * where they left it. A stack of routes would have to reconstruct that; an overlay over a live
 * shell already is it.
 *
 * ── THE STEP IS DERIVED. THERE IS NO COUNTER, AND {@link at} IS NOT ONE ───────────────────
 *
 * `deriveOnboardingStep` (`onboarding.ts`) answers "where does this run RESUME" from the facts
 * the product actually stored, and it is the authority here. {@link at} is a CURSOR INSIDE ONE
 * RUN — what "Back" and "Continue" move — and it exists because three screens are not resume
 * targets and cannot be: `welcome` is shown once at the top of a run with nothing behind it,
 * `window` shares one write with `consent` (so there is no truth-condition between them to
 * resume on), and `pair` is offered after the flow is otherwise finished.
 *
 * **Every write clears the cursor**, which is what "re-derive after every write" means here
 * concretely: the derivation, not this component, decides what comes next the moment anything
 * is stored. A cursor that survived a write would be a step counter with extra steps.
 *
 * ── THE FOOT IS THE SAME ON EVERY SCREEN, AND THAT IS THE PROMISE ─────────────────────────
 *
 * Cancel and Start over are on every screen that has a foot; Back is there wherever a step has
 * one before it. Both destructive verbs confirm IN PLACE — a second dialog stacked over a
 * dialog is how a person loses track of which one Escape closes, and there is exactly one
 * Escape binding here (`overlay` scope, so it beats every view binding underneath).
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  Button, DecisionBar, Kbd,
  SettingsActions, SettingsBanner, SettingsChoice, SettingsField, SettingsRow, SettingsVerdict,
} from "@ohmail/ui";
import type { DecisionDestination, DecisionScope } from "@ohmail/ui";
import { useKeyBindings } from "./keymap";
import { PROVIDERS, hostsFor, providerById, providerLabel, type ProviderPreset } from "./providers";
import {
  deriveOnboardingStep, onboardingPath,
  type OnboardingFacts, type OnboardingStep,
} from "./onboarding";
import type { FirstRunHost, FirstRunMailboxInput, FirstRunProbeOk } from "./first-run-host";
import { pullEtaMs, pullRate, pullRemaining, pullSampleStep, type PullSample } from "./pull-rate";
import "./first-run.css";

/**
 * THE RAIL — seven groups over eleven screens, because the rail names PHASES and several
 * screens are two halves of one phase (welcome/mailbox/elsewhere are all "get the mailbox in";
 * ai/provider are one question and its answer; summary/pair are both "done").
 *
 * Ordered, and the order is `onboardingPath`'s: a rail whose order disagreed with the path's
 * would light a dot the Back button walks away from.
 */
const RAIL: Array<{ id: string; steps: OnboardingStep[] }> = [
  { id: "mailbox", steps: ["welcome", "mailbox", "elsewhere"] },
  { id: "organize", steps: ["consent"] },
  { id: "history", steps: ["window"] },
  { id: "ai", steps: ["ai", "provider"] },
  { id: "pull", steps: ["pull"] },
  { id: "decide", steps: ["decide"] },
  { id: "done", steps: ["summary", "pair"] },
];

/** The five destinations the guided decision offers, with the keycap each one wears. */
const DECIDE_LEGEND: Array<{ key: string; copy: "decideOhbox" | "decideReads" | "decideReceipts" | "decideScreened" | "decideSpam" }> = [
  { key: "o", copy: "decideOhbox" },
  { key: "r", copy: "decideReads" },
  { key: "c", copy: "decideReceipts" },
  { key: "n", copy: "decideScreened" },
  { key: "x", copy: "decideSpam" },
];

/** The history-depth options. `365` is the default and wears the word for it. */
const WINDOWS = ["90", "180", "365", "all"] as const;
type WindowChoice = (typeof WINDOWS)[number];

/** The one sender the guided decision is about, and what a decision on it does. */
export interface FirstRunDecideSubject {
  name: string;
  address: string;
  /** How many of their messages are waiting. */
  held: number;
  /** The "first contact N days ago" line, already formatted by the host. */
  since: ReactNode;
  onDecide: (dest: DecisionDestination, opts: { markRead: boolean; scope: DecisionScope }) => void;
}

export interface FirstRunProps {
  host: FirstRunHost;
  facts: OnboardingFacts;
  /**
   * RE-READ THE FACTS. Called after every write, and the reason the stage needs no local copy
   * of anything it just stored: the next render's step comes from the same place the first
   * one's did.
   */
  onRefresh: () => void;
  /** Leave the stage — the caller returns the route to the app. */
  onLeave: () => void;
  /**
   * THE PULL SCREEN'S NUMBERS, all from the client's own mirror except the last.
   *
   * `screened`/`history` are what the two counters say; `mirrorCount` is the numerator the rate
   * sampler folds. The DENOMINATOR is on the facts (`serverMessageCount`), because only the
   * server can say how much is out there.
   */
  pull: { screened: number; history: number; mirrorCount: number };
  /** How much mail the server says is in the mailbox — see `MailboxDTO.serverMessageCount`. */
  serverMessageCount?: number;
  /** The guided decision's sender, or `null` when the queue is empty (the step is skipped). */
  decide: FirstRunDecideSubject | null;
  /** `true` while the run resumed after the connection dropped — the pull's own notice. */
  resumed?: boolean;
  /**
   * THE MAILBOX'S ID — a separate prop rather than a field on {@link OnboardingFacts}.
   *
   * The derivation is a pure function over TRUTH-CONDITIONS and an id is not one of them: it
   * decides nothing, and putting it there would invite an arm that branches on which mailbox
   * this is. The STAGE needs it, because `organize` and `forgetMailbox` address a row.
   */
  mailboxId: string | null;
  /**
   * HOW THE HOLDER'S "since" INSTANT IS SAID IN WORDS — the host formats it, as everywhere.
   *
   * A `string` and not a `ReactNode`, unlike {@link FirstRunDecideSubject.since}: this one is
   * INTERPOLATED INTO A SENTENCE (`mailboxes.readerSince*`), and a message catalogue takes
   * values, not elements. The decision card's line is a whole line of its own and may be a node.
   */
  organizedSince?: string;
  /**
   * THE CONNECTED MAILBOX'S ADDRESS, for the one screen that has to say WHICH mailbox this run is
   * about. Absent before one exists, which is exactly when that screen is a form instead.
   */
  mailboxAddress?: string;
  /**
   * IS THIS A RE-RUN from Settings — `#/first-run/again`. See {@link firstRunStep}.
   */
  rerun?: boolean;
  /**
   * WHAT THE ACCOUNT ALREADY STORED, so a re-run is pre-filled from truth rather than from the
   * product default. Absent on a first run, where there is nothing stored to show.
   *
   * A re-run that showed "One year" over an account screening all time would be a control that
   * misreports the state it is about to change — which is the same defect class as a switch
   * drawn ON over a write that failed.
   */
  screening?: { dormancyDays: number; scope: "window" | "all_time" };
}

/**
 * WHICH SCREEN IS ON, or `null` when the flow must not be open at all.
 *
 * Exported for the tests, which drive this table directly rather than through a render: the
 * cursor/derivation interaction is the part with rows, and rows are what a table test is for.
 */
export function firstRunStep(
  facts: OnboardingFacts, at: OnboardingStep | null, rerun = false, claimAnswered = false,
): OnboardingStep | null {
  const derived = deriveOnboardingStep(facts);
  /**
   * IS THERE A CLAIM QUESTION OUTSTANDING — read from the FACTS, not from `derived`.
   *
   * `derived` cannot answer this on the path that needs it most. Row 1 returns `null` for any
   * account carrying a completion stamp, so on `#/first-run/again` the guard below would be
   * structurally inert — and the walk that reaches it is short: connect a mailbox somebody else
   * holds, CANCEL on the consent screen (cancel stamps completion, which is the whole point of
   * the stamp), then press "Run setup again". The re-run arm opens on the consent statement, the
   * claim question is never shown, and Agree writes a consent the lease is about to decline.
   * That is the measured defect arriving through the other door.
   *
   * `flowIsOpen` keeps row 1's authority where row 1 has it: on a BOOT the completion stamp
   * still closes the stage, so the reader ending — which leaves the mailbox a consent-less
   * reader with a holder for ever — does not re-open this screen at every launch.
   */
  const mb = facts.mailbox;
  const claimPending = mb !== null
    && Boolean(mb.organizedBy && (mb.organizedBy.kind || mb.organizedBy.name))
    && !mb.organizeConsentedAt;
  const flowIsOpen = rerun || derived !== null;
  /* ── THE CLAIM QUESTION IS NOT SKIPPABLE, AND THE CURSOR USED TO SKIP IT SILENTLY ────────
   *
   * MEASURED on the released 0.13.6, on a fresh standalone connect to a mailbox ohmail Cloud
   * holds the lease on: the flow opened on the consent statement (correct at that instant — the
   * pre-consent PEEK had not landed yet, so no holder was named), the person pressed Continue,
   * and from that press onward `at` was non-null. The peek then landed, the derivation started
   * answering "elsewhere", and the arm below returned the cursor instead — so the one screen
   * built for this situation never rendered. The person agreed, the install stood down to
   * reader on its next pass, and the summary reported the organizing it had just been refused.
   *
   * The cursor is a navigation aid, not evidence. It may carry a run through screens the
   * derivation cannot name; it may not carry a run PAST a question nobody answered. So while
   * the facts say somebody else holds this mailbox and the claim question has not been
   * answered in this run, the question wins over the cursor.
   *
   * `claimAnswered` is what makes that a guard rather than a loop — and the loop is the failure
   * mode this codebase keeps producing, so it is spelled out: "Organize here instead" moves the
   * cursor to `consent`, the consent stamp is not written until the window screen's press two
   * screens later, and the derivation therefore still answers "elsewhere" for that whole
   * stretch. Without the flag the person would be thrown back to the choice they just made, on
   * every render, for ever.
   *
   * The three cursors exempted are the ones at or BEFORE this screen in the path
   * (`onboardingPath`: welcome → mailbox → elsewhere). Back has to work.
   */
  if (flowIsOpen && claimPending && !claimAnswered
      && at !== "welcome" && at !== "mailbox" && at !== "elsewhere") {
    return "elsewhere";
  }
  /* ── A RE-RUN IS AN INTENT, AND IT OUTRANKS THE COMPLETION STAMP ─────────────────────────
   *
   * `rerun` comes from the ROUTE (`#/first-run/again`), which is the only place it can come
   * from: an account that has been through setup derives to "nothing to do", correctly, and
   * that is exactly what somebody who just pressed "Run setup again" does not want. The
   * alternative would be to CLEAR the stamp, and there is deliberately no instruction to do
   * that — nothing un-finishes onboarding, because a control that silently reopens setup on
   * every future boot is worse than a route segment.
   *
   * It opens on the consent statement, not on the welcome and not on the derived step. A re-run
   * is for the three things a person comes back to change — what ohmail files, how far back, and
   * AI — and it is pre-filled from what the account already stored. The one exception is an
   * account with no mailbox, where there is nothing to re-run and the flow is a first run.
   */
  if (rerun) {
    if (at !== null) return at;
    return facts.mailbox === null ? "mailbox" : "consent";
  }
  // THE DERIVATION CLOSES THE FLOW AND THE CURSOR MAY NOT REOPEN IT. `null` means the
  // completion stamp is set — cancelled or finished — and a cursor left over from the press
  // that stamped it would keep the stage on screen after the person asked to leave.
  if (derived === null) return null;
  if (at !== null) return at;
  // THE ONE PLACE THE OPENING SCREEN IS NOT THE DERIVED ONE. A run with no mailbox behind it
  // has nothing to resume, so it starts at the welcome; a run that resumes onto `mailbox`
  // because the mailbox was REMOVED has a history and does not need the greeting again.
  return facts.mailbox === null && derived === "mailbox" ? "welcome" : derived;
}

export function FirstRun({
  host, facts: wireFacts, onRefresh, onLeave, pull, serverMessageCount, decide, resumed,
  mailboxId, organizedSince, rerun, screening, mailboxAddress,
}: FirstRunProps) {
  const t = useTranslations("onboarding");
  const tm = useTranslations("mailboxes");
  const tp = useTranslations("providerPicker");
  /** The connect funnel's namespace, for the one sentence this flow shares with it. */
  const tj = useTranslations("join");
  const locale = useLocale();
  const ids = useId();

  /**
   * WHAT THE CONSENT CALL JUST PROVED — applied to the facts BEFORE the derivation reads them.
   *
   * ── WHY THE RE-READ IS NOT ENOUGH ON ITS OWN ──────────────────────────────────────────────
   *
   * "Re-derive after every write" needs the write to be VISIBLE, and `onRefresh` is a request,
   * not a fact: the facts this stage renders come from `GET /mailboxes` on the hosted door and
   * from the local mirror on the standalone one, and neither is guaranteed to have caught up by
   * the render that follows the press. Row 4 of the derivation is `if (!consented) return
   * "consent"` — so for as long as the read lags, a person who has just agreed is put back on
   * the screen asking them to agree, with the button they pressed still on it. That is the same
   * loop the re-run had, arriving through a different door, and on a slow read it does not end.
   *
   * So the answer the server gave is applied to the local copy. It only ever ASSERTS SOMETHING
   * TRUE — the organize call returned `stored`, which means consent is recorded — and it stops
   * mattering the moment the read catches up, because the override is only consulted while the
   * wire still says null.
   *
   * KEYED BY MAILBOX, and that is not decoration: "Start over → forget this mailbox" and a
   * reconnect inside one mount would otherwise carry this assertion onto a NEW row that nobody
   * has consented to, and skip the consent screen on a mailbox that needs it.
   */
  const [consented, setConsented] = useState<{ mailboxId: string; at: string } | null>(null);
  const facts = useMemo(() => {
    const mb = wireFacts.mailbox;
    if (!consented || !mb || mb.organizeConsentedAt || consented.mailboxId !== mailboxId) {
      return wireFacts;
    }
    return { ...wireFacts, mailbox: { ...mb, organizeConsentedAt: consented.at } };
  }, [consented, mailboxId, wireFacts]);

  /** The cursor inside this run — never a step counter. See the header. */
  const [at, setAt] = useState<OnboardingStep | null>(null);
  /** Which destructive verb is asking, if either is. One at a time, in the foot. */
  const [confirm, setConfirm] = useState<null | "cancel" | "restart">(null);
  const [busy, setBusy] = useState(false);
  /** A write that failed, in the server's own words. Cleared by the next attempt. */
  const [problem, setProblem] = useState<string | null>(null);
  /**
   * WHICH MAILBOX'S CLAIM QUESTION HAS BEEN ANSWERED IN THIS RUN — the flag `firstRunStep`'s
   * guard reads, and the thing that keeps that guard from becoming a loop.
   *
   * KEYED BY MAILBOX, on `consented`'s rule and for the same measured reason: "Start over →
   * forget this mailbox" and a reconnect inside one mount would otherwise carry an answer given
   * about one mailbox onto a NEW row whose holder nobody has been told about — which is exactly
   * the state the guard exists for.
   *
   * Deliberately NOT persisted. A run abandoned on the consent screen and resumed tomorrow gets
   * the question again: the safe direction, and the same trade the AI posture's union
   * documents — being asked twice costs a screen, not being asked costs a mailbox.
   */
  const [claimAnsweredFor, setClaimAnsweredFor] = useState<string | null>(null);

  const step = firstRunStep(
    facts, at, rerun === true, mailboxId !== null && claimAnsweredFor === mailboxId,
  );
  const path = useMemo(() => onboardingPath(facts), [facts]);

  /**
   * EVERY WRITE GOES THROUGH HERE, and every write clears the cursor.
   *
   * The `finally` is what makes the clear unconditional, and that is deliberate even for a
   * FAILED write: a refusal may still have changed something (a claim the worker took while
   * the request was in flight), and the derivation is the only thing entitled to say where the
   * flow stands afterwards. Re-deriving after a failure costs a render; NOT re-deriving after
   * one leaves the person on a screen whose question the facts have already answered.
   *
   * ── EXCEPT ON A RE-RUN, WHERE A CLEARED CURSOR IS AN INFINITE LOOP ────────────────────────
   *
   * `firstRunStep` answers `consent` for a re-run whose cursor is null. That is right for an
   * ENTRY — a re-run opens on the consent statement — and it is fatal for a WRITE, because a
   * finished account derives to "nothing to do" and the cursor is therefore the re-run's only
   * navigation. So on `#/first-run/again` every write walked back to the screen before it:
   * pressing "Agree and start organizing" stored the window, cleared the cursor, and returned to
   * the consent statement, for ever. Measured on a released build by somebody who had opened
   * setup again on a mailbox that was already organized.
   *
   * A re-run's SUCCESS therefore names its next screen (the caller's `keepCursor`, which on that
   * path is not optional), and a re-run's FAILURE stays where it is, on the screen carrying the
   * sentence that explains it. A first run is untouched: there the derivation is the authority
   * and a null cursor is how it is asked.
   */
  const run = useCallback(async (write: () => Promise<void>, keepCursor?: OnboardingStep) => {
    /* THE FORM'S GENERATION AT THE MOMENT THIS STARTED. `retireTest` advances it on every edit, so
       this is exactly "has the form moved since I was sent". A WRITE needs it for the same reason
       the test does, and it was missed because a write looks like it cannot be overtaken: press
       Connect for A, edit the address to B while it is in flight, A is refused — and the refusal
       was written unconditionally, so A's sentence appeared over B with no B press. The evidence
       had been retired and then re-arrived. */
    const mine = testSeq.current;
    /* Where a FAILED write leaves a re-run: exactly here. Captured before the await, so a screen
       the person left mid-flight cannot be restored over the one they are on. */
    const here = step;
    setBusy(true);
    setProblem(null);
    try {
      await write();
      setAt(keepCursor ?? null);
    } catch (err) {
      // The CURSOR still moves on a first run — the derivation is entitled to answer over the
      // newest facts whatever happened here — but the SENTENCE belongs to a form that is gone.
      if (testSeq.current === mine) {
        setProblem(host.probeMessage(err) ?? String((err as { message?: string })?.message ?? err));
      }
      setAt(rerun === true ? here : null);
    } finally {
      setBusy(false);
      onRefresh();
    }
  }, [host, onRefresh, rerun, step]);

  /** Move inside the run — the Back and Continue verbs, and nothing else. */
  const goTo = useCallback((next: OnboardingStep) => {
    setConfirm(null);
    setProblem(null);
    setAt(next);
  }, []);
  const forward = useCallback(() => {
    if (step === null) return;
    const i = path.indexOf(step);
    const next = i >= 0 ? path[i + 1] : undefined;
    if (next) goTo(next);
  }, [goTo, path, step]);
  const backStep = step === null ? undefined : path[path.indexOf(step) - 1];

  /**
   * LEAVING STAMPS COMPLETION — cancel and finish alike, because the truth-condition that
   * closes the flow is one condition and both of these are it. A cancel that stamped nothing
   * would re-open this stage at the next boot on whatever screen it was abandoned at.
   */
  const leave = useCallback(() => {
    void run(async () => { await host.complete(); }).then(onLeave);
  }, [host, onLeave, run]);

  /**
   * THE ONE ESCAPE BINDING, at `overlay` scope.
   *
   * `overlay` beats every `view` binding underneath (`keymap.tsx` argues why that rank exists),
   * so Escape here is not competing with the Ohbox's selection-clearing Escape. It ASKS rather
   * than acts: this flow's cancel writes a stamp, and a keystroke that silently ends setup is
   * the kind of thing a person does not know they did.
   *
   * `inInput` because the mailbox step is a form — a field you cannot leave is a trap, which is
   * the rule the registry states for exactly this key.
   */
  useKeyBindings(
    useMemo(() => [{
      chord: "Escape",
      group: "app" as const,
      label: t("cancel"),
      inInput: true,
      run: () => setConfirm((c) => (c === "cancel" ? null : "cancel")),
    }], [t]),
    "overlay",
  );

  /* ── THE MAILBOX FORM ──────────────────────────────────────────────────────────────── */

  const [providerId, setProviderId] = useState<string>(PROVIDERS[0]!.id);
  const [address, setAddress] = useState("");
  const [pass, setPass] = useState("");
  const [imapHost, setImapHost] = useState(PROVIDERS[0]!.imap.host);
  const [imapPort, setImapPort] = useState(String(PROVIDERS[0]!.imap.port));
  const [smtpHost, setSmtpHost] = useState(PROVIDERS[0]!.smtp.host);
  const [smtpPort, setSmtpPort] = useState(String(PROVIDERS[0]!.smtp.port));
  const [verdict, setVerdict] = useState<null | { ok: FirstRunProbeOk } | { reason: string | null; message: string | null }>(null);
  const [testing, setTesting] = useState(false);
  /**
   * WHICH TEST IS THE NEWEST. Clearing the verdict when a field changes is only half the rule —
   * a test already IN FLIGHT resolves later and does not know the form has moved. Start a test
   * against A, edit the address to B (the verdict clears, correctly), A's answer lands, and A's
   * green tick is sitting over B, having reappeared with nothing pressed. Worse here than on the
   * settings pane, because on this screen the verdict AUTHORISES: "Connect and continue" is gated
   * on it, so a stale green would arm a submit for a configuration nobody proved.
   */
  const testSeq = useRef(0);
  /**
   * RETIRE WHATEVER IS IN FLIGHT, and clear what is on screen — one act, because they are one
   * fact: this form no longer describes the thing that was asked about.
   *
   * The generation counter alone does NOT do this, and believing it did was the defect a third
   * review round found in the second round's fix. Advancing the sequence only when a test STARTS
   * orders concurrent presses and nothing else: press Test for A, edit the host to B while it is
   * pending, and A's answer still carries the current generation, so it lands — over B, with the
   * gate on "Connect and continue" opening for a configuration nobody proved. The clear has to
   * advance the sequence too, which is what makes an EDIT invalidate a request rather than merely
   * blank the screen.
   *
   * `setTesting(false)` with it: the request is no longer ours, so the pending line must not go on
   * describing it.
   */
  const retireTest = useCallback(() => {
    testSeq.current += 1;
    setVerdict(null);
    setTesting(false);
    /* AND THE FAILED WRITE'S OWN SENTENCE, which is the second thing on this screen that reports
       on a configuration. A refused connect sets `problem`; editing the address afterwards used to
       leave that refusal standing beside the new one, so the screen carried a server's complaint
       about a mailbox nobody is trying any more — and a fresh green test did not remove it either,
       because the two were written by different code paths and only one of them was retired. */
    setProblem(null);
  }, []);
  const preset = providerById(providerId);

  /**
   * A PRESET CHANGE REWRITES THE HOSTS THROUGH `hostsFor`, WHICH TAKES THE PREVIOUS CHOICE.
   *
   * Not tidiness — `providers.ts` records the credential leak this closes: without the previous
   * choice, moving from Gmail to the generic entry KEPT `imap.gmail.com` in a field the person
   * never typed, and their own server's password was then dialled at Gmail. The rule is one
   * function and this surface uses it rather than restating it.
   */
  const chooseProvider = useCallback((next: string) => {
    const p = providerById(next);
    const previous = providerById(providerId);
    const hosts = hostsFor(p, { imapHost, smtpHost }, previous);
    setProviderId(next);
    setImapHost(hosts.imapHost);
    setSmtpHost(hosts.smtpHost);
    if (!p.manual) {
      setImapPort(String(p.imap.port));
      setSmtpPort(String(p.smtp.port));
    }
    // THE VERDICT IS ABOUT A CONFIGURATION, NOT ABOUT A FORM. Changing the provider changes
    // which server would be dialled, so a green tick left standing would authorise "Connect and
    // continue" on evidence gathered against a different host entirely — and a test still in
    // flight against the old provider would land the same way, which is why this RETIRES.
    retireTest();
  }, [imapHost, providerId, retireTest, smtpHost]);

  const mailboxInput = useCallback((): FirstRunMailboxInput => {
    const port = Number(imapPort);
    const sPort = Number(smtpPort);
    return {
      address: address.trim(),
      provider: preset.id,
      imap: {
        host: imapHost.trim(),
        ...(Number.isInteger(port) && port > 0 ? { port } : {}),
        secure: preset.manual ? port === 993 : preset.imap.secure,
        pass,
      },
      ...(smtpHost.trim() ? {
        smtp: {
          host: smtpHost.trim(),
          ...(Number.isInteger(sPort) && sPort > 0 ? { port: sPort } : {}),
          secure: preset.manual ? sPort === 465 : preset.smtp.secure,
          pass,
        },
      } : {}),
    };
  }, [address, imapHost, imapPort, pass, preset, smtpHost, smtpPort]);

  const test = useCallback(async () => {
    const mine = ++testSeq.current;
    setTesting(true);
    setVerdict(null);
    try {
      const ok = await host.probe(mailboxInput());
      if (testSeq.current !== mine) return;
      setVerdict({ ok });
    } catch (err) {
      if (testSeq.current !== mine) return;
      setVerdict({ reason: host.probeReason(err), message: host.probeMessage(err) });
    } finally {
      if (testSeq.current === mine) setTesting(false);
    }
  }, [host, mailboxInput]);

  /**
   * "Connect and continue" IS DISABLED UNTIL A TEST HAS PASSED, and the gate reads the VERDICT
   * rather than the fields.
   *
   * A form that looks complete is not evidence that the mail server accepts it, and the whole
   * point of the test button is to make the difference visible before somebody's password is
   * stored. `verdict` is cleared by any provider change (above), so the gate cannot be
   * satisfied by a pass against a host that is no longer in the form.
   */
  const tested = verdict !== null && "ok" in verdict;

  /* ── THE WINDOW AND THE AI ANSWER ──────────────────────────────────────────────────── */

  /**
   * THE WINDOW, pre-filled from truth on a re-run and 365 on a first run.
   *
   * 365 is written EXPLICITLY rather than left to the product default, which is 60 and is pinned
   * twice elsewhere: the dial a person sees on this screen and the dial that gets stored have to
   * be the same number, and a first run that showed one and stored the other would be exactly the
   * lie this flow's copy is written against.
   *
   * A stored value that is not one of the four offered rungs falls to the nearest OFFER rather
   * than to the default — somebody who set 120 in Settings should not be shown "One year".
   */
  const [win, setWin] = useState<WindowChoice>(() => initialWindow(screening));
  const [ai, setAi] = useState<"yes" | "no">(
    // The posture, where the door has one. `on` and `on-unconfigured` are both a "yes" that was
    // already given; `unset` and `off` both render as "no", which is what the radio group can
    // say — the difference between them lives in the derivation, not in this control.
    () => (facts.ai === "on" || facts.ai === "on-unconfigured" ? "yes" : "no"),
  );
  const [scope, setScope] = useState<DecisionScope>("sender");

  /* ── THE ELSEWHERE CHOICE ──────────────────────────────────────────────────────────── */

  /**
   * WHICH CHOICE THE PERSON MADE, or `null` while they have not touched the control.
   *
   * `null` rather than a seeded value, because the default is a FACT and the fact arrives late.
   * The holder columns are filled by a PEEK — an IMAP round trip that lands after this component
   * mounts — so a `useState` initializer reading them would compute the default against facts
   * that had not arrived yet and keep it for the life of the run. The effective value is derived
   * below, where `claimRefusedHere` is in hand, and switches to what the person picked the
   * instant they pick anything.
   */
  const [elsewhereChoicePicked, setElsewhereChoice] = useState<"here" | "read" | null>(null);
  /** A claim has been authorized in this run — the "on its next pass" verdict, not a success. */
  const [claimed, setClaimed] = useState(false);

  /* ── THE PULL'S RATE ───────────────────────────────────────────────────────────────── */

  const [samples, setSamples] = useState<PullSample[]>([]);
  const mirrorCount = pull.mirrorCount;
  /**
   * Sampled on every render in which the count MOVED, not on a timer of its own. The mirror's
   * size only changes when a drain lands, and a timer would fill the window with duplicate
   * observations that make the span look longer than the evidence in it.
   */
  const lastSampled = useRef<number | null>(null);
  useEffect(() => {
    if (lastSampled.current === mirrorCount) return;
    lastSampled.current = mirrorCount;
    setSamples((prev) => pullSampleStep(prev, mirrorCount, Date.now()));
  }, [mirrorCount]);

  const rate = pullRate(samples);
  const remaining = pullRemaining(serverMessageCount, mirrorCount);
  const etaMs = pullEtaMs(remaining, rate);

  /** Whether the claim choice on the elsewhere screen would be declined. See the function. */
  const claimRefusedHere = claimRefusedOnThisDoor(facts);
  /**
   * THE PRE-SELECTED CHOICE IS THE ONE THAT CAN SUCCEED — and it used to be the refused one.
   *
   * `here` was hard-coded as the default on the reasoning that a first run is somebody setting
   * ohmail up to organize their mail. That reasoning holds on a door where the claim can be
   * taken. It does not hold here: `claimRefusedHere` is the state in which the block directly
   * under this control says, before any press, that the takeover cannot be taken — and the
   * default sat on exactly that option, so ↵ on an untouched screen pressed the refused thing.
   *
   * So the default follows the facts, and only until the person answers: any press writes
   * `elsewhereChoicePicked` and that wins from then on, including a deliberate "Organize here
   * instead" over a live holder — the screen states the refusal, it does not remove the choice.
   * Where the claim CAN succeed (the hosted door, a stopped holder) `here` is still the default,
   * unchanged, because there the choice promises nothing the next pass declines.
   */
  const elsewhereChoice: "here" | "read" =
    elsewhereChoicePicked ?? (claimRefusedHere ? "read" : "here");
  /**
   * IS THIS INSTALL THE ORGANIZER — the one fact the summary is allowed to report work on.
   *
   * `!== "reader"` and not `=== "organizer"`, on {@link OnboardingMailbox.organizerRole}'s own
   * rule: absent is a host too old to say, and every install was an organizer before the column
   * existed. Only an explicit `reader` withholds the work summary.
   */
  const organizing = facts.mailbox?.organizerRole !== "reader";

  if (step === null) return null;

  const num = (n: number) => new Intl.NumberFormat(locale).format(n);
  /**
   * "4 minutes" / "4 Minuten" — the locale's own unit formatting, never a hand-built string.
   * Hours above ninety minutes, because "about 143 minutes" is not how anybody says it.
   */
  const durationWords = (ms: number): string => {
    const minutes = Math.max(1, Math.round(ms / 60_000));
    const useHours = minutes >= 90;
    const value = useHours ? Math.max(1, Math.round(minutes / 60)) : minutes;
    return new Intl.NumberFormat(locale, {
      style: "unit", unit: useHours ? "hour" : "minute", unitDisplay: "long",
    }).format(value);
  };

  const railAt = RAIL.findIndex((r) => r.steps.includes(step));
  const railLabel = (id: string) => t(`rail_${id}` as "rail_mailbox");

  const foot = (opts: { primary?: ReactNode; back?: boolean; cancel?: boolean } = {}) => (
    <div className="ob-foot">
      {opts.cancel === false ? null : (
        <button type="button" className="join-alt" disabled={busy}
          onClick={() => setConfirm("cancel")}>
          {t("cancel")} <Kbd>esc</Kbd>
        </button>
      )}
      <button type="button" className="join-alt" disabled={busy}
        onClick={() => (mailboxId ? setConfirm("restart") : goTo("welcome"))}>
        {t("restart")}
      </button>
      <span className="ob-spacer" />
      {opts.back && backStep ? (
        <Button variant="ghost" onClick={() => goTo(backStep)} disabled={busy}>{t("back")}</Button>
      ) : null}
      {opts.primary}
    </div>
  );

  /** The primary verb of a step whose Enter submits its form. */
  const next = (label: string, extra: { disabled?: boolean } = {}) => (
    <Button variant="primary" type="submit" kbdHint="↵" disabled={busy || extra.disabled}>
      {label}
    </Button>
  );

  /**
   * A STEP'S BODY IS A FORM so ↵ submits it — the keyboard-first law applied to a flow whose
   * every screen has exactly one forward verb. `onSubmit` is the same closure the primary
   * button runs, so the two cannot drift.
   */
  const screen = (submit: () => void, body: ReactNode) => (
    <form onSubmit={(e) => { e.preventDefault(); if (!busy) submit(); }}>{body}</form>
  );

  return (
    <div className="ob-stage">
      <div className="login-card ob-card set-pane" role="dialog" aria-modal="true"
        aria-labelledby={`${ids}-title`}>
        <span className="wordmark"><b><em>oh</em>mail</b></span>

        {step === "welcome" ? null : (
          <>
            <ol className="join-rail" aria-label={t("rail_mailbox")}>
              {RAIL.map((r, i) => (
                <li key={r.id} data-state={i < railAt ? "done" : i === railAt ? "now" : "todo"}>
                  <span className="join-rail-dot" aria-hidden="true" />
                  <span className="join-rail-label">{railLabel(r.id)}</span>
                </li>
              ))}
            </ol>
            {/* NARROW: the labels go and the step is NAMED once. See `first-run.css`. */}
            <p className="ob-step" aria-hidden="true">
              {`${railAt + 1} / ${RAIL.length} · ${railLabel(RAIL[railAt]?.id ?? "mailbox")}`}
            </p>
          </>
        )}

        {step === "welcome" ? screen(forward, (
          <>
            <h1 id={`${ids}-title`}>
              {host.door === "cloud" ? t("welcomeCloudTitle") : t("welcomeTitle")}
            </h1>
            <p className="sub">{t("welcomeLead")}</p>
            <SettingsActions>{next(t("welcomeStart"))}</SettingsActions>
          </>
        )) : null}

        {step === "mailbox" ? screen(
          () => {
            /* ── BACK ONTO THIS SCREEN MUST NOT CONNECT A SECOND MAILBOX ────────────────────
             *
             * This step's forward verb CREATES, and Back from the consent screen lands here —
             * on a run whose mailbox already exists. Pressing it again would call `connect` for
             * a mailbox that is already connected, on the strength of a verdict from before it
             * was. So when the facts already hold a mailbox, the press CONTINUES: the work this
             * screen does has been done, and the person is walking back through it, not redoing
             * it.
             *
             * The derivation agrees — it answers `consent` for this state — which is what makes
             * "continue" the honest reading of the press rather than a special case. */
            if (facts.mailbox !== null) { forward(); return; }
            if (!tested) return;
            void run(async () => {
              await host.connect(mailboxInput());
              /* AND THE VERDICT IS RETIRED WITH THE FORM IT DESCRIBED. It proved a login that has
               * since been stored; leaving it standing would arm this screen's primary again the
               * moment somebody walked back onto it. */
              retireTest();
            });
          },
          (
            <>
              <h1 id={`${ids}-title`}>{t("mailboxTitle")}</h1>
              <p className="sub">{t("mailboxLead")}</p>
              {/* ── ONCE A MAILBOX EXISTS THIS SCREEN IS A STATEMENT, NOT A FORM ───────────────
                  Back from the consent screen lands here on a run whose mailbox is connected, and
                  a connect form there is a form whose every control is a lie: the fields describe
                  a mailbox that has been stored, "Test connection" would prove a login nobody is
                  about to use, and the primary — whatever the verdict says — can only navigate.
                  A person who tested, got a green tick and pressed on would have watched a
                  successful test authorise nothing at all.

                  So the form is withheld and the screen says which mailbox this run is about. The
                  way to connect a DIFFERENT one is "Start over", which is on this foot and which
                  offers to forget this one. */}
              {facts.mailbox !== null ? (
                <>
                  <SettingsBanner
                    /* THE SENTENCE, not the bare address — the connect funnel's own line, already
                       written and already translated. The heading above still reads "Add a
                       mailbox", which is the step's name rather than this state's, so the block
                       has to say for itself what it is reporting. */
                    label={tj("mailboxConnected", { address: mailboxAddress ?? "" })}
                    description={t("probeOkDetail")}
                  />
                  {foot({ back: true, primary: next(t("continue")) })}
                </>
              ) : (<>
              {/* EVERY PRESET, not a shortened list. The picker is the only way to reach a
                  provider's hosts without typing them, and a truncated one silently tells
                  somebody their provider is unsupported when it is in the table. */}
              <SettingsChoice
                name={`${ids}-provider`} ariaLabel={tp("label")} value={providerId}
                onChange={chooseProvider} disabled={busy}
                options={PROVIDERS.map((p: ProviderPreset) => ({
                  id: p.id,
                  label: providerLabel(p, tp),
                  description: p.manual ? tp("otherSub") : `${p.imap.host} · ${p.smtp.host}`,
                }))}
              />
              <div className="set-fields">
                <SettingsField htmlFor={`${ids}-address`} label={t("address")}>
                  <input id={`${ids}-address`} type="email" autoComplete="email" value={address}
                    onChange={(e) => { setAddress(e.target.value); retireTest(); }} />
                </SettingsField>
                <SettingsField htmlFor={`${ids}-pass`} label={t("password")}
                  hint={host.door === "local" ? t("passwordHint") : t("passwordHintCloud")}>
                  <input id={`${ids}-pass`} type="password" autoComplete="off" value={pass}
                    onChange={(e) => { setPass(e.target.value); retireTest(); }} />
                </SettingsField>
              </div>
              {preset.manual ? (
                <div className="set-fields">
                  <SettingsField htmlFor={`${ids}-imap`} label={t("imapHost")}>
                    <input id={`${ids}-imap`} className="set-mono" value={imapHost}
                      onChange={(e) => { setImapHost(e.target.value); retireTest(); }} />
                  </SettingsField>
                  <SettingsField htmlFor={`${ids}-imap-port`} label={t("imapPort")}>
                    <input id={`${ids}-imap-port`} className="set-mono" inputMode="numeric"
                      value={imapPort}
                      onChange={(e) => { setImapPort(e.target.value); retireTest(); }} />
                  </SettingsField>
                  <SettingsField htmlFor={`${ids}-smtp`} label={t("smtpHost")}>
                    <input id={`${ids}-smtp`} className="set-mono" value={smtpHost}
                      onChange={(e) => { setSmtpHost(e.target.value); retireTest(); }} />
                  </SettingsField>
                  <SettingsField htmlFor={`${ids}-smtp-port`} label={t("smtpPort")}>
                    <input id={`${ids}-smtp-port`} className="set-mono" inputMode="numeric"
                      value={smtpPort}
                      onChange={(e) => { setSmtpPort(e.target.value); retireTest(); }} />
                  </SettingsField>
                </div>
              ) : null}
              <SettingsActions>
                {/* NOT a submit: this button asks the mail server a question and the form's ↵
                    belongs to the step's forward verb. */}
                <Button type="button" onClick={() => void test()} disabled={testing || busy}>
                  {verdict === null ? t("test") : t("testAgain")}
                </Button>
              </SettingsActions>
              {testing ? (
                <SettingsVerdict state="wait" headline={t("testing", { host: imapHost.trim() })} />
              ) : null}
              {!testing && verdict !== null && "ok" in verdict ? (
                <SettingsVerdict
                  state="ok"
                  headline={t("probeOk", {
                    host: verdict.ok.host, user: verdict.ok.user, count: verdict.ok.folders ?? 0,
                  })}
                  detail={t("probeOkDetail")}
                />
              ) : null}
              {/* THE FAILURE SENTENCES ARE THE CONNECT FORM'S OWN (`mailboxes.probe_*`), not a
                  second set written for this screen. The endpoint throws the same refusal
                  `POST /mailboxes` does, so one vocabulary covers both surfaces; an unknown
                  reason falls back to the SERVER's sentence, which is true on a newer API this
                  build has no copy for. */}
              {!testing && verdict !== null && "reason" in verdict ? (
                <SettingsVerdict
                  state="bad"
                  headline={verdict.reason
                    ? tm(`probe_${verdict.reason}` as "probe_auth")
                    : verdict.message ?? tm("probe_unknown")}
                />
              ) : null}
              {problem ? <SettingsVerdict state="bad" headline={problem} /> : null}
              {foot({
                back: true,
                primary: next(busy ? t("connecting") : t("connect"), { disabled: !tested }),
              })}
              </>)}
            </>
          ),
        ) : null}

        {step === "elsewhere" ? screen(
          () => {
            /* ── THE QUESTION HAS NOW BEEN ANSWERED, WHICHEVER WAY ───────────────────────
             *
             * Recorded BEFORE either branch, because both are answers: `firstRunStep`'s guard
             * holds this screen against the cursor for as long as the facts say somebody else
             * organizes the mailbox, and without this flag "Organize here instead" would move
             * the cursor to `consent` and be thrown straight back here — the consent stamp
             * that ends the situation is two screens away. See the guard's own note. */
            if (mailboxId) setClaimAnsweredFor(mailboxId);
            /* ── "JUST READ IT HERE" WRITES NOTHING ABOUT ORGANIZING ──────────────────────
             *
             * There is no "become a reader" call: this install is already a reader (which is
             * what put this screen on screen), and a reader is a mail client — it reads,
             * searches, marks read and sends. Nothing has to change for it to be one.
             *
             * ── AND IT USED TO `leave()` HERE, WHICH ENDED THE RUN AT THE QUESTION ────────
             *
             * Measured on the released 0.13.7: choosing to read closed the flow outright, on a
             * first run, on "Run setup again" and in German — no summary, and nothing anywhere
             * else in the shell saying who organizes the mailbox. The reader summary that
             * screen owes exists in both catalogues (`doneReaderTitle`, `doneReaderReads`/`Why`,
             * `doneReaderClaim`/`Why`) and was unreachable, because this was the only path to
             * it and it went past.
             *
             * So the run FINISHES rather than being abandoned: `goTo("summary")` walks to the
             * one screen written for this ending, which names the holder and since when, says
             * what this computer does and does not do, and points at where the claim lives. Its
             * own "Open ohmail" is what stamps completion — cancel and finish write the same
             * stamp, so nothing is lost by deferring it one screen, and a person who quits
             * mid-summary is in exactly the state `leave()` would have left them in.
             *
             * `summary` is always in `onboardingPath`, and `firstRunStep` returns a non-null
             * cursor once the claim question is answered — which the line above has just
             * recorded — so this cannot be thrown back to the choice it came from. */
            if (elsewhereChoice === "read") { goTo("summary"); return; }
            /* ── "ORGANIZE HERE INSTEAD" — AND WHY IT USUALLY CALLS NOTHING EITHER ────────
             *
             * The claim, the consent and the window ride ONE request
             * (`POST /mailboxes/:id/organize`), and the consent screen and the window screen
             * are the two halves of composing it. Reaching this screen means the derivation's
             * row 3 fired, which is gated on `!consented` — so in a first run the answer here
             * is forward navigation, and the window's press is what claims.
             *
             * The one exception is the RE-ENTRY path: a mailbox this account already consented
             * to, that another install has since taken, reached from the Settings banner. There
             * is nothing left to ask, so the claim goes at once and the verdict says what
             * actually happened — asked for, decided by the worker on its next pass. Never
             * "done": this authorizes ONE attempt and does not win anything. */
            if (!facts.mailbox?.organizeConsentedAt) { forward(); return; }
            if (!mailboxId) return;
            void run(async () => {
              await host.organize(mailboxId, {});
              setClaimed(true);
            }, "elsewhere");
          },
          (
            <>
              <h1 id={`${ids}-title`}>{t("elsewhereTitle")}</h1>
              <p className="sub">{t("elsewhereLead")}</p>
              <SettingsBanner
                label={holderName(facts) === null
                  ? tm("readerLabelLegacy")
                  : tm("readerLabel", { name: holderName(facts)! })}
                description={facts.mailbox?.organizerState === "stopped"
                  /* NO AGE, and the prop that carried one is gone with it. `readerStopped` took a
                     `{when}` and was handed `organizedBy.since` — which is when that install
                     BECAME the organizer, not when it was last seen; the heartbeat is
                     deliberately not persisted. The copy dropped the placeholder and this kept
                     feeding it, which is a prop with a caller and no consumer. */
                  ? tm("readerStopped", { name: holderName(facts) ?? tm("readerHolderUnknown") })
                  : holderName(facts) === null
                    ? tm("readerSinceUnknown", { since: organizedSince ?? "" })
                    : facts.mailbox?.organizedBy?.kind === "cloud"
                      ? tm("readerSinceCloud", { since: organizedSince ?? "" })
                      : tm("readerSinceLocal", {
                        since: organizedSince ?? "", name: holderName(facts)!,
                      })}
              />
              <SettingsChoice
                name={`${ids}-elsewhere`} ariaLabel={t("elsewhereTitle")} value={elsewhereChoice}
                onChange={setElsewhereChoice} disabled={busy}
                options={[
                  {
                    id: "here" as const, label: t("elsewhereChoiceHere"),
                    description: t("elsewhereChoiceHereWhy", {
                      name: holderName(facts) ?? tm("readerHolderUnknown"),
                    }),
                  },
                  {
                    id: "read" as const, label: t("elsewhereChoiceRead"),
                    description: t("elsewhereChoiceReadWhy", {
                      name: holderName(facts) ?? tm("readerHolderUnknown"),
                    }),
                  },
                ]}
              />
              {/* ── ONE SENTENCE, ON EVERY DOOR, AND IT IS TRUE ON ALL THREE AGAIN ─────────
                  This was door-aware for a day. The standalone install read its takeover stamp
                  ONCE, when it assembled its engine, so a claim made while the app was running
                  was not spent until a restart — and "on its next pass, within a minute" would
                  have been a promise that door could not keep. It said what had to be done
                  instead, in the mailbox pane's own words.

                  The engine re-reads the stamp at the top of every gate now, so a press on a
                  running install is honoured on the next poll with no relaunch. The premise the
                  branch stood on is gone, and the branch goes with it rather than surviving as a
                  vaguer sentence on one door — which would understate what that door does. */}
              {/* ── AND WHERE THE LEASE WILL REFUSE, THE SCREEN SAYS SO BEFORE THE PRESS ───
                  `decideLease` ranks kinds cloud > local > unknown, and a STANDALONE install is
                  `local`: rule 5 gives it no path over a live Cloud (or over a live kind this
                  build cannot rank) whatever was authorized — the honest action is to stop the
                  organizer there first. Without this the choice promised a takeover that the
                  very next pass refuses: agree, stand down on that pass, and read a summary
                  claiming the organizing.

                  The sentence is `mailboxes.organizeHereWhatBlocked`, the SAME one Settings →
                  Mailboxes prints for the same state — one vocabulary for one refusal, so the
                  two surfaces cannot drift into describing it differently.

                  Withheld on the other two doors rather than made vaguer: a Cloud claim outranks
                  a local holder, so there the promise the choice makes is true.

                  IT NO LONGER WAITS FOR "ORGANIZE HERE INSTEAD" TO BE SELECTED, and that is the
                  other half of moving the default off the refused option. Gated on the selection
                  it would be invisible in exactly the state it describes — the person arrives on
                  "Just read it here" and is never told why that is where they landed. The
                  sentence is about the MAILBOX, not about a selection, so it is said whenever it
                  is true. */}
              {claimRefusedHere ? (
                <SettingsVerdict
                  state="off"
                  headline={tm("organizeHereWhatBlocked", {
                    name: holderName(facts) ?? tm("readerHolderUnknown"),
                  })}
                />
              ) : null}
              {claimed ? <SettingsVerdict state="wait" headline={t("elsewhereQueued")} /> : null}
              {problem ? <SettingsVerdict state="bad" headline={problem} /> : null}
              {foot({ back: true, primary: next(t("continue")) })}
            </>
          ),
        ) : null}

        {step === "consent" ? screen(forward, (
          <>
            <h1 id={`${ids}-title`}>{t("consentTitle")}</h1>
            {/* THE CONSENT STATEMENT, and the two sentences under it are not decoration. The
                first names every folder in `DESTINATIONS` — a draft that named four of six was
                false by omission, and a test pins the set. The second says History is a VIEW:
                mail older than the window stays physically in the Inbox, so "filed to History"
                would be a claim about a move that does not happen. */}
            <p className="ob-consent">{t("consentBody")}</p>
            <p className="ob-consent">{t("consentHistory")}</p>
            <p className="set-note-inline" style={{ paddingTop: 10 }}>{t("consentNothingYet")}</p>
            {foot({ back: true, primary: next(t("continue")) })}
          </>
        )) : null}

        {step === "window" ? screen(
          () => {
            if (!mailboxId) return;
            void run(async () => {
              const outcome = await host.organize(mailboxId, {
                screening: win === "all"
                  ? { scope: "all_time" }
                  : { dormancyDays: Number(win), scope: "window" },
              });
              /* ── A PRESS THAT STORED NOTHING MAY NOT LOOK LIKE ONE THAT WORKED ───────────
               *
               * Every reply to this call is a 200, including the one for a mailbox that is no
               * longer there — so until `organize` answered, the stage advanced identically
               * whether the window had been stored or not. Throwing puts the sentence in the
               * screen's own verdict and leaves the cursor here, which is the rule the rest of
               * this flow's copy is written to: a control may not report having acted when it
               * has not. */
              if (outcome === "gone") throw new Error(t("windowGone"));
              // The write's own result, applied before the re-read lands. See `consented`.
              setConsented({ mailboxId, at: new Date().toISOString() });
            /* ── ON A RE-RUN THE CURSOR NAMES THE NEXT SCREEN, BECAUSE NOTHING ELSE CAN ─────
             *
             * See `run`. A re-run is cursor-driven — a finished account derives to "nothing to
             * do" — so a cleared cursor here means the consent statement, which is the screen
             * this press came FROM. That was an infinite loop on the button that ends setup's
             * only irreversible-sounding sentence. On a first run the cursor is cleared and the
             * derivation answers, which it now can: consent has just been stamped. */
            }, rerun === true ? "ai" : undefined);
          },
          (
            <>
              <h1 id={`${ids}-title`}>{t("windowTitle")}</h1>
              <p className="sub">{t("windowLead")}</p>
              <SettingsChoice
                name={`${ids}-window`} ariaLabel={t("windowTitle")} value={win}
                onChange={setWin} disabled={busy}
                options={[
                  { id: "90" as const, label: t("win90") },
                  { id: "180" as const, label: t("win180") },
                  { id: "365" as const, label: `${t("win365")} · ${t("winDefault")}` },
                  { id: "all" as const, label: t("winAll"), description: t("winAllWhy") },
                ]}
              />
              {/* "You can widen this later" — pinned to what widening actually does: senders
                  past the old cutoff become undecided in the Screener queue and only a decision
                  moves their mail. No backlog re-route pass exists and the sentence must not
                  imply one. */}
              <p className="set-note-inline">{t("windowLater")}</p>
              <p className="ob-consent ob-window-recap">{firstSentence(t("consentBody"))}</p>
              {problem ? <SettingsVerdict state="bad" headline={problem} /> : null}
              {foot({ back: true, primary: next(busy ? t("agreeing") : t("agree")) })}
            </>
          ),
        ) : null}

        {step === "ai" ? screen(
          () => {
            const on = ai === "yes";
            if (!host.setAiEnabled) { forward(); return; }
            /* ── THE ONE PLACE A CURSOR IS KEPT PAST A WRITE, AND WHY ────────────────────
             *
             * "Yes" needs no help: it MOVES the posture — `on-unconfigured` on the standalone
             * door, `on` on Cloud — and the derivation then names the provider step or the pull
             * correctly by itself.
             *
             * "No" is the problem, and it is a real gap in what the doors can store rather than
             * a shortcut taken here. `OnboardingAi` distinguishes "answered no" from "never
             * asked" precisely because they need opposite behaviour; Cloud's storage cannot —
             * `accounts.ai_enabled` is a boolean that rests false — so a re-derive after a "no"
             * hands back `unset`, and the person is returned to the question they just answered,
             * every time, for ever. Walking the cursor past it is what makes "no" a complete
             * answer on that door.
             *
             * The cost is stated rather than hidden: a run RESUMED later on Cloud asks the AI
             * question again. That is the safe direction and the one the posture's own union
             * documents — the danger is silently skipping somebody who was never asked, not
             * asking somebody twice.
             *
             * `undefined` once the import is finished, because "pull" would then be a completed
             * progress bar and the derivation has a better answer (the guided decision, or the
             * summary).
             */
            /* ── AND ON A RE-RUN THE CURSOR IS THE ONLY NAVIGATION ──────────────────────────
             *
             * Same reason as the window step's: `firstRunStep` answers `consent` for a re-run
             * with no cursor, so a cleared cursor here walks back to the statement two screens
             * ago. "Yes" on the standalone door still needs a model, which is the provider step;
             * every other answer has nothing left to ask and a re-run ends at the summary. */
            const keep = rerun === true
              ? (on && host.door === "local" ? ("provider" as const) : ("summary" as const))
              : on || facts.mailbox?.initialImportCompletedAt !== null
                ? undefined
                : ("pull" as const);
            void run(async () => { await host.setAiEnabled!(on); }, keep);
          },
          (
            <>
              <h1 id={`${ids}-title`}>{t("aiTitle")}</h1>
              <p className="sub">{t("aiLead")}</p>
              {/* THE CONSEQUENCE IS DOOR-AWARE because "yes" means a different thing on each:
                  the standalone asks for a model on the next screen, Cloud spends the plan's
                  credits, self-host runs on the operator's key and asks nothing. */}
              <SettingsChoice
                name={`${ids}-ai`} ariaLabel={t("aiTitle")} value={ai} onChange={setAi}
                disabled={busy}
                options={[
                  { id: "no" as const, label: t("aiNo"), description: t("aiNoWhy") },
                  {
                    id: "yes" as const,
                    label: host.door === "cloud" ? t("aiYesCloud")
                      : host.door === "selfhost" ? t("aiYesSelfhost") : t("aiYes"),
                    description: host.door === "cloud" ? t("aiYesCloudWhy")
                      : host.door === "selfhost" ? t("aiYesSelfhostWhy") : t("aiYesWhy"),
                  },
                ]}
              />
              {problem ? <SettingsVerdict state="bad" headline={problem} /> : null}
              {foot({ back: true, primary: next(t("continue")) })}
            </>
          ),
        ) : null}

        {step === "provider" ? screen(forward, (
          <>
            {host.door === "local" ? (
              <>
                <h1 id={`${ids}-title`}>{t("aiTitle")}</h1>
                {/* THE DESKTOP'S OWN FORM, INJECTED. One write path to the install's model file,
                    shared with Settings → AI; `apps/webapp` never imports it and a pin says so. */}
                {host.providerForm}
              </>
            ) : host.door === "cloud" ? (
              <>
                <h1 id={`${ids}-title`}>{t("providerCloudTitle")}</h1>
                <p className="ob-consent">{t("providerCloudBody")}</p>
              </>
            ) : (
              <>
                <h1 id={`${ids}-title`}>{t("providerSelfhostTitle")}</h1>
                <p className="ob-consent">
                  {host.selfhostAi ? t("providerSelfhostOn") : t("providerSelfhostOff")}
                </p>
              </>
            )}
            {foot({ back: true, primary: next(t("continue")) })}
          </>
        )) : null}

        {step === "pull" ? screen(onLeave, (
          <>
            <h1 id={`${ids}-title`}>{t("pullTitle")}</h1>
            <p className="sub">{t("pullLead")}</p>
            <div className="ob-counters">
              <div className="ob-counter"><b>{num(pull.screened)}</b><span>{t("screened")}</span></div>
              <div className="ob-counter"><b>{num(pull.history)}</b><span>{t("history")}</span></div>
              {/* THE THIRD COUNTER EXISTS ONLY WHEN THE SERVER HAS SAID. `serverMessageCount` is
                  absent until a cycle has counted a folder, and a "0 still to read" over a
                  running pull is a confident wrong answer. */}
              {remaining !== null ? (
                <div className="ob-counter"><b>{num(remaining)}</b><span>{t("remaining")}</span></div>
              ) : null}
            </div>
            {remaining !== null ? (
              <div className="ob-track" role="progressbar" aria-valuemin={0}
                aria-valuemax={mirrorCount + remaining} aria-valuenow={mirrorCount}>
                <i style={{ width: `${Math.round((mirrorCount / (mirrorCount + remaining)) * 100)}%` }} />
              </div>
            ) : null}
            {/* "about", and NEVER before two minutes of samples. The gate is in `pull-rate.ts`;
                until it opens the line says the flow is still working the number out, which is
                true and is not a number. */}
            <p className="ob-eta" role="status">
              {etaMs !== null && rate !== null
                ? t("eta", { eta: durationWords(etaMs), rate: Math.round(rate) })
                : t("etaSoon")}
            </p>
            {resumed ? <SettingsVerdict state="wait" headline={t("pullResumed")} /> : null}
            {foot({
              primary: (
                <Button variant="ghost" type="submit" disabled={busy}>{t("pullLeave")}</Button>
              ),
            })}
          </>
        )) : null}

        {step === "decide" && decide ? (
          <>
            <h1 id={`${ids}-title`}>{t("decideTitle")}</h1>
            <p className="sub">{t("decideLead")}</p>
            <div className="ob-sender">
              <div className="who">
                <span className="av" aria-hidden="true">{decide.name.slice(0, 1).toUpperCase()}</span>
                <div><b>{decide.name}</b> <span>{decide.address}</span></div>
              </div>
              <div className="held">{decide.since}</div>
              {/* THE REAL BAR, and `keyboard` is ON here unlike in the Screener. There the five
                  keys are a VIEW-scope registry layer so the shell can tell `c` (Receipts) from
                  `c` (Compose); inside this dialog there is no view under it to arbitrate with,
                  and the bar's own listener is the only thing bound. */}
              <DecisionBar
                scope={scope} onScopeChange={setScope} ruleTarget={decide.address} keyboard
                onDecide={(dest, opts) => {
                  decide.onDecide(dest, { markRead: opts.markRead, scope });
                  // FORWARD, NOT RE-DERIVED. The queue may still hold senders — it usually does
                  // — and the derivation would answer "decide" again. The guided step is one
                  // decision by construction; the rest of the queue is the Screener's.
                  goTo("summary");
                }}
              />
            </div>
            <ul className="ob-verbs">
              {DECIDE_LEGEND.map((v) => (
                <li key={v.key}><Kbd>{v.key}</Kbd> {t(v.copy)}</li>
              ))}
            </ul>
            <p className="set-note-inline">{t("decideAfter")}</p>
            {foot({})}
          </>
        ) : null}

        {/* ── THE SUMMARY REPORTS WHAT **THIS INSTALL** DID, AND IT USED TO REPORT THE MAILBOX ──
         *
         * An install that has stood down to READER organizes nothing, and this screen used to
         * end its setup run by reporting a screening count and a list of folders anyway. Every
         * number on it was true about the MAILBOX and false about the run that printed it: the
         * folders and the screening belong to whichever install holds the lease. Settings →
         * Mailboxes said the true thing at the same moment on the same machine, which is how the
         * contradiction shows up.
         *
         * The two shapes are not two wordings of one screen. An organizer reports work; a reader
         * reports a relationship — what it does (read, search, mark read, send), who organizes
         * the mailbox and since when, and where the claim lives if they want it here. There is no
         * count on the reader's half at all, because a count is a claim about work.
         *
         * `organizing` is `organizerRole !== "reader"`, so a host too old to say the role gets
         * the organizer summary — the pre-0083 world, where every install was one.
         */}
        {step === "summary" ? screen(leave, (
          <>
            <h1 id={`${ids}-title`}>{organizing ? t("doneTitle") : t("doneReaderTitle")}</h1>
            <div className="ob-done">
              {organizing ? (
                <>
                  {/* THE COUNTS ARE MESSAGES, AND THE LABEL SAID SENDERS. `pull.screened` is the
                      mirror's size minus what History lists — a count of MESSAGES that went
                      through the screening partition — and it was rendered under "{n} senders
                      screened", which is a smaller number on any real mailbox. The value was
                      right and the noun was not. */}
                  <SettingsRow label={t("doneScreened", { count: pull.screened })}
                    description={t("doneScreenedWhy")} />
                  <SettingsRow label={t("doneHistory", { count: pull.history })}
                    description={t("doneHistoryWhy")} />
                  <SettingsRow label={t("doneFolders")} description={t("doneWhere")} />
                </>
              ) : (
                <>
                  <SettingsRow label={t("doneReaderReads")} description={t("doneReaderReadsWhy")} />
                  {/* WHO ORGANIZES IT AND SINCE WHEN — the same four columns and the same three
                      sentences the elsewhere screen and Settings → Mailboxes render, so the three
                      surfaces cannot describe one state differently. */}
                  <SettingsRow
                    label={holderName(facts) === null
                      ? tm("readerLabelLegacy")
                      : tm("readerLabel", { name: holderName(facts)! })}
                    description={holderName(facts) === null
                      ? tm("readerSinceUnknown", { since: organizedSince ?? "" })
                      : facts.mailbox?.organizedBy?.kind === "cloud"
                        ? tm("readerSinceCloud", { since: organizedSince ?? "" })
                        : tm("readerSinceLocal", {
                          since: organizedSince ?? "", name: holderName(facts)!,
                        })}
                  />
                  <SettingsRow label={t("doneReaderClaim")} description={t("doneReaderClaimWhy")} />
                </>
              )}
            </div>
            <p className="set-note-inline">{t("doneSettings")}</p>
            {/* ── THE PAIR OFFER IS A SECOND VERB HERE, AND IT HAS TO BE ────────────────────
             *
             * `pair` is in the path and lights a rail dot, and NOTHING COULD REACH IT: this
             * screen's only verb stamps completion and leaves, so the pairing step was rendered
             * by no state the flow could produce. Found while building the render harness, before
             * a pixel — the step existed in the type, the path and the rail, and in no reachable
             * run.
             *
             * A second VERB rather than making "Open ohmail" advance, because that label would
             * then be false: it would not open ohmail, it would show another setup screen. Two
             * true labels beat one that navigates somewhere its words do not name.
             *
             * Withheld where the door does not pair, structurally: no panel, no offer, and the
             * step is skipped rather than rendered empty. */}
            {foot({
              cancel: false,
              primary: (
                <>
                  {host.pairNode ? (
                    <Button variant="ghost" onClick={() => goTo("pair")} disabled={busy}>
                      {t("pairTitle")}
                    </Button>
                  ) : null}
                  {next(t("doneOpen"))}
                </>
              ),
            })}
          </>
        )) : null}

        {/* THE LAST SCREEN, reached only from the summary's second verb — and it IS what stamps
            on that path, because taking the pair offer means the summary's "Open ohmail" was not
            pressed. Skipping it therefore has to END the run rather than abandon it: "Later" and
            Cancel are the same act here, which is why the foot carries no Cancel of its own. */}
        {step === "pair" ? screen(leave, (
          <>
            <h1 id={`${ids}-title`}>{t("pairTitle")}</h1>
            <p className="sub">{t("pairLead")}</p>
            <div className="ob-qr">{host.pairNode}</div>
            {/* IT STAMPS NOTHING. The summary's "Open ohmail" is what finishes the flow; this
                screen is offered after it and skipping it must not look like abandoning setup. */}
            {foot({ cancel: false, primary: (
              <Button variant="ghost" type="submit">{t("pairLater")}</Button>
            ) })}
          </>
        )) : null}

        {confirm === "cancel" ? (
          <div className="ob-confirm">
            <p>{t("cancelWhat")}</p>
            <SettingsActions>
              <Button variant="primary" onClick={leave} disabled={busy}>{t("cancelConfirm")}</Button>
              <Button variant="ghost" onClick={() => setConfirm(null)}>{t("back")}</Button>
            </SettingsActions>
          </div>
        ) : null}

        {confirm === "restart" ? (
          <div className="ob-confirm">
            <p>{t("restartWhat")}</p>
            <SettingsActions>
              <Button variant="primary" onClick={() => goTo("mailbox")} disabled={busy}>
                {t("restartKeep")}
              </Button>
              {host.forgetMailbox && mailboxId ? (
                <Button variant="ghost" disabled={busy}
                  onClick={() => void run(async () => { await host.forgetMailbox!(mailboxId); })
                    .then(() => goTo("welcome"))}>
                  {t("restartForget")}
                </Button>
              ) : null}
              <Button variant="ghost" onClick={() => setConfirm(null)}>{t("back")}</Button>
            </SettingsActions>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * WHICH RUNG A STORED WINDOW SITS ON.
 *
 * `all_time` is a MODE and not a number, so it is answered first — reading it off `dormancyDays`
 * would put an account that screens everything onto whatever day-count happens to be stored
 * beside the mode. Everything else picks the CLOSEST offered rung, because the four on screen are
 * an offer and not the set of storable values: Settings will store any day-count from 1 to 365.
 */
export function initialWindow(
  screening?: { dormancyDays: number; scope: "window" | "all_time" },
): WindowChoice {
  if (!screening) return "365";
  if (screening.scope === "all_time") return "all";
  const rungs = [90, 180, 365] as const;
  let best: WindowChoice = "365";
  let bestGap = Number.POSITIVE_INFINITY;
  for (const r of rungs) {
    const gap = Math.abs(r - screening.dormancyDays);
    if (gap < bestGap) { bestGap = gap; best = String(r) as WindowChoice; }
  }
  return best;
}

/** The first sentence of the consent statement, re-shown under the window choice. */
function firstSentence(s: string): string {
  const at = s.indexOf(". ");
  return at < 0 ? s : `${s.slice(0, at)}.`;
}

/**
 * WHO ORGANIZES THIS MAILBOX, by name, or `null` when nobody is NAMED.
 *
 * `null` is not the same as "nobody organizes it" — the mailbox has a holder (that is what put
 * the elsewhere screen on screen), and this build simply has no name for them: a claim written
 * by a version that recorded none, or a row from a server that does not send the field. The
 * copy has a legacy label for exactly that, and inventing "another install" as the NAME would
 * put quotation marks around a phrase and read as a machine called "another install".
 */
function holderName(facts: OnboardingFacts): string | null {
  const by = facts.mailbox?.organizedBy;
  if (!by) return null;
  return by.name && by.name.trim() ? by.name : null;
}

/**
 * WOULD "ORGANIZE HERE INSTEAD" BE REFUSED BY THE LEASE, on the facts this screen can see?
 *
 * `decideLease` (`organizer-lease.ts`) ranks kinds cloud > local > unknown, and rule 5 refuses a
 * takeover of a LIVE holder that outranks us "even with authorization" — §4 gives a standalone
 * install no path over a live Cloud on purpose. So on the `local` door the claim choice promises
 * something the very next pass declines. The measured cost of not saying so was the confusion
 * this screen exists to prevent: agree, stand down on the next pass, and read a summary
 * reporting the organizing that was refused.
 *
 * `organizerState !== "stopped"` and not `=== "held"`, on the desktop pane's rule verbatim: the
 * column is `null` when this install has not LOOKED, which is not evidence the holder went away.
 * Treating unknown as beatable promises a takeover against a claim that may be perfectly fresh;
 * the cost of the cautious direction is a sentence pointing at an action that also works.
 *
 * Exported because it is the branch this screen's honesty rests on and it has rows.
 */
export function claimRefusedOnThisDoor(facts: OnboardingFacts): boolean {
  if (facts.door !== "local") return false;
  const mb = facts.mailbox;
  if (!mb || mb.organizerState === "stopped") return false;
  const kind = mb.organizedBy?.kind;
  return kind === "cloud" || kind === "unknown";
}
