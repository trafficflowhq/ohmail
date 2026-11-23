/**
 * The fourth door — what this phone is as the organizer, then the mailbox's
 * credentials. The limitations come first and cannot be skipped: the
 * limitations are read before any password field exists. Continue means the
 * cost was shown; "Choose differently" returns to the chooser with nothing
 * typed. Every decision on both steps lives in `src/ui/standalone-form.ts` —
 * which sentence the platform shows, whether Connect is offered, what the
 * server fields hold — because this workspace has no React Native renderer
 * and a rule written inside a component is a rule no test can drive.
 */
import { useCallback, useRef, useState } from "react";
import { Linking, Platform, TextInput, View } from "react-native";
import { router } from "expo-router";
import type { ProviderPreset } from "@ohmail/app-logic/mailboxes/connect/providers";
import { Copy } from "../src/copy";
import { refuse, sayRefusal, type Refusal } from "../src/refusal";
import { phoneEngineStart } from "../src/engine/engine-artifact";
import { engineLogSink } from "../src/engine/engine-log";
import {
  armConsentPress, holdStandaloneDoor, releaseStandaloneLaunch, sayOrganizerRestricted,
  standaloneLaunchGeneration, takeStandaloneLaunch,
} from "../src/engine/organizer-session";
import { PHONE_CLAIM_NAME, openStandaloneMailbox, standaloneAvailable } from "../src/engine/standalone-door";
import { networkNow } from "../src/net/network-door";
import { useConnection } from "../src/net/connection";
import { onboardingType } from "../src/theme/type";
import { Button, Tap, Txt } from "../src/ui/base";
import { OnboardingButton, OnboardingPage, OnboardingTag, OnboardingTitle, useOnboardingLook, useOnboardingButton } from "../src/ui/OnboardingPage";
import { Field } from "../src/ui/Field";
import { StandaloneProvider } from "../src/ui/StandaloneProvider";
import { NotifyPermission } from "../src/ui/NotifyPermission";
import { useNotifyPermission } from "../src/ui/useNotifyPermission";
import {
  EMPTY_STANDALONE,
  appPasswordNote,
  focusTargetFor,
  limitationLines,
  mayConnect,
  portFieldSaid,
  refusalField,
  refusalLinks,
  refusalNamesServerFields,
  setImapTls,
  setImapPort,
  setTyped,
  standaloneAutofill,
  withAddress,
  type ProviderLink,
  type StandaloneFields,
  type StandaloneStep,
} from "../src/ui/standalone-form";
import { useLocale } from "../src/i18n/LocaleProvider";
import { SurfaceBoundary } from "../src/ui/ErrorBoundary";
import { buildCommit } from "../src/build-info";

export default function StandaloneScreen() {
  return (
    <SurfaceBoundary surface="standalone">
      <StandaloneBody />
    </SurfaceBoundary>
  );
}

function StandaloneBody() {
  /* Subscribed to the language, so a switch in Settings redraws this screen rather than waiting
     for the next navigation — every other pushed screen does the same. */
  useLocale();
  const [step, setStep] = useState<StandaloneStep>("limits");
  const [choice, setChoice] = useState<{ preset: ProviderPreset; address: string } | null>(null);
  if (step === "limits") return <Limitations onGo={() => setStep("provider")} />;
  if (step === "credentials" && choice !== null) {
    return <Credentials {...choice} back={() => setStep("provider")} />;
  }
  return (
    <StandaloneProvider
      back={() => setStep("limits")}
      later={() => router.canGoBack() ? router.back() : router.replace("/welcome")}
      choose={(preset, address) => {
        setChoice({ preset, address });
        setStep("credentials");
      }}
    />
  );
}

function Limitations({ onGo }: { onGo: () => void }) {
  const { palette } = useOnboardingLook();
  const [showFolders, setShowFolders] = useState(false);
  const back = () => router.canGoBack() ? router.back() : router.replace("/welcome");
  const terms = (
    <OnboardingPage
      showUnsaved
      back={back}
      actions={
        <>
          <OnboardingButton label={Copy.phoneStandaloneGo} onPress={onGo} />
          <OnboardingButton label={Copy.phoneStandaloneBack} kind="quiet" onPress={back} />
        </>
      }
    >
      <OnboardingTitle text={Copy.phoneStandaloneTitle} compact />
      <View style={{ marginTop: 16, padding: 20, borderRadius: 20, gap: 8, backgroundColor: palette.sheet }}>
        {limitationLines(Platform.OS).map((line) => (
          <View key={line} style={{ flexDirection: "row", gap: 8 }}>
            <Txt accessible={false} style={{ color: palette.ink, ...onboardingType.body }}>•</Txt>
            <Txt style={{ color: palette.ink, ...onboardingType.body, flex: 1 }}>{line}</Txt>
          </View>
        ))}
      </View>
      <View style={{ marginTop: 12, gap: 8 }}>
        <OnboardingTag label={Copy.phoneFoldersTitle} large expanded={showFolders} onPress={() => setShowFolders(!showFolders)} />
        {showFolders ? <FolderGuide /> : null}
      </View>
    </OnboardingPage>
  );
  if (!standaloneAvailable({ startEngine: phoneEngineStart() })) {
    return (
      <OnboardingPage back={back}
        actions={<OnboardingButton label={Copy.phoneStandaloneBack} onPress={back} />}
      >
        <OnboardingTitle text={Copy.phoneStandaloneTitle} compact />
        <Txt variant="body" accessibilityRole="alert" style={{ color: palette.ink, marginTop: 12 }}>
          {Copy.standaloneNoEngine}
        </Txt>
      </OnboardingPage>
    );
  }
  return terms;
}

function FolderGuide() {
  const { palette } = useOnboardingLook();
  const folders = [
    ["ohmail/Screener", Copy.phoneFoldersScreener],
    ["ohmail/News", Copy.phoneFoldersNews],
    ["ohmail/Receipts", Copy.phoneFoldersReceipts],
    ["ohmail/Screened", Copy.phoneFoldersScreened],
    ["ohmail/Quarantine", Copy.phoneFoldersQuarantine],
  ] as const;
  return (
    <View style={{ backgroundColor: palette.sheet, borderRadius: 20, padding: 16, gap: 12 }}>
      <Txt variant="body" style={{ color: palette.ink }}>{Copy.phoneFoldersInbox}</Txt>
      {folders.map(([name, note]) => (
        <View key={name} style={{ gap: 2 }}>
          <Txt variant="settingsLabel" style={{ color: palette.ink }}>{name}</Txt>
          <Txt variant="body" style={{ color: palette.ink2 }}>{note}</Txt>
        </View>
      ))}
      <Txt variant="body" style={{ color: palette.ink2 }}>{Copy.phoneFoldersOther}</Txt>
    </View>
  );
}

/** What a press on Connect is doing, or the sentence it ended on. Never a dead control. */
type Phase = { k: "idle" } | { k: "opening" } | { k: "failed"; reason: Refusal };

/** Step two. Address, password, and the server settings behind a disclosure. */
function Credentials({ preset, address: pickedAddress, back }: { preset: ProviderPreset; address: string; back: () => void }) {
  const conn = useConnection();
  const { palette } = useOnboardingLook();
  const [fields, setFields] = useState<StandaloneFields>(() => withAddress(EMPTY_STANDALONE, pickedAddress, preset.id));
  const [revealed, setRevealed] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const address = useRef<TextInput>(null);
  const password = useRef<TextInput>(null);

  const start = phoneEngineStart();
  const ready = mayConnect(fields) && phase.k !== "opening";
  const onboardingButton = useOnboardingButton();
  /* The provider's App Password note, from the typed address or incoming host; null for every other mailbox. */
  const note = appPasswordNote(fields);
  /* THE NOTIFICATION ASK, held here so the sheet renders over this screen — see the call below
     for the moment it runs, which is after the mailbox is open and not before the dial. */
  const notify = useNotifyPermission();

  const connect = useCallback(async () => {
    /* ══ ONE ENGINE IN THIS PROCESS, AND THIS PRESS IS WHERE THE SECOND ONE CAME FROM ═══════
     *
     * `holdStandaloneDoor` declines a second door and `startOrganizerSession` a second session,
     * both silently — so a press made over a live engine opened another one and orphaned it
     * beside the first, two organizers polling one device store. The reachable way in was a
     * refused profile write: the screen said so and the engine stayed up, and the chooser still
     * offers this door. The slot refuses the press instead, and the refusal names the state. */
    if (takeStandaloneLaunch() === "standing") {
      setPhase({ k: "failed", reason: refuse("standaloneAlreadyOpen") });
      return;
    }
    try {
      setPhase({ k: "opening" });
      /* ══ THE FINGER THAT LICENSES THE CONSENT PRESS ═════════════════════════════════════════
       *
       * The connection layer records the consent for a standalone mailbox, and it used to do so on
       * every arrival — which made a plain relaunch beside a laptop holding the claim a takeover
       * (measured: stood down at +2 s, claimed at +19 s). It now spends an arm, and this press is
       * one: a person typed a mailbox's password and pressed Connect. Armed BEFORE the engine is
       * opened, because `openStandalone` below adopts the session and that is what spends it; a press
       * that adopts nothing loses it when the slot is given back below. */
      armConsentPress();
      const outcome = await openStandaloneMailbox(fields, {
        startEngine: start,
        platform: async () => {
          /* THE NATIVE HALF IS REQUIRED BEHIND A PLATFORM GATE, never imported at module scope: the
             expo packages are Flow-typed JavaScript and a static import makes this whole route
             unloadable by the node-side suite — the rule `servers-native.ts` established. */
          const native = await import("../src/engine/local-engine-native");
          return native.nativeEnginePlatform();
        },
        machineName: () => PHONE_CLAIM_NAME,
        network: networkNow,
        buildCommit: buildCommit(process.env.EXPO_PUBLIC_COMMIT),
        /* THE SAME ID THE GATE STAMPED, never a fresh one: a claim written against a second id is
           how an install reads its own claim as somebody else's. `null` — the marker has not been
           settled — is handed on as the empty string, and the engine refuses a nameless claimant
           rather than this screen inventing one. */
        installId: async () => {
          const native = await import("../src/engine/native");
          const marker = await import("../src/state/install-marker");
          return (await marker.installGeneration(native.nativeEngineDeps())) ?? "";
        },
        /* THE ENGINE'S OWN LOG, to the platform's log — `engine-log.ts` for what this is and is
           not. Without it a dial that authenticated and then filed nothing wrote no line anywhere,
           which is how three device-only defects had to be diagnosed off a mail server's wire. */
        logSink: engineLogSink(),
        /* A STORE HOLDING ANOTHER MAILBOX IS LISTED, so the refusal's "in Servers" names a row. */
        listHeld: (accountId) => conn.listHeldStandalone(accountId),
      });
      if (outcome.ok) {
        /* The app goes live through the path a paired connect takes:
         * `holdStandaloneDoor` first, because the connection layer's standalone
         * arm reads the door from there — the engine has no network address, so
         * a session cannot be built from a stored row alone. Then
         * `openStandalone`, which writes the profile row and adopts the session;
         * the navigation below is what `welcome.tsx` redirects through and only
         * means anything once `conn.state.k === "live"`. The engine was left
         * running by the arm that returned it, so a failed adoption is said on
         * this screen rather than navigated past.
         */
        holdStandaloneDoor(outcome.door);
        /* The engine is wired to the app's lifecycle here — the call site
         * `background.ts` was written for; without it nothing subscribes to
         * `AppState`, so Android posts no notification and keeps no service and
         * a suspended iPhone leaves its claim in `ohmail/_meta` for the whole
         * staleness window — the double-organizer state the fourth door promises
         * to avoid. The session is module scope: the navigation on the next line
         * unmounts this screen, so a session owned here would be disposed by its
         * own success. Native for `local-engine-native.ts`'s reason (`AppState`
         * not loadable under vitest); `void` — an open mailbox must not wait.
         */
        /* ══ AND THE SESSION BELONGS TO THIS LAUNCH ═══════════════════════════════════════
         *
         * The import below is not awaited, and the adoption after it can be refused — which
         * hands the claim back and STOPS this engine. A session raised by an import that
         * settled after that ran over a dead engine, and the session is first-start-wins, so
         * the next successful Connect could not attach its own: the mailbox organized behind
         * no notification and no service for the run of the app. The generation is read here,
         * inside the slot, and the discard bumps it. */
        const launch = standaloneLaunchGeneration();
        void import("../src/engine/organizer-session-native")
          .then((m) => { m.startOrganizerSessionNative(outcome.door, launch); })
          /* A BUILD THAT CANNOT REACH ITS OWN BACKGROUND HALF SAYS SO. Swallowed, this would be an
             app that looks like it organizes in the background and does not. */
          .catch(() => { sayOrganizerRestricted(); });
        const adopted = await conn.openStandalone(outcome.door);
        if (!adopted.ok) {
          setPhase({ k: "failed", reason: adopted.reason });
          return;
        }
        /* ══ AND THIS IS WHERE THE NOTIFICATION IS ASKED FOR ════════════════════════════════
         * Organizing has begun on this phone: the door is open, the session is wired and the
         * claim is this install's. Before the dial it would be a permission spent on a press
         * that may still be refused by the mail server; at launch it would be a dialog in front
         * of somebody who only opened their mail. Nothing to ask on iOS, where there is no
         * notification, or where the permission is already held — `gate` resolves at once. */
        await notify.gate();
        /* The Ohbox in its first-sync state. Nothing between — the engine's own progress carries the
           wait, and a screen in the middle would be a screen with nothing true to say. */
        router.replace("/");
        return;
      }
      setPhase({ k: "failed", reason: outcome.reason });
      /* A refusal about a server field is worn BY that field, so the disclosure opens to show it. */
      if (refusalNamesServerFields(outcome.reason)) setAdvanced(true);
    } finally {
      /* ON EVERY EXIT, including a throw: a slot never given back refuses every later press for
         the run of the app, which is the fourth door gone until the app is killed. */
      releaseStandaloneLaunch();
    }
  }, [conn, fields, notify, start]);

  /* What each server field wears: the press's refusal where it names that field, else — for the
     two ports — the rule the typed value already breaks. */
  const failedOn = phase.k === "failed" ? refusalField(phase.reason) : null;
  const wears = (
    field: "imapHost" | "imapPort" | "smtpHost" | "smtpPort",
  ): { error: string } | Record<string, never> => {
    if (phase.k === "failed" && failedOn === field) return { error: sayRefusal(phase.reason) };
    const live = field === "imapPort" ? portFieldSaid(fields.imapPort, "imap")
      : field === "smtpPort" && fields.smtpHost.trim() !== ""
        ? portFieldSaid(fields.smtpPort, "smtp")
        : null;
    return live === null ? {} : { error: sayRefusal(live) };
  };

  return (
    <OnboardingPage
      showUnsaved
      back={() => { if (phase.k !== "opening") back(); }}
      actions={
        <Button appearance={onboardingButton}
          label={phase.k === "opening" ? Copy.phoneStandaloneConnecting : Copy.phoneStandaloneConnect}
          disabled={!ready}
          onPress={() => void connect()}
        />
      }
    >
      <View style={{ gap: 12, marginTop: preset.manual ? 0 : -12 }}>
        {preset.manual ? null : (
          <Tap accessibilityRole="button" accessibilityLabel={Copy.phoneMailboxProvider(preset.label)}
            accessibilityHint={Copy.phoneStandaloneAdvanced}
            accessibilityState={{ expanded: advanced }} onPress={() => setAdvanced((shown) => !shown)}
          >
            <Txt style={{ color: palette.ink, fontWeight: "700", paddingBottom: 6 }}>
              {Copy.phoneMailboxProvider(preset.label)}
            </Txt>
          </Tap>
        )}
        <Field
          value={fields.address}
          onChange={(v) => setFields((cur) => withAddress(cur, v, preset.id))}
          label={Copy.phoneStandaloneAddress}
          sentence={{
            before: Copy.phoneMailboxIAm,
            placeholder: Copy.phoneMailboxEmailBlank,
            compact: preset.manual,
            after: Copy.phoneMailboxWith,
          }}
          inputRef={address}
          input={{
            keyboardType: "email-address",
            ...standaloneAutofill("address"),
            returnKeyType: "next",
            onSubmitEditing: () => password.current?.focus(),
          }}
        />
        <Field
          value={fields.password}
          onChange={(v) => setFields((cur) => ({ ...cur, password: v }))}
          label={preset.appPassword ? Copy.phoneStandaloneAppPassword : Copy.phoneStandalonePassword}
          sentence={{
            before: preset.appPassword ? Copy.phoneStandaloneAppPasswordClause : Copy.phoneMailboxPassword,
            placeholder: preset.appPassword ? Copy.phoneMailboxAppCodeHint : Copy.phoneMailboxEntryHint,
            compact: preset.manual,
            end: "hot",
          }}
          inputRef={password}
          secret
          revealed={revealed}
          onReveal={setRevealed}
          revealLabels={{
            show: Copy.phoneStandaloneShowPassword,
            hide: Copy.phoneStandaloneHidePassword,
          }}
          input={{
            ...standaloneAutofill("password"),
            returnKeyType: "done",
            onSubmitEditing: () => {
              if (ready) void connect();
            },
          }}
        />
        {/* The name the letters carry; blank sends the bare address, as before. */}
        <Field
          value={fields.name ?? ""}
          onChange={(v) => setFields((cur) => ({ ...cur, name: v }))}
          label={Copy.phoneStandaloneName}
          sentence={{
            before: Copy.phoneMailboxSeenAs,
            placeholder: Copy.phoneMailboxNameBlank,
            compact: true,
            end: "ink",
          }}
          input={{
            autoComplete: "name",
            textContentType: "name",
            autoCapitalize: "words",
            returnKeyType: "done",
            onSubmitEditing: () => {
              if (ready) void connect();
            },
          }}
        />
        <Txt variant="caption" tone="ink2">{Copy.phoneStandaloneFormLead}</Txt>
        {/* The refusal sits beside the verb unless the OPEN disclosure is already wearing it on the
            field it names — a sentence hidden behind a closed disclosure is a refusal nobody reads,
            and a sentence about a password attached to the host field names the wrong thing. */}
        {phase.k === "failed" && !(advanced && refusalNamesServerFields(phase.reason)) ? (
          <Txt
            variant="body"
            accessibilityRole="alert"
            style={{ color: palette.ink, fontWeight: "700" }}
          >
            {sayRefusal(phase.reason)}
          </Txt>
        ) : null}
        {phase.k === "failed" && refusalLinks(phase.reason) !== null ? (
          <View style={{ paddingHorizontal: 16 }}>
            <ProviderLinks links={refusalLinks(phase.reason)!} />
          </View>
        ) : null}

        {/* A provider that takes only an App Password says so here, before the first press. */}
        {note !== null ? <ProviderLinks links={note.links} note={note.text} /> : null}

        {/* ── SERVER SETTINGS, PRE-FILLED FROM THE ADDRESS ────────────────────────────────────
            A disclosure rather than a nine-field form: behind a recognised domain these are facts
            this app knows, and behind an unrecognised one the person opens it and types them. */}
        {preset.manual ? <OnboardingTag
          label={fields.imapHost || Copy.phoneMailboxHostPorts}
          accessibilityLabel={Copy.phoneStandaloneAdvanced}
          disclosure
          expanded={advanced}
          onPress={() => setAdvanced((shown) => !shown)}
        /> : null}
        {advanced ? (
          <View style={{ gap: 12 }}>
            <View style={{ flexDirection: "row", gap: 12 }}>
              <View style={{ flex: 1 }}>
                <Field
                  value={fields.imapHost}
                  onChange={(v) => setFields((cur) => setTyped(cur, "imapHost", v))}
                  boxed
                  label={Copy.phoneStandaloneImapHost}
                  {...wears("imapHost")}
                  input={{ keyboardType: "url" }}
                />
              </View>
              <View style={{ width: 96 }}>
                <Field
                  value={fields.imapPort}
                  onChange={(v) => setFields((cur) => setImapPort(cur, v))}
                  boxed
                  label={Copy.phoneStandaloneImapPort}
                  {...wears("imapPort")}
                  input={{ inputMode: "numeric", keyboardType: "number-pad", selectTextOnFocus: true }}
                />
              </View>
            </View>
            <View style={{ flexDirection: "row", gap: 12 }}>
              <View style={{ flex: 1 }}>
                <Field
                  value={fields.smtpHost}
                  onChange={(v) => setFields((cur) => setTyped(cur, "smtpHost", v))}
                  boxed
                  label={Copy.phoneStandaloneSmtpHost}
                  {...wears("smtpHost")}
                  input={{ keyboardType: "url" }}
                />
              </View>
              <View style={{ width: 96 }}>
                <Field
                  value={fields.smtpPort}
                  onChange={(v) => setFields((cur) => setTyped(cur, "smtpPort", v))}
                  boxed
                  label={Copy.phoneStandaloneSmtpPort}
                  {...wears("smtpPort")}
                  input={{ inputMode: "numeric", keyboardType: "number-pad", selectTextOnFocus: true }}
                />
              </View>
            </View>
            <Tap
              accessibilityRole="switch"
              accessibilityLabel={Copy.phoneStandaloneImapTls}
              accessibilityHint={Copy.phoneStandaloneImapTlsHint}
              accessibilityState={{ checked: fields.imapTls }}
              onPress={() => setFields((cur) => setImapTls(cur, !cur.imapTls))}
              style={{ minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
            >
              <Txt variant="settingsLabel" style={{ color: palette.ink }}>{Copy.phoneStandaloneImapTls}</Txt>
              <View style={{
                width: 44, height: 26, padding: 4, borderRadius: 13,
                alignItems: fields.imapTls ? "flex-end" : "flex-start",
                backgroundColor: fields.imapTls ? palette.solid : palette.soft,
              }}>
                <View style={{
                  width: 18, height: 18, borderRadius: 9,
                  backgroundColor: fields.imapTls ? palette["on-solid"] : palette.ink2,
                }} />
              </View>
            </Tap>
          </View>
        ) : null}

      </View>
      <NotifyPermission open={notify.open} onAnswer={notify.answer} />
    </OnboardingPage>
  );
}

/** A provider's pages, each opened in the system browser by the person's own press. */
function ProviderLinks({ links, note }: { links: readonly ProviderLink[]; note?: string }) {
  const [more, setMore] = useState(false);
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      {note && links.length > 1 ? <OnboardingTag label={Copy.phoneMailboxPrerequisite} /> : null}
      {note ? <OnboardingTag label={Copy.phonePasswordHelp} expanded={more} onPress={() => setMore(!more)} /> : null}
      {more ? <Txt variant="body" tone="ink2" style={{ width: "100%" }}>{note}</Txt> : null}
      {(more || !note ? links : []).map((link) => (
        <Tap
          key={link.url}
          onPress={() => { void Linking.openURL(link.url).catch(() => undefined); }}
          accessibilityRole="link"
          accessibilityLabel={link.label}
          style={{ paddingVertical: 8 }}
        >
          <Txt variant="settingsLabel" tone="accent">{link.label}</Txt>
        </Tap>
      ))}
    </View>
  );
}

/** Named for the route's sake: the focus rule this screen implements. Read by the suite. */
export const FOCUS_ON_MOUNT = {
  limits: focusTargetFor("limits"),
  credentials: focusTargetFor("credentials"),
} as const;

/** The step order, so nothing can render the form before the limitations. */
export const STEP_ORDER: readonly StandaloneStep[] = ["limits", "credentials"];
