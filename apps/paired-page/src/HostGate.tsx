/**
 * THE HOST-CLIENT GATE — which of two things this browser is looking at. Either it holds a
 * pairing (a refresh token the BearerManager found), and the answer is the mail client — the
 * SAME frame over the mail ground the desktop window and app.ohmail.app mount, over the shared
 * `HttpAdapter` in bearer mode — or it does not, and the answer is the pairing landing, which is also where
 * a session that DIES mid-use lands: rendering mail past a revocation would be a mailbox that
 * silently stopped being live. `baseUrl: ""` (root-relative on the served origin); the
 * `headers` seam injects Authorization; the `fetch` is the manager's, with its single 401
 * recovery; no cookie option is touched — bearer-only in both directions, by construction.
 */

/*
 * The mirror is in memory, rebuilt per page load from the computer this page is served FROM —
 * a persistent mirror needs a server-confirmed owner id, which this door cannot read. Only the
 * queued changes stay in this browser, keyed by the pairing (`host-engine.ts`). A
 * `sendSurfaceMaxTotalBytes` IS passed ({@link HOST_SEND_MAX_TOTAL_BYTES}): a send here rides
 * the host door's adapter and the door declares exactly this ceiling on its service bag
 */

/*
 * (`apps/sidecar/src/host-listener.ts`) — absent, the compose form would promise the strict
 * hosted constant, under-selling the door.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useFrame } from "@ohmail/app/frame";
import { BrowserGeneralSettings, PairedScreenerSettings } from "@ohmail/app/settings/browser";
import {
  autoFiledVia,
  screeningVia,
  NONE,
  type FeatureEntry,
  type HostContract,
  type HostLanguage,
} from "@ohmail/app/host";
import {
  browserMailParts,
  browserOpenLink,
  MailFrame,
  useBrowserMail,
} from "../../webapp/app/shell/browser-mail";
import { EngineProvider } from "../../webapp/app/shell/engine";
import { browserNotificationHost } from "../../webapp/app/shell/notification-settings";
import {
  useFiledLetters,
  useOhboxPreference,
} from "../../webapp/app/(product)/mailbox/use-screening-preferences";
import { dropLocalStorageKeys } from "@ohmail/app-logic/session/boot-cache";
import { COMPOSE_DRAFT_PREFIX, LEGACY_COMPOSE_DRAFT_KEY } from "@ohmail/app-logic/writing/compose";
import {
  OWNED_REPLY_DRAFT_PREFIX,
  OWNED_REPLY_META_PREFIX,
  REPLY_DRAFT_PREFIX,
  REPLY_META_PREFIX,
  SENT_COPY_NOTES_PREFIX,
} from "@ohmail/app-logic/writing/mail-send";
import { SCREENER_INTENTS_PREFIX } from "@ohmail/app-logic/screener/screener-intents";
import { DELETE_INTENTS_PREFIX } from "@ohmail/app-logic/press/delete-intents";
import { ROUTING_INTENTS_PREFIX } from "@ohmail/client-engine";
import { SEND_LOCKS_PREFIX } from "@ohmail/app-logic/writing/send-lock";
import { scopeMayMount, setStorageOwner } from "@ohmail/app-logic/storage";
import { BearerManager, type SignOutOutcome } from "./bearer.js";
import { usePairedEngine, useReplacePairedEngine } from "./paired-engine.js";
import { languageOf, pairedAccountDoor, pairedHost, pairedPaneParts } from "./host.js";
import { discardHostOutbox } from "./outbox-store.js";
import { reportDiscard, reportSweep } from "./pairing-cleanup.js";
import { PairScreen } from "./PairScreen.js";
import {
  consentOverBearer,
  draftReplyOverBearer,
  gapLettersOverBearer,
  junkOverBearer,
  mailboxFactsOverBearer,
  olderBodyOverBearer,
  profileImportOverBearer,
  trashOverBearer,
} from "./transports.js";

/**
 * The host door's send-surface ceiling in raw attachment bytes — the FORM-side twin of
 * `HOST_SEND_MAX_TOTAL_BYTES` in `apps/sidecar/src/host-listener.ts`. A literal rather than an
 * import, because that module is the engine's (node-only: it imports node:http machinery) and
 * this bundle is a browser artifact; the two are held together by the suite instead.
 */
export const HOST_CLIENT_SEND_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/**
 * THE DURABLE-DECISION STORES THIS DOOR LEAVES AT REST, and what must reach them when the
 * pairing ends. The shared shell keeps five things in `localStorage` past a reload — the
 * compose scratch, the per-message reply body and its editor metadata, the durable send
 * lanes, the Screener's intent journal — and three are MAIL TEXT: a phone signed out of this
 * door must not still hold somebody's half-written message. The same rule and prefix list
 * `apps/webapp/app/sign-out.ts` applies on the hosted door. By PREFIX and not by scope,
 * deliberately: ending a pairing means this browser forgets, and a key left under a retired
 * scope is unreachable rather than gone; an exact key is a prefix of itself, which is how the
 */

/*
 * legacy un-owned compose key rides along.
 */
export const HOST_SCRATCH_PREFIXES: readonly string[] = [
  COMPOSE_DRAFT_PREFIX,
  LEGACY_COMPOSE_DRAFT_KEY,
  SEND_LOCKS_PREFIX,
  // The letters' Sent copy notes: a recipient and a subject each.
  SENT_COPY_NOTES_PREFIX,
  SCREENER_INTENTS_PREFIX,
  // The two journals beside it, and the delete one was MISSING: each is a scheduled write
  // against a mailbox, owner-keyed, and a pairing that ends without them leaves a delete or a
  // filing rule to be carried out for whoever pairs this browser next.
  DELETE_INTENTS_PREFIX,
  ROUTING_INTENTS_PREFIX,
  REPLY_DRAFT_PREFIX,
  REPLY_META_PREFIX,
  // …and the same two under the pairing scope they were typed in.
  OWNED_REPLY_DRAFT_PREFIX,
  OWNED_REPLY_META_PREFIX,
];

/** How the CURRENT unpaired state came about, for the landing: ended at the computer, or signed out here. */
type Ended = { kind: "revoked" } | { kind: "signed-out"; outcome: SignOutOutcome | null };

/** The pairing's own sign-out, stood around the frame for the Account section's door. */
const PairingSignOut = createContext<(() => Promise<void>) | null>(null);

/** The page's door of the Account section, the sign-out alone: one door for the page's life. */
function usePairedAccountDoor() {
  const signOut = useContext(PairingSignOut);
  const door = useMemo(() => (signOut === null ? null : pairedAccountDoor(signOut)), [signOut]);
  if (door === null) throw new Error("usePairedAccountDoor: no pairing stands above (PairingSignOut)");
  return door;
}

const pairedTextRoot = () => document.documentElement;

type PairedLocale = HostLanguage & NonNullable<Parameters<typeof BrowserGeneralSettings>[0]["locale"]>;
const PairedLocaleContext = createContext<PairedLocale | null>(null);

function PairedGeneralPane() {
  return <BrowserGeneralSettings locale={useContext(PairedLocaleContext)} textRoot={pairedTextRoot} />;
}

function PairedScreenerPane() {
  const { host } = useFrame();
  const ohbox = useOhboxPreference(host.wires.screening);
  const filed = useFiledLetters(host.wires.autoFiled);
  return <PairedScreenerSettings ohbox={ohbox} filed={filed} />;
}

export const PAIRED_PANE_PARTS = pairedPaneParts(usePairedAccountDoor, PairedGeneralPane, PairedScreenerPane);

/** What only this page hands the mail: a browser host's reader, no part of a stage, and that one door. */
const PAIRED_MAIL_PARTS = browserMailParts(PAIRED_PANE_PARTS);

/** The paired root supplies the language controls for adoption and the General pane. */
export function HostGate({ bearer, language }: { bearer: BearerManager; language?: PairedLocale | null }) {
  const { paired, ended, onPairPath, signOut, onPaired } = usePairedSession(bearer);
  const { scope, makeEngine, mirrorAccount, unkept, setUnkept } = usePairedEngine(bearer);
  // Re-pairing changes the scope even when the bearer object stays the same.
  const engine = useMemo(
    () => (paired ? makeEngine(bearer, scope) : null),
    [paired, bearer, scope, makeEngine],
  );
  useReplacePairedEngine(engine);

  /* Stable identities: the shared hooks (`useProfileImport`, the mail-state probe) treat their
     transport as a dependency, and a fresh object per render would re-run them per render. */
  const mailboxFacts = useMemo(() => mailboxFactsOverBearer(bearer), [bearer]);
  const profileImport = useMemo(() => profileImportOverBearer(bearer), [bearer]);
  const olderBody = useMemo(() => olderBodyOverBearer(bearer), [bearer]);
  /* The two live windows' wires, memoised for the reason above: both hooks treat the wire as the
     dependency that decides whether the section is supported at all. */
  const junk = useMemo(() => junkOverBearer(bearer), [bearer]);
  const trash = useMemo(() => trashOverBearer(bearer), [bearer]);
  /* The account's consent row, memoised for the reason above and for one more: `useConsentState`
     treats the wire as the dependency that decides whether it fetches at all, so a fresh object
     per render would re-ask `GET /consent` on every paint. */
  const consent = useMemo(() => consentOverBearer(bearer), [bearer]);
  /* The gap offer's answer, memoised for the reason above: the shell draws the offer only with it. */
  const gapLetters = useMemo(() => gapLettersOverBearer(bearer), [bearer]);
  /* The draft reply's two calls, memoised: the shared control reads the wire as a dependency. */
  const draftReply = useMemo(() => draftReplyOverBearer(bearer), [bearer]);
  const screeningWires = useMemo(() => {
    if (scope === null) return { screening: NONE, autoFiled: NONE } as const;
    const request = (path: string, init?: RequestInit) => bearer.fetch(path, init, scope);
    return { screening: screeningVia(request), autoFiled: autoFiledVia(request) };
  }, [bearer, scope]);
  /* THIS BROWSER WILL NOT KEEP A CHANGE MADE WHILE THE HOST IS AWAY: said once for the pairing, in the notice slot. */
  const unkeptHere = unkept !== null && unkept.scope === scope && !unkept.dismissed;
  const dismissUnkept = useCallback(() => setUnkept((u) => (u ? { ...u, dismissed: true } : u)), []);
  const features = useMemo(
    () => ({
      account: { name: "account", render: () => null } satisfies FeatureEntry,
      accountStrip: {
        name: "accountStrip",
        render: () => null,
        notice: unkeptHere ? () => [useUnkeptNotice(dismissUnkept)] : undefined,
      } satisfies FeatureEntry,
      screener: { name: "screener", render: () => null } satisfies FeatureEntry,
    }),
    [unkeptHere, dismissUnkept],
  );

  /**
   * WHOSE `localStorage` PARTITION THE SHARED SHELL USES ON THIS DOOR — established in
   * render, above the `AppShell` below, for `storage-owner.ts`'s ordering reason: the shell
   * reads the compose scratch in its own effect, and a child's effects run before its
   * parent's. No cookie exists here, so until this line every pairing this origin ever held
   * shared one key — and addresses are reused: the same phone, paired to a second computer at
   * an address the first one used, restored the first computer's unfinished message. `null`
   * while unpaired — correct, not a fallback: the branch below renders the pairing landing,
   * which stores nothing per account.
   */
  setStorageOwner(paired ? scope : null);

  if (onPairPath || !paired || engine === null || !scopeMayMount(scope)) {
    /* A pairing with no scope stands at a mail view's address and nobody scanned a code: its landing reads none. */
    const scans = onPairPath || !paired;
    return (
      <PairScreen
        key={scans ? "scan" : "no-scope"}
        readsCode={scans}
        bearer={bearer}
        ended={ended?.kind ?? null}
        signedOut={ended?.kind === "signed-out" ? ended.outcome : null}
        onPaired={() => {
          // Re-pairing also departs from the previous account. Sweep before adopting the new frame.
          reportSweep(dropLocalStorageKeys(HOST_SCRATCH_PREFIXES));
          onPaired();
        }}
      />
    );
  }

  /* The wires over the bearer socket, each memoized above: today's hooks treat a wire as a dependency. */
  const has: PairedHas = {
    signOut,
    mailboxes: mailboxFacts,
    wires: { gapLetters, profileImport, consent, olderBody, junk, trash, draftReply, ...screeningWires },
    features,
  };
  return (
    /**
     * KEYED BY THE PAIRING, for the reason `DesktopGate` states: partitioning the storage does not move the SHELL STATE
     * that writes into it. A tab whose pairing changes underneath it (another tab redeems a new QR on this origin, and
     * this tab's next rotation adopts the stored token) would otherwise keep the previous pairing's compose in state
     * while the storage owner beneath it has already become the new one. On the outermost element, so scope B's frame
     * never mounts for one commit over scope A's engine.
     */
    <EngineProvider key={scope} demo={false} engine={engine}>
      <PairingSignOut.Provider value={signOut}>
        <PairedFrame
          engine={engine}
          scope={scope}
          mirrorAccount={mirrorAccount}
          has={has}
          controls={language ?? null}
        />
      </PairingSignOut.Provider>
    </EngineProvider>
  );
}

type PairedHas = Omit<Parameters<typeof pairedHost>[2], "notifications" | "frame" | "language" | "openLink">;

/** The frame over this page's host, held to one record while its parts stand. */
function PairedFrame({
  engine,
  scope,
  mirrorAccount,
  has,
  controls,
}: {
  engine: HostContract["engine"];
  scope: string;
  mirrorAccount: string | null;
  has: PairedHas;
  controls: PairedLocale | null;
}) {
  /* What every browser host hands the frame for mail: made where the frame mounts, under the page's theme. */
  const frame = useBrowserMail(NONE, PAIRED_MAIL_PARTS);
  const language = useMemo(() => languageOf(controls), [controls]);
  const { signOut, mailboxes, wires, features } = has;
  const host = useMemo(
    () =>
      pairedHost(
        engine,
        {
          scope,
          mirrorAccount,
          sendCeiling: HOST_CLIENT_SEND_MAX_TOTAL_BYTES,
          build: { version: null, commit: null },
        },
        {
          signOut,
          mailboxes,
          wires,
          features,
          notifications: browserNotificationHost,
          language,
          openLink: browserOpenLink,
          frame,
        },
      ),
    [
      engine,
      scope,
      mirrorAccount,
      signOut,
      mailboxes,
      wires.gapLetters,
      wires.profileImport,
      wires.consent,
      wires.olderBody,
      wires.junk,
      wires.trash,
      wires.draftReply,
      features,
      language,
      frame,
    ],
  );
  return (
    <PairedLocaleContext.Provider value={controls}>
      <MailFrame host={host} />
    </PairedLocaleContext.Provider>
  );
}

/** The page's own sentence for a browser that refused the outbox's database, with its one answer. */
function useUnkeptNotice(dismiss: () => void) {
  const t = useTranslations("pairLanding");
  return {
    kind: "notKept" as const,
    title: t("outboxNotKept"),
    acts: [{ label: t("outboxNotKeptDismiss"), onPress: dismiss }] as const,
  };
}

function usePairedSession(bearer: BearerManager) {
  const [paired, setPaired] = useState(bearer.paired());
  /** `null` until the session ends in this page; the landing says which way it ended. */
  const [ended, setEnded] = useState<Ended | null>(null);
  /** Set across this page's own Sign out, so the death it causes is said as a sign-out. */
  const signingOut = useRef(false);
  /** `/pair` opens the landing even while paired — that is what a fresh QR scan is. */
  const [onPairPath, setOnPairPath] = useState(
    typeof window !== "undefined" && window.location.pathname === "/pair",
  );

  useEffect(
    () =>
      bearer.onSessionDead(() => {
        // WHAT IS LEFT AT REST GOES WITH THE PAIRING. `bearer.die()` has already dropped the
        // refresh token and the pairing scope, so nothing on this page can read these keys again
        // — but unreachable is not gone, and three of them are mail text on a device somebody
        // just signed out of. See HOST_SCRATCH_PREFIXES.
        reportSweep(dropLocalStorageKeys(HOST_SCRATCH_PREFIXES));
        // The changes this browser kept for the pairing go with it too, every pairing's.
        void discardHostOutbox().then(reportDiscard);
        // Land on /pair with the plain sentence — the ruled shape for a rotation failure. The
        // path is replaced (not pushed) so Back cannot return to a dead mailbox.
        window.history.replaceState(null, "", "/pair");
        setEnded(signingOut.current ? { kind: "signed-out", outcome: null } : { kind: "revoked" });
        setPaired(false);
        setOnPairPath(true);
      }),
    [bearer],
  );

  /** This page's own Sign out: the death above sweeps, and the landing says what the computer heard. */
  const signOut = useCallback(async (): Promise<void> => {
    signingOut.current = true;
    try {
      const outcome = await bearer.signOut();
      setEnded({ kind: "signed-out", outcome });
    } finally {
      signingOut.current = false;
    }
  }, [bearer]);

  const onPaired = () => {
    // Every earlier pairing's queued changes; the new one keeps its own.
    void discardHostOutbox({ except: bearer.pairScope() }).then(reportDiscard);
    window.history.replaceState(null, "", "/");
    setEnded(null);
    setOnPairPath(false);
    setPaired(true);
  };
  return { paired, ended, onPairPath, signOut, onPaired };
}
