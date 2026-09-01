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
  type EngineConfig,
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
 * built bundle in a headless DOM — where there is no shell to have an engine. The app has two
 * states, not connected and connected, and with no shell there is nothing to be connected TO, so
 * the honest surface there is the not-connected one: the door chooser, whose submits fail with a
 * sentence rather than pretending. (It used to be a sample mailbox; the no-demo rule retired it —
 * demo mail lives on the landing page and nowhere an app opens.)
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
  // No shell ⇒ not connected, and nothing to connect with. The chooser is the honest surface;
  // see the note on {@link Shell} for why this is not a notice and not a sample world.
  if (shell.kind === "none") return { kind: "choose" };
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
 * "there is an engine serving mail right now", and the window has two honest things to draw.
 *
 *  · `engine` — the shell says an engine is serving, and `key` names the mailbox it is serving.
 *    The real client runs against it.
 *  · `opening` — a door is chosen and no engine has served yet. Nothing is drawn about the mail,
 *    because the only alternative is a guess. (There used to be a third kind, `sample` — an
 *    invented mailbox for the no-shell case. The no-demo rule retired it: `gateFor` routes the
 *    no-shell case to the chooser now, so this question is only ever asked with a shell present.)
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
  | { kind: "engine"; key: string }
  | { kind: "opening" };

export function mailMount(shell: Shell, mounted: string | null): MailMount {
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

/**
 * WHETHER THIS INSTALL MAY ASK ABOUT SETTINGS FOUND ON A MAILBOX — the profile-import card's
 * door rule, a pure function here for the reason `gateFor` and `awayDoorFor` are.
 *
 * It is NOT `awayDoorFor` under another name, and the difference is the standalone arm. The
 * responder is withheld there because nothing on that door SENDS the reply; the confirm-import
 * flow has no such absent half — the engine on this machine mounts the three routes itself and
 * answers them out of its own store, and the standalone door is the flow's flagship case: a
 * mailbox that arrives carrying another ohmail's settings (leave Cloud, install the app) is
 * asked before anything is applied.
 *
 *  · STANDALONE — always, even without the mailbox password. The card's resting question is a
 *    marker read the engine answers without dialling, and a held question it cannot re-verify
 *    is a 502 the shared hook already treats as "no card, ask again later". Gating on the
 *    credential here would silence the ask on exactly the launch where the person is mid-setup.
 *  · HOSTED, SIGNED IN — the engine forwards the three routes to the account with the bearer,
 *    so the question and the durable answer are the account's own, shared with every browser
 *    tab. Signed out, every call could only be refused: `null`, `suggestDoorFor`'s rule.
 */
export function profileImportDoorFor(status: EngineStatus | null): "local" | "cloud" | null {
  if (status?.mode === "local") return "local";
  if (status?.mode === "cloud" && status.credentialState === "ready") return "cloud";
  return null;
}

/**
 * WHETHER THIS INSTALL MAY ADMINISTER A HOSTED ACCOUNT FROM ITS SETTINGS — the gate on everything
 * that belongs to an ACCOUNT rather than to this machine.
 *
 * One function for one question, so the whole family moves together: the consent row (the dormancy
 * dial, the auto-suggest opt-in, auto-unsubscribe — `local-consent.ts`), the Screener's spend wire
 * (`cloud-suggest.ts`, which the opt-in's quote runs on), and the three panes that exist only
 * because there is an account behind this window — Subscription, Security and Account.
 *
 * It agrees with {@link awayDoorFor} on every status either has been shown, and it is deliberately
 * a separate function rather than a second caller of that one. They ask different questions and one
 * of them could move: that one is about whether a REPLY CAN BE SENT, a fact about the hosted
 * worker's schedule; this one is about whether there is an ACCOUNT TO READ AND WRITE. Collapsing
 * them would make a change to either a silent change to the other.
 *
 *  · STANDALONE. There is no account, so there is nothing here to administer: no consent row to
 *    store a window or a spending watermark in, no ledger to price against, no subscription and no
 *    second factor. Every one of those surfaces is withheld structurally rather than offered dead,
 *    and expanding that door is not what this gate is for.
 *  · HOSTED, SIGNED IN. The account is real and the engine forwards these routes to it with the
 *    bearer, so what is read and written is the account's own row — identical to a browser tab with
 *    one hop more.
 *  · HOSTED, NOT SIGNED IN — or no door yet, or no answer from the shell. `null`. `READY`, not
 *    merely present, for the reason {@link suggestDoorFor} gives: on this door the credential IS
 *    the session, so `absent` is "signed out" and `unreadable`/`unknown` are "we cannot say", and
 *    a settings pane whose only state is an error about something it cannot fix from inside itself
 *    is worse than no pane.
 */
export function accountDoorFor(status: EngineStatus | null): "cloud" | null {
  return status?.mode === "cloud" && status.credentialState === "ready" ? "cloud" : null;
}

/**
 * WHETHER THIS INSTALL MAY OFFER HOST MODE — the Devices pane's door rule, a pure function here
 * for the reason `gateFor` and `accountDoorFor` are: a decision a test can drive is worth more
 * than a condition a component describes.
 *
 * STANDALONE ONLY, and the boundary is the product rather than the plumbing. Host mode publishes
 * the mail engine on THIS computer to the user's own devices; on the standalone door that engine
 * holds the whole mailbox and there is something real to serve. An install mirroring a hosted
 * account has nothing of its own to publish — its devices should talk to the hosted service
 * directly — so the pane is withheld structurally there rather than offered onto the shell's
 * `local-door-required` refusal. The shell enforces the same rule one layer down (that problem
 * code exists precisely so a mis-wired window degrades instead of serving); this function is what
 * keeps the refusal unreachable from the UI.
 *
 * `null` also covers "no door yet" and "no answer from the shell", `suggestDoorFor`'s rule: never
 * a pane whose every control could only refuse.
 */
export function hostDoorFor(status: EngineStatus | null): "local" | null {
  return status?.mode === "local" ? "local" : null;
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
 *
 * ── WHY THIS IS MINUTES AND NOT SECONDS ───────────────────────────────────────────────────────
 *
 * It was thirty seconds, and thirty seconds was chosen against a cold-disk open — measured at well
 * under a second on an established mirror. What it did not cover is Postgres CRASH RECOVERY, which
 * happens inside the engine's database open and is bounded by the size of the write-ahead log
 * rather than by the mailbox. An engine whose previous run left a large log replays it before it
 * can serve anything: measured at roughly 305 MB/s, so a directory that had accumulated tens of
 * gigabytes took near two minutes to come up, every launch, and was reported here as an engine that
 * had failed to start.
 *
 * That log is now bounded — the engine checkpoints on a timer while it runs, which it never used to
 * do — so an install made after this change never accumulates one. What the budget still has to
 * cover is the ONE launch that heals an install which grew a large log before it: recovery ends in
 * a checkpoint, after which the directory is small and every later launch is sub-second. Cutting
 * that launch short is the worst possible move, because a recovery that does not finish leaves the
 * log exactly as it found it and the next launch is longer.
 *
 * Note what this bound does and does not do. It ends a WAIT and returns the last status seen; it
 * never stops or kills the engine, which goes on starting either way. So the cost of it being too
 * large is a slower sentence about a genuinely dead engine, and the cost of it being too small is
 * telling somebody their mail engine failed while it is busy repairing itself.
 */
export const SETTLE_MS = 180_000;
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
/**
 * The engine's code for "the account you just signed in as is not the one this mirror holds".
 *
 * Named here rather than matched inline because two files read it and a typo would be silent: the
 * refusal would simply look like any other, and the window would offer no way through it.
 */
export const MIRROR_OWNER_MISMATCH = "mirror_owner_mismatch";

export interface DoorResult {
  status: EngineStatus | null;
  /** Null on success. A sentence for the field the person is looking at, never a code. */
  problem: string | null;
  /**
   * The sign-in was refused because THIS INSTALL IS MIRRORING A DIFFERENT ACCOUNT.
   *
   * Not an error variant so much as an instruction about what the next attempt has to be. The
   * engine will not activate a session over another account's database, and it is right not to —
   * but the person asking is very often entitled to switch, and the way to switch is the door
   * CONFIGURE path: it replaces the engine, and the replacement discards the foreign mirror before
   * it opens the database. So the chooser reads this and sends the next submit down that path
   * instead of down the one-request one. See `DoorChooser`.
   */
  switchAccount?: boolean;
}

/**
 * The transport a door attempt is about, as one value.
 *
 * Named because {@link enterLocalDoor} hands the identical object to the shell (as settings) and
 * to the engine (as the credential's transport), and those two must describe the same dial.
 */
interface LocalTransport {
  host: string;
  user: string;
  port: number;
  secure: boolean;
}

/**
 * Two addresses, compared the way a mailbox row is looked up.
 *
 * `ensureLocalWorld` finds the mailbox by `lower(address)` (`apps/sidecar/src/identity.ts`), so
 * that is the comparison that decides whether the engine will come back to the SAME row — and
 * therefore whether the id in a status answer is still the id to seal a password onto. An absent
 * address on either side is never a match: "the shell did not say" is not "they agree".
 */
function sameAddress(a: string | undefined, b: string): boolean {
  const left = (a ?? "").trim().toLowerCase();
  const right = b.trim().toLowerCase();
  return left.length > 0 && left === right;
}

/**
 * WHETHER THIS SUBMIT IS A RECONFIGURE OF THE MAILBOX ALREADY OPEN — the decision that picks the
 * order the door takes, exported so a test can drive it without a shell.
 *
 * `standing` is what the shell said about the engine BEFORE this attempt touched anything.
 * `enterLocalDoor` cannot read it for itself: its own first act on the other arm is
 * `engine_configure`, which replaces the engine, so the fact this asks about is one the caller
 * holds and the door destroys. A caller that passes nothing gets `false`, which is the answer
 * that is correct when there is no engine standing — the first-connect order.
 *
 * Every clause is load-bearing, and each one is a case where sealing first would be wrong:
 *
 *  · `serving` WITH a `mailboxId` — there has to be a row to `PATCH`. A starting engine has none.
 *  · `mode === "local"` — a hosted install's credential is a SESSION, and its mailbox row is a
 *    mirror of somebody's account. Choosing the local door there is a door SWITCH, not a
 *    reconfigure, and sealing a mail-server password onto the mirror's row would put a credential
 *    on a mailbox this install is about to throw away.
 *  · `credentialState === "ready"` — this is the precondition of the defect itself, not a
 *    convenience. `ready` means the engine resolved a sealed password it can decrypt
 *    (`engine.ts`: `credentialState: () => (await resolveLogin()).state`), which is exactly the
 *    secret a relaunch against a new host would dial with. `absent` has nothing to leak and no
 *    credential to diverge; `unreadable` means the keystore will not open the row, so the boot
 *    dials with nothing and the install is already asking to be re-entered. Both take the
 *    first-connect order, which is the one that works for them.
 *  · the ADDRESS IS UNCHANGED — and this is the case that needed `ensureLocalWorld` read as
 *    truth rather than assumed. It looks the mailbox up by `lower(address)` within the account
 *    and INSERTS a fresh row when it finds none (`identity.ts`), so a changed address means the
 *    engine that comes back will serve a DIFFERENT, newly minted mailbox id. Sealing onto the
 *    standing id would put the new server's credential on a row that still names the old address
 *    and that nothing will ever read. It also means the leak this reorder exists to stop cannot
 *    happen there: the new row has no credential at all, so `resolveLogin()` answers `absent` and
 *    the boot dials nothing. An address change therefore takes the first-connect order, and it is
 *    safe on that arm rather than merely tolerated.
 */
export function reconfiguresLocalDoor(
  standing: EngineStatus | null | undefined,
  address: string,
): standing is EngineStatus & { mailboxId: string } {
  return (
    !!standing &&
    standing.state === "serving" &&
    standing.mode === "local" &&
    typeof standing.mailboxId === "string" &&
    standing.mailboxId.length > 0 &&
    standing.credentialState === "ready" &&
    sameAddress(standing.address, address)
  );
}

/**
 * SEAL THE PASSWORD — the one request in this file that carries a secret, written once so the two
 * orders below cannot disagree about what it sends.
 *
 * Returns null on success, or the sentence to show. The engine tries the password before it seals
 * it, so a refusal here is the mail server's answer and not a stored credential that will fail
 * quietly on the next launch.
 *
 * ── THE TRANSPORT GOES WITH IT, AND BOTH ORDERS DEPEND ON THAT ──────────────────────────────
 *
 * This body used to be the password alone, on the reasoning that the engine had just been
 * configured with the transport and therefore already knew it. It knows it as a SETTINGS FILE;
 * this route reads `mailbox_credentials`, and on a first connect there is no such row. The
 * engine's boot inserts one only when a password arrives in its own config, which on this path it
 * deliberately never does — the shell has no route for a secret. `ensureLocalWorld` inserts the
 * `mailboxes` row and nothing else.
 *
 * So the service merged a pass-only patch over an absent stored meta, got a config with no host,
 * and refused it: **"imap host is required"** — reported by the first external user against their
 * own mail server (issue #5), who had in fact typed every field. The patch is a complete
 * statement about the transport, which is what the merge is built to accept (patch wins field by
 * field) and what `POST /mailboxes` has always sent.
 *
 * On the RECONFIGURE order it is that completeness that makes sealing-before-configuring possible
 * at all: the mailbox service's `probedImapMeta` dials the MERGED PATCH, not whatever the running
 * engine is configured for, so an engine still serving host A proves and seals the credential for
 * host B. The stored `meta` then records the host that was actually DIALLED, and the service holds
 * that invariant on its own account against a concurrent writer: it rebuilds the same merge under
 * the mailbox row's lock and refuses with a 409 rather than store a combination no probe tried.
 */
async function sealLocalPassword(
  mailboxId: string,
  imap: LocalTransport,
  password: string,
): Promise<string | null> {
  try {
    const res = await bridgeFetch(`/mailboxes/${encodeURIComponent(mailboxId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ imap: { ...imap, pass: password } }),
    });
    return res.ok ? null : await refusal(res);
  } catch (err) {
    return sentence(err);
  }
}

/**
 * Door one: this machine opens the user's own mailbox.
 *
 * Settings over the command, password over the bridge, and never the other way — the shell has no
 * route for a password and the engine has no route for a data directory.
 *
 * ── THE TWO ORDERS, AND WHY THERE ARE TWO ───────────────────────────────────────────────────
 *
 * `engine_configure` REPLACES the engine: it writes the settings and starts a new process against
 * them. Which side of that the password goes on is not a style question, and one order is wrong
 * on each arm of the same step.
 *
 * A FIRST CONNECT must configure first. There is no mailbox row to address a password to until
 * the engine has made one, and no stored secret to leak — the boot resolves `absent` and dials
 * nothing.
 *
 * A RECONFIGURE must seal first, and configuring first fails in both directions:
 *
 *  · ON SUCCESS the replacement engine boots with the NEW host and the PREVIOUSLY sealed password.
 *    `resolveLogin()` has no opinion about which host a secret was sealed for, so the adapter
 *    dials the new server with the old password BEFORE `settle()` returns — before the door has
 *    even asked for the new one. Correcting a typo'd hostname costs nothing; moving a mailbox to
 *    a server you do not control hands that server your previous password.
 *  · ON REFUSAL — wrong password, unreachable host — the settings file already says the new host
 *    and the credential correctly still says the old one. The door returns a sentence, the person
 *    backs out, and nothing rolls the settings back: the next launch configures the new host with
 *    the old password, and a mailbox that worked this morning does not connect.
 *
 * Sealing first ends both, because the seal is provable without changing anything: `PATCH
 * /mailboxes/:id` dials what the BODY says, so the engine still running against the old host is
 * what proves the credential for the new one. A refusal then returns with the install byte-for-
 * byte as it was found, and a success leaves the settings and the credential naming one host.
 *
 * WHAT THIS DOES NOT CLOSE, said plainly. The reorder fixes the defect FROM THIS DOOR. Any other
 * route that reconfigures an install still boots against whatever is sealed, and the general
 * close is the boot contract — `resolveLogin()` refusing a password whose stored `meta.host`
 * disagrees with the configured host. That needs a credential state to report it with, and every
 * existing one would be a true sentence about the wrong thing (`unreadable` tells the user their
 * keystore cannot open a credential it opens perfectly), so it is ledgered rather than half-done.
 */
export async function enterLocalDoor(
  f: LocalDoorFields,
  preset: { imap: { host: string; port: number }; smtp: { host: string; port: number } },
  /**
   * What the shell said about the engine before this attempt — {@link standingEngine}.
   *
   * Defaulted rather than required so the meaning of the two-argument call does not change: no
   * standing engine is the first-connect case, and the first-connect order is what it gets.
   * `DoorChooser` reads it AT SUBMIT rather than at render, because a door opened from Settings
   * may have been on screen for minutes and the order has to be chosen from what is true now.
   */
  standing: EngineStatus | null = null,
): Promise<DoorResult> {
  const problem = localProblem(f);
  if (problem) return { status: null, problem };

  const imapPort = portOr(f.imapPort, preset.imap.port);
  const smtpHost = f.smtpHost.trim() || preset.smtp.host;
  const smtpPort = portOr(f.smtpPort, preset.smtp.port);
  const address = f.address.trim();
  const user = f.user.trim() || address;
  /**
   * ONE transport, resolved ONCE, used by BOTH steps below.
   *
   * The shell is configured with it and the credential is probed and stored with it, and those
   * two must describe the same dial. Deriving them separately is how they drift; a single value
   * is why they cannot. See the patch body for what depended on this.
   */
  const imap: LocalTransport = {
    host: f.imapHost.trim() || preset.imap.host,
    user,
    port: imapPort,
    secure: implicitTls(imapPort),
  };

  /** The settings, as ONE value for the same reason `imap` is one: two spellings would drift. */
  const config: EngineConfig = {
    mode: "local",
    imap,
    ...(smtpHost
      ? { smtp: { host: smtpHost, port: smtpPort, secure: implicitTls(smtpPort) } }
      : {}),
    address,
  };

  if (reconfiguresLocalDoor(standing, address)) {
    /* SEAL, THEN COMMIT. Nothing about this install has changed yet, so a refusal here returns
       with the mailbox still on the configuration that was working. */
    const refused = await sealLocalPassword(standing.mailboxId, imap, f.password);
    if (refused !== null) return { status: standing, problem: refused };

    /**
     * ── THE ONE WINDOW THIS ORDER OPENS, NAMED RATHER THAN LEFT TO BE FOUND ─────────────────
     *
     * From here until the configure below returns, the CREDENTIAL names host B and the SETTINGS
     * still name host A. Both halves of that were raised by review of this change and both are
     * real:
     *
     *  · IF THE CONFIGURE FAILS, OR THE APP EXITS HERE, the install is left in the mirror image
     *    of the divergence this ordering exists to end, and the next launch would offer B's
     *    password to A. The catch below says exactly that, in a sentence a person can act on —
     *    which covers the half where there is somebody to tell. A crash has nobody to tell.
     *  · A SEND RACING THIS INTERVAL authenticates to A with B's password: `openLocalSend`
     *    resolves the credential afresh for every send while holding the SMTP coordinates it
     *    booted with. Not reachable from this window — the door is a modal over the whole app —
     *    but a scheduled send fires on the engine's own timer.
     *
     * Both close at the same single point, and neither closes here: the ENGINE has to refuse a
     * password whose stored `meta.host` disagrees with the host it is configured for. That is
     * deliberately not smuggled into this change, because the refusal needs a credential state
     * to report itself with and every existing one would be a true sentence about the wrong
     * thing. It is ledgered, and this ordering is what makes it load-bearing rather than
     * merely desirable.
     *
     * WHY THIS IS STILL THE RIGHT TRADE, said plainly rather than assumed. Before this ordering
     * the bad state was THE NORMAL PATH: every reconfigure to a new host dialled it with the old
     * password, and every refused password left the two disagreeing until somebody noticed. After
     * it, the bad state needs the process to die inside one `engine_configure` — a settings-file
     * write and a process spawn. A much narrower window in the same class is progress. Calling it
     * closure would not be, and nothing here or in the release notes says it is.
     */

    /* ONE configure, not two. The first-connect order needs a second because it seals into an
       engine that booted without a password; here the credential was in the store before this
       process started, so the engine that comes up resolves it on its first read. */
    try {
      await engineConfigure(config);
    } catch (err) {
      return { status: standing, problem: handoffInterrupted(err) };
    }
    const swapped = await settle();
    if (swapped.state !== "serving") return { status: swapped, problem: stalled(swapped) };
    return { status: await engineStatus(), problem: null };
  }

  let status: EngineStatus;
  try {
    status = await engineConfigure(config);
  } catch (err) {
    return { status: null, problem: sentence(err) };
  }

  const settled = await settle();
  if (settled.state !== "serving" || !settled.mailboxId) {
    return { status: settled, problem: stalled(settled) };
  }

  /* THE PASSWORD, AND THE ONLY PLACE IT IS WRITTEN DOWN IS THE ENGINE'S OWN STORE. See
     {@link sealLocalPassword} for what the body carries and why it carries all of it. */
  const refused = await sealLocalPassword(settled.mailboxId, imap, f.password);
  if (refused !== null) return { status: settled, problem: refused };

  /**
   * ── AND NOW REPLACE THE ENGINE, BECAUSE THE ONE THAT IS RUNNING CANNOT USE THAT PASSWORD ────
   *
   * The engine builds its IMAP adapter ONCE, at boot, from whatever password resolved then —
   * `engine.ts` says so where it builds it: "A password entered AFTER the process is up therefore
   * takes effect on the next launch rather than this one". On this path the engine booted seconds
   * ago with no password at all, so the adapter it is holding cannot log in, and the credential we
   * have just sealed is not reachable by anything until something re-reads it.
   *
   * Without this the door SUCCEEDED and the app stayed empty: no error, no sync, no explanation —
   * mail appeared only if the person happened to quit and reopen. That is the worst shape a
   * first-run failure can take, because everything the user can see says it worked.
   *
   * `engineConfigure` is the replacement, and it is the same call that started this one — the
   * settings are identical, so this is a relaunch and not a reconfiguration. A failure here is
   * reported rather than swallowed: the credential IS stored, so the honest sentence is about the
   * engine not coming back, and relaunching the app fixes it.
   */
  try {
    await engineConfigure(config);
  } catch (err) {
    return { status: settled, problem: sentence(err) };
  }
  const restarted = await settle();
  if (restarted.state !== "serving") return { status: restarted, problem: stalled(restarted) };

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
    if (!res.ok) {
      const { problem: refusalText, code } = await refused(res);
      // The engine will not put a session for one account over another account's mirror. Signing
      // in HERE cannot fix that — this request deliberately does not touch the engine's lifetime —
      // so the answer carries the flag that sends the next attempt through the door configure,
      // which replaces the engine and discards the foreign mirror before opening the database.
      return {
        status: known ?? null,
        problem: refusalText,
        ...(code === MIRROR_OWNER_MISMATCH ? { switchAccount: true } : {}),
      };
    }
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

/**
 * What starting a browser handoff produced: the commitment to put in the page's URL, or a problem.
 *
 * `challenge` is the PUBLIC half of a PKCE pair the ENGINE invented and whose secret half never
 * leaves that process. It is not a credential and nothing here can do anything with it except hand
 * it to the shell, which decides what page it goes on.
 */
export interface HandoffStart {
  challenge: string | null;
  status: EngineStatus | null;
  problem: string | null;
}

/**
 * START A BROWSER HANDOFF: configure the door if it is not already, then ask the engine for a
 * commitment.
 *
 * ── THE ORDER IS FORCED, AND GETTING IT WRONG IS SILENT ─────────────────────────────────────
 *
 * The verifier lives in the ENGINE's memory, and `engine_configure` REPLACES the engine — it stops
 * the process that is running and starts a new one. So the door has to be configured BEFORE the
 * pair is minted, never between minting it and claiming the code: a reconfigure in that window
 * takes the verifier with it, and the code the browser is showing becomes unclaimable by anybody.
 * Nothing fails loudly when that happens. The account answers the same sentence it answers an
 * expired code with, because telling the two apart is exactly what it refuses to do.
 *
 * That is why this function does the configure itself rather than leaving it to the sign-in that
 * follows, and why {@link signInToCloudWithCode} — which does NOT reconfigure — is the only sign-in
 * that may be used to finish a handoff this started. `DoorChooser` remembers that it started one.
 *
 * A door that is already chosen and serving is left alone: signing in again on a configured
 * install is one request, and restarting the engine to change nothing would take somebody's mail
 * off the screen for the length of a first launch.
 */
export async function beginBrowserSignIn(
  address: string,
  /** True when the door is already configured and serving — the Settings pane's "Sign in". */
  configured = false,
): Promise<HandoffStart> {
  const trimmedAddress = address.trim();
  if (!trimmedAddress) return { challenge: null, status: null, problem: "Your ohmail address is missing." };
  if (!trimmedAddress.includes("@")) {
    return { challenge: null, status: null, problem: "That does not look like a mailbox address." };
  }

  let settled: EngineStatus | null = null;
  if (!configured) {
    try {
      await engineConfigure({ mode: "cloud", cloudUrl: CLOUD_URL, address: trimmedAddress });
    } catch (err) {
      return { challenge: null, status: null, problem: sentence(err) };
    }
    settled = await settle();
    if (settled.state !== "serving") {
      return { challenge: null, status: settled, problem: stalled(settled) };
    }
  }

  try {
    const res = await bridgeFetch("/cloud/signin/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!res.ok) return { challenge: null, status: settled, problem: await refusal(res) };
    const body = (await res.json()) as { challenge?: unknown };
    const challenge = typeof body.challenge === "string" ? body.challenge : "";
    /* A missing or empty commitment is a REFUSAL rather than "open the page anyway". The page
       without one mints a code any program that claimed `ohmail://` could spend, and this app
       would still be waiting for a link — so the honest answer is to say the handoff could not be
       started and leave the password and retype paths, both of which work. */
    if (!challenge) {
      return {
        challenge: null,
        status: settled,
        problem: "The mail engine did not start a browser sign-in. Type the code in instead.",
      };
    }
    return { challenge, status: settled, problem: null };
  } catch (err) {
    return { challenge: null, status: settled, problem: sentence(err) };
  }
}

/**
 * The handoff sign-in on its own, for the door that is already chosen.
 *
 * ALSO the only sign-in that may finish a handoff {@link beginBrowserSignIn} started, on a fresh
 * install as well as a configured one — see that function for why a second `engine_configure` here
 * would silently discard the verifier the whole handoff rests on.
 */
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
    if (!res.ok) {
      // THE SAME FLAG AS THE PASSWORD PATH, because the hazard is the same one. The browser path
      // sends no address at all, so a code claimed from a browser signed in to a different account
      // reaches this install as a session with nowhere legitimate to go — and the engine refuses it
      // for the reason it refuses the typed one.
      const { problem: refusalText, code: refusalCode } = await refused(res);
      return {
        status: known ?? null,
        problem: refusalText,
        ...(refusalCode === MIRROR_OWNER_MISMATCH ? { switchAccount: true } : {}),
      };
    }
  } catch (err) {
    return { status: known ?? null, problem: sentence(err) };
  }
  return { status: await engineStatus(), problem: null };
}

/**
 * WHAT THE ENGINE IS DOING RIGHT NOW, or null when nothing can say.
 *
 * The reading {@link reconfiguresLocalDoor} decides from, and the reason it is a function here
 * rather than a prop threaded down from the window: a door opened over a running install may have
 * been on screen for minutes, and the order the submit takes has to come from what is true at the
 * moment of the submit. Null covers both "no shell" and "the shell would not answer", and both
 * mean the same thing to the caller — there is no standing engine to reconfigure, so the attempt
 * is a first connect.
 */
export async function standingEngine(): Promise<EngineStatus | null> {
  const shell = await readShell();
  return shell.kind === "status" ? shell.status : null;
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

/**
 * WHAT TO SAY WHEN THE PASSWORD LANDED AND THE SETTINGS DID NOT.
 *
 * The one state the seal-first ordering can leave behind, and the only one in this file where
 * telling the truth costs a longer sentence than the shell's own error. Saying only "the settings
 * could not be written" would be true and would hide the half that matters: the stored password is
 * now the NEW server's, while this install is still pointed at the old one. Somebody who reads the
 * short version and quits has been told nothing about the state they are in.
 *
 * Re-opening the door finishes it, and the retry is safe rather than merely allowed: the credential
 * is still `ready` and the address has not moved, so the attempt takes this same arm, re-proves the
 * password against the new server and commits the settings. Nothing has to be undone first.
 */
function handoffInterrupted(err: unknown): string {
  return (
    "Your new mailbox password was stored, but this computer's mail settings were not changed, " +
    "so it is still set up for the previous server. Open this door again to finish. " +
    `(${sentence(err)})`
  );
}

/**
 * What to say about an engine that was reconfigured and then did not come up.
 *
 * Exported for `self-host.ts`, which is a THIRD door taking the same two steps this file's cloud
 * door takes and therefore has the same three things to say about them. Sharing the sentence is
 * the point: a second wording for the same state is how two doors start describing one product
 * differently.
 */
export function stalled(status: EngineStatus): string {
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
  return (await refused(res)).problem;
}

/**
 * A refusal as both halves: the sentence for the person, and the CODE for the caller.
 *
 * Split out because one refusal is not merely text — `mirror_owner_mismatch` tells the window that
 * the next attempt has to take a different path, and a reader that only ever saw the message would
 * have to match on English to find that out.
 */
async function refused(res: Response): Promise<{ problem: string; code: string | null }> {
  let body = "";
  try {
    body = await res.text();
  } catch {
    /* nothing readable — the status line below is the whole answer */
  }
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string; code?: string; details?: unknown };
    };
    const code = parsed.error?.code ?? null;
    /* The probe can say more than its own sentence does — see {@link probeTlsSentence}. */
    const sharper = probeTlsSentence(parsed.error?.details);
    const message = sharper ?? parsed.error?.message ?? parsed.error?.code;
    if (message) return { problem: message, code };
  } catch {
    /* not JSON */
  }
  return {
    problem: res.statusText ? `${res.status} ${res.statusText}` : `The request was refused (${res.status}).`,
    code: null,
  };
}

/**
 * THE PROBE ALREADY KNOWS THE ANSWER — SAY IT, INSTEAD OF SENDING THE PERSON TO THEIR PROVIDER.
 *
 * `mailbox_probe_failed` carries `details.tls` on a TLS refusal, and on a HOSTNAME MISMATCH that
 * detail may name the host the certificate actually covers (`suggestedHost` — the vanity-name
 * shape: someone types `mail.<their-domain>` and the server there presents a certificate for
 * `<their-domain>`). The service's own `message` is deliberately generic, because it is one
 * sentence for every TLS failure; the detail beside it is where the specifics live.
 *
 * Until this existed the door read `error.message` and nothing else, so a person on their own
 * mail server was told *"Check the IMAP host with your provider"* while the engine, in the same
 * response, was holding the exact host to use. Measured against a real mailbox during the
 * onboarding drill: typing `mail.trafficflow.ch` produced
 * `{kind:"hostname_mismatch", expectedHost:"mail.trafficflow.ch", certHost:"trafficflow.ch",
 * suggestedHost:"trafficflow.ch"}` — the answer, one field away from the screen it belonged on.
 * The hosted web app has rendered this since the detail was added; only the desktop door dropped
 * it, which made the STANDALONE customer — the one with no support channel — the worst served.
 *
 * The wording is the hosted app's, verbatim (`probe_tls_hostname_suggest` /
 * `probe_tls_hostname` in `apps/webapp/messages/en.json`), so the two flavors of the same
 * product do not describe the same refusal in two different ways.
 *
 * NOT a trust change, and this is the line worth naming: the sentence is only ever SHOWN. The
 * person retypes the host and the next probe dials it and verifies strictly against it, exactly
 * as before — see `suggestedHostFor` in `packages/api/src/imap-probe.ts`, which explains why a
 * spoofed DNS answer can steer this suggestion but never past validation.
 *
 * Returns null for every shape it does not fully recognise, so an unknown or newer detail falls
 * back to the service's own sentence rather than to a worse one.
 */
export function probeTlsSentence(details: unknown): string | null {
  if (typeof details !== "object" || details === null) return null;
  const d = details as { reason?: unknown; transport?: unknown; tls?: unknown };
  if (d.reason !== "tls") return null;
  if (typeof d.tls !== "object" || d.tls === null) return null;
  const tls = d.tls as { kind?: unknown; certHost?: unknown; expectedHost?: unknown; suggestedHost?: unknown };
  if (tls.kind !== "hostname_mismatch") return null;

  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
  const certHost = str(tls.certHost);
  const expectedHost = str(tls.expectedHost);
  if (!certHost || !expectedHost) return null;

  const protocol = d.transport === "smtp" ? "SMTP" : "IMAP";
  const opening =
    `That server's certificate is for ${certHost}, not ${expectedHost}, ` +
    "so we stopped before sending the password.";

  const suggestedHost = str(tls.suggestedHost);
  return suggestedHost
    ? `${opening} It answers to ${suggestedHost} — use that as the ${protocol} host.`
    : `${opening} Check the ${protocol} host with your provider.`;
}

/** Whatever was thrown, as something a person can read. Shared with `self-host.ts`; see {@link stalled}. */
export function sentence(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message || "Something went wrong and said nothing about what.";
}
