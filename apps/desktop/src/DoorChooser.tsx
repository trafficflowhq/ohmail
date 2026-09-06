/**
 * THE FIRST SCREEN A FRESH INSTALL SHOWS — which mailbox is this?
 *
 * ── IT IS A REACT SCREEN, NOT A NATIVE ONE ──────────────────────────────────────────────────
 *
 * Every pixel of setup belongs to the frontend. The shell owns the process, the keystore and the
 * settings file, and it owns no user interface at all beyond the menu bar — so onboarding is the
 * same React app the mail is, built from the same design system, and there is no second
 * look-and-feel to keep in step. The alternative — a native window asking for a mail server —
 * would be the one screen in the product that could not be restyled with the rest of it.
 *
 * ── AND IT IS HONEST ABOUT FAILING ──────────────────────────────────────────────────────────
 *
 * A rejected password renders beside the fields, in the card the person is already looking at,
 * and the words are the mail server's or the engine's rather than a category. Nothing here ever
 * falls back to showing sample mail: an install that could not be configured says so and stays
 * on this screen, because a window full of somebody else's invented correspondence is a worse
 * answer to "it did not work" than a sentence is.
 *
 * ── THE COPY IS IN THE CATALOGUE, UNDER A NAMESPACE OF THIS WINDOW'S OWN ────────────────────
 *
 * This paragraph used to argue the opposite — that these screens exist only inside this app, in
 * one language, so their words belonged in the file. The second half was the mistake: the app
 * ships in two languages, and "one language" described the door rather than the product. A German
 * install opened on an English door and then went on in German, which is the one impression a
 * setup screen cannot afford to give.
 *
 * So the words are `desktopDoor` in `messages/{en,de}.json`, read through `DOOR_COPY`
 * (`door-copy.ts`), and the vocabulary argument survives intact: `desktopDoor` is the window's
 * own namespace, not a corner of `settings`, and the served host client never carries it. The
 * machine's own word still comes from `platform.ts` — a fact about the build, one per platform
 * this ships to — and is now translated as well, because "computer" is an ordinary noun and only
 * two of the three are proper ones. The provider table this renders is the shared one, so the
 * sentences that matter most (what an app password is, and which providers actually work) are
 * still written down exactly once.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@ohmail/ui";

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
  proveHostLink,
  signInToCloud,
  signInToCloudWithCode,
  standingEngine,
  type DoorResult,
  type HostLinkRefusal,
  type HostLinkStep,
  type HostRefusal,
  type LocalDoorFields,
} from "./doors.js";
import {
  OPERATOR_CA_FILE,
  configureSelfHostDoor,
  selfHostBase,
  signInToSelfHost,
} from "./self-host.js";
import { DOOR_COPY, machineWord } from "./door-copy.js";
import { offLinkCode, onLinkCode, openWeb } from "./native.js";

/**
 * Which card is on screen. `doors` is where a fresh install starts.
 *
 * `server` is the self-hosted arm, and it is a step of its own rather than a flag on `cloud`
 * because it asks a question `cloud` does not: which server. Everything after that question is the
 * same engine, the same sign-in and the same mirror — see `self-host.ts`.
 */
type Step = "doors" | "local" | "host" | "server" | "cloud";

export function DoorChooser({
  onEntered,
  /** Where the chooser opens. The Settings pane sends somebody straight to one door. */
  start = "doors",
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
  onCancel?: () => void;
}) {
  const [step, setStep] = useState<Step>(start);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /**
   * THE ADDRESS A BROWSER HANDOFF WAS STARTED FOR, or null when none has been.
   *
   * Two jobs, and the first one is not a nicety. It selects which sign-in a code goes to:
   * `enterCloudDoorWithCode` begins with `engine_configure`, which REPLACES the engine — and the
   * verifier the whole handoff rests on lives in that process's memory. Reconfiguring after the
   * commitment has been published throws it away, and the account then answers a perfectly good
   * code with the same sentence it gives an expired one, because telling those apart is exactly
   * what it refuses to do. So once a handoff has started, both the deep link AND a retyped code
   * take the sign-in that does not touch the engine's lifetime.
   *
   * It holds the ADDRESS rather than a flag because the engine is now configured for that address
   * and nothing afterwards will reconfigure it. Editing the field once the browser has been sent
   * off must not quietly sign a session in against a mailbox this install is not mirroring; the
   * value the handoff was started with is the one that stays true.
   */
  const [handedOff, setHandedOff] = useState<string | null>(null);

  /**
   * THE ENGINE REFUSED A SIGN-IN BECAUSE THIS INSTALL MIRRORS A DIFFERENT ACCOUNT.
   *
   * The same kind of remembered fact as `handedOff` above, doing the same kind of job: it selects
   * which sign-in the NEXT submit takes. A door that is already chosen signs in with one request
   * and deliberately does not touch the engine's lifetime — which is exactly why that request can
   * never be the one that switches accounts. The engine will not activate a session over another
   * account's database (it would be that account's mail in this window), and it cannot discard that
   * database either, because by then it is open. The one code path that can is the door CONFIGURE:
   * it replaces the engine, and the replacement throws a foreign mirror away before it opens
   * anything. So this flips the form onto that path.
   *
   * A BOOLEAN AND NOT AN ADDRESS, unlike `handedOff` — the address to use is whatever is in the
   * field, because switching accounts is precisely the case where the field is the true thing and
   * the configured door is the stale one. It is never cleared: taking the configure path with the
   * install's own address again costs a restart and discards nothing, so the worst case of leaving
   * it set is a few seconds, and the worst case of clearing it too eagerly is a person stuck on a
   * refusal with no way through.
   */
  const [mustSwitch, setMustSwitch] = useState(false);

  /**
   * THE SELF-HOSTED SERVER THIS INSTALL HAS BEEN POINTED AT AND PROVED, or null.
   *
   * The same kind of remembered fact as `handedOff`: it selects what the next submit IS. Null means
   * the self-hosted card is still asking for an address, and its submit configures the engine and
   * probes. Set means the engine is configured for that base and serving, and the submit is a
   * sign-in — the identical request the hosted door makes, because from the engine's side there is
   * no difference between the two.
   *
   * It holds the BASE rather than a flag for `handedOff`'s reason: what was proved is the thing to
   * report and the thing to sign in against, and a boolean would let a later edit of the field
   * quietly change which server the sentence on screen was describing. The field is read-only from
   * the moment this is set, so the two can never disagree.
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
  const [provedLink, setProvedLink] = useState<HostLinkStep | null>(null);

  /* One attempt at a time, and the result travels up whole. A door attempt restarts the engine
     and can take tens of seconds on a first run, so a second press while the first is in flight
     would reconfigure underneath it — the shell would stop an engine that was still starting. */
  const attempt = async (run: () => Promise<DoorResult>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await run();
      setProblem(result.problem);
      if (result.switchAccount) setMustSwitch(true);
      if (!result.problem) onEntered(result);
    } finally {
      setBusy(false);
    }
  };

  /**
   * START THE BROWSER HANDOFF — configure the door, mint the commitment, open the page.
   *
   * Three things in one press, and they have to be in this order: the engine must exist before it
   * can invent a verifier, and the verifier must exist before the page is opened, or the page mints
   * a code nothing on this machine can spend. `beginBrowserSignIn` owns the ordering; this owns
   * what the person sees while it happens.
   *
   * A refusal from the shell is reported here WITH the address, because somebody who cannot be sent
   * to the page can still walk to it — and the retype field is still on screen underneath.
   */
  const startHandoff = async (address: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
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
            reached={reachedServer}
            onBack={() => { setProblem(null); setReachedServer(null); setStep("doors"); }}
            onCancel={onCancel}
            /* THE ADDRESS STEP. Not routed through `attempt`, because it does not end in a
               `DoorResult` and must not call `onEntered`: proving a server is reachable is not
               being signed in to it, and a window that closed the door here would leave somebody
               looking at a mail client with no session and nothing explaining why. */
            onProve={(typedOrigin, address) => {
              if (busy) return;
              setBusy(true);
              setProblem(null);
              void configureSelfHostDoor(typedOrigin, address)
                .then((step) => {
                  if (step.problem !== null) {
                    setProblem(step.problem);
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
        ) : step === "host" ? (
          <HostDoor
            busy={busy}
            problem={problem}
            proved={provedLink}
            onBack={() => { setProblem(null); setProvedLink(null); setStep("doors"); }}
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
              void proveHostLink(link)
                .then((refusal) => {
                  if (refusal !== null) {
                    setProblem(refusalSentence(refusal, label));
                    return;
                  }
                  setProvedLink(step);
                })
                .finally(() => setBusy(false));
            }}
            onSubmit={() => {
              const proved = provedLink;
              if (!proved?.link) return;
              const link = proved.link;
              const label = proved.host ?? link.origin;
              void attempt(async () => {
                const result = await enterHostDoor(link);
                /* THE REDEEM'S REFUSAL BECOMES A SENTENCE HERE, for the reason the map above
                   gives: `doors.ts` may not read this window's catalogue, so it hands back the
                   kind and the card is what has the words. */
                return result.refusal === null
                  ? result
                  : { ...result, problem: refusalSentence(result.refusal, label) };
              });
            }}
          />
        ) : step === "local" ? (
          <LocalDoor
            busy={busy}
            problem={problem}
            onBack={() => { setProblem(null); setStep("doors"); }}
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
 * THE THREE DOORS, as three things rather than as a dropdown.
 *
 * They are not variants of one setup. Each one names a DIFFERENT MACHINE as the thing that does the
 * organizing — this computer, a server the person runs, or ours — and that is the only question
 * this screen asks. Rendered as tiles for the reason the provider picker is: a choice between
 * recognisable things, with a factual line under each name saying what will actually happen.
 *
 * ── THE ORDER IS THE ANSWER TO "WHO HOLDS IT", NEAREST FIRST ──────────────────────────────────
 *
 * This computer, then a server you run, then ours. It is not a ranking by how much we would like
 * somebody to pick it, and putting the hosted service last is deliberate: the first two are the
 * ones a person can verify for themselves, and a product whose whole claim is that you can leave
 * should not lead with the door that is hardest to leave from.
 *
 * ── EVERY SENTENCE HERE IS A CLAIM, AND TWO OF THEM ARE LOAD-BEARING ──────────────────────────
 *
 *  · **"Nothing is sent anywhere."** on the local door. Structurally true rather than promised: the
 *    window's CSP is `connect-src 'none'`, `offline-guard.ts` replaces every browser API that could
 *    leave the process, and the engine on this door dials the user's own IMAP server and nothing
 *    else — `engine.ts`'s graph reaches no hosted client at all. Pinned in
 *    `desktop-door-chooser.test.tsx` against the fact that makes it true, so a change that made the
 *    local door talk to anything reddens the sentence rather than leaving it standing.
 *  · **The travel sentence** beneath all three. Also a fact about the code and not a promise about
 *    intentions: the rules and settings are written to the MAILBOX (`ohmail/_meta`, the travelling
 *    profile), which is what every door reads them back out of — `local-profile-import.ts` is the
 *    surface that asks about them on arrival. That is the same sentence the product's own invariant
 *    is written in: the IMAP mailbox is the master, never this app and never Cloud.
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

/** Door one: the user's own mail server, opened from this machine. */
function LocalDoor({
  busy,
  problem,
  onBack,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  problem: string | null;
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

      {problem ? <p className="join-error">{problem}</p> : null}

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
 * DOOR TWO: a server the person runs, mirrored onto this machine.
 *
 * ── TWO PHASES IN ONE CARD, AND THE FIRST ONE IS NOT A FORMALITY ──────────────────────────────
 *
 * The address is asked for and PROVED before anything asks for a password. Everything that can go
 * wrong with a self-hosted address goes wrong at that step — a typo, a machine that is not running
 * ohmail, a certificate signed by an authority nobody outside that network has heard of — and every
 * one of those becomes a sentence about the address rather than a sentence about credentials.
 * Asking for all four fields at once and finding out at the end is how somebody concludes their
 * password is wrong when their server is simply not at that name.
 *
 * The proof costs a real `engine_configure`; `configureSelfHostDoor` explains why that is not
 * avoidable from a window that cannot dial, and what a refusal leaves behind.
 *
 * ── WHAT THIS ARM DOES NOT HAVE ───────────────────────────────────────────────────────────────
 *
 * No browser handoff. The shell resolves `link-desktop` to an address it owns, and all of them are
 * ohmail.app's — see `self-host.ts`. The password-and-code form is the whole door here, and the
 * screen says nothing about a handoff rather than offering one that would go to the wrong place.
 */
function ServerDoor({
  busy,
  problem,
  reached,
  onBack,
  onCancel,
  onProve,
  onSubmit,
}: {
  busy: boolean;
  problem: string | null;
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

      {problem ? <p className="join-error">{problem}</p> : null}

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
 * DOOR TWO: ANOTHER COMPUTER OF THE PERSON'S OWN, reached over their network or their Tailscale.
 *
 * ── TWO PHASES IN ONE CARD, `ServerDoor`'s SHAPE ──────────────────────────────────────────────
 *
 * The link is PROVED before the token is spent, and the reason is sharper here than on the
 * self-hosted door: a pairing link works ONCE. Redeeming first and finding out afterwards that
 * the address was wrong, or that the key had changed, would consume the one thing the person
 * carried across from the other machine and leave them to go and make another.
 *
 * ── PHASE B SHOWS THE KEY, AND SHOWING IT IS THE WHOLE OF WHAT IT IS FOR ──────────────────────
 *
 * Twelve characters of the fingerprint, mono, beside the sentence saying where to find the same
 * twelve on the other computer. That comparison is the only thing standing between "we reached
 * something" and "we reached the machine you meant" on a network where no authority vouches for
 * anybody. The full forty-three are deliberately not shown: a credential-shaped string nobody
 * actually compares is a ceremony rather than a check.
 *
 * A TAILSCALE ORIGIN CARRIES NO PIN (the link's two forms), so there is no key line there and the
 * sentence says what did the checking instead — the certificate, which the platform verified.
 * Silence would read as a check that was skipped.
 *
 * ── AND THERE IS NO "PAIRED" SCREEN AFTERWARDS ────────────────────────────────────────────────
 *
 * The gate does what it does after every other door: the shell reports a session, `AppShell`
 * mounts, and the sync line says the first sync has not finished yet and then counts. The Ohbox
 * filling is the confirmation; an interstitial announcing something the next frame shows is a
 * sentence in the way.
 */
function HostDoor({
  busy,
  problem,
  proved,
  onBack,
  onCancel,
  onProve,
  onSubmit,
}: {
  busy: boolean;
  problem: string | null;
  /** The link the first step proved, or null while it has not been proved yet. */
  proved: HostLinkStep | null;
  onBack: () => void;
  onCancel?: () => void;
  onProve: (text: string) => void;
  onSubmit: () => void;
}) {
  const [text, setText] = useState("");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (proved === null) onProve(text);
        else onSubmit();
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
 * A REFUSAL KIND, AS THE SENTENCE THE READER'S LANGUAGE HAS FOR IT.
 *
 * ── WHY THE MAP IS HERE AND THE DECISION IS IN `doors.ts` ─────────────────────────────────────
 *
 * `doors.ts` is reachable from the SERVED host client's import graph, and `desktopDoor` is a
 * window-only namespace — so a catalogue read there ships the whole namespace to a phone loading
 * that client over the network, where every one of these surfaces would draw a raw dotted key.
 * `desktop-messages.test.ts` caught exactly that. This file is the window's alone, so the words
 * live here and the decision lives there.
 *
 * ── AND AN UNKNOWN KIND IS NOT SILENCE ────────────────────────────────────────────────────────
 *
 * The eight kinds the engine can name get a translated sentence; anything else gets the ENGINE's
 * own words, which are English and true. That is the `guideKey` bargain the Devices pane already
 * strikes, and it matters here because the desktop's update flow makes "the engine is newer than
 * this window" an ordinary state. Composing a catalogue key from an unrecognised code is what
 * throws inside a render; falling back to prose is what does not.
 *
 * The last resort is the status line. A refusal with no kind, no message and no throw behind it
 * still has to say something, and "(409)" is a worse sentence than the others and a better one
 * than a blank card.
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
    case "managed": return DOOR_COPY.hostRefuseManaged;
    case "selfhost": return DOOR_COPY.hostRefuseServer(host);
    case "pairing_invalid": return DOOR_COPY.hostRefuseSpent;
    case "unreachable": return DOOR_COPY.hostRefuseUnreachable(host);
    /* NOT A DEFAULT SENTENCE. `null` is what sends the caller to the engine's own words; a
       catchall here would replace a true, specific refusal with a vague one. */
    default: return null;
  }
}

/**
 * THE TWELVE CHARACTERS A PERSON ACTUALLY COMPARES — first six, an ellipsis, last six.
 *
 * The fingerprint is forty-three base64url characters. Shown whole it is a credential-shaped
 * string that nobody reads to the end, and a check nobody performs is worse than no check,
 * because it looks like one. Twelve is what fits in one glance across two screens, and the host's
 * own Devices pane shows exactly the same twelve from the same rule — the two ends of the
 * comparison have to be one function or the ceremony compares nothing.
 *
 * A value SHORTER than the twelve it would elide is returned whole rather than padded with an
 * ellipsis that hides nothing.
 */
export function shortPin(pin: string): string {
  return pin.length <= 13 ? pin : `${pin.slice(0, 6)}…${pin.slice(-6)}`;
}

/**
 * Door three: a hosted ohmail account, mirrored onto this machine.
 *
 * ── TWO WAYS IN, AND THE PASSWORD ONE IS STILL THE DEFAULT ──────────────────────────────────
 *
 * The form asks for a password and a six-digit code, which means typing a password into a native
 * window — the one place a person cannot check an address bar. So there is a second way: the
 * browser, where the account may already be signed in and where a password manager and a URL both
 * work, hands over a code that is worth a session for two minutes and once.
 *
 * The password form stays first because the browser path needs a browser signed in to the
 * account, and that is not always where somebody is standing — a fresh Mac, a borrowed machine,
 * a person who has just installed this and has never opened ohmail.app. Offering the alternative
 * as the default would make the common case the one with an extra step in it.
 *
 * ── AND THE BROWSER PATH NO LONGER ASKS ANYBODY TO COPY A CODE ──────────────────────────────
 *
 * Pressing "Open ohmail.app" now hands the browser a commitment the mail engine on this machine
 * invented, so the code that page mints is spendable only by this install. That is what makes it
 * safe for the page to hand the code straight back over the `ohmail://` scheme — a scheme any
 * program on the machine may claim, and one that authenticates nobody — and it is why the button
 * on the page can exist at all.
 *
 * THE FIELD STAYS. A scheme handler can be missing, claimed by something that does nothing
 * visible, or simply not fire, and a screen whose only way forward is a button in another
 * application is a dead end. The page shows the code as well as the button; this shows the field
 * as well as the explanation, and the two paths reach the same request.
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
   * WHAT AN ACTIVATION NEEDS THAT AN ACTIVATION CANNOT CARRY: the address.
   *
   * The deep link carries the code and nothing else — deliberately, since a link is composed by
   * whatever opened it. The address is this install's own answer to "which mailbox is this", typed
   * into the field above, and it is read through a ref so the one live handler always sees what is
   * on screen rather than what was on screen when it was registered.
   *
   * `onSubmitCode` is in here for a sharper reason than convenience: the parent's version of it
   * decides — from state the parent updates when the handoff starts — whether the code goes to the
   * sign-in that reconfigures the engine or the one that does not. A handler holding the version it
   * was mounted with would take the first, restart the engine, and discard the verifier the code is
   * bound to. Same fact, one render later, and the handoff fails with nothing on screen saying why.
   */
  const live = useRef({ address, viaBrowser, onSubmitCode });
  live.current = { address, viaBrowser, onSubmitCode };

  /**
   * ANSWER THE SCHEME while this screen is the one on show.
   *
   * Registered once and cleared on unmount — `native.ts` keeps a single shell-side listener for the
   * life of the window and swaps the handler behind it, because taking a listener off would cost a
   * second core permission this window is deliberately not granted.
   *
   * The code is put IN THE FIELD as well as submitted. Somebody who pressed a button in another
   * application and came back to this one should be able to see what arrived — and if the sign-in
   * is refused, the value they would otherwise have to fetch again is already where they can retry
   * with it.
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
