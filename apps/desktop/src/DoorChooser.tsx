/**
 * THE FIRST SCREEN A FRESH INSTALL SHOWS — which mailbox is this? A REACT SCREEN, NOT A
 * NATIVE ONE: the shell owns the process, the keystore and the settings file, and no user
 * interface beyond the menu bar, so onboarding is the same React app the mail is — no second
 * look-and-feel to keep in step. HONEST ABOUT FAILING: a rejected password renders beside the
 * fields in the mail server's or the engine's own words, and nothing falls back to sample
 * mail. The copy is `desktopDoor` in `messages/{en,de}.json`, read through `DOOR_COPY`
 * (`door-copy.ts`) — the window's own namespace, never carried by the served host client; the
 * provider table is the shared one, so the sentences that matter are written down once.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@ohmail/ui";
/* `shortPin` moved to core when the phone grew the third end of the key comparison; this file
   still both USES it (the client door) and re-exports it (DesktopDevices imports it from here). */
import { shortPin } from "@ohmail/client-engine";

import { ProviderPicker } from "../../webapp/app/shell/ProviderPicker";
import { hostsFor, providerById } from "../../webapp/app/shell/providers";
import {
  EMPTY_LOCAL,
  beginBrowserSignIn,
  enterCloudDoor,
  enterCloudDoorWithCode,
  enterHostDoor,
  enterLocalDoor,
  hostLinkProblem,
  pairAgainWithHost,
  proveHostLink,
  signInToCloud,
  signInToCloudWithCode,
  standingEngine,
  type DoorResult,
  type HostLinkRefusal,
  type HostLinkStep,
  type HostRefusal,
  type HostSuggestion,
  type LocalDoorFields,
} from "./doors.js";
import {
  OPERATOR_CA_FILE,
  configureSelfHostDoor,
  selfHostBase,
  signInToSelfHost,
} from "./self-host.js";
import { DOOR_COPY, machineWord } from "./door-copy.js";
import { DoorProblem } from "./DoorProblem.js";
import { offLinkCode, onLinkCode, openWeb } from "./native.js";

/**
 * Which card is on screen. `doors` is where a fresh install starts.
 *
 * `server` is the self-hosted arm, and it is a step of its own rather than a flag on `cloud`
 * because it asks a question `cloud` does not: which server. Everything after that question is the
 * same engine, the same sign-in and the same mirror — see `self-host.ts`.
 */
type Step = "doors" | "takeover" | "local" | "host" | "server" | "cloud";

export function DoorChooser({
  onEntered,
  /** Where the chooser opens. The Settings pane sends somebody straight to one door. */
  start = "doors",
  /**
   * THE MAILBOXES THE OTHER COMPUTER HELD, for the takeover's first step. Three states, three
   * sentences — the whole reason this is not `string[]`: `undefined` is "still reading",
   * `null` is "the read failed", and an array is the answer (the empty array means that
   * computer was organizing nothing). `null` may NEVER be rendered as an empty list: the read
   * happens against a mirror the next step discards, so a failure and a host that held
   * nothing look identical afterwards — "there is nothing to take over" about a machine
   * organizing three mailboxes is failure-looks-healthy. The gate captures it BEFORE the
   * door moves; see `DesktopGate`.
   */
  roster,
  /** What to call the computer being left. Null falls back to sentences that name no machine. */
  host,
  /**
   * WHETHER THE CLOUD FORM CHOOSES A DOOR OR ONLY SIGNS IN AGAIN.
   *
   * Not the same act, and the difference is a restarted engine. Choosing the door writes the
   * settings and replaces the engine behind them; signing in again on a door that is already
   * chosen is one request over the bridge, with the mirror left exactly as it is. The Settings
   * pane's "Sign in" is the second, and doing it as the first would take somebody's mail away
   * for the length of a restart to change nothing.
   */
  cloudAction = "configure",
  /** Offered only when there is already a door to go back to. */
  onCancel,
}: {
  onEntered: (result: DoorResult) => void;
  start?: Step;
  cloudAction?: "configure" | "signIn";
  roster?: { address: string; id: string }[] | null | undefined;
  host?: string | null;
  onCancel?: () => void;
}) {
  const [step, setStep] = useState<Step>(start);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /**
   * THE ADDRESS A BROWSER HANDOFF WAS STARTED FOR, or null when none has been. It selects
   * which sign-in a code goes to: `enterCloudDoorWithCode` begins with `engine_configure`,
   * which REPLACES the engine — and the verifier lives in that process's memory, so
   * reconfiguring after the commitment is published throws it away and the account answers a
   * good code with its expired-code sentence. Once a handoff has started, the deep link AND a
   * retyped code take the sign-in that does not touch the engine's lifetime. It holds the
   * ADDRESS rather than a flag: editing the field after the browser was sent off must not
   * quietly sign in against a mailbox this install is not mirroring.
   */
  const [handedOff, setHandedOff] = useState<string | null>(null);

  /**
   * THE ENGINE REFUSED A SIGN-IN BECAUSE THIS INSTALL MIRRORS A DIFFERENT ACCOUNT — a
   * remembered fact that selects which sign-in the NEXT submit takes. The one-request sign-in
   * deliberately never touches the engine's lifetime, so it can never be the one that
   * switches accounts: the engine will not activate a session over another account's
   * database, and cannot discard one already open. The door CONFIGURE can — it replaces the
   * engine, and the replacement discards a foreign mirror — so this flips the form onto that
   * path. A BOOLEAN, not an address: the field is the true thing when switching. Never
   * cleared — a wasted configure costs a restart; clearing too eagerly strands a person.
   */
  const [mustSwitch, setMustSwitch] = useState(false);

  /**
   * THE SELF-HOSTED SERVER THIS INSTALL HAS BEEN POINTED AT AND PROVED, or null. It selects
   * what the next submit IS: null means the card is still asking for an address (its submit
   * configures and probes); set means the engine is configured for that base and serving,
   * and the submit is a sign-in — the identical request the hosted door makes. It holds the
   * BASE rather than a flag: what was proved is the thing to report and to sign in against,
   * and a boolean would let a later edit change which server the sentence describes. The
   * field is read-only from the moment this is set, so the two can never disagree.
   */
  const [reachedServer, setReachedServer] = useState<string | null>(null);

  /**
   * THE PAIRING LINK THIS INSTALL HAS PROVED, or null while the card is still asking for one.
   *
   * `reachedServer`'s shape and for its reason: it selects what the next submit IS. Null means
   * the field is live and the submit PROVES; set means the engine has said what is at that origin
   * and the submit REDEEMS. Holding the parsed LINK rather than a flag is what keeps the two from
   * disagreeing — the fingerprint on screen, the origin in the sentence and the token that will be
   * spent are all read out of this one value, so a later edit of the field cannot change which
   * computer the card was describing. The field is read-only from the moment this is set.
   */
  const [provedLink, setProvedLink] = useState<(HostLinkStep & { base: string }) | null>(null);

  /**
   * THE ONE REFUSAL WITH A WAY OUT — remembered so the card can offer the verb, cleared the
   * moment anything else happens. `pair_account_mismatch` means the computer at that address
   * was reinstalled: a different account behind a familiar name, invisible to the engine's
   * existing comparisons. The plain redeem is a dead end, and the only way through discards
   * the mail this machine holds for the other account. A REMEMBERED REFUSAL, NOT AN
   * INFERENCE: Start over appears as a control and the person presses it; a new link, Back
   * or a successful pairing clears it, so the verb can never outlive the refusal that
   * justified it and be pressed against a different computer.
   */
  const [mismatch, setMismatch] = useState(false);

  /**
   * A HOST THE LAST REFUSAL NAMED, remembered so the card can offer it as a press.
   *
   * `mismatch`'s shape and for its reason: it is a REMEMBERED refusal rather than an inference, so
   * the offer cannot outlive the answer that justified it. Cleared wherever `problem` is — every
   * attempt, every Back — because a host offered beside a different refusal would fill a field
   * with an answer to a question nobody asked.
   */
  const [suggestion, setSuggestion] = useState<HostSuggestion | null>(null);

  /* One attempt at a time, and the result travels up whole. A door attempt restarts the engine
     and can take tens of seconds on a first run, so a second press while the first is in flight
     would reconfigure underneath it — the shell would stop an engine that was still starting. */
  const attempt = async (run: () => Promise<DoorResult>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setSuggestion(null);
    try {
      const result = await run();
      setProblem(result.problem);
      setSuggestion(result.suggestion ?? null);
      if (result.switchAccount) setMustSwitch(true);
      if (!result.problem) onEntered(result);
    } finally {
      setBusy(false);
    }
  };

  /**
   * START THE BROWSER HANDOFF — configure the door, mint the commitment, open the page, in
   * that order: the engine must exist before it can invent a verifier, and the verifier must
   * exist before the page opens, or the page mints a code nothing on this machine can spend.
   * `beginBrowserSignIn` owns the ordering; this owns what the person sees. A refusal from
   * the shell is reported WITH the address, because somebody who cannot be sent to the page
   * can still walk to it — and the retype field is still on screen underneath.
   */
  const startHandoff = async (address: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setSuggestion(null);
    try {
      /* `configured` is false once a switch has been demanded, and that is not a detail. Leaving it
         true would mint a commitment inside an engine still pointed at the OTHER account, and the
         claim that followed would be refused all over again — a loop with no way out of it. Passing
         false reconfigures the door first, which discards the foreign mirror, so the code is claimed
         against a mirror that already belongs to the account being signed in to. */
      const started = await beginBrowserSignIn(address, cloudAction === "signIn" && !mustSwitch);
      if (!started.challenge) {
        setProblem(started.problem ?? DOOR_COPY.browserSignInFailed);
        return;
      }
      /* SET BEFORE THE BROWSER IS OPENED, and it stays set even if opening fails: by this point the
         engine HAS been configured and IS holding a verifier, so a code submitted afterwards must
         not go down a path that would restart it. */
      setHandedOff(address.trim());
      try {
        await openWeb("link-desktop", started.challenge);
      } catch {
        setProblem(DOOR_COPY.noBrowser(machineWord()));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gate">
      <div className="gate-card join-card">
        <span className="wordmark">
          <b>ohmail</b>
          <em>.</em>
        </span>
        {step === "doors" ? (
          <Doors onPick={setStep} onCancel={onCancel} />
        ) : step === "server" ? (
          <ServerDoor
            busy={busy}
            problem={problem}
            suggestion={suggestion}
            reached={reachedServer}
            onBack={() => {
              setProblem(null);
              setSuggestion(null);
              setReachedServer(null);
              setStep("doors");
            }}
            onCancel={onCancel}
            /* THE ADDRESS STEP. Not routed through `attempt`, because it does not end in a
               `DoorResult` and must not call `onEntered`: proving a server is reachable is not
               being signed in to it, and a window that closed the door here would leave somebody
               looking at a mail client with no session and nothing explaining why. */
            onProve={(typedOrigin, address) => {
              if (busy) return;
              /* ── A PAIRING LINK PASTED INTO THE SERVER FIELD GOES TO THE DOOR THAT WANTS
                 IT. Both doors ask for "an address", and the link came from the other
                 computer's Devices pane — the ordinary mistake. Left alone it is answered by
                 THIS door's refusals, which are about self-hosting (the worst tells somebody
                 to install a root certificate). Routed BEFORE any dial — `hostLinkProblem`
                 parses, opens nothing — so a link recognised here costs zero fetches and the
                 previous door's mirror is untouched. ONLY A PINNED LINK IS TAKEN: an unpinned
                 `#<token>` on a real hostname is genuinely ambiguous (that is also a
                 self-hosted origin's shape), so it is left to this door; `k1.` is unambiguous. */
              const pasted = hostLinkProblem(typedOrigin);
              if (pasted.link !== null && pasted.link.pin !== null) {
                setProblem(null);
                setSuggestion(null);
                setProvedLink(null);
                setMismatch(false);
                setStep("host");
                return;
              }
              setBusy(true);
              setProblem(null);
              setSuggestion(null);
              void configureSelfHostDoor(typedOrigin, address)
                .then((step) => {
                  if (step.problem !== null) {
                    setProblem(step.problem);
                    setSuggestion(step.suggestion ?? null);
                    return;
                  }
                  /* The NORMALIZED base, never the raw typing. It is what the engine was actually
                     configured with, and it is what the card then shows — so "Reached …" names the
                     thing that answered rather than the characters somebody entered. */
                  setReachedServer(selfHostBase(typedOrigin));
                })
                .finally(() => setBusy(false));
            }}
            onSubmit={(address, password, totp) =>
              attempt(() => signInToSelfHost(address, password, totp))
            }
          />
        ) : step === "takeover" ? (
          <TakeoverCard
            roster={roster}
            host={host ?? null}
            onContinue={() => setStep("local")}
            onCancel={onCancel}
          />
        ) : step === "host" ? (
          <HostDoor
            busy={busy}
            problem={problem}
            proved={provedLink}
            onBack={() => {
              setProblem(null);
              setProvedLink(null);
              setMismatch(false);
              setStep("doors");
            }}
            onCancel={onCancel}
            /* THE LINK STEP. Not routed through `attempt`, for `ServerDoor.onProve`'s reason: it
               does not end in a `DoorResult` and must not call `onEntered`. Proving that a
               computer is there is not being paired with it, and a window that closed the door
               here would leave somebody looking at a mail client with no session behind it. */
            onProve={(text) => {
              if (busy) return;
              const step = hostLinkProblem(text);
              /* THE WINDOW'S OWN THREE REFUSALS FIRST, and they cost no connection at all: a
                 malformed link, a cleartext origin and an unpinned address are facts about the
                 link, and dialling to learn them would mean opening the connection this app has
                 already decided not to use. */
              if (step.refusal !== null || step.link === null) {
                setProblem(
                  step.refusal === null
                    ? DOOR_COPY.hostLinkShape
                    : sentenceForKind(step.refusal, step.host ?? "") ?? DOOR_COPY.hostLinkShape,
                );
                return;
              }
              const link = step.link;
              const label = step.host ?? link.origin;
              setBusy(true);
              setProblem(null);
              /* A NEW LINK RETIRES THE VERB. Start over discards mail, and a control justified by
                 one refusal must never survive into a check against a different computer. */
              setMismatch(false);
              void proveHostLink(link)
                .then((proof) => {
                  if (proof.refusal !== null) {
                    setProblem(refusalSentence(proof.refusal, label));
                    return;
                  }
                  /* THE BASE THE ENGINE MEASURED travels with the proved link, so the configure
                     below uses the shape that actually answered rather than recomposing one. */
                  setProvedLink({ ...step, base: proof.base ?? link.origin });
                })
                .finally(() => setBusy(false));
            }}
            mismatch={mismatch}
            onSubmit={(startOver) => {
              const proved = provedLink;
              if (!proved?.link) return;
              const link = proved.link;
              const label = proved.host ?? link.origin;
              void attempt(async () => {
                /* PAIR AGAIN IS NOT CHOOSING THE DOOR AGAIN. The door is already chosen and the
                   mirror is still here; reconfiguring would replace the engine and give
                   `enforceMirrorOwner` grounds to discard the copy the pane promises is kept.
                   The same distinction `cloudAction` draws for the hosted door.

                   A START OVER always takes the in-place path, whichever door this card was
                   opened from: it is repairing a mismatch against a computer this install is
                   already configured for, and reconfiguring would replace the engine underneath
                   the very redeem that is staging the discard. */
                const result = startOver || cloudAction === "signIn"
                  ? await pairAgainWithHost(link, startOver)
                  : await enterHostDoor(link, proved.base);

                /* THE PAIRING WORKED AND THE APP MUST BE REOPENED. Not a refusal and not an
                   ordinary success: a session exists and may not be used until the next launch
                   has performed the staged discard. `onEntered` still runs — the gate re-reads
                   `/health`, sees `restartRequired`, and draws the relaunch card. */
                if (result.restartRequired) {
                  setMismatch(false);
                  return { status: result.status, problem: null };
                }

                /* THE REDEEM'S REFUSAL BECOMES A SENTENCE HERE, for the reason the map above
                   gives: `doors.ts` may not read this window's catalogue, so it hands back the
                   kind and the card is what has the words. */
                if (result.refusal === null) {
                  setMismatch(false);
                  return result;
                }
                /* …and the ONE refusal that has a way out arms the verb. Remembered rather than
                   acted on: the discard is the person's press, never this window's inference. */
                setMismatch(result.refusal.kind === "pair_account_mismatch");
                return { ...result, problem: refusalSentence(result.refusal, label) };
              });
            }}
          />
        ) : step === "local" ? (
          <LocalDoor
            busy={busy}
            problem={problem}
            suggestion={suggestion}
            onBack={() => { setProblem(null); setSuggestion(null); setStep("doors"); }}
            onCancel={onCancel}
            onSubmit={(fields) =>
              attempt(async () =>
                /* THE STANDING ENGINE IS READ HERE, AT THE SUBMIT, AND THE ORDER OF THE DOOR
                   DEPENDS ON IT. Reconfiguring an install that already holds a sealed password
                   has to prove the NEW password before the shell is asked to commit the new
                   settings — otherwise the replacement engine dials the new server with the old
                   secret, and a refusal leaves the settings and the credential naming different
                   hosts. `enterLocalDoor` cannot read this for itself: its own first act on the
                   first-connect arm replaces the engine, which destroys the fact. Read at the
                   submit rather than captured at render, because this form is opened over a
                   running install from Settings and may sit on screen for minutes. */
                enterLocalDoor(fields, providerById(fields.providerId), await standingEngine()),
              )
            }
          />
        ) : (
          <CloudDoor
            busy={busy}
            problem={problem}
            onBack={() => { setProblem(null); setStep("doors"); }}
            onCancel={onCancel}
            signInOnly={cloudAction === "signIn"}
            onSubmit={(address, password, totp) =>
              attempt(() =>
                cloudAction === "signIn" && !mustSwitch
                  ? signInToCloud(address, password, totp)
                  : enterCloudDoor(address, password, totp),
              )
            }
            onSubmitCode={(address, code) =>
              attempt(() =>
                /* `handedOff` still wins: a handoff started under `mustSwitch` has ALREADY taken
                   the configure path (see `startHandoff`), so reconfiguring again here would
                   discard the verifier the code it is about to send is bound to. The switch only
                   redirects a code that arrives with no handoff behind it — a retype from a
                   browser — which is the case that has had no configure yet. */
                handedOff !== null || (cloudAction === "signIn" && !mustSwitch)
                  ? signInToCloudWithCode(handedOff ?? address, code)
                  : enterCloudDoorWithCode(address, code),
              )
            }
            onOpenBrowser={(address) => void startHandoff(address)}
          />
        )}
      </div>
    </div>
  );
}

/**
 * THE THREE DOORS, as three things rather than as a dropdown. Each names a DIFFERENT MACHINE
 * as the thing that organizes — this computer, a server the person runs, or ours. THE ORDER
 * IS "WHO HOLDS IT", NEAREST FIRST: a product whose claim is that you can leave
 * should not lead with the door hardest to leave from. Two load-bearing claims: "Nothing is
 * sent anywhere." on the local door is structurally true (CSP `connect-src 'none'`,
 * `offline-guard.ts`, an engine dialling only the user's own IMAP server), pinned in
 * `desktop-door-chooser.test.tsx`; the travel sentence under all three states the invariant —
 * rules and settings live on the MAILBOX (`ohmail/_meta`; `local-profile-import.ts` reads them).
 */
function Doors({ onPick, onCancel }: { onPick: (step: Step) => void; onCancel?: () => void }) {
  return (
    <>
      <h1>{DOOR_COPY.chooserTitle}</h1>
      <div className="door-grid" role="group" aria-label={DOOR_COPY.chooserGroupAria}>
        {/* Focused on mount so a keyboard reaches the choice without tabbing through the chrome
            above it. Native buttons: Tab moves between the three, Enter and Space open one, and
            nothing here claims a chord the shared keymap has spoken for. */}
        <button type="button" className="door-tile" autoFocus onClick={() => onPick("local")}>
          <span className="door-name">{DOOR_COPY.doorLocalName(machineWord())}</span>
          <span className="door-say">{DOOR_COPY.doorLocalSay}</span>
        </button>
        {/* SECOND, and the order is still "nearest first": this computer, then another of yours,
            then a server you run, then ours. A paired desktop is nearer than a server — it is a
            machine in the same house — and it is the door somebody arrives at holding a link. */}
        <button type="button" className="door-tile" onClick={() => onPick("host")}>
          <span className="door-name">{DOOR_COPY.doorHostName}</span>
          <span className="door-say">{DOOR_COPY.doorHostSay(machineWord())}</span>
        </button>
        <button type="button" className="door-tile" onClick={() => onPick("server")}>
          <span className="door-name">{DOOR_COPY.doorServerName}</span>
          <span className="door-say">
            <em>{DOOR_COPY.doorServerLead}</em> {DOOR_COPY.doorServerSay}
          </span>
        </button>
        <button type="button" className="door-tile" onClick={() => onPick("cloud")}>
          <span className="door-name">{DOOR_COPY.doorCloudName}</span>
          <span className="door-say">{DOOR_COPY.doorCloudSay}</span>
        </button>
      </div>
      <p className="door-travel">{DOOR_COPY.doorsTravel}</p>
      {onCancel ? (
        <div className="join-actions">
          <Button variant="ghost" onClick={onCancel}>{DOOR_COPY.cancel}</Button>
        </div>
      ) : null}
    </>
  );
}

/**
 * SETTING THIS MACHINE UP ON ITS OWN — step one: what it costs, and what the other computer
 * held. A STEP BEFORE THE FORM because the next screen reads as ordinary setup and is not:
 * pressing through it discards the copy of the mail on this machine, reads the mailbox again
 * from the server, and makes this computer the organizer. Stated first, ending with what
 * is true: nothing on the mail server changes until somebody agrees to organize. THE
 * ROSTER IS THE USEFUL HALF: which mailboxes the other computer organized exists only in the
 * copy about to be discarded, so it is captured before the door moves and shown as a LIST
 * (no servers in the mirror — nothing to pre-fill). A read that FAILED says so, never "nothing".
 */
function TakeoverCard({
  roster,
  host,
  onContinue,
  onCancel,
}: {
  roster: { address: string; id: string }[] | null | undefined;
  host: string | null;
  onContinue: () => void;
  onCancel?: () => void;
}) {
  const machine = machineWord();
  const named = host ?? DOOR_COPY.doorHostName;
  return (
    <>
      <h1>{DOOR_COPY.takeoverLabel(machine)}</h1>
      <p>{DOOR_COPY.takeoverLead(machine, named)}</p>

      <h2 className="join-subhead">{DOOR_COPY.takeoverRoster(named)}</h2>
      {roster === undefined ? (
        <p className="join-hint">{DOOR_COPY.hostChecking}</p>
      ) : roster === null ? (
        /* THE READ FAILED. Its own sentence, and it points at the way forward rather than at the
           failure: the server can still be entered by hand, which is the next screen anyway. */
        <p className="join-error">{DOOR_COPY.takeoverRosterUnknown(named)}</p>
      ) : (
        <>
          <ul className="join-roster">
            {roster.map((m) => (
              <li key={m.id}>{m.address}</li>
            ))}
          </ul>
          {/* ONLY WHEN THERE IS A REST. The next screen opens ONE mailbox, so a list of three says
              nothing about the other two unless this line does — and with one mailbox there is no
              "other" and the sentence would be about nothing. */}
          {roster.length > 1 ? (
            <p className="join-hint">{DOOR_COPY.takeoverRest(roster.length - 1)}</p>
          ) : null}
        </>
      )}

      <div className="join-actions">
        <Button variant="primary" onClick={onContinue}>{DOOR_COPY.serverContinue}</Button>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel}>{DOOR_COPY.cancel}</Button>
        ) : null}
      </div>
    </>
  );
}

/** Door one: the user's own mail server, opened from this machine. */
function LocalDoor({
  busy,
  problem,
  suggestion,
  onBack,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  problem: string | null;
  /** The host the last refusal named, or null. Offered as a press when there is a field for it. */
  suggestion: HostSuggestion | null;
  onBack: () => void;
  onCancel?: () => void;
  onSubmit: (fields: LocalDoorFields) => void;
}) {
  const [fields, setFields] = useState<LocalDoorFields>(EMPTY_LOCAL);
  const set = <K extends keyof LocalDoorFields>(key: K, value: LocalDoorFields[K]): void =>
    setFields((cur) => ({ ...cur, [key]: value }));

  const preset = useMemo(
    () => (fields.providerId ? providerById(fields.providerId) : null),
    [fields.providerId],
  );
  /* Hosts and ports are shown for the generic entry and hidden for the named ones. A named
     preset's host is a fact this app knows and the user does not have to; the "any other IMAP
     mailbox" entry is the one where nobody but them can supply it. */
  const manual = preset?.manual === true;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(fields);
      }}
    >
      <h1>{DOOR_COPY.localTitle}</h1>
      <p>{DOOR_COPY.localLead(machineWord())}</p>

      {/* ── THE REFUSAL, AND THE HOST IT NAMED ────────────────────────────────────────────────
          `onUse` is passed ONLY while the host fields are on screen. Behind a named provider the
          host is this app's own fact and there is no field to fill, so the sentence names the
          host (as it did before this control existed) and no control presses into nothing. */}
      <DoorProblem
        problem={problem}
        suggestion={suggestion}
        {...(manual
          ? {
              onUse: (offer: HostSuggestion) =>
                set(offer.transport === "smtp" ? "smtpHost" : "imapHost", offer.host),
            }
          : {})}
      />

      <ProviderPicker
        value={fields.providerId || null}
        onChange={(id) => {
          const chosen = providerById(id);
          setFields((cur) => ({
            ...cur,
            providerId: id,
            // The preset's own hosts, so the manual fields open pre-filled where there is
            // something to pre-fill — and, for the generic entry, which has nothing to
            // pre-fill with, whatever is already typed rather than two empty strings over it.
            // The previous choice decides whether the hosts in the form are the person's own
            // typing (keep) or a preset's (never carry into another provider's attempt).
            ...hostsFor(chosen, cur, cur.providerId ? providerById(cur.providerId) : null),
            imapPort: String(chosen.imap.port),
            smtpPort: String(chosen.smtp.port),
          }));
        }}
      />

      <label className="join-label" htmlFor="door-address">{DOOR_COPY.localAddress}</label>
      <input
        id="door-address"
        className="join-input"
        type="email"
        autoComplete="username"
        spellCheck={false}
        value={fields.address}
        onChange={(e) => set("address", e.target.value)}
      />

      <label className="join-label" htmlFor="door-password">{DOOR_COPY.localPassword}</label>
      <input
        id="door-password"
        className="join-input"
        type="password"
        autoComplete="current-password"
        value={fields.password}
        onChange={(e) => set("password", e.target.value)}
      />
      <p className="join-hint">{DOOR_COPY.localPasswordHint}</p>

      {manual ? (
        <>
          <label className="join-label" htmlFor="door-imap-host">{DOOR_COPY.localImapHost}</label>
          <input
            id="door-imap-host"
            className="join-input"
            spellCheck={false}
            value={fields.imapHost}
            onChange={(e) => set("imapHost", e.target.value)}
          />
          <label className="join-label" htmlFor="door-imap-port">{DOOR_COPY.localImapPort}</label>
          <input
            id="door-imap-port"
            className="join-input join-code"
            inputMode="numeric"
            value={fields.imapPort}
            onChange={(e) => set("imapPort", e.target.value)}
          />
          <label className="join-label" htmlFor="door-smtp-host">{DOOR_COPY.localSmtpHost}</label>
          <input
            id="door-smtp-host"
            className="join-input"
            spellCheck={false}
            value={fields.smtpHost}
            onChange={(e) => set("smtpHost", e.target.value)}
          />
          <label className="join-label" htmlFor="door-smtp-port">{DOOR_COPY.localSmtpPort}</label>
          <input
            id="door-smtp-port"
            className="join-input join-code"
            inputMode="numeric"
            value={fields.smtpPort}
            onChange={(e) => set("smtpPort", e.target.value)}
          />
          <label className="join-label" htmlFor="door-user">{DOOR_COPY.localUser}</label>
          <input
            id="door-user"
            className="join-input"
            spellCheck={false}
            autoComplete="off"
            value={fields.user}
            onChange={(e) => set("user", e.target.value)}
          />
        </>
      ) : null}

      <div className="join-actions">
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? DOOR_COPY.localOpening : DOOR_COPY.localOpen}
        </Button>
        <Button variant="ghost" type="button" onClick={onBack} disabled={busy}>
          {DOOR_COPY.back}
        </Button>
        {onCancel ? (
          <Button variant="ghost" type="button" onClick={onCancel} disabled={busy}>
            {DOOR_COPY.cancel}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/**
 * DOOR TWO: a server the person runs, mirrored onto this machine. TWO PHASES IN ONE CARD,
 * and the first is not a formality: the address is asked for and PROVED before anything asks
 * for a password. Everything that can go wrong with a self-hosted address goes wrong at that
 * step — a typo, a machine not running ohmail, a certificate from an unknown authority — and
 * each becomes a sentence about the ADDRESS, not about credentials; four fields at once is
 * how somebody concludes their password is wrong when their server is not at that name. The
 * proof costs a real `engine_configure` (`configureSelfHostDoor` says why). NO browser
 * handoff on this arm (`self-host.ts`): the password-and-code form is the whole door here.
 */
function ServerDoor({
  busy,
  problem,
  suggestion,
  reached,
  onBack,
  onCancel,
  onProve,
  onSubmit,
}: {
  busy: boolean;
  problem: string | null;
  /**
   * The host the last refusal named, or null.
   *
   * Rendered through the same component the standalone door uses and with NO `onUse`: this card
   * asks for one server address rather than a pair of transports, so there is no field a
   * transport-scoped host belongs in. It is passed anyway because the two doors read one refusal
   * through one reader, and a screen that dropped the value here is how the two would drift apart
   * again the next time the engine learns to name something.
   */
  suggestion: HostSuggestion | null;
  /** The server the address step proved, or null while it has not been proved yet. */
  reached: string | null;
  onBack: () => void;
  onCancel?: () => void;
  onProve: (origin: string, address: string) => void;
  onSubmit: (address: string, password: string, totp: string) => void;
}) {
  const [origin, setOrigin] = useState("");
  const [address, setAddress] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (reached === null) onProve(origin, address);
        else onSubmit(address, password, totp);
      }}
    >
      <h1>{DOOR_COPY.doorServerName}</h1>
      <p>
        {reached === null
          ? DOOR_COPY.serverAskLead
          : DOOR_COPY.serverSignInLead(machineWord())}
      </p>

      <DoorProblem problem={problem} suggestion={suggestion} />

      <label className="join-label" htmlFor="server-origin">{DOOR_COPY.serverOrigin}</label>
      {/* `type="text"` WITH `inputMode="url"`, and the pair is deliberate — this was `type="url"`
          and that was wrong twice over. A url-typed field is constraint-validated by the browser,
          which BLOCKS the submit and shows its own bubble ("Please enter a URL") in place of the
          sentence this door wrote, on exactly the inputs the sentence was written for. And its
          notion of a URL requires a scheme, so it refuses `ohmail.example.com` — the bare host this
          door goes out of its way to accept and complete to `https://`. The mode gives the same
          keyboard without either. Caught by the typo case below, which could not submit at all. */}
      <input
        id="server-origin"
        className="join-input"
        type="text"
        inputMode="url"
        spellCheck={false}
        autoComplete="off"
        placeholder={DOOR_COPY.serverOriginPlaceholder}
        /* LOCKED once the server has answered. The engine is now configured for this address and
           the sign-in below goes to it; a field that could still be edited would let somebody type
           one server, prove it, then sign in believing they had reached another. Changing it is
           "Use a different server", which starts the address step again. */
        readOnly={reached !== null}
        value={origin}
        onChange={(e) => setOrigin(e.target.value)}
      />

      {reached === null ? (
        <>
          <label className="join-label" htmlFor="server-address">{DOOR_COPY.serverAddress}</label>
          {/* Text, not `type="email"`, for the reason the address field above is text: this door's
              own refusals are the ones worth reading, and a constraint-validated field preempts
              them with a bubble. `inputMode` and `autoComplete` carry the keyboard and the
              autofill, which is what the type was doing that was worth keeping. */}
          <input
            id="server-address"
            className="join-input"
            type="text"
            inputMode="email"
            autoComplete="username"
            spellCheck={false}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
          {/* SAID BEFORE THE REFUSAL, not only after it. A self-hoster on a private name is
              GOING to hit this — their stack issues its own certificates, correctly — and a
              person who has already read what to do recognises the refusal instead of
              debugging it. The path is `cloud-origin.ts`'s constant, so the hint and the
              engine's own sentence cannot name two different files. */}
          {/* TWO KEYS AROUND ONE CONSTANT. The file name is rendered as code and is not a word,
              so it is not a placeholder in a sentence — the sentence is split around it, and each
              half is translated on its own. */}
          <p className="join-hint">
            {DOOR_COPY.serverCaHintBefore}{" "}
            <code>{OPERATOR_CA_FILE}</code> {DOOR_COPY.serverCaHintAfter}
          </p>
        </>
      ) : (
        <>
          <p className="join-hint">{DOOR_COPY.serverReached(reached, address)}</p>
          <label className="join-label" htmlFor="server-password">{DOOR_COPY.password}</label>
          <input
            id="server-password"
            className="join-input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <label className="join-label" htmlFor="server-totp">{DOOR_COPY.totpLabel}</label>
          <input
            id="server-totp"
            className="join-input join-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={totp}
            onChange={(e) => setTotp(e.target.value)}
          />
        </>
      )}

      <div className="join-actions">
        <Button variant="primary" type="submit" disabled={busy}>
          {busy
            ? reached === null ? DOOR_COPY.serverChecking : DOOR_COPY.signingIn
            : reached === null ? DOOR_COPY.serverContinue : DOOR_COPY.signIn}
        </Button>
        <Button variant="ghost" type="button" onClick={onBack} disabled={busy}>
          {DOOR_COPY.back}
        </Button>
        {onCancel ? (
          <Button variant="ghost" type="button" onClick={onCancel} disabled={busy}>
            {DOOR_COPY.cancel}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/**
 * DOOR TWO: ANOTHER COMPUTER OF THE PERSON'S OWN, over their network or Tailscale. TWO
 * PHASES, `ServerDoor`'s shape — the link is PROVED before the token is spent: a pairing
 * link works ONCE. PHASE B SHOWS THE KEY: twelve characters of the fingerprint,
 * mono, beside where to find the same twelve on the other computer — the only thing between
 * "we reached something" and "we reached the machine you meant" where no authority vouches;
 * forty-three characters would be a ceremony nobody compares. A Tailscale origin carries no
 * pin — that sentence names the certificate instead. NO "paired" screen afterwards:
 * `AppShell` mounts and the Ohbox filling is the confirmation.
 */
function HostDoor({
  busy,
  problem,
  proved,
  mismatch,
  onBack,
  onCancel,
  onProve,
  onSubmit,
}: {
  busy: boolean;
  problem: string | null;
  /** The link the first step proved, or null while it has not been proved yet. */
  proved: (HostLinkStep & { base: string }) | null;
  /**
   * The last redeem was refused because this machine holds mail from a DIFFERENT account on that
   * computer — so there is a way out, and it costs that mail. Offering the verb is the whole of
   * what this flag does; pressing it is the person's.
   */
  mismatch: boolean;
  onBack: () => void;
  onCancel?: () => void;
  onProve: (text: string) => void;
  /** `startOver` is true only from the Start over control — never from the refusal itself. */
  onSubmit: (startOver: boolean) => void;
}) {
  const [text, setText] = useState("");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (proved === null) onProve(text);
        else onSubmit(false);
      }}
    >
      <h1>{DOOR_COPY.doorHostName}</h1>
      <p>{proved === null ? DOOR_COPY.hostAskLead : DOOR_COPY.hostPairLead(machineWord())}</p>

      {problem ? <p className="join-error">{problem}</p> : null}

      <label className="join-label" htmlFor="host-link">{DOOR_COPY.hostLink}</label>
      {/* `type="text"`, for `ServerDoor`'s reason exactly: a url-typed field is
          constraint-validated by the browser, which BLOCKS the submit and replaces this card's own
          sentence with a bubble — on precisely the inputs the sentences were written for. */}
      <input
        id="host-link"
        className="join-input join-code"
        type="text"
        spellCheck={false}
        autoComplete="off"
        placeholder={DOOR_COPY.hostLinkPlaceholder}
        /* LOCKED once the link has been proved. What is on screen from that moment — the origin,
           the key — describes THAT link, and a field that could still be edited would let somebody
           read one computer's fingerprint while pairing with another. Changing it is Back. */
        readOnly={proved !== null}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />

      {proved === null ? (
        <p className="join-hint">{DOOR_COPY.hostLinkHint}</p>
      ) : (
        <p className="join-hint">
          {DOOR_COPY.hostReached(proved.host ?? "")}{" "}
          {proved.link?.pin
            ? (
              <>
                {DOOR_COPY.hostReachedLanBefore}{" "}
                <span className="host-key">{shortPin(proved.link.pin)}</span>{" "}
                {DOOR_COPY.hostReachedLanAfter}
              </>
            )
            : DOOR_COPY.hostReachedTs(machineWord())}
        </p>
      )}

      <div className="join-actions">
        <Button variant="primary" type="submit" disabled={busy}>
          {busy
            ? proved === null ? DOOR_COPY.hostChecking : DOOR_COPY.hostPairing
            : proved === null ? DOOR_COPY.hostCheck : DOOR_COPY.hostPair}
        </Button>
        {/* ── THE WAY OUT OF THE ONE REFUSAL THAT HAS ONE ──────────────────────────────────
            Offered only after that refusal, and it is a GHOST rather than a second primary: it
            discards the mail this machine holds for the other account, so it must not read as
            the obvious next press. The sentence above it has already said what it costs and that
            a fresh link is needed; this is only the press.

            `type="button"`, so the form's own submit — Pair, the ordinary path — cannot be what
            fires it. That distinction is the whole safety of this control. */}
        {mismatch ? (
          <Button
            variant="ghost"
            type="button"
            disabled={busy}
            onClick={() => onSubmit(true)}
          >
            {busy ? DOOR_COPY.hostStartingOver : DOOR_COPY.hostStartOver}
          </Button>
        ) : null}
        <Button variant="ghost" type="button" onClick={onBack} disabled={busy}>
          {DOOR_COPY.back}
        </Button>
        {onCancel ? (
          <Button variant="ghost" type="button" onClick={onCancel} disabled={busy}>
            {DOOR_COPY.cancel}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/**
 * A REFUSAL KIND, AS THE SENTENCE THE READER'S LANGUAGE HAS FOR IT. The map is HERE and the
 * decision in `doors.ts` because that module is reachable from the SERVED host client's
 * import graph and `desktopDoor` is window-only — a catalogue read there ships the namespace
 * to a phone or draws raw dotted keys (`desktop-messages.test.ts` caught exactly that). AN
 * UNKNOWN KIND IS NOT SILENCE: the eight kinds the engine can name get a translated
 * sentence; anything else gets the ENGINE's own words — the `guideKey` bargain — which
 * matters because the update flow makes "the engine is newer than this window" ordinary. The
 * last resort is the status line: "(409)" is a worse sentence, and better than a blank card.
 */
function refusalSentence(refusal: HostRefusal, host: string): string {
  const known = sentenceForKind(refusal.kind, host);
  if (known !== null) return known;
  if (refusal.message) return refusal.message;
  /* THE LAST RESORT IS THE STATUS LINE. A refusal with no kind, no message and no throw behind
     it still has to say something, and "(409)" is a worse sentence than the others and a better
     one than a blank card. */
  return DOOR_COPY.errorRefused(String(refusal.status ?? ""));
}

/** The window's own three refusals plus the engine's eight, as one table. */
export function sentenceForKind(kind: HostLinkRefusal | string, host: string): string | null {
  switch (kind) {
    case "missing": return DOOR_COPY.hostLinkMissing;
    case "shape": return DOOR_COPY.hostLinkShape;
    case "cleartext": return DOOR_COPY.hostRefuseCleartext;
    case "no_pin": return DOOR_COPY.hostRefuseNoPin;
    case "pin_mismatch": return DOOR_COPY.hostRefusePinChanged;
    case "not_ohmail": return DOOR_COPY.hostRefuseNotOhmail(host);
    case "local": return DOOR_COPY.hostRefuseNotServing(host);
    case "managed": return DOOR_COPY.hostRefuseManaged;
    case "selfhost": return DOOR_COPY.hostRefuseServer(host);
    case "pairing_invalid": return DOOR_COPY.hostRefuseSpent;
    case "restart_required": return DOOR_COPY.hostRefuseRestartFirst(host);
    case "pair_account_mismatch": return DOOR_COPY.hostRefuseAccountMismatch(host);
    case "unreachable": return DOOR_COPY.hostRefuseUnreachable(host);
    /* NOT A DEFAULT SENTENCE. `null` is what sends the caller to the engine's own words; a
       catchall here would replace a true, specific refusal with a vague one. */
    default: return null;
  }
}

/**
 * Re-exported from `@trafficflow/core/pair-link`, where it moved when the PHONE grew the third
 * end of the comparison. It was written here; the rule now has to be one function across three
 * graphs (this window, the host's Devices pane, the phone's pairing confirmation), and the
 * desktop's own copy — "a device pairing over your network shows these characters before it
 * pairs" — is what makes that a contract rather than a tidiness. `DesktopDevices.tsx` imports it
 * from this module, so the name stays here and decides nothing.
 */
export { shortPin };

/**
 * Door three: a hosted ohmail account, mirrored onto this machine. TWO WAYS IN, the password
 * one first: the browser path needs a browser signed in to the account, which is not always
 * where somebody stands (a fresh machine, a first install) — offering it as the default puts
 * an extra step in the common case. The browser path hands the page a commitment the mail
 * engine on this machine invented, so the code the page mints is spendable only by this
 * install — which is what makes it safe to hand back over `ohmail://`, a scheme any program
 * may claim and which authenticates nobody. THE FIELD STAYS: a scheme handler can be missing
 * or silent, and the page shows the code as well as the button — both paths reach one request.
 */
function CloudDoor({
  busy,
  problem,
  signInOnly,
  onBack,
  onCancel,
  onSubmit,
  onSubmitCode,
  onOpenBrowser,
}: {
  busy: boolean;
  problem: string | null;
  /** The door is already chosen; this is only the session coming back. */
  signInOnly?: boolean;
  onBack: () => void;
  onCancel?: () => void;
  onSubmit: (address: string, password: string, totp: string) => void;
  onSubmitCode: (address: string, code: string) => void;
  onOpenBrowser: (address: string) => void;
}) {
  const [address, setAddress] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [handoff, setHandoff] = useState("");
  const [viaBrowser, setViaBrowser] = useState(false);

  /**
   * WHAT AN ACTIVATION NEEDS THAT AN ACTIVATION CANNOT CARRY: the address. The deep link
   * carries the code and nothing else — deliberately, since a link is composed by whatever
   * opened it; the address is this install's own answer, typed above, read through a ref so
   * the one live handler sees what is on screen now. `onSubmitCode` is in here for a sharper
   * reason than convenience: the parent's version decides whether the code goes to the
   * sign-in that reconfigures the engine or the one that does not, and a handler holding the
   * mounted-time version would take the first, restart the engine and discard the verifier
   * the code is bound to — the handoff fails with nothing on screen saying why.
   */
  const live = useRef({ address, viaBrowser, onSubmitCode });
  live.current = { address, viaBrowser, onSubmitCode };

  /**
   * ANSWER THE SCHEME while this screen is the one on show. Registered once and cleared on
   * unmount — `native.ts` keeps a single shell-side listener for the life of the window and
   * swaps the handler behind it, because taking a listener off would cost a second core
   * permission this window is deliberately not granted. The code is put IN THE FIELD as well
   * as submitted: somebody who pressed a button in another application should see what
   * arrived, and if the sign-in is refused the value is already where they can retry with it.
   */
  useEffect(() => {
    const answer = (code: string): void => {
      /* Only on the branch that asked for it. A person who switched back to the password form has
         a password half-typed in front of them, and submitting a sign-in under them would be this
         screen acting on an event from another application. */
      if (!live.current.viaBrowser) return;
      setHandoff(code);
      live.current.onSubmitCode(live.current.address, code);
    };
    void onLinkCode(answer);
    return () => offLinkCode(answer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- registered once; state is read
    // through `live` so the handler cannot go stale, and re-registering per render would swap the
    // shell's handler on every keystroke.
  }, []);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (viaBrowser) onSubmitCode(address, handoff);
        else onSubmit(address, password, totp);
      }}
    >
      <h1>{DOOR_COPY.cloudTitle}</h1>
      <p>{signInOnly ? DOOR_COPY.cloudLeadSignIn(machineWord()) : DOOR_COPY.cloudLead}</p>

      {problem ? <p className="join-error">{problem}</p> : null}

      <label className="join-label" htmlFor="cloud-address">{DOOR_COPY.cloudAddress}</label>
      <input
        id="cloud-address"
        className="join-input"
        type="email"
        autoComplete="username"
        spellCheck={false}
        value={address}
        onChange={(e) => setAddress(e.target.value)}
      />

      {viaBrowser ? (
        <>
          <p className="join-hint">{DOOR_COPY.cloudBrowserHint}</p>
          <div className="join-actions">
            <Button type="button" onClick={() => onOpenBrowser(address)} disabled={busy}>
              {DOOR_COPY.cloudOpenBrowser}
            </Button>
          </div>

          {/* THE FALLBACK STAYS ON SCREEN. See this component's header: a scheme handler can be
              missing or claimed by something that does nothing visible, and the page shows the
              code beside the button for exactly this. Nothing about typing it in has changed. */}
          <label className="join-label" htmlFor="cloud-handoff">
            {DOOR_COPY.cloudHandoffLabel}
          </label>
          <input
            id="cloud-handoff"
            className="join-input join-code"
            /* NOT `one-time-code`: that is the authenticator field's autofill and offering an
               SMS or TOTP value here is a suggestion that cannot be right. */
            autoComplete="off"
            spellCheck={false}
            value={handoff}
            onChange={(e) => setHandoff(e.target.value)}
          />
          <p className="join-hint">{DOOR_COPY.cloudHandoffHint}</p>
        </>
      ) : (
        <>
          <label className="join-label" htmlFor="cloud-password">{DOOR_COPY.password}</label>
          <input
            id="cloud-password"
            className="join-input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          <label className="join-label" htmlFor="cloud-totp">{DOOR_COPY.totpLabel}</label>
          <input
            id="cloud-totp"
            className="join-input join-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={totp}
            onChange={(e) => setTotp(e.target.value)}
          />
        </>
      )}

      <div className="join-actions">
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? DOOR_COPY.signingIn : DOOR_COPY.signIn}
        </Button>
        {/* The switch CLEARS the fields of the form being left. Otherwise a password typed and
            then abandoned sits in this component's state for as long as the window is open, and
            the whole argument for the browser path is that it never holds one. */}
        <Button
          variant="ghost"
          type="button"
          disabled={busy}
          onClick={() => {
            setPassword("");
            setTotp("");
            setHandoff("");
            setViaBrowser((v) => !v);
          }}
        >
          {viaBrowser ? DOOR_COPY.cloudUsePassword : DOOR_COPY.cloudUseBrowser}
        </Button>
        <Button variant="ghost" type="button" onClick={onBack} disabled={busy}>
          {DOOR_COPY.back}
        </Button>
        {onCancel ? (
          <Button variant="ghost" type="button" onClick={onCancel} disabled={busy}>
            {DOOR_COPY.cancel}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
