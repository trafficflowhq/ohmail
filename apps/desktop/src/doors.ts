/**
 * THE TWO DOORS, as decisions rather than as screens. A fresh install is asked whose mail this
 * is — the mailbox on your own server, or a hosted ohmail account, mirrored. `DoorChooser.tsx`
 * is what that looks like; this file is what it MEANS, separate so the rules are driven by a
 * test. A door's SETTINGS go to the shell over `engine_configure` (it remembers them across a
 * quit and composes the engine's environment). A door's SECRET does NOT: it travels over the
 * bridge to the ENGINE, which seals it under this install's key — the shell REFUSES a
 * configuration carrying a secret-shaped field, and a command argument is process state in the
 * shell. So each door is configure, then `PATCH /mailboxes/:id` / `POST /cloud/signin`.
 */

/*
 * THE STEP BETWEEN THE TWO STEPS: `engine_configure` REPLACES the engine — stops the running
 * one, starts a new one against the new settings — and answers `starting`, not `serving`: the
 * new engine has not announced itself, and until it does there is no mailbox id to address a
 * password to and no bridge to send it down. {@link settle} is that wait, and it is bounded: a
 * first launch has a schema to migrate and a directory to lock, and an engine that never
 * announces itself is a state a person must be told about rather than shown a spinner for.
 */

import { originNeedsPin, parsePairLink, type PairLink } from "@ohmail/client-engine";

import { BUILD_PLATFORM } from "./platform.js";
import {
  bridgeAvailable,
  bridgeFetch,
  engineConfigure,
  engineStatus,
  type DoorFlavorWire,
  type EngineConfig,
  type EngineStatus,
} from "./bridge-fetch.js";

/**
 * Where a hosted account lives. A constant and not a field on the form: "which ohmail is this"
 * is not a question anybody signing in to ohmail can answer, and a text box for it would be a
 * phishing surface with the app's own chrome around it. Named HERE rather than in
 * `bridge-fetch.ts` on purpose — that file is asserted to contain no URL at all. Nothing in
 * this window ever dials it: the value goes shell → engine, and the engine opens the
 * connection; the page's CSP still says `connect-src 'none'`.
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
 * What this window is running inside. `"none"` is NOT an error state and is deliberately not
 * routed to a notice: it means the bundle is loaded outside the app (a development server, the
 * render check's headless DOM), where there is no shell to have an engine — the honest surface
 * is the not-connected one, the door chooser, whose submits fail with a sentence. (It used to
 * be a sample mailbox; the no-demo rule retired it.) In the packaged app this is never
 * `"none"` — the runtime defines its command channel before any bundle script runs — so the
 * case that matters, a shell present and an engine not, is `"unreachable"`, which does get
 * a notice.
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
 * WHICH MAIL THE WINDOW SHOWS, once {@link gateFor} has said the mail client renders. A
 * different question from onboarding: "a door is chosen" is not "an engine is serving mail
 * right now". `engine` — the shell says an engine is serving and `key` names the mailbox.
 * `opening` — a door is chosen, no engine has served yet; nothing is drawn about the mail.
 * `mounted` is why a restart does not empty the screen: once a mailbox has been served, a
 * status no longer `serving` (the engine bouncing after a settings change) keeps that client
 * mounted — its mirror is in memory and its next request waits. A DIFFERENT mailbox replaces
 * it, because the key changes: rendering on would show one mailbox's mail under another's name.
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
 * ═══ WHAT IS ON THE FAR SIDE OF THIS INSTALL'S DOOR — the ONE seam every branch reads ══════
 * `status.mode === "cloud"` was asked in eleven places, each writing a sentence or opening a
 * pane true of a HOSTED account and false of a desktop paired to another computer of the
 * person's own — four panes about an account that does not exist, one spend control with no
 * ledger behind it. The eleven read this instead: one function, one place to correct, and a
 * table test that drives every branch — the reason `gateFor` and `accountDoorFor` are
 * functions rather than conditions inside a render.
 */

/*
 * `"unknown"` IS A STATE, NOT A DEFAULT: an engine that predates `EngineStatus.flavor` sends
 * nothing, and collapsing that into either answer fails — absent-as-`desktop-host` strips four
 * panes from every shipped Cloud install; absent-as-`managed` makes the field unable to say
 * anything. Every branch that changed for the paired door tests POSITIVELY for
 * `"desktop-host"`, so `"unknown"` keeps the shipped behaviour — correct, not merely safe: no
 * engine old enough to omit the field has a paired door. The wire value is narrowed HERE
 * against the closed set; anything else becomes `"unknown"` rather than travelling on — a call
 * site comparing `status.flavor` for itself is the first copy forgotten when a fourth exists.
 */
export type DoorFlavor = "local" | "managed" | "selfhost" | "desktop-host" | "unknown";

const CLOUD_FLAVORS: readonly DoorFlavorWire[] = ["managed", "selfhost", "desktop-host"];

export function flavorOf(status: EngineStatus | null): DoorFlavor {
  if (status?.mode === "local") return "local";
  if (status?.mode !== "cloud") return "unknown";
  const wire = status.flavor;
  return wire != null && CLOUD_FLAVORS.includes(wire) ? wire : "unknown";
}

/**
 * IS THIS INSTALL PAIRED TO ANOTHER COMPUTER OF THE PERSON'S OWN?
 *
 * The positive test the eleven branches take, named so the rule reads the same way in each of
 * them and so `"unknown"` can never be mistaken for it by a stray `!==`. A negation would invert
 * exactly the care {@link flavorOf} takes: `flavor !== "managed"` is true of an engine that said
 * nothing, and that is every shipped install.
 */
export function isDesktopHost(status: EngineStatus | null): boolean {
  return flavorOf(status) === "desktop-host";
}

/**
 * WHAT TO CALL THE OTHER COMPUTER ON SCREEN — the URL's hostname, and for a tailnet name its
 * first label. `/hello` is not widened with a machine name (a name volunteered by whatever
 * answered is worth less than the address the person typed), so the label derives from the
 * configured origin: `machine.tailnet.ts.net`'s first label is the machine's tailnet name; an
 * IP literal stays an IP — a truncated address is a wrong address. Two machines with one name
 * on two tailnets read alike, which is why Settings → Desktop carries the full origin beside
 * this and the rail does not. Unparseable or absent is `null`, never a guess or the empty
 * string — every sentence built on this interpolates it, and "Can't reach ." is worse.
 */
export function hostLabelOf(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null;
  const m = /^https?:\/\/([^/?#\s:]+)/i.exec(baseUrl.trim());
  const host = m?.[1]?.toLowerCase();
  if (!host) return null;
  return host.endsWith(".ts.net") ? (host.split(".")[0] ?? host) : host;
}

/**
 * WHICH NETWORK THE OTHER COMPUTER IS REACHED OVER — decided from the origin's SHAPE, the only
 * thing this window is told. The same-network door binds one interface and hands out its
 * address as an IP literal (`host-lan.ts`), and no authority certifies one — why that door's
 * link carries a pin; a NAME is a tailnet MagicDNS name with a checkable certificate. So an IP
 * literal is `"lan"` and anything else is `"ts"`. It selects one sentence — same network
 * versus signed in to Tailscale — and getting it wrong costs one wrong thing to check, which
 * is why a derivation is allowed. `null` when there is no origin to read.
 */
export function hostViaOf(baseUrl: string | null | undefined): "lan" | "ts" | null {
  if (!baseUrl) return null;
  const m = /^https?:\/\/([^/?#\s:]+)/i.exec(baseUrl.trim());
  const host = m?.[1];
  if (!host) return null;
  /* IPv4 literal, or a bracketed IPv6 one. Neither can carry a certificate anybody checks. */
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith("[") ? "lan" : "ts";
}

/**
 * WHICH SUGGEST CONTROL THE SCREENER GETS, if any — a decision, so a function rather than a
 * condition in a render. A STANDALONE install spends nothing: the model is the installer's
 * own, so its control names no price and says whether there is a model at all. A HOSTED
 * install spends an account's allowance, so the question is a browser tab's — what would this
 * cost — answered by the account. `null` is a control not offered, three states under one
 * rule, never a spend control with nothing behind it: no door yet or no shell answer (a
 * control chosen on a guess changes its mind), a hosted install with no session (every press
 * could only be refused), and anything a later door adds — the arms are named, not defaulted.
 */
export type SuggestDoor = "local" | "cloud" | null;

/**
 * IS THERE A LIVE HOSTED SESSION BEHIND THIS WINDOW — asked of the engine, never remembered
 * from the launch frame. Cloud arms used to read `status.credentialState === "ready"`, a
 * LAUNCH-TIME SNAPSHOT ("the value AT LAUNCH, never updated in place",
 * `apps/sidecar/src/protocol.ts`): sign in through the window's own surface and it still says
 * `absent`, so six settings panes and three Screener controls stayed missing for the session.
 * The window already polls `GET /health` on the cloud door, and these rules take that answer:
 * `"live"` = the CURRENT engine's `/health` said `signedIn`; `"out"` = signed out or a
 * definitive refusal to renew; `"unknown"` = not asked yet or no bridge — withheld.
 */
export type HostedSession = "live" | "out" | "unknown";

export function suggestDoorFor(status: EngineStatus | null, session: HostedSession): SuggestDoor {
  if (status?.mode === "local") return "local";
  /* PAIRED TO ANOTHER COMPUTER — `null`, and it is `null` rather than `"cloud"` for the reason
     the whole of this function's `null` arm exists. `CloudSuggest` prices a batch against an
     ACCOUNT's ledger and watermark, and a host has neither: it is a standalone install with a
     model of its own or with none. Rendering the hosted ladder there would quote a price against
     a ledger that does not exist, which is precisely the "spend control with nothing behind it"
     this rule forbids — and it would be the worse kind, because the quote would look real.
     Offering the host's own model through the proxy is a real control and a later slice's; until
     something serves it, nothing is offered and nothing lies. */
  if (isDesktopHost(status)) return null;
  // LIVE, not merely configured: a purchase control offered on a maybe is a purchase control
  // that refuses. See {@link HostedSession} for why this is the engine's live answer and not the
  // launch frame's `credentialState`.
  if (status?.mode === "cloud" && session === "live") return "cloud";
  return null;
}

/**
 * WHICH DOOR'S AWAY RESPONDER THIS INSTALL MAY CONFIGURE — a function, for `gateFor`'s reason.
 * STANDALONE — `"local"` whenever the engine is serving: the pass lives in
 * `@trafficflow/services`, which the desktop engine bundles, and the sidecar's drain sends
 * with this machine's own SMTP dial — the smaller promise stated on the pane ("Replies are
 * sent while ohmail is open on this computer"). A credential the engine cannot read does not
 * withhold the CONTROL: the responder is configuration, and gating on the password hides the
 * setting exactly when somebody is mid-setup. HOSTED, SIGNED IN — `"cloud"`: forwarded with
 * the bearer. NOT SIGNED IN — `null`. `DesktopGate` reads this answer, never the mode.
 */
export function awayDoorFor(
  status: EngineStatus | null,
  session: HostedSession,
): "local" | "cloud" | "host" | null {
  if (status?.mode === "local") return "local";
  /* PAIRED TO ANOTHER COMPUTER — a THIRD arm, because the wire works and only the promise is
     different. The engine forwards `GET/PUT /away-responder` to the host with the bearer exactly
     as it forwards them to an account, so the row that is written is the host's own and the
     host's drain sends from it. What may not be borrowed is either of the other two sentences:
     Cloud's is always-on and false here, and the standalone one names THIS computer while the
     replies go out from the other one. It is the standalone promise about a different machine —
     "while ohmail is open on {host}" — and that is what the third arm selects. */
  if (isDesktopHost(status)) return session === "live" ? "host" : null;
  return status?.mode === "cloud" && session === "live" ? "cloud" : null;
}

/**
 * WHETHER THIS INSTALL MAY ASK ABOUT SETTINGS FOUND ON A MAILBOX — the profile-import card's
 * door rule, a pure function for `gateFor`'s reason. It returns the SAME shape as
 * `awayDoorFor` and is still deliberately separate: they ask different questions, and a change
 * to either must not be a silent change to the other (`accountDoorFor`'s rule). STANDALONE —
 * always, even without the mailbox password: the card's resting question is a marker read the
 * engine answers without dialling, and gating on the credential would silence the ask exactly
 * when somebody is mid-setup. HOSTED, SIGNED IN — the engine forwards the three routes to the
 * account with the bearer. Signed out — `null`, `suggestDoorFor`'s rule.
 */
export function profileImportDoorFor(
  status: EngineStatus | null,
  session: HostedSession,
): "local" | "cloud" | null {
  if (status?.mode === "local") return "local";
  /* PAIRED TO ANOTHER COMPUTER — the CLOUD shape, and this is the one branch in the family where
     the paired door is not a third thing. The three routes are forwarded to the host with the
     bearer exactly as they are forwarded to an account, the durable answer is the host's, and the
     question the card asks — "this mailbox arrived carrying settings; shall I apply them?" — is
     asked once for the mailbox rather than once per machine reading it. A person answering here
     answers for the install that organizes, which is what the host is. */
  if (status?.mode === "cloud" && session === "live") return "cloud";
  return null;
}

/**
 * WHETHER THIS INSTALL MAY ADMINISTER A HOSTED ACCOUNT FROM ITS SETTINGS — the gate on all
 * that belongs to an ACCOUNT rather than this machine: the consent row (`local-consent.ts`),
 * the Screener's spend wire (`cloud-suggest.ts`), and the Subscription, Security and Account
 * panes. Deliberately NOT {@link awayDoorFor}: the responder answers `"local"` standalone,
 * this stays `null` there — no account, no ledger, no watermark, no second factor (it DOES
 * store its own screening window since `consentRoutes` mounted on `localRoutes`). HOSTED,
 * SIGNED IN — the routes forward with the bearer; otherwise `null`. The signed-in test is
 * {@link HostedSession}, never `credentialState` (a launch frame, never rewritten).
 */
export function accountDoorFor(
  status: EngineStatus | null,
  session: HostedSession,
): "cloud" | null {
  /* PAIRED TO ANOTHER COMPUTER — `null`, the standalone door's answer for the standalone
     door's reason: no HOSTED account behind this window — the far side is a computer of the
     person's own running the same app, with no subscription, no second factor, no ledger.
     Left as `"cloud"` this one expression would have opened FOUR panes onto an account that
     does not exist and priced a batch against no ledger at all — why the eleven read one
     seam. `null` rather than a third arm because there is nothing to put in these panes: a
     host's own subscription belongs to the host's window; this install administers nothing. */
  if (isDesktopHost(status)) return null;
  return status?.mode === "cloud" && session === "live" ? "cloud" : null;
}

/**
 * WHICH CONSENT ROW THIS INSTALL WRITES INTO, and which SHAPE of it — a pure function,
 * separate from {@link accountDoorFor} because the questions parted when a cloud door stopped
 * meaning a hosted account. `"cloud"` — a HOSTED account's own row, folders storable there.
 * `"standalone"` — this machine's own `account_settings`, or a paired host's: the same ten
 * calls, one field short (no folder verb, so the flag is declared unstorable). `null` — no
 * door, or a hosted door with no session. THE PAIRED DOOR IS `"standalONE"`: it reads
 * `accountDoorFor` false and `firstRunDoorFor` null, so without a rule of its own it would
 * get NO consent transport — a silently missing screening window; its far side IS standalone.
 */
export function consentDoorFor(
  status: EngineStatus | null,
  session: HostedSession,
): "cloud" | "standalone" | null {
  if (status?.mode === "local") return "standalone";
  if (isDesktopHost(status)) return session === "live" ? "standalone" : null;
  return status?.mode === "cloud" && session === "live" ? "cloud" : null;
}

/**
 * WHETHER THIS INSTALL MAY OFFER HOST MODE — the Devices pane's door rule, a pure function
 * for `gateFor`'s reason. STANDALONE ONLY, and the boundary is the product: host mode
 * publishes the mail engine on THIS computer, and on the standalone door that engine holds
 * the whole mailbox — something real to serve. An install mirroring a hosted account has
 * nothing of its own to publish (its devices should talk to the hosted service directly), so
 * the pane is withheld structurally rather than offered onto the shell's
 * `local-door-required` refusal — the shell enforces the same rule one layer down; this keeps
 * it unreachable from the UI. `null` also covers "no door yet" and "no shell answer".
 */
export function hostDoorFor(status: EngineStatus | null): "local" | null {
  return status?.mode === "local" ? "local" : null;
}

/**
 * WHETHER THE GUIDED SETUP FLOW EXISTS IN THIS WINDOW — the first-run stage's door rule.
 * STANDALONE ONLY, and the boundary is which install the flow is ABOUT. Standalone: the flow
 * is this install's own — the consent that lets this machine re-arrange the mailbox is
 * written here (`POST /local/mailboxes/:id/organize`), the model is a property of the
 * install. Hosted: the account's setup has already been run elsewhere and its answers live on
 * the hosted row — a second stage would re-ask a given consent, and its "Start over" would
 * offer to forget a mailbox other devices mirror; withheld structurally (`AppShell` renders no
 * stage without a host). No door or no shell answer — `null`: the needed screen is `DoorChooser`.
 */
export function firstRunDoorFor(status: EngineStatus | null): "local" | null {
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
 * The same, for the browser handoff — an address and a code, and no password anywhere. The
 * ADDRESS is still asked for, and it is not a credential: it is what this install configures
 * its engine for — the handoff proves who you are, not which mailbox this machine mirrors.
 * The code is NOT pattern-checked beyond being present: a server-minted opaque value, and a
 * shape assertion would be a second, quieter definition of what the server issues — working
 * until the issuer changes, then refusing every valid code with a sentence nobody can see.
 */
export function handoffProblem(address: string, code: string): string | null {
  if (!address.trim()) return "Your ohmail address is missing.";
  if (!address.includes("@")) return "That does not look like a mailbox address.";
  if (!code.trim()) return "Paste the code the browser showed you.";
  return null;
}

/**
 * ═══ DOOR TWO: ANOTHER COMPUTER OF THE PERSON'S OWN ════════════════════════════════════════
 *
 * Two steps, the self-hosted door's shape and for its reason: the link is PROVED before anything
 * is committed, so a mistyped or spent link is a sentence about the link rather than a pairing
 * that half-happened. What differs is that this door's first step also has to establish WHOSE key
 * to trust, and that fact comes off the link rather than off the network.
 */

/**
 * WHY A LINK WAS REFUSED, as a closed set of KINDS — never as a sentence. The words live in
 * `desktopDoor`, a window-only namespace (`vite.config.ts`'s `WINDOW_ONLY_NAMESPACES`): the
 * served host client does not carry it, so a catalogue read HERE would ship the namespace to
 * a phone or draw raw dotted keys — the decisions answer kinds, and `DoorChooser`'s
 * `sentenceForKind` owns the sentences. CLOSED with an explicit escape: an unrecognised code
 * once composed a catalogue key that did not exist and threw inside a render; an unknown kind
 * maps to no sentence and the card shows the ENGINE's own words. `not_sharing` is absent —
 * no host mode means no listener (`unreachable`), and `/hello` never answers `local` remotely.
 */
export const HOST_REFUSAL_KINDS = [
  "cleartext",
  "no_pin",
  "pin_mismatch",
  "not_ohmail",
  /* A DESKTOP RUNNING OHMAIL THAT HAS NOT BEEN SET UP TO SERVE ITS OTHER DEVICES — the single
     most likely wrong-link case, and the one where a translated sentence is worth the most: the
     remedy is a switch on the OTHER machine, under its Settings → Devices. Left to fall back on
     the engine's own words it would be the one common failure that reads in English inside a
     German window. */
  "local",
  "managed",
  "selfhost",
  "pairing_invalid",
  /* AN EARLIER START-OVER IS STILL PENDING. Not the success above: nothing was paired, the token
     was not spent, and the app must be reopened before this can be tried again. */
  "restart_required",
  /* THE HOST WAS REINSTALLED AT THE SAME ADDRESS — a different account behind a familiar name.
     It is on this list rather than falling through to the engine's own words because it is the
     one refusal with a VERB attached: the sentence has to name what Start over costs, and a
     translated sentence is the only place that fits. */
  "pair_account_mismatch",
  "unreachable",
] as const;
export type HostRefusalKind = (typeof HOST_REFUSAL_KINDS)[number];

/**
 * The three the WINDOW decides on its own, before anything is dialled, plus "nothing pasted".
 * Two of them are also engine kinds — a cleartext origin and a missing pin are facts about the
 * link, and the engine would reach the same verdict after opening a connection this app has
 * already decided not to use.
 */
export type HostLinkRefusal = "missing" | "shape" | "cleartext" | "no_pin";

/** What a refused engine step answers: what it was, and what the engine itself said. */
export interface HostRefusal {
  /** A {@link HostRefusalKind}, or any other string the engine named — the card maps it. */
  kind: string;
  /** The engine's own sentence, when it gave one. The fallback for an unmapped kind. */
  message: string | null;
  /**
   * The HTTP status, when there was an answer to read one from — `null` for a throw.
   *
   * The card's last resort, and it exists because the two above can both be empty: an engine that
   * refuses with a body this window cannot parse has said something, and "(409)" is a worse
   * sentence than a real one and a better one than a blank card.
   */
  status: number | null;
}

/** What the link step ended as: the parsed link and what to call it, or why it was refused. */
export interface HostLinkStep {
  link: PairLink | null;
  /** The label the card names — {@link hostLabelOf} of the link's origin. */
  host: string | null;
  /** Which network, for the "check this" sentence. */
  via: "lan" | "ts" | null;
  refusal: HostLinkRefusal | null;
}

/**
 * THE FIRST THING WRONG WITH THE LINK, decided in the WINDOW, before the engine is asked. All
 * three refusals are facts about the LINK ITSELF — no dial can change the answer — and they
 * are the phone's three (`apps/mobile/src/net/pairing.ts`): the same ceremony, so a second
 * set of rules would be a second opinion about which links are safe. NOT A PAIRING LINK —
 * `parsePairLink` refuses a query string, a wrong path, a foreign scheme, an empty fragment,
 * a `k2` this build cannot read; ONE kind for all, naming the SHAPE wanted. CLEARTEXT is
 * refused before anything is sent; NO PIN where one is needed — `originNeedsPin`, the shared
 * rule. A refused link returns `link: null` even where it parsed — no reaching past it.
 */
export function hostLinkProblem(text: string): HostLinkStep {
  const none = { link: null, host: null, via: null };
  if (!text.trim()) return { ...none, refusal: "missing" };
  const link = parsePairLink(text);
  if (link === null) return { ...none, refusal: "shape" };

  const host = hostLabelOf(link.origin);
  const via = hostViaOf(link.origin);
  if (link.origin.startsWith("http://")) return { link: null, host, via, refusal: "cleartext" };
  if (link.pin === null && originNeedsPin(link.origin)) {
    return { link: null, host, via, refusal: "no_pin" };
  }
  return { link, host, via, refusal: null };
}

/**
 * The refusal a bridge answer carries, or null when it succeeded. Two routes put the
 * meaningful kind in two places, and both are read: `/cloud/probe` answers a GENERIC `code`
 * (`invalid_request`, `cloud_probe_failed`) with what happened in `details.kind`
 * (`cleartext`, `no_pin`, `not_ohmail`) — reading `code` there collapses eight refusals into
 * two; `/cloud/pair-redeem` has no `details` at all — its `code` IS the kind
 * (`pair_account_mismatch`, `already_signed_in`, `restart_required`). So `details.kind` wins
 * where it exists and `code` is the fallback; reading only `details.kind` sent every redeem
 * refusal to the engine's English, `restart_required` shown as an error, not a worked pairing.
 */
async function refusalOf(res: Response): Promise<HostRefusal | null> {
  if (res.ok) return null;
  try {
    const parsed = (await res.json()) as {
      error?: { code?: string; message?: string; details?: { kind?: string } };
    };
    return {
      kind: parsed.error?.details?.kind ?? parsed.error?.code ?? "",
      message: parsed.error?.message ?? null,
      status: res.status,
    };
  } catch {
    /* Not JSON. The status is all there is to say, and saying it beats inventing a reason. */
    return { kind: "", message: null, status: res.status };
  }
}

/**
 * STEP ONE: ask the ENGINE what is at the link's origin, and whether its key is the one the
 * link names — null when a computer running ohmail is there. NOTHING IS CONFIGURED HERE, the
 * self-hosted door's finding applied to this one: `enforceMirrorOwner` discards the previous
 * mirror when the door changes, so configuring for a candidate would cost somebody their
 * whole copy for a typo. A refusal leaves the settings file, the previous door, its mirror
 * and its session exactly where they were. The window cannot dial — the engine is the process
 * that looks, handed the origin and the pin as a CANDIDATE.
 */
export async function proveHostLink(link: PairLink): Promise<HostProof> {
  let res: Response;
  try {
    res = await bridgeFetch("/cloud/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      /* THE TOKEN IS NOT SENT. Proving what is at an address needs the address and the key; the
         credential is spent once, at the redeem, and a probe that carried it would spend it on a
         step the person has not agreed to yet. */
      body: JSON.stringify({ origin: link.origin, flavor: "desktop-host", hostPin: link.pin }),
    });
  } catch (err) {
    return { base: null, refusal: { kind: "unreachable", message: sentence(err), status: null } };
  }
  const refusal = await refusalOf(res);
  if (refusal !== null) return { base: null, refusal };

  /**
   * THE BASE THE ENGINE SAYS ANSWERED, and this window does not recompose it. A desktop host
   * serves its API at the ROOT; a self-hosted stack serves it under `/api`. The door composed
   * `/api` unconditionally, which made a desktop host unreachable from a desktop by
   * construction. The engine discovers which shape answered, so the base it reports is a
   * measurement; deriving it again here would be a second opinion that parts company the day
   * a third shape exists. The ORIGIN is the fallback, not a default: an engine that predates
   * the field has not learned to serve this door either, so the fallback is only exercised
   * on a build where the redeem below will refuse anyway.
   */
  try {
    const body = (await res.json()) as { base?: unknown };
    return {
      base: typeof body.base === "string" && body.base !== "" ? body.base : link.origin,
      refusal: null,
    };
  } catch {
    return { base: link.origin, refusal: null };
  }
}

/** What {@link proveHostLink} ended as: the base to configure, or why it was refused. */
export interface HostProof {
  /** The base the ENGINE says answered — handed to `engine_configure` verbatim. */
  base: string | null;
  refusal: HostRefusal | null;
}

/**
 * STEP TWO: configure the door and redeem the link. The ORIGIN and the PIN go to the shell,
 * which writes them into the settings file and rebuilds the engine. The TOKEN does not: it
 * goes down the bridge to `POST /cloud/pair-redeem`, which exchanges it for the bearer pair
 * and seals that under this install's key — the shell refuses a payload carrying a secret,
 * and a command argument is process state in the shell. CONFIGURE-THEN-REDEEM, never the
 * other way: the token is spent once, and redeeming against an engine still pointed at the
 * previous door would seal a session into a mirror about to be discarded, with no second
 * link to try.
 */
export async function enterHostDoor(
  link: PairLink,
  /** The base {@link proveHostLink} reported. The link's origin only where none was measured. */
  base: string = link.origin,
): Promise<HostDoorResult> {
  try {
    await engineConfigure({
      mode: "cloud",
      flavor: "desktop-host",
      /* THE MEASURED BASE, not the typed origin — see {@link proveHostLink}. */
      cloudUrl: base,
      hostPin: link.pin,
    });
  } catch (err) {
    return { status: null, refusal: null, problem: sentence(err) };
  }

  const settled = await settle();
  if (settled.state !== "serving") {
    return { status: settled, refusal: null, problem: stalled(settled) };
  }
  return redeemPairing(link, settled);
}

/**
 * PAIR AGAIN, IN PLACE — for an install whose pairing ended and whose mirror is still here.
 * Not `enterHostDoor` again: choosing the door writes settings and REPLACES the engine —
 * mail off the screen for a restart that changes nothing, and a reconfigure is a door change
 * `enforceMirrorOwner` could discard the promised copy over; re-pairing is two requests
 * against the running engine. THE SIGN-OUT COMES FIRST, not optional: a redeem while a
 * session is held is refused `409 already_signed_in` — and signing out FREEZES the mirror,
 * cursor and recorded owner ("the copy of your mail here is kept" stays true). A REINSTALLED
 * host is a different account, refused (`409 pair_account_mismatch`), nothing discarded.
 */
export async function pairAgainWithHost(
  link: PairLink,
  /**
   * START OVER — the person's explicit press, never an inference from the refusal.
   * `409 pair_account_mismatch` means this machine holds mail from a DIFFERENT account on
   * that computer (a host reinstalled at the same address: same address, same base, different
   * account — neither comparison the engine makes can see it), so the plain redeem is a dead
   * end. This press costs the previous account's copy on this machine, so it is a separate
   * argument a caller passes on purpose — the refusal must never select it by itself. The
   * code is also SPENT by then (the engine redeems at the host before comparing accounts),
   * so the caller needs a fresh one from that computer's Settings → Devices.
   */
  startOver = false,
): Promise<HostDoorResult> {
  try {
    await bridgeFetch("/cloud/session", { method: "DELETE" });
  } catch (err) {
    return {
      status: null,
      refusal: { kind: "unreachable", message: sentence(err), status: null },
      problem: null,
    };
  }
  return redeemPairing(link, null, startOver);
}

/** What either pairing path ended as. */
export interface HostDoorResult {
  status: EngineStatus | null;
  /** A refusal with a kind the card can translate. */
  refusal: HostRefusal | null;
  /** A sentence with no kind behind it — a shell throw, or an engine that never settled. */
  problem: string | null;
  /**
   * THE PAIRING WORKED AND THE APP MUST BE REOPENED — a THIRD outcome, neither success nor
   * refusal.
   *
   * It is its own field rather than a shape of `status` because the window routes on it before it
   * routes on anything else: a session exists, and it may not be used until the next launch has
   * performed the staged discard. Absent on every ordinary path.
   */
  restartRequired?: boolean;
}

/**
 * SPEND THE TOKEN. Shared by both paths so "what a redeem is" has one definition.
 *
 * `kind` is sent even though the engine composes its own from `process.platform` and ignores what
 * arrives — it is the same machine, so the two agree by construction. It stays on the wire because
 * the field is part of the request's meaning: a reader of this call should see that this install
 * declares what it is, and the day the engine stops composing it, the absence would be a silent
 * "web" on somebody's Devices pane rather than a compile error.
 */
async function redeemPairing(
  link: PairLink,
  settled: EngineStatus | null,
  /** The person's explicit Start over. Never inferred from a refusal — see {@link HostDoorResult}. */
  startOver = false,
): Promise<HostDoorResult> {
  let res: Response;
  try {
    res = await bridgeFetch("/cloud/pair-redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      /* THE EXACT BOOLEAN, and only when asked for. The engine matches `startOver === true` and
         refuses every truthy near-miss — `"true"`, `1`, `{}` — as an ordinary pairing, because
         this flag discards somebody's mail and a value nobody deliberately wrote must not select
         it. Spread rather than always-present so an ordinary pairing sends no such field at all.

         `kind` IS NOT SENT. The engine composes the device kind from its own `process.platform`
         and ignores anything on the wire: what platform this install runs on is that process's
         own fact, not something a caller over the bridge may assert. Sending it was harmless and
         misleading — a reader would think this window decided it. */
      body: JSON.stringify({ token: link.token, ...(startOver ? { startOver: true } : {}) }),
    });
  } catch (err) {
    return {
      status: settled,
      refusal: { kind: "unreachable", message: sentence(err), status: null },
      problem: null,
    };
  }

  /* ── A REDEEM ATTEMPTED WHILE A DISCARD IS PENDING IS A REFUSAL, NOT THE SUCCESS ──────────
     These two states share a restart and nothing else, and collapsing them put a false sentence
     on screen: the success card reads "Pairing finished — this computer is now paired with
     {host}", and on this arm NOTHING was paired. What is pending is an EARLIER start-over, and
     the app has to be reopened before this pairing can even be attempted.
     The engine refuses this one BEFORE spending the token, deliberately — so the link in the
     person's hand still works after the restart, which is the opposite of the account-mismatch
     refusal and worth saying. It stays a refusal here and gets its own sentence. */
  const refusal = await refusalOf(res);
  if (refusal !== null) return { status: settled, refusal, problem: null };

  /* ── `res.ok` IS NOT "PAIRED AND READY", AND TREATING IT AS SUCH WAS THE DEFECT ────────────
     A start-over answers 200 — the pairing genuinely succeeded, the code is spent and the session
     is sealed — but activates nothing: the previous account's mirror is an open database that
     cannot be removed under the process holding it, so the discard is staged for the next launch
     and every read stays refused until then. Reported as an ordinary success, the window would
     have shown a signed-in mail client over an engine answering 409 to everything.

     So the BODY decides, not the status. An ordinary pairing's 200 carries no `restartRequired`
     at all, which is why the check is for the exact `true` rather than for the field's presence. */
  try {
    const body = (await res.json()) as { restartRequired?: unknown };
    if (body.restartRequired === true) {
      return { status: settled, refusal: null, problem: null, restartRequired: true };
    }
  } catch {
    /* A 200 whose body will not parse is still a completed ordinary pairing as far as anything
       here can tell; the status read below is what the window actually routes on. */
  }

  return { status: await engineStatus(), refusal: null, problem: null };
}

/**
 * WHAT THIS INSTALL CALLS ITSELF ON THE HOST'S DEVICES LIST — A CENSUS NOW, NOT A WIRE VALUE.
 * The engine composes the device kind from its own `process.platform` and ignores the wire,
 * deliberately: an install's platform is that process's own fact, not something a caller over
 * the bridge may assert; sending it too was harmless but misleading, so the redeem sends only
 * the token. What this still buys is the parity check: `desktop-host-door.test.ts` holds this
 * function against the server's admitted set AND the engine's own derivation, so a divergence
 * reddens here, cheaply — not as a 400 after a single-use code was spent (the
 * `desktop-mac`/`desktop-macos` split's cost).
 */
export function desktopDeviceKind(platform: string = BUILD_PLATFORM): string {
  switch (platform) {
    /* `desktop-macos`, NOT `desktop-mac`. The server admits a CLOSED set
       (`PAIRED_DEVICE_KINDS`, `packages/services/src/auth/session-lifecycle.ts`) and refuses
       anything outside it with a 400 — so the shorter spelling would have failed every pairing
       from a Mac, at the redeem, after the token had been spent. The engine's own
       `desktopDeviceKind(process.platform)` (`apps/sidecar/src/cloud-signin.ts`) has said
       `desktop-macos` all along; this is the same vocabulary and it has to be the same word.
       `desktop-host-door.test.ts` holds all three against the shared set rather than against
       literals, so a rename there reddens here instead of failing in front of somebody. */
    case "darwin": return "desktop-macos";
    case "win32": return "desktop-windows";
    /* Linux AND anything this app has no word for. `machineWord()` is deliberately NOT the route:
       it collapses those two cases into "computer" and it goes through the CATALOGUE, so the kind
       a German install declared would depend on a translation. This is a fact about the build. */
    default: return "desktop-linux";
  }
}

/**
 * How long the window waits for a reconfigured engine to announce itself: long enough that a
 * slow first start is not reported as failure, short enough that an engine which will never
 * serve is said out loud. MINUTES, NOT SECONDS: thirty seconds was chosen against a cold-disk
 * open and did not cover Postgres CRASH RECOVERY, bounded by the write-ahead log — measured
 * at roughly 305 MB/s, so tens of accumulated gigabytes took near two minutes every launch
 * and read as a failed engine. The log is bounded now (the engine checkpoints on a timer), so
 * the budget covers the ONE launch that heals an install which grew a large log before that.
 * The bound ends a WAIT and returns the last status seen — it never stops or kills the engine.
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
   * A HOST THE PROBE NAMED AS THE ONE THAT WOULD HAVE WORKED, and the field it belongs in.
   *
   * Structured beside {@link problem} rather than only inside it, because the sentence is for
   * reading and this is for PRESSING: the door offers it as a control and fills the field. Null
   * whenever the refusal named no host, which is every refusal that is not a certificate hostname
   * mismatch with a resolvable answer — see {@link probeTlsRefusal}.
   */
  suggestion?: HostSuggestion | null;
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
 * WHETHER THIS SUBMIT IS A RECONFIGURE OF THE MAILBOX ALREADY OPEN — picks which order the
 * door takes; exported so a test can drive it without a shell. `standing` is what the shell
 * said BEFORE this attempt; absent means `false`, the first-connect order. Every clause is
 * load-bearing: `serving` WITH a `mailboxId` (a starting engine has no row to `PATCH`);
 * `mode === "local"` (choosing local over a hosted install is a door SWITCH);
 * `credentialState === "ready"` (the sealed password is exactly what a relaunch would dial;
 * `absent`/`unreadable` have nothing to leak); ADDRESS UNCHANGED (a new address makes
 * `ensureLocalWorld` INSERT a fresh row, `identity.ts` — first-connect is the safe order there).
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
 * SEAL THE PASSWORD — the one request in this file that carries a secret, written once so the
 * two orders below cannot disagree about what it sends; null on success, else the sentence to
 * show, and the engine tries the password before sealing it. THE TRANSPORT GOES WITH IT: this
 * route reads `mailbox_credentials`, and on a first connect there is no row — a pass-only
 * patch merged over absent meta got "imap host is required" (issue #5). A complete patch is
 * also what allows sealing first on the RECONFIGURE order: `probedImapMeta` dials the MERGED
 * PATCH, so an engine serving host A proves the credential for host B, and the stored `meta`
 * records the host DIALLED — held under the row's lock (409 rather than an unprobed combination).
 */
async function sealLocalPassword(
  mailboxId: string,
  imap: LocalTransport,
  password: string,
  /**
   * THE OUTGOING TRANSPORT, AS A BLOCK THE SERVICE CAN STORE — not only the witness below.
   * With two mailboxes the send path reads the MAILBOX's own `smtp` credential row
   * (`makeSendAdapter`: the smtp row, else the imap host on 587) — a mailbox without one
   * would submit through another mailbox's server with its own password. So the block travels
   * with the seal and the service writes an `smtp` row, probed first exactly as the hosted
   * `PATCH /mailboxes/:id` does; `null` where the form and preset name no outgoing server —
   * nothing written, and `smtpHost: ""` below still records the outgoing-less pair.
   */
  smtp: LocalTransport | null,
  /**
   * THE OUTGOING SERVER THIS PASSWORD IS BEING SAVED FOR — recorded with the credential,
   * never dialled by this request. One password covers both transports, and only the incoming
   * server used to be written down: a change touching only the outgoing server left the
   * stored password offerable to a server nobody had named. `""` is a STATEMENT, not a
   * silence: the password was saved for a pair with nothing outgoing, and a submission server
   * appearing afterwards without the password being saved for it is refused. ABSENT means
   * something weaker ("this row says nothing") — every credential sealed before this key
   * existed carries that — so the two must not be spelled the same.
   */
  smtpHost: string,
): Promise<DoorRefusal | null> {
  try {
    /* -- `/local/…`, AND THAT IS NOT A STYLE CHOICE ------------------------------------------
     * The shared `PATCH /mailboxes/:id` is `stepUp: true`, and this door's second-factor
     * stamp is written ONCE at boot — measured: re-connecting a mailbox thirty-five minutes
     * in was told "recent two-factor authentication required", on a door with no second
     * factor. It passed on the FIRST connect by luck of timing (that arm seals seconds after
     * the engine was replaced); both arms call this function now, making that success
     * structural. The local route's authority is the per-launch bearer — minted at boot,
     * added shell-side, never in this window — and it runs the SAME `MailboxService.update`
     * with the SAME probes; the older `/local/` verbs carry the argument in full. */
    const res = await bridgeFetch(`/local/mailboxes/${encodeURIComponent(mailboxId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        /* `smtpUnsettled: ""` SETTLES IT, and it is stated on every seal that carries a submission
           block. The engine's local route retries without that block when the submission dial is
           refused, writing the probe's reason into this key instead — so a repair has to say
           positively that the server is settled, or a mailbox would carry its first refusal for
           ever. `undefined` leaves whatever is stored alone, which is the wrong default here.

           WITH NO OUTGOING SERVER NAMED there is nothing to settle and nothing to refuse: the
           block is absent, the probe never runs, and the key is left as it is. */
        imap: { ...imap, pass: password, smtpHost, ...(smtp ? { smtpUnsettled: "" } : {}) },
        // The same password on both blocks: one form, one secret, two servers the person named.
        ...(smtp ? { smtp: { ...smtp, pass: password } } : {}),
      }),
    });
    return res.ok ? null : await refusal(res);
  } catch (err) {
    return { sentence: sentence(err), suggestion: null };
  }
}

/**
 * WHICH ADDRESS A MAILBOX ROW CARRIES, or `null` when this install cannot say.
 * `GET /mailboxes/:id` on the engine's own table — `cost: "read"`, no step-up, reachable at
 * any point in a launch; exported so the first-connect guard can be driven without a shell.
 * EVERY FAILURE ANSWERS `null` (a refusal, a 404, non-JSON, a row with no address), and the
 * caller reads `null` as "not provably the right row" and refuses — the safe direction; the
 * alternative is sealing a password onto a row nobody has identified.
 */
export type SettledRowAddress =
  /** The row answered, and this is the address it carries. */
  | { kind: "address"; address: string }
  /** The engine answered and the row could not be identified — a refusal, a 404, a blank address. */
  | { kind: "unreadable" }
  /**
   * THE ENGINE COULD NOT BE REACHED AT ALL, which is a different situation and not this check's
   * to report. No request will land on any row, so there is no wrong-row hazard here — and the
   * caller has a better sentence for it: the seal it goes on to attempt fails with the engine's
   * own words ("the mail engine is not answering"), which tells somebody what to do. Collapsing
   * this into `unreadable` replaced that with a sentence about mailbox identity, which is
   * accurate about nothing and actionable about less.
   */
  | { kind: "unreachable" };

export async function localMailboxAddress(mailboxId: string): Promise<SettledRowAddress> {
  let res: Response;
  try {
    res = await bridgeFetch(`/mailboxes/${encodeURIComponent(mailboxId)}`);
  } catch {
    return { kind: "unreachable" };
  }
  if (!res.ok) return { kind: "unreadable" };
  try {
    const row = (await res.json()) as { address?: unknown };
    return typeof row.address === "string" && row.address.trim() !== ""
      ? { kind: "address", address: row.address }
      : { kind: "unreadable" };
  } catch {
    return { kind: "unreadable" };
  }
}

/** The refusal both arms give, written once so the two cannot drift. */
const COULD_NOT_CHECK =
  "ohmail could not check which mailbox this copy is opening, so the password you typed was not "
  + "saved. Try again in a moment.";
const OPENING_A_DIFFERENT_MAILBOX =
  "This copy of ohmail is set up for that address but is still opening a different mailbox, so "
  + "the password you typed was not saved. Add this mailbox from Settings → Mailboxes instead.";

/**
 * Door one: this machine opens the user's own mailbox. Settings over the command, password
 * over the bridge, never the other way — the shell has no route for a password and the engine
 * none for a data directory. TWO ORDERS: a FIRST CONNECT must configure first — no mailbox
 * row exists yet, and the boot resolves `absent` and dials nothing. A RECONFIGURE must seal
 * first: configured first, a SUCCESS dials the NEW host with the PREVIOUSLY sealed password
 * before the door has asked for the new one, and a REFUSAL leaves settings naming the new
 * host while the credential names the old — the next launch configures that pair, and a
 * mailbox that worked this morning does not connect.
 */

/*
 * Sealing first is provable without changing anything: `PATCH /mailboxes/:id` dials what the
 * BODY says, so the engine still running against the old host proves the credential for the
 * new one; a refusal returns the install byte-for-byte as found. WHAT THIS ORDER DOES NOT
 * DO: it fixes the defect FROM THIS DOOR. Any other route that changes an install's servers
 * still boots against whatever is sealed — the general close is the ENGINE's: it refuses a
 * password whose recorded server disagrees with the configured one, incoming at launch and
 * outgoing at each send. That is why this function states BOTH servers when saving.
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
   * ONE transport, resolved ONCE, used by BOTH steps below: the shell is configured with it
   * and the credential is probed and stored with it, and those two must describe the same
   * dial — deriving them separately is how they drift. `smtpHost` above is the same
   * discipline on the outgoing side, where it matters MORE: the settings and the credential
   * each get that one value, and the engine refuses to send when the two disagree — two
   * spellings would produce an install that refuses its own sends.
   */
  const imap: LocalTransport = {
    host: f.imapHost.trim() || preset.imap.host,
    user,
    port: imapPort,
    secure: implicitTls(imapPort),
  };

  /**
   * THE OUTGOING TRANSPORT, resolved once for the same reason {@link imap} is: the settings
   * file and the stored credential each take it, and two spellings produce an install that
   * refuses its own sends. `null` where nothing names a submission server — the ABSENCE is
   * meaningful: `sealLocalPassword` writes no `smtp` row, and `smtpHost: ""` records a pair
   * with nothing outgoing. The USER is the incoming login — one form, one identity; a
   * submission server wanting a different one has never been offered a field here.
   */
  const smtp: LocalTransport | null = smtpHost
    ? { host: smtpHost, user, port: smtpPort, secure: implicitTls(smtpPort) }
    : null;

  /** The settings, as ONE value for the same reason `imap` is one: two spellings would drift. */
  const config: EngineConfig = {
    mode: "local",
    imap,
    ...(smtp ? { smtp: { host: smtp.host, port: smtp.port, secure: smtp.secure } } : {}),
    address,
  };

  if (reconfiguresLocalDoor(standing, address)) {
    /**
     * ── THE ROW THIS WOULD SEAL ONTO HAS TO CARRY THE TYPED ADDRESS, HERE TOO ─────────────
     * `reconfiguresLocalDoor` compares the typed address against the SETTINGS FILE's;
     * `standing.mailboxId` is "the active row for the configured address, ELSE THE OLDEST
     * ACTIVE ROW", and the two disagree once removing the seed keeps another mailbox signed
     * in: `config.json` names removed address A while `mailboxId` is survivor B, so
     * re-entering A's password sealed A's credential onto ROW B — which then syncs A's mail
     * into the mirror labelled B. Same check as the first-connect twin: `localMailboxAddress`
     * answers `null` for every failure — refused BEFORE the seal and configure, so it is free.
     */
    const standingRow = await localMailboxAddress(standing.mailboxId);
    /* `unreachable` FALLS THROUGH on purpose — see the union. The seal below fails against the
       same dead engine and says so in the engine's own words, which is the useful sentence. */
    if (standingRow.kind === "unreadable") {
      return { status: standing, problem: COULD_NOT_CHECK };
    }
    if (standingRow.kind === "address" && !sameAddress(standingRow.address, address)) {
      return { status: standing, problem: OPENING_A_DIFFERENT_MAILBOX };
    }

    /* SEAL, THEN COMMIT. Nothing about this install has changed yet, so a refusal here returns
       with the mailbox still on the configuration that was working. */
    const refused = await sealLocalPassword(standing.mailboxId, imap, f.password, smtp, smtpHost);
    if (refused !== null) {
      return { status: standing, problem: refused.sentence, suggestion: refused.suggestion };
    }

    /**
     * ── THE ONE WINDOW THIS ORDER OPENS, NAMED ────────────────────────────────────────────
     * From here until the configure returns, the CREDENTIAL names host B and the SETTINGS
     * still name host A: a configure failure or an exit here leaves the next launch offering
     * B's password to A (the catch below says so), and a scheduled send racing the interval
     * authenticates to A with B's password. Both close at one point, and not here: the ENGINE
     * refuses a password whose recorded server disagrees with the configured one, which makes
     * the window survivable. The bad state used to be the NORMAL path; now it needs a death
     * inside one `engine_configure` — narrower in the same class, and never called closure.
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

  /**
   * ── THE ROW THE ENGINE SETTLED ON HAS TO BE THE ONE THAT WAS TYPED ────────────────────
   * `settled.mailboxId` is whatever the replacement engine reports it is opening, and this
   * arm seals a password onto it — safe while an install held ONE mailbox. With several, the
   * engine reports the SEED's mailbox (the active row for the configured address, else the
   * OLDEST active row, else `""`), so a first connect made while other mailboxes are live
   * can settle on somebody else's row (remove the seed while #2 remains). So the id is
   * CHECKED against the typed address over `GET /mailboxes/:id`; a mismatch is refused with a
   * sentence about the install, and an UNREADABLE answer refuses too — never "it matched".
   */
  const settledRow = await localMailboxAddress(settled.mailboxId);
  if (settledRow.kind === "unreadable") {
    /* ── "WE COULD NOT CHECK" IS NOT "IT IS THE WRONG MAILBOX" ───────────────────────────────
     *
     * Both refuse, and refusing is right either way — an unchecked row must not be sealed onto.
     * What must NOT be the same is the sentence. `localMailboxAddress` collapses a refusal, a
     * 404, a body that is not JSON and a row with no address into one `null`, and the mismatch
     * sentence below states a confident fact about the install ("it is still opening a different
     * mailbox") that a failed read has not established. On a transient read failure that is a
     * confident claim about a state nobody observed. */
    return { status: settled, problem: COULD_NOT_CHECK };
  }
  if (settledRow.kind === "address" && !sameAddress(settledRow.address, address)) {
    return {
      status: settled,
      /* THE SENTENCE HAS TO BE TRUE ABOUT WHAT DID CHANGE, and the first draft was not. The
         configure above has ALREADY replaced the engine and rewritten the shell's settings, so
         "the password you typed was not saved" is true and incomplete: this install is now set up
         for the address that was typed while still opening a different mailbox. The check cannot
         move ahead of the configure — there is no row to read until the engine makes one — so the
         honest answer is to say both halves and name the door that does work. */
      /* ONE SENTENCE FOR BOTH ARMS. The reconfigure arm reaches the same state one step earlier
         and with less collateral, and two spellings of one refusal is how they come to disagree. */
      problem: OPENING_A_DIFFERENT_MAILBOX,
    };
  }

  /* THE PASSWORD, AND THE ONLY PLACE IT IS WRITTEN DOWN IS THE ENGINE'S OWN STORE. See
     {@link sealLocalPassword} for what the body carries and why it carries all of it. */
  const refused = await sealLocalPassword(settled.mailboxId, imap, f.password, smtp, smtpHost);
  if (refused !== null) {
    return { status: settled, problem: refused.sentence, suggestion: refused.suggestion };
  }

  /**
   * ── NOW REPLACE THE ENGINE — THE RUNNING ONE CANNOT USE THAT PASSWORD ─────────────────
   * The engine builds its IMAP adapter ONCE, at boot, from whatever password resolved then
   * (`engine.ts`: a password entered after the process is up takes effect on the next
   * launch). On this path the engine booted with no password, so the sealed credential is
   * unreachable until something re-reads it — without this the door SUCCEEDED and the app
   * stayed empty: no error, no sync, mail only after a quit and reopen. `engineConfigure`
   * with identical settings is that relaunch; a failure here is reported, not swallowed —
   * the credential IS stored, so the sentence is about the engine, and a relaunch fixes it.
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
 * Door two, entered with a code from the browser instead of a password. The SAME two steps
 * `enterCloudDoor` takes — configure, settle, one request over the bridge — with the third
 * argument swapped; its own pair of functions rather than a flag because the two forms
 * validate different fields, and both end at `POST /cloud/signin`, where the engine decides
 * what it was handed. Nothing about the code is stored here or anywhere in this process: it
 * is worth a session for about two minutes, once, and is spent by the time this returns.
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
 * START A BROWSER HANDOFF: configure the door if it is not already, then ask the engine for
 * a commitment. THE ORDER IS FORCED AND GETTING IT WRONG IS SILENT: the verifier lives in
 * the ENGINE's memory and `engine_configure` REPLACES the engine, so the door must be
 * configured BEFORE the pair is minted — a reconfigure between minting and claiming takes
 * the verifier with it, and the code the browser shows becomes unclaimable, answered with
 * the expired-code sentence. So this configures itself, and {@link signInToCloudWithCode} —
 * which does NOT reconfigure — is the only sign-in that may finish a handoff this started
 * (`DoorChooser` remembers). A door already serving is left alone.
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
    if (!res.ok) return { challenge: null, status: settled, problem: (await refusal(res)).sentence };
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
 * WHAT TO SAY WHEN THE PASSWORD LANDED AND THE SETTINGS DID NOT — the one state the
 * seal-first ordering can leave, and the one where truth costs a longer sentence: "the
 * settings could not be written" alone would hide that the stored password is now the NEW
 * server's while the install still points at the old one. Re-opening the door finishes it,
 * and the retry is safe: the credential is still `ready` and the address has not moved, so
 * the attempt takes this same arm, re-proves the password and commits the settings.
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
async function refusal(res: Response): Promise<DoorRefusal> {
  const { problem, suggestion } = await refused(res);
  return { sentence: problem, suggestion };
}

/**
 * A refusal as both halves: the sentence for the person, and the CODE for the caller.
 *
 * Split out because one refusal is not merely text — `mirror_owner_mismatch` tells the window that
 * the next attempt has to take a different path, and a reader that only ever saw the message would
 * have to match on English to find that out.
 */
async function refused(
  res: Response,
): Promise<{ problem: string; code: string | null; suggestion: HostSuggestion | null }> {
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
    /* The probe can say more than its own sentence does — see {@link probeTlsRefusal}, which is
       also what the self-hosted door reads, so the two cannot diverge. */
    const sharper = probeTlsRefusal(parsed.error?.details);
    const message = sharper?.sentence ?? parsed.error?.message ?? parsed.error?.code;
    if (message) return { problem: message, code, suggestion: sharper?.suggestion ?? null };
  } catch {
    /* not JSON */
  }
  return {
    problem: res.statusText ? `${res.status} ${res.statusText}` : `The request was refused (${res.status}).`,
    code: null,
    suggestion: null,
  };
}

/**
 * THE PROBE ALREADY KNOWS THE ANSWER — SAY IT, instead of sending the person to their
 * provider. `mailbox_probe_failed` carries `details.tls`, and a HOSTNAME MISMATCH may name
 * the host the certificate covers (`suggestedHost`, the vanity-name shape). The door read
 * `error.message` alone — "Check the IMAP host with your provider" while holding the exact
 * host to use; the wording is the hosted app's, verbatim (`probe_tls_hostname_suggest` /
 * `probe_tls_hostname` in `apps/webapp/messages/en.json`). NOT a trust change: the sentence
 * is only SHOWN — the next probe verifies strictly against the retyped host
 * (`suggestedHostFor`, `packages/api/src/imap-probe.ts`). Null for every unrecognised shape.
 */
export function probeTlsSentence(details: unknown): string | null {
  return probeTlsRefusal(details)?.sentence ?? null;
}

/** A host the probe named, and which of the two transports it is the host for. */
export interface HostSuggestion {
  host: string;
  transport: "imap" | "smtp";
}

/** A refusal as both halves: the sentence to read, and the host to press. */
export interface DoorRefusal {
  sentence: string;
  suggestion: HostSuggestion | null;
}

/**
 * THE ONE READING OF `error.details` — one because two doors are shown the same answer. The
 * standalone and self-hosted doors are two screens over one product handed the same
 * `error.details`; read in two places, they came to describe one refusal in two ways.
 * `desktop-door-tls-census.test.tsx` drives both and asserts they say the same thing about
 * every shape. The suggestion is returned STRUCTURED as well as inside the sentence — a host
 * somebody can press is not one they must retype; the hosted web app has offered the
 * correction as a control since the detail existed, and this is that half.
 */
export function probeTlsRefusal(details: unknown): DoorRefusal | null {
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

  /* THE TRANSPORT DECIDES WHICH FIELD, so it is read once here and travels with the host. An
     outgoing mismatch that filled the incoming field would put the right server in the wrong box,
     which is worse than making somebody type it. */
  const transport = d.transport === "smtp" ? "smtp" : "imap";
  const protocol = transport === "smtp" ? "SMTP" : "IMAP";
  const opening =
    `That server's certificate is for ${certHost}, not ${expectedHost}, ` +
    "so we stopped before sending the password.";

  const suggestedHost = str(tls.suggestedHost);
  return suggestedHost
    ? {
        sentence: `${opening} It answers to ${suggestedHost} — use that as the ${protocol} host.`,
        suggestion: { host: suggestedHost, transport },
      }
    : { sentence: `${opening} Check the ${protocol} host with your provider.`, suggestion: null };
}

/** Whatever was thrown, as something a person can read. Shared with `self-host.ts`; see {@link stalled}. */
export function sentence(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message || "Something went wrong and said nothing about what.";
}
