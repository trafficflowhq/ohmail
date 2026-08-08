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
 * app, in one language, and the vocabulary — "On this Mac", "ohmail Cloud" — belongs to the
 * desktop rather than to the catalogue's `settings` namespace. The provider table it renders is
 * the shared one, so the sentences that matter most (what an app password is, and which
 * providers actually work) are still written down exactly once.
 */

import { useMemo, useState } from "react";
import { Button } from "@ohmail/ui";

import { ProviderPicker } from "../../webapp/app/shell/ProviderPicker";
import { providerById } from "../../webapp/app/shell/providers";
import {
  EMPTY_LOCAL,
  enterCloudDoor,
  enterCloudDoorWithCode,
  enterLocalDoor,
  signInToCloud,
  signInToCloudWithCode,
  type DoorResult,
  type LocalDoorFields,
} from "./doors.js";
import { openWeb } from "./native.js";

/** Which of the three cards is on screen. `doors` is where a fresh install starts. */
type Step = "doors" | "local" | "cloud";

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
      if (!result.problem) onEntered(result);
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
        ) : step === "local" ? (
          <LocalDoor
            busy={busy}
            problem={problem}
            onBack={() => { setProblem(null); setStep("doors"); }}
            onCancel={onCancel}
            onSubmit={(fields) =>
              attempt(() => enterLocalDoor(fields, providerById(fields.providerId)))
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
                cloudAction === "signIn"
                  ? signInToCloud(address, password, totp)
                  : enterCloudDoor(address, password, totp),
              )
            }
            onSubmitCode={(address, code) =>
              attempt(() =>
                cloudAction === "signIn"
                  ? signInToCloudWithCode(address, code)
                  : enterCloudDoorWithCode(address, code),
              )
            }
            onOpenBrowser={() =>
              /* Same shape and same sentence style as Settings' `NO_BROWSER`: a refusal from the
                 shell is reported here, with the address, because a person who cannot be sent to
                 the page can still walk to it. */
              void openWeb("link-desktop").catch(() =>
                setProblem("This Mac would not open a browser. The page is at ohmail.app/link-desktop."),
              )
            }
          />
        )}
      </div>
    </div>
  );
}

/**
 * The two doors, as two things rather than as a dropdown.
 *
 * They are not variants of one setup: one opens a mailbox that already exists on somebody's own
 * server, the other mirrors an account they hold with us. Rendered as tiles for the reason the
 * provider picker is — a choice between recognisable things, with the factual line under each
 * name saying what will actually happen.
 */
function Doors({ onPick, onCancel }: { onPick: (step: Step) => void; onCancel?: () => void }) {
  return (
    <>
      <h1>Which mailbox is this?</h1>
      <p>
        ohmail organizes a mailbox you already have. It never becomes the master copy — your mail
        stays where it is, and you can leave at any time and take it with you.
      </p>
      <div className="pvp">
        <div className="pvp-grid" role="group" aria-label="Where your mail lives">
          <button type="button" className="pvp-tile" onClick={() => onPick("local")}>
            <span className="pvp-name">On this Mac</span>
            <span className="pvp-host">your own IMAP mailbox</span>
          </button>
          <button type="button" className="pvp-tile pvp-other" onClick={() => onPick("cloud")}>
            <span className="pvp-name">ohmail Cloud</span>
            <span className="pvp-host">a hosted ohmail account</span>
          </button>
        </div>
      </div>
      <p className="join-hint">
        On this Mac, your mail is organized by this computer and nothing is sent to us. With
        ohmail Cloud, a server does the organizing and this app keeps a copy of the result.
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
        This computer connects to your mail server directly. Your password is stored on this Mac,
        encrypted under a key held in the keychain, and is never sent to us.
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
            // something to pre-fill and empty for the generic entry, which has nothing.
            imapHost: chosen.imap.host,
            imapPort: String(chosen.imap.port),
            smtpHost: chosen.smtp.host,
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
 * Door two: a hosted ohmail account, mirrored onto this machine.
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
  onOpenBrowser: () => void;
}) {
  const [address, setAddress] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [handoff, setHandoff] = useState("");
  const [viaBrowser, setViaBrowser] = useState(false);

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
          ? "The copy of your mail on this Mac is where you left it. Signing in happens in the " +
            "mail engine on this machine — the password and the code go straight there and are " +
            "not kept anywhere else."
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
            Open ohmail.app in your browser, sign in there if you are not already, and it will
            show you a short code. Type it here. The code works once and lasts a couple of
            minutes.
          </p>
          <div className="join-actions">
            <Button type="button" onClick={onOpenBrowser} disabled={busy}>
              Open ohmail.app
            </Button>
          </div>

          <label className="join-label" htmlFor="cloud-handoff">Code from the browser</label>
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
