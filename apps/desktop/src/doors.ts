/**
 * THE TWO DOORS, as decisions rather than as screens.
 *
 * A fresh install has to be asked one question — whose mail is this? — and there are exactly
 * two answers: the mailbox on your own server, opened from this machine, or a hosted ohmail
 * account, mirrored. `DoorChooser.tsx` is what that looks like; this file is what it MEANS, and
 * it is separate so the rules can be driven by a test instead of described in a comment.
 *
 * ── WHERE EACH PIECE OF THE ANSWER GOES, AND WHY THEY GO TO DIFFERENT PLACES ────────────────
 *
 * A door's SETTINGS — the mail server, the port, the address — go to the shell, over the
 * `engine_configure` command, because the shell is what has to remember them across a quit and
 * compose the engine's environment from them at every launch.
 *
 * A door's SECRET — the mailbox password, or the hosted sign-in — does NOT. It travels over the
 * bridge, addressed to the ENGINE, which seals it under this install's key and hands it back to
 * nobody. Two reasons, and the second is the one that made it a rule rather than a preference:
 *
 *   1. the shell REFUSES a configuration carrying a secret-shaped field, so a password sent the
 *      other way is not stored badly, it is rejected;
 *   2. a command argument is process state in the shell. The engine's store is the only place a
 *      credential is meant to rest, and the only way to keep that true is for the credential
 *      never to pass through anything else.
 *
 * So the local door is two steps — configure, then `PATCH /mailboxes/:id` with the password —
 * and the cloud door is two steps — configure, then `POST /cloud/signin`. Neither password is
 * ever an argument to a Tauri command.
 *
 * ── THE STEP BETWEEN THE TWO STEPS ──────────────────────────────────────────────────────────
 *
 * `engine_configure` REPLACES the engine: it stops the one that was running and starts a new one
 * against the new settings. The status it answers with is therefore `starting`, not `serving` —
 * the new engine has not announced itself yet, and until it does there is no mailbox id to
 * address a password to and no bridge to send it down. {@link settle} is that wait, and it is
 * bounded: a first launch has a schema to migrate and a directory to lock, and an engine that
 * never announces itself is a state the person in front of it has to be told about rather than
 * shown a spinner for.
 */

import {
  bridgeAvailable,
  bridgeFetch,
  engineConfigure,
  engineStatus,
  type EngineStatus,
} from "./bridge-fetch.js";

/**
 * Where a hosted account lives.
 *
 * A constant and not a field on the form: "which ohmail is this" is not a question anybody
 * signing in to ohmail can answer, and a text box for it would be a phishing surface with the
 * app's own chrome around it. It is the same address the macOS client uses, and it is named
 * HERE rather than in `bridge-fetch.ts` on purpose — that file is asserted to contain no URL at
 * all, because it is the one the security story is written about.
 *
 * Nothing in this window ever dials it. The value is handed to the shell, the shell hands it to
 * the engine, and the engine is the process that opens the connection; the page's CSP still says
 * `connect-src 'none'` and `offline-guard.ts` still replaces every API that could leave it.
 */
export const CLOUD_URL = "https://api.ohmail.app";

/** What the window should be showing, given what the shell last said about the engine. */
export type Gate =
  /** Nothing has been asked yet. Say nothing; do not guess. */
  | { kind: "waiting" }
  /** No door has been chosen. The chooser takes the whole window. */
  | { kind: "choose" }
  /** There is an engine and something is wrong with it. `reason` is the only thing to go on. */
  | { kind: "notice"; reason: string }
  /** A door is chosen and the engine is behind it. The mail client renders. */
  | { kind: "app" };

/**
 * What this window is running inside.
 *
 * `"none"` is NOT an error state and is deliberately not routed to a notice. It means the bundle
 * is being loaded outside the app — a development server, or the render check that loads the
 * built bundle in a headless DOM — where there is no shell to have an engine. The only honest
 * thing to show there is what the bundle has always shown without one.
 *
 * In the packaged app this value is never `"none"`: the runtime defines its command channel
 * before any bundle script runs. So the case that matters — a shell that IS there and an engine
 * that is not — is `"unreachable"`, and that one does get a notice.
 */
export type Shell =
  | { kind: "none" }
  | { kind: "unreachable"; reason: string }
  | { kind: "status"; status: EngineStatus };

/**
 * The gate, from one reading of the shell. The whole of the onboarding routing decision.
 *
 * `not_configured` and a null `mode` both mean "no door yet", and they are not redundant: the
 * first is the shell reporting that it has nothing to start, the second is the settings file
 * being absent. A sign-out produces both at once; a build whose engine binary is missing
 * produces neither and must not land on the chooser, because choosing a door would not help.
 */
export function gateFor(shell: Shell): Gate {
  if (shell.kind === "none") return { kind: "app" };
  if (shell.kind === "unreachable") return { kind: "notice", reason: shell.reason };

  const status = shell.status;
  switch (status.state) {
    case "not_configured":
      return { kind: "choose" };
    case "absent":
      return {
        kind: "notice",
        reason:
          "This copy of ohmail was built without a mail engine, so there is nothing for it to " +
          "open a mailbox with.",
      };
    case "no_key":
      return {
        kind: "notice",
        reason:
          status.reason ??
          "This computer's keystore would not give up the key this install seals your password " +
            "under.",
      };
    case "failed":
      return { kind: "notice", reason: status.reason ?? "The mail engine stopped and did not come back." };
    default:
      // `starting`, `restarting`, `stopped` and `serving`. A door HAS been chosen in every one of
      // them, so the client renders and the sync surface reports the rest — a window that hid the
      // mail every time the engine bounced would hide it for a second on every reconfigure.
      return status.mode ? { kind: "app" } : { kind: "choose" };
  }
}

/**
 * WHICH MAIL THE WINDOW SHOWS, once {@link gateFor} has said the mail client is what renders.
 *
 * `gateFor` answers the onboarding question — chooser, notice, or the app. This answers the one
 * after it, and they are genuinely different questions: "a door is chosen" is not the same fact as
 * "there is an engine serving mail right now", and the window has three honest things to draw.
 *
 *  · `sample` — there is no shell to ask. The bundle is running outside the app: a development
 *    server, or the render check that loads the built files in a headless DOM. Nothing is being
 *    organized, so the invented mailbox is the only thing there is to show, and it is the same
 *    thing this bundle has always shown without a shell.
 *  · `engine` — the shell says an engine is serving, and `key` names the mailbox it is serving.
 *    The real client runs against it.
 *  · `opening` — a door is chosen and no engine has served yet. Nothing is drawn about the mail,
 *    because the only alternatives are a guess and somebody else's sample mail under their own
 *    mailbox's name.
 *
 * ── `mounted` IS WHY A RESTART DOES NOT EMPTY THE SCREEN ─────────────────────────────────────
 *
 * The caller passes the key of the client already on screen, or `null`. Once a mailbox has been
 * served, a status that is no longer `serving` — the engine bouncing after a settings change, a
 * moment of `restarting` — keeps that client mounted rather than replacing the mail with a
 * spinner. Its mirror is already in memory and its next request simply waits. What DOES replace it
 * is a different mailbox, because the key changes, and that is the case where continuing to render
 * would be showing one mailbox's mail under another's name.
 */
export type MailMount =
  | { kind: "sample" }
  | { kind: "engine"; key: string }
  | { kind: "opening" };

export function mailMount(shell: Shell, mounted: string | null): MailMount {
  if (shell.kind === "none") return { kind: "sample" };
  const status = shell.kind === "status" ? shell.status : null;
  if (status?.state === "serving" && status.mailboxId) {
    return { kind: "engine", key: status.mailboxId };
  }
  /* NOT SERVING, and the two reasons for that are not alike. An engine between states still has a
     mailbox behind it; a window with no door chosen, or one that cannot reach its engine at all,
     does not — and mail must come off the screen in the second case rather than linger under a
     mailbox that is no longer this install's. `gateFor` is where that distinction already lives,
     so it is asked rather than restated here. An engine reporting `serving` with no mailbox id
     lands here too: it has not finished announcing itself, and there would be nothing to name the
     client after. */
  if (gateFor(shell).kind !== "app") return { kind: "opening" };
  return mounted === null ? { kind: "opening" } : { kind: "engine", key: mounted };
}

/**
 * WHICH SUGGEST CONTROL THE SCREENER GETS, if any — a decision, so it is a function and not a
 * condition buried in a render.
 *
 * The two doors buy different things and the difference is not wording. A STANDALONE install spends
 * nothing: the model is the installer's own, reached over the pipe, so its control names no price
 * and instead says whether there is a model at all. A HOSTED install spends an account's allowance,
 * so the question is the one asked in a browser tab — what would this cost — and the answer has to
 * come from the account.
 *
 * `null` is a control that is not offered, and it covers three states, all of which are the same
 * rule: never a spend control with nothing behind it.
 *
 *  · NO DOOR YET, or no answer from the shell. A control chosen on a guess appears and then changes
 *    its mind about what it is.
 *  · A HOSTED INSTALL WITH NO SESSION. Every press could only be refused, and the refusal would be
 *    about the one thing this window cannot fix from inside the Screener.
 *  · Anything else a later door might add, by construction — the arms are named, not defaulted.
 */
export type SuggestDoor = "local" | "cloud" | null;

export function suggestDoorFor(status: EngineStatus | null): SuggestDoor {
  if (status?.mode === "local") return "local";
  // READY, not merely present: on this door the credential IS the hosted session, so `absent` is
  // "signed out" and `unreadable`/`unknown` are "we cannot say" — and a purchase control offered on
  // a maybe is a purchase control that refuses.
  if (status?.mode === "cloud" && status.credentialState === "ready") return "cloud";
  return null;
}

/**
 * WHETHER THIS INSTALL MAY CONFIGURE AN AWAY RESPONDER — a decision, so it is a function here and
 * not a condition buried in a render, for the reason `gateFor` and `suggestDoorFor` are.
 *
 * It is NOT the same question as `suggestDoorFor`, even though the two agree on every status they
 * have ever been shown. That one is about SPENDING: never offer a purchase control with no ledger
 * behind it. This one is about a SENDER, and the rule is stronger than "the control would refuse".
 *
 *  · STANDALONE. The engine on this machine would answer `GET/PUT /away-responder` perfectly well
 *    out of its own database, and that is exactly why the check has to be here rather than left to
 *    the route. Nothing on this door SENDS the reply: the responder is a scheduled pass in the
 *    hosted service, whose module map publishes four entry points and not that one — a rule its own
 *    build holds rather than one somebody remembers. An always-on replier cannot live in an app
 *    that only runs while its window is open. So the control is absent, and a stored configuration
 *    that answers nobody is impossible rather than merely unlikely.
 *  · HOSTED, SIGNED IN. The account is real, the engine forwards this endpoint to it with the
 *    bearer, and the hosted worker sends from the row that is written. Identical to a browser tab
 *    with one hop more.
 *  · HOSTED, NOT SIGNED IN — or no door yet, or no answer from the shell. `null`, like the suggest
 *    control's: every read would be refused, and a settings pane whose only state is an error about
 *    something it cannot fix from inside itself is worse than no pane.
 */
export function awayDoorFor(status: EngineStatus | null): "cloud" | null {
  return status?.mode === "cloud" && status.credentialState === "ready" ? "cloud" : null;
}

/** What the local door's form collects. Every field is what the user typed, untrimmed. */
export interface LocalDoorFields {
  /** The preset's id — `providerById` in the shared shell resolves it to hosts and ports. */
  providerId: string;
  /** The address the mailbox is known by. Also the IMAP login unless `user` says otherwise. */
  address: string;
  /** The login, when the mail server knows you by something other than the address. */
  user: string;
  imapHost: string;
  imapPort: string;
  smtpHost: string;
  smtpPort: string;
  /** Never stored by the shell, never written to its settings file. See the header. */
  password: string;
}

export const EMPTY_LOCAL: LocalDoorFields = {
  providerId: "",
  address: "",
  user: "",
  imapHost: "",
  imapPort: "",
  smtpHost: "",
  smtpPort: "",
  password: "",
};

/** A port a person typed, or the preset's default when they typed nothing usable. */
export function portOr(typed: string, fallback: number): number {
  const n = Number.parseInt(typed.trim(), 10);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : fallback;
}

/**
 * `secure` is IMPLICIT TLS (993 / 465), not "is this connection encrypted".
 *
 * Port 587 is `false` here and still upgrades through STARTTLS. The flag names the socket's
 * initial state, which is the distinction the mail libraries draw — the same rule the shared
 * provider table states, restated where a hand-typed port is turned into one.
 */
export const implicitTls = (port: number): boolean => port === 993 || port === 465;

/**
 * The first thing wrong with the local form, as a sentence, or null when it is complete.
 *
 * Beside the fields and not in a toast: a rejection that leaves the screen is a rejection the
 * person has to remember while they fix what caused it.
 */
export function localProblem(f: LocalDoorFields): string | null {
  if (!f.providerId) return "Choose where your mail lives.";
  if (!f.address.trim()) return "Your mailbox address is missing.";
  if (!f.address.includes("@")) return "That does not look like a mailbox address.";
  if (!f.imapHost.trim()) return "The incoming mail server's address is missing.";
  if (!f.password) return "Your mailbox password is missing.";
  return null;
}

/** The first thing wrong with the cloud form, as a sentence, or null. */
export function cloudProblem(address: string, password: string, totp: string): string | null {
  if (!address.trim()) return "Your ohmail address is missing.";
  if (!address.includes("@")) return "That does not look like a mailbox address.";
  if (!password) return "Your password is missing.";
  if (!/^\d{6}$/.test(totp.trim())) return "The code from your authenticator app is six digits.";
  return null;
}

/**
 * The same, for the browser handoff — an address and a code, and no password anywhere.
 *
 * The ADDRESS is still asked for, and it is not a credential: it is what this install configures
 * its engine for and what the window shows in Settings afterwards. The handoff proves who you
 * are; it does not tell this machine which mailbox it is mirroring.
 *
 * The code is NOT pattern-checked beyond being present. It is a server-minted opaque value, and a
 * shape assertion here would be a second, quieter definition of what the server issues — the kind
 * that keeps working until the day the issuer changes and then refuses every valid code with a
 * sentence about a format nobody can see.
 */
export function handoffProblem(address: string, code: string): string | null {
  if (!address.trim()) return "Your ohmail address is missing.";
  if (!address.includes("@")) return "That does not look like a mailbox address.";
  if (!code.trim()) return "Paste the code the browser showed you.";
  return null;
}

/**
 * How long the window waits for a reconfigured engine to announce itself.
 *
 * A first launch on a new door has a database to create and a data directory to take an
 * exclusive lock on, and both are slower on a cold disk than anything that follows. Long enough
 * that a slow first start is not reported as a failure; short enough that an engine which will
 * never serve — a directory another copy already holds, a migration that failed — is said out
 * loud rather than spun on.
 */
export const SETTLE_MS = 30_000;
const POLL_MS = 250;

/**
 * Ask the shell about the engine until it stops starting.
 *
 * Returns the first status that is not `starting` or `restarting`, or the last one seen when the
 * bound is reached — never a fabricated one. The caller decides what a still-starting engine
 * means, because "it is taking a while" and "it will never come up" are the same reading here
 * and different sentences on screen.
 */
export async function settle(
  read: () => Promise<EngineStatus> = engineStatus,
  sleep: (ms: number) => Promise<void> = wait,
  budgetMs: number = SETTLE_MS,
  /* The clock, as a parameter, so a test can watch a thirty-second budget expire without taking
     thirty seconds — and without a fake sleep that advances nothing spinning for the real
     duration, which is the shape the first version of this had. */
  now: () => number = Date.now,
): Promise<EngineStatus> {
  const deadline = now() + budgetMs;
  let last = await read();
  while (last.state === "starting" || last.state === "restarting") {
    if (now() >= deadline) return last;
    await sleep(POLL_MS);
    last = await read();
  }
  return last;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** What a door attempt ended as. `status` is what the shell last said, whatever happened. */
export interface DoorResult {
  status: EngineStatus | null;
  /** Null on success. A sentence for the field the person is looking at, never a code. */
  problem: string | null;
}

/**
 * Door one: this machine opens the user's own mailbox.
 *
 * Settings over the command, password over the bridge, in that order and never the other way —
 * the shell has no route for a password and the engine has no route for a data directory.
 */
export async function enterLocalDoor(
  f: LocalDoorFields,
  preset: { imap: { host: string; port: number }; smtp: { host: string; port: number } },
): Promise<DoorResult> {
  const problem = localProblem(f);
  if (problem) return { status: null, problem };

  const imapPort = portOr(f.imapPort, preset.imap.port);
  const smtpHost = f.smtpHost.trim() || preset.smtp.host;
  const smtpPort = portOr(f.smtpPort, preset.smtp.port);
  const user = f.user.trim() || f.address.trim();

  let status: EngineStatus;
  try {
    status = await engineConfigure({
      mode: "local",
      imap: {
        host: f.imapHost.trim() || preset.imap.host,
        user,
        port: imapPort,
        secure: implicitTls(imapPort),
      },
      ...(smtpHost
        ? { smtp: { host: smtpHost, port: smtpPort, secure: implicitTls(smtpPort) } }
        : {}),
      address: f.address.trim(),
    });
  } catch (err) {
    return { status: null, problem: sentence(err) };
  }

  const settled = await settle();
  if (settled.state !== "serving" || !settled.mailboxId) {
    return { status: settled, problem: stalled(settled) };
  }

  /* THE PASSWORD, AND THE ONLY PLACE IT IS WRITTEN DOWN IS THE ENGINE'S OWN STORE.
     The engine tries it before it seals it, so a rejection here is the mail server's answer and
     not a stored credential that will fail quietly on the next launch. */
  try {
    const res = await bridgeFetch(`/mailboxes/${encodeURIComponent(settled.mailboxId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ imap: { pass: f.password } }),
    });
    if (!res.ok) return { status: settled, problem: await refusal(res) };
  } catch (err) {
    return { status: settled, problem: sentence(err) };
  }

  return { status: await engineStatus(), problem: null };
}

/**
 * Door two: a hosted account, mirrored onto this machine.
 *
 * The sign-in is the engine's, not the shell's and not this page's: the password and the code go
 * down the bridge in one request, are exchanged for a session there, and are sealed under this
 * install's key. Nothing in this process holds either afterwards.
 */
export async function enterCloudDoor(
  address: string,
  password: string,
  totp: string,
): Promise<DoorResult> {
  const problem = cloudProblem(address, password, totp);
  if (problem) return { status: null, problem };

  let status: EngineStatus;
  try {
    status = await engineConfigure({ mode: "cloud", cloudUrl: CLOUD_URL, address: address.trim() });
  } catch (err) {
    return { status: null, problem: sentence(err) };
  }

  const settled = await settle();
  if (settled.state !== "serving") return { status: settled, problem: stalled(settled) };

  return signInToCloud(address, password, totp, settled);
}

/**
 * The hosted sign-in on its own, for the door that is already chosen.
 *
 * Signing out of a cloud install leaves the door in place and the mirror frozen; coming back is
 * this request and nothing else. Shared with {@link enterCloudDoor} so the two cannot disagree
 * about what a sign-in is.
 */
export async function signInToCloud(
  address: string,
  password: string,
  totp: string,
  known?: EngineStatus,
): Promise<DoorResult> {
  const problem = cloudProblem(address, password, totp);
  if (problem) return { status: known ?? null, problem };
  try {
    const res = await bridgeFetch("/cloud/signin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: address.trim(), password, totp: totp.trim() }),
    });
    if (!res.ok) return { status: known ?? null, problem: await refusal(res) };
  } catch (err) {
    return { status: known ?? null, problem: sentence(err) };
  }
  return { status: await engineStatus(), problem: null };
}

/**
 * Door two, entered with a code from the browser instead of a password.
 *
 * The SAME two steps `enterCloudDoor` takes — configure the engine for the address, wait for it
 * to serve, then one request over the bridge — with the third argument swapped. It is written as
 * its own pair of functions rather than as a flag on the password ones because the two forms
 * validate different fields and read differently at the call site, and it costs one delegation:
 * both end at `POST /cloud/signin`, which is where the engine decides what it was handed.
 *
 * Nothing about the code is stored here or anywhere else in this process. It is worth a session
 * for about two minutes and only once, and by the time this returns it has been spent.
 */
export async function enterCloudDoorWithCode(address: string, code: string): Promise<DoorResult> {
  const problem = handoffProblem(address, code);
  if (problem) return { status: null, problem };

  let status: EngineStatus;
  try {
    status = await engineConfigure({ mode: "cloud", cloudUrl: CLOUD_URL, address: address.trim() });
  } catch (err) {
    return { status: null, problem: sentence(err) };
  }

  const settled = await settle();
  if (settled.state !== "serving") return { status: settled, problem: stalled(settled) };

  return signInToCloudWithCode(address, code, settled);
}

/** The handoff sign-in on its own, for the door that is already chosen. */
export async function signInToCloudWithCode(
  address: string,
  code: string,
  known?: EngineStatus,
): Promise<DoorResult> {
  const problem = handoffProblem(address, code);
  if (problem) return { status: known ?? null, problem };
  try {
    const res = await bridgeFetch("/cloud/signin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // ONLY the code. Not an empty `password` and an empty `totp` alongside it: the engine
      // branches on this field's presence, and sending the other two blank would make a future
      // reader think either shape might be in play here.
      body: JSON.stringify({ handoffCode: code.trim() }),
    });
    if (!res.ok) return { status: known ?? null, problem: await refusal(res) };
  } catch (err) {
    return { status: known ?? null, problem: sentence(err) };
  }
  return { status: await engineStatus(), problem: null };
}

/** Ask the shell what it is doing, and say honestly when there is no shell to ask. */
export async function readShell(): Promise<Shell> {
  if (!bridgeAvailable()) return { kind: "none" };
  try {
    return { kind: "status", status: await engineStatus() };
  } catch (err) {
    return { kind: "unreachable", reason: sentence(err) };
  }
}

/** What to say about an engine that was reconfigured and then did not come up. */
function stalled(status: EngineStatus): string {
  if (status.reason) return status.reason;
  if (status.state === "starting" || status.state === "restarting") {
    return "The mail engine is still starting. Settings are saved; give it a moment and open ohmail again.";
  }
  return `The mail engine did not start (${status.state}). Your settings are saved.`;
}

/**
 * The engine's own words for a refusal, or the status line when it sent none.
 *
 * The body is read as text and parsed leniently rather than assumed to be JSON: an error page
 * from a route that does not exist is not JSON, and `await res.json()` on one throws inside the
 * handler that was trying to explain the first failure.
 */
async function refusal(res: Response): Promise<string> {
  let body = "";
  try {
    body = await res.text();
  } catch {
    /* nothing readable — the status line below is the whole answer */
  }
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; code?: string } };
    const message = parsed.error?.message ?? parsed.error?.code;
    if (message) return message;
  } catch {
    /* not JSON */
  }
  return res.statusText ? `${res.status} ${res.statusText}` : `The request was refused (${res.status}).`;
}

/** Whatever was thrown, as something a person can read. */
function sentence(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message || "Something went wrong and said nothing about what.";
}
