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
 * ── THE COPY IS IN THIS FILE ────────────────────────────────────────────────────────────────
 *
 * Deliberately, and it is the exception rather than the rule. The shared client reads its words
 * from the message catalogue because two products render it; these screens exist only inside this
 * app, in one language, and the vocabulary — "On this Mac" / "On this PC" / "On this computer",
 * "ohmail Cloud" — belongs to the desktop rather than to the catalogue's `settings` namespace.
 * The machine's own word comes from `platform.ts` (a fact about the build, one per platform this
 * ships to), never hardcoded: the Linux AppImage said "On this Mac" for a release before that
 * rule existed. The provider table it renders is the shared one, so the sentences that matter
 * most (what an app password is, and which providers actually work) are still written down
 * exactly once.
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
  enterLocalDoor,
  signInToCloud,
  signInToCloudWithCode,
  standingEngine,
  type DoorResult,
  type LocalDoorFields,
} from "./doors.js";
import {
  OPERATOR_CA_FILE,
  configureSelfHostDoor,
  selfHostBase,
  signInToSelfHost,
} from "./self-host.js";
import { offLinkCode, onLinkCode, openWeb } from "./native.js";
import { MACHINE_WORD } from "./platform.js";

/** What the app says when the platform would not spawn a browser. Same sentence Settings uses. */
const NO_BROWSER =
  `This ${MACHINE_WORD} would not open a browser. The page is at ohmail.app/link-desktop.`;

/**
 * Which card is on screen. `doors` is where a fresh install starts.
 *
 * `server` is the self-hosted arm, and it is a step of its own rather than a flag on `cloud`
 * because it asks a question `cloud` does not: which server. Everything after that question is the
 * same engine, the same sign-in and the same mirror — see `self-host.ts`.
 */
type Step = "doors" | "local" | "server" | "cloud";

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
        setProblem(started.problem ?? "The browser sign-in could not be started.");
        return;
      }
      /* SET BEFORE THE BROWSER IS OPENED, and it stays set even if opening fails: by this point the
         engine HAS been configured and IS holding a verifier, so a code submitted afterwards must
         not go down a path that would restart it. */
      setHandedOff(address.trim());
      try {
        await openWeb("link-desktop", started.challenge);
      } catch {
        setProblem(NO_BROWSER);
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
      <h1>Which mailbox is this?</h1>
      <div className="door-grid" role="group" aria-label="Which machine does the organizing">
        {/* Focused on mount so a keyboard reaches the choice without tabbing through the chrome
            above it. Native buttons: Tab moves between the three, Enter and Space open one, and
            nothing here claims a chord the shared keymap has spoken for. */}
        <button type="button" className="door-tile" autoFocus onClick={() => onPick("local")}>
          <span className="door-name">On this {MACHINE_WORD}</span>
          <span className="door-say">
            Your own IMAP mailbox, organized right here. Nothing is sent anywhere.
          </span>
        </button>
        <button type="button" className="door-tile" onClick={() => onPick("server")}>
          <span className="door-name">Your own server</span>
          <span className="door-say">
            <em>Self-hosted ohmail Cloud.</em> A server you run does the organizing; this app keeps
            a copy.
          </span>
        </button>
        <button type="button" className="door-tile" onClick={() => onPick("cloud")}>
          <span className="door-name">ohmail Cloud</span>
          <span className="door-say">
            Our hosted service does the organizing; this app keeps a copy.
          </span>
        </button>
      </div>
      <p className="door-travel">
        Move between these anytime. Your rules and settings live in your own mailbox and travel
        with you — the mailbox is always the master.
      </p>
      {onCancel ? (
        <div className="join-actions">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
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
      <h1>Your own mailbox</h1>
      <p>
        This computer connects to your mail server directly. Your password is stored on this{" "}
        {MACHINE_WORD}, encrypted under a key held in the keychain, and is never sent to us.
      </p>

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

      <label className="join-label" htmlFor="door-address">Mailbox address</label>
      <input
        id="door-address"
        className="join-input"
        type="email"
        autoComplete="username"
        spellCheck={false}
        value={fields.address}
        onChange={(e) => set("address", e.target.value)}
      />

      <label className="join-label" htmlFor="door-password">Mailbox password</label>
      <input
        id="door-password"
        className="join-input"
        type="password"
        autoComplete="current-password"
        value={fields.password}
        onChange={(e) => set("password", e.target.value)}
      />
      <p className="join-hint">
        For most providers this is an app password rather than the password you sign in with —
        the note above your provider says which.
      </p>

      {manual ? (
        <>
          <label className="join-label" htmlFor="door-imap-host">Incoming server (IMAP)</label>
          <input
            id="door-imap-host"
            className="join-input"
            spellCheck={false}
            value={fields.imapHost}
            onChange={(e) => set("imapHost", e.target.value)}
          />
          <label className="join-label" htmlFor="door-imap-port">IMAP port</label>
          <input
            id="door-imap-port"
            className="join-input join-code"
            inputMode="numeric"
            value={fields.imapPort}
            onChange={(e) => set("imapPort", e.target.value)}
          />
          <label className="join-label" htmlFor="door-smtp-host">Outgoing server (SMTP)</label>
          <input
            id="door-smtp-host"
            className="join-input"
            spellCheck={false}
            value={fields.smtpHost}
            onChange={(e) => set("smtpHost", e.target.value)}
          />
          <label className="join-label" htmlFor="door-smtp-port">SMTP port</label>
          <input
            id="door-smtp-port"
            className="join-input join-code"
            inputMode="numeric"
            value={fields.smtpPort}
            onChange={(e) => set("smtpPort", e.target.value)}
          />
          <label className="join-label" htmlFor="door-user">Username, if it is not the address</label>
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
          {busy ? "Opening your mailbox…" : "Open this mailbox"}
        </Button>
        <Button variant="ghost" type="button" onClick={onBack} disabled={busy}>Back</Button>
        {onCancel ? (
          <Button variant="ghost" type="button" onClick={onCancel} disabled={busy}>Cancel</Button>
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
      <h1>Your own server</h1>
      <p>
        {reached === null
          ? "Give the address you open ohmail at in a browser. This app will check that your " +
            "server is there before it asks for anything else."
          : `Signing in happens in the mail engine on this ${MACHINE_WORD} — the password and the ` +
            "code go straight there and are not kept anywhere else."}
      </p>

      {problem ? <p className="join-error">{problem}</p> : null}

      <label className="join-label" htmlFor="server-origin">Your server's address</label>
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
        placeholder="https://ohmail.example.com"
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
          <label className="join-label" htmlFor="server-address">Your ohmail address on that server</label>
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
          <p className="join-hint">
            If your server issues its own certificates, put its root certificate in a file named{" "}
            <code>{OPERATOR_CA_FILE}</code> in this app's data folder first. ohmail verifies
            certificates and has no way to skip that.
          </p>
        </>
      ) : (
        <>
          <p className="join-hint">
            Reached {reached}. Signing in as {address}.
          </p>
          <label className="join-label" htmlFor="server-password">Password</label>
          <input
            id="server-password"
            className="join-input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <label className="join-label" htmlFor="server-totp">Code from your authenticator app</label>
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
            ? reached === null ? "Checking your server…" : "Signing in…"
            : reached === null ? "Continue" : "Sign in"}
        </Button>
        <Button variant="ghost" type="button" onClick={onBack} disabled={busy}>Back</Button>
        {onCancel ? (
          <Button variant="ghost" type="button" onClick={onCancel} disabled={busy}>Cancel</Button>
        ) : null}
      </div>
    </form>
  );
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
      <h1>Sign in to ohmail Cloud</h1>
      <p>
        {signInOnly
          ? `The copy of your mail on this ${MACHINE_WORD} is where you left it. Signing in ` +
            "happens in the mail engine on this machine — the password and the code go straight " +
            "there and are not kept anywhere else."
          : "Your account is organized on our servers and this app keeps a copy. Signing in " +
            "happens in the mail engine on this machine — the password and the code go straight " +
            "there and are not kept anywhere else."}
      </p>

      {problem ? <p className="join-error">{problem}</p> : null}

      <label className="join-label" htmlFor="cloud-address">Your ohmail address</label>
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
          <p className="join-hint">
            Your browser opens ohmail.app. Sign in there if you are not already, then press
            “Open ohmail” on that page and this app comes forward signed in.
          </p>
          <div className="join-actions">
            <Button type="button" onClick={() => onOpenBrowser(address)} disabled={busy}>
              Open ohmail.app
            </Button>
          </div>

          {/* THE FALLBACK STAYS ON SCREEN. See this component's header: a scheme handler can be
              missing or claimed by something that does nothing visible, and the page shows the
              code beside the button for exactly this. Nothing about typing it in has changed. */}
          <label className="join-label" htmlFor="cloud-handoff">
            Or type the code the page shows
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
          <p className="join-hint">
            The code works once and lasts a couple of minutes.
          </p>
        </>
      ) : (
        <>
          <label className="join-label" htmlFor="cloud-password">Password</label>
          <input
            id="cloud-password"
            className="join-input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />

          <label className="join-label" htmlFor="cloud-totp">Code from your authenticator app</label>
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
          {busy ? "Signing in…" : "Sign in"}
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
          {viaBrowser ? "Use my password instead" : "Sign in with browser"}
        </Button>
        <Button variant="ghost" type="button" onClick={onBack} disabled={busy}>Back</Button>
        {onCancel ? (
          <Button variant="ghost" type="button" onClick={onCancel} disabled={busy}>Cancel</Button>
        ) : null}
      </div>
    </form>
  );
}
