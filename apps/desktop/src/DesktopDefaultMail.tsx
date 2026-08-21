/**
 * THE DEFAULT-MAIL SURFACE — one question, asked once, and a row that always tells the truth.
 *
 * Two components over one hook. {@link DefaultMailAsk} is the first-run card: shown once a
 * mailbox is connected, only when another app holds mailto links, and NEVER twice — either
 * answer persists, and "it is already the default" persists too, because a question whose answer
 * is on screen is a nag. {@link DefaultMailRow} is the durable home in Settings → General: the
 * live-detected state and the platform's own action, for whoever said "not now" and changed
 * their mind.
 *
 * ── WHAT "MAKE DEFAULT" ACTUALLY DOES IS THE PLATFORM'S, AND THE COPY SAYS WHICH ────────────
 *
 * The shell answers `how` the request went — macOS takes the change and may confirm with its
 * own dialog or apply it directly (see `default_mail.rs`), Windows opens the Settings page
 * (this app never writes the choice), Linux writes it through `xdg-settings` — and the sentence
 * on screen is derived from that answer rather than from sniffing the platform here. Where the
 * person may still have a dialog or a page in front of them, the state flips only when the OS
 * says so, so the hook re-reads for a while instead of pretending.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, SettingsRow } from "@ohmail/ui";

import { usePersistedFlag } from "../../webapp/app/shell/persisted-ui.js";
import {
  defaultMailStatus,
  requestDefaultMail,
  type DefaultMailHow,
  type DefaultMailState,
} from "./native.js";

/**
 * Whether the one-time question has been answered — `"1"` after any answer, including "the OS
 * already says ohmail". The `ohmail.desktopCtaDismissed` naming precedent; localStorage, because
 * on a desktop install the webview's storage IS this install's preference store (the locale and
 * the theme live the same way).
 */
export const DEFAULT_MAIL_ASKED_KEY = "ohmail.desktopDefaultMailAsked";

/** How long the hook keeps re-reading after a request — the person is answering a dialog. */
const REREAD_MS = 2_000;
const REREAD_TRIES = 20;

/** The sentence the person is owed after a request, decided by what the shell says it did. */
export function afterRequestSentence(how: DefaultMailHow | null, state: DefaultMailState): string {
  switch (how) {
    case "system-dialog":
      // Launch Services is documented as SETTING the handler; macOS interposes its own
      // confirmation for some scheme changes and not for others, so this sentence promises
      // neither — the re-read below announces the outcome either way.
      return "macOS is applying the change — confirm its dialog if one appears.";
    case "settings-opened":
      return "Windows Settings is open — choose ohmail under Default apps.";
    case "set":
      return state === "default"
        ? "Mail links on this computer open in ohmail now."
        : "The change was sent to your desktop, and it has not taken effect yet.";
    default:
      return "The request was sent.";
  }
}

/** The row's right-hand value, from the detected state. Plain words, no vocabulary leaks. */
export function stateValue(state: DefaultMailState | null): string {
  switch (state) {
    case "default":
      return "ohmail";
    case "not-default":
      return "Another app";
    case "unknown":
      return "Not known";
    default:
      return "Checking…";
  }
}

/**
 * The detected state, the request, and the sentence the last request earned. `active` gates the
 * read so a surface that is not on screen costs nothing.
 */
export function useDefaultMail(active: boolean): {
  state: DefaultMailState | null;
  note: string | null;
  problem: string | null;
  busy: boolean;
  request: () => Promise<void>;
} {
  const [state, setState] = useState<DefaultMailState | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /* Re-reads left after a request. In state so the effect below re-arms; reset by each request. */
  const [watching, setWatching] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const read = useCallback(async () => {
    const fresh = await defaultMailStatus();
    if (alive.current) setState(fresh);
    return fresh;
  }, []);

  useEffect(() => {
    if (active) void read();
  }, [active, read]);

  /* THE WAIT FOR THE PERSON. A consent dialog and a Settings page both outlive the request, so
     the state is re-read on a slow clock for a bounded while — ending early the moment the
     answer arrives, and quietly giving up rather than polling forever at someone who said no. */
  useEffect(() => {
    if (watching <= 0) return;
    const timer = setTimeout(() => {
      void read().then((fresh) => {
        if (!alive.current) return;
        setWatching(fresh === "default" ? 0 : watching - 1);
        if (fresh === "default") setNote("Mail links on this computer open in ohmail now.");
      });
    }, REREAD_MS);
    return () => clearTimeout(timer);
  }, [watching, read]);

  const request = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setNote(null);
    try {
      const answer = await requestDefaultMail();
      if (!alive.current) return;
      setState(answer.state);
      setNote(afterRequestSentence(answer.how, answer.state));
      if (answer.state !== "default") setWatching(REREAD_TRIES);
    } catch (err) {
      if (alive.current) setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [busy]);

  return { state, note, problem, busy, request };
}

/**
 * Settings → General: the durable row. Lives on the shared General pane rather than the Desktop
 * pane because the question is about MAIL LINKS on this computer, which is where somebody who
 * skipped the first-run card would look — beside language and appearance, not beside the engine.
 */
export function DefaultMailRow() {
  const mail = useDefaultMail(true);
  const isDefault = mail.state === "default";
  return (
    <>
      <SettingsRow
        label="Default mail app"
        description={
          isDefault
            ? "Email links on this computer open a new message in ohmail."
            : "Which app opens email links (mailto) on this computer."
        }
        value={stateValue(mail.state)}
        control={
          isDefault ? undefined : (
            <Button onClick={() => void mail.request()} disabled={mail.busy}>
              {mail.busy ? "Asking…" : "Make default"}
            </Button>
          )
        }
      />
      {mail.problem ? <p className="join-error">{mail.problem}</p> : null}
      {!mail.problem && mail.note ? <p className="set-sub">{mail.note}</p> : null}
    </>
  );
}

/**
 * The one-time ask, over the mail surface once a mailbox is connected.
 *
 * Renders NOTHING until the state is read, and only when another app holds mail links — a card
 * about a setting that is already right is noise. Every exit persists: Make default, Not now,
 * and "it is already the default" all call `onDone`, and the card never appears again. The
 * Settings row above is the way back.
 */
export function DefaultMailAsk() {
  /* `false` is the fresh-install truth; a stored answer replaces it in the hook's post-mount
     read. `seen` flips in an effect REGISTERED AFTER that read, so the probe below cannot start
     until the stored answer is in — which is what makes a flash for somebody who already
     answered impossible, on top of the probe itself being an async round-trip. */
  const [asked, setAsked] = usePersistedFlag(DEFAULT_MAIL_ASKED_KEY, false);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    setSeen(true);
  }, []);

  const mail = useDefaultMail(seen && !asked);
  const [phase, setPhase] = useState<"ask" | "after">("ask");

  /* Already the default: there is nothing to ask, now or ever — the answer is the OS's own. */
  useEffect(() => {
    if (!asked && mail.state === "default" && phase === "ask") setAsked(true);
  }, [asked, mail.state, phase, setAsked]);

  if (asked && phase === "ask") return null;
  if (mail.state !== "not-default" && phase === "ask") return null;

  const decide = async (): Promise<void> => {
    setPhase("after");
    setAsked(true);
    await mail.request();
  };

  return (
    <div
      role="dialog"
      aria-label="Default mail app"
      style={{
        position: "fixed",
        insetInline: 0,
        bottom: 24,
        margin: "0 auto",
        width: "min(440px, calc(100vw - 32px))",
        zIndex: 80,
        background: "var(--float)",
        color: "var(--ink)",
        border: "1px solid var(--hair)",
        borderRadius: 12,
        padding: "16px 18px",
        boxShadow: "0 12px 32px var(--scrim)",
      }}
    >
      {phase === "ask" ? (
        <>
          <p style={{ margin: 0, fontWeight: 600 }}>Open email links with ohmail?</p>
          <p style={{ margin: "6px 0 12px", opacity: 0.8 }}>
            Clicking an email address anywhere on this computer would start a new message here.
            You can change this later in Settings.
          </p>
          <span className="set-tag-acts">
            <Button variant="primary" onClick={() => void decide()}>
              Make default
            </Button>
            <Button variant="ghost" onClick={() => setAsked(true)}>
              Not now
            </Button>
          </span>
        </>
      ) : (
        <>
          <p style={{ margin: 0, fontWeight: 600 }}>
            {mail.problem ?? mail.note ?? "Asking the system…"}
          </p>
          <span className="set-tag-acts" style={{ marginTop: 12, display: "inline-flex" }}>
            <Button variant="ghost" onClick={() => setPhase("ask")}>
              Done
            </Button>
          </span>
        </>
      )}
    </div>
  );
}
