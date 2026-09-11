/**
 * THE FOURTH DOOR — what this phone is as the organizer, then the mailbox's credentials.
 *
 * Two steps, in this order, and the first cannot be skipped: the limitations are read BEFORE any
 * password field exists. A person who presses Continue has been told what the door costs; a person
 * who presses "Choose differently" goes back to the chooser with nothing typed.
 *
 * Every decision on both steps lives in `src/ui/standalone-form.ts` — which sentence the platform
 * shows, whether Connect is offered, what the server fields hold for a typed address — because this
 * workspace has no React Native renderer and a rule written inside a component is a rule no test can
 * drive. This file renders those answers.
 */
import { useCallback, useRef, useState } from "react";
import { Platform, TextInput, View } from "react-native";
import { router } from "expo-router";
import { Copy } from "../src/copy";
import { sayRefusal, type Refusal } from "../src/refusal";
import { phoneEngineStart } from "../src/engine/engine-artifact";
import { sayOrganizerRestricted } from "../src/engine/organizer-session";
import { PHONE_CLAIM_NAME, openStandaloneMailbox } from "../src/engine/standalone-door";
import { useTheme } from "../src/theme";
import { Button, Panel, Rule, Screen, Scroller, Tap, Txt } from "../src/ui/base";
import { DetailBar } from "../src/ui/chrome";
import { Field } from "../src/ui/Field";
import { Segmented } from "../src/ui/Segmented";
import {
  EMPTY_STANDALONE,
  focusTargetFor,
  limitationLines,
  mayConnect,
  refusalNamesServerFields,
  setImapTls,
  setImapPort,
  setTyped,
  withAddress,
  type StandaloneFields,
  type StandaloneStep,
} from "../src/ui/standalone-form";
import { useLocale } from "../src/i18n/LocaleProvider";

export default function StandaloneScreen() {
  /* Subscribed to the language, so a switch in Settings redraws this screen rather than waiting
     for the next navigation — every other pushed screen does the same. */
  useLocale();
  const [step, setStep] = useState<StandaloneStep>("limits");
  return (
    <Screen>
      <DetailBar title={Copy.doorPhone} />
      {step === "limits" ? (
        <Limitations onGo={() => setStep("credentials")} />
      ) : (
        <Credentials />
      )}
    </Screen>
  );
}

/** Step one. The three ruled sentences, then the confirm and the way back out. */
function Limitations({ onGo }: { onGo: () => void }) {
  const t = useTheme();
  const lines = limitationLines(Platform.OS);
  return (
    <Scroller>
      <View style={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 14 }}>
        {/* THE HEADING IS THE FOCUS TARGET (`focusTargetFor("limits")`), because this step is a
            read: a reader who lands mid-list has skipped the sentence that decides. */}
        <Txt variant="h1" accessibilityRole="header" accessible>
          {Copy.phoneStandaloneTitle}
        </Txt>
      </View>
      <Panel style={{ paddingTop: 4, paddingBottom: 16 }}>
        {lines.map((line, i) => (
          <View key={line}>
            {i > 0 ? <Rule inset={20} /> : null}
            {/* Rows with hairlines rather than bullet glyphs — the panel's own idiom, and without
                a `TapRow` wash they read as a list instead of as settings rows. */}
            <View style={{ paddingHorizontal: 20, paddingVertical: 10 }}>
              <Txt variant="body">{line}</Txt>
            </View>
          </View>
        ))}
      </Panel>
      <View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 12 }}>
        <Button label={Copy.phoneStandaloneGo} variant="solid" onPress={onGo} />
        {/* Deliberately a second way back, beside the bar's. After three lines the exit belongs
            next to the verb, not at the top of the screen. */}
        <Button
          label={Copy.phoneStandaloneBack}
          variant="quiet"
          onPress={() => router.back()}
          style={{ marginBottom: 24 }}
        />
      </View>
      <View style={{ height: t.space.paneXCompact }} />
    </Scroller>
  );
}

/** What a press on Connect is doing, or the sentence it ended on. Never a dead control. */
type Phase = { k: "idle" } | { k: "opening" } | { k: "failed"; reason: Refusal };

/** Step two. Address, password, and the server settings behind a disclosure. */
function Credentials() {
  const [fields, setFields] = useState<StandaloneFields>(EMPTY_STANDALONE);
  const [revealed, setRevealed] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const address = useRef<TextInput>(null);
  const password = useRef<TextInput>(null);

  const start = phoneEngineStart();
  const ready = mayConnect(fields) && phase.k !== "opening";

  const connect = useCallback(async () => {
    setPhase({ k: "opening" });
    const outcome = await openStandaloneMailbox(fields, {
      startEngine: start,
      platform: async () => {
        /* THE NATIVE HALF IS REQUIRED BEHIND A PLATFORM GATE, never imported at module scope: the
           expo packages are Flow-typed JavaScript and a static import makes this whole route
           unloadable by the node-side suite — the rule `servers-native.ts` established. */
        const native = (await import("../src/engine/local-engine-native")) as {
          nativeEnginePlatform: () => Promise<{ exec: unknown; keks: Record<number, string> }>;
        };
        return native.nativeEnginePlatform();
      },
      machineName: () => PHONE_CLAIM_NAME,
      /* THE SAME ID THE GATE STAMPED, never a fresh one: a claim written against a second id is
         how an install reads its own claim as somebody else's. `null` — the marker has not been
         settled — is handed on as the empty string, and the engine refuses a nameless claimant
         rather than this screen inventing one. */
      installId: async () => {
        const native = await import("../src/engine/native");
        const marker = await import("../src/state/install-marker");
        return (await marker.installGeneration(native.nativeEngineDeps())) ?? "";
      },
    });
    if (outcome.ok) {
      /* ══ THE ENGINE IS NOW WIRED TO THE APP'S OWN LIFECYCLE ═══════════════════════════════
       *
       * This is the line `background.ts` was written for and had no call site for. Without it
       * every arm in that file is unreachable: nothing subscribes to `AppState`, so an Android
       * phone posts no notification and keeps no service, and an iPhone leaves its claim standing
       * in `ohmail/_meta` for the whole staleness window while it is suspended — which is the
       * double-organizer state the fourth door's own sentences promise it avoids.
       *
       * The session is MODULE SCOPE and not this component's, because the navigation on the next
       * line unmounts this screen: a session owned here would be disposed by its own success.
       * Native for `local-engine-native.ts`'s reason — `AppState` is not loadable under vitest —
       * and `void`, because a mailbox that is open must not wait on a notification.
       */
      const address = fields.address.trim();
      void import("../src/engine/organizer-session-native")
        .then((m) => { m.startOrganizerSessionNative(outcome.door, address); })
        /* A BUILD THAT CANNOT REACH ITS OWN BACKGROUND HALF SAYS SO. Swallowed, this would be an
           app that looks like it organizes in the background and does not. */
        .catch(() => { sayOrganizerRestricted(); });
      /* The Ohbox in its first-sync state. Nothing between — the engine's own progress carries the
         wait, and a screen in the middle would be a screen with nothing true to say. */
      router.replace("/");
      return;
    }
    setPhase({ k: "failed", reason: outcome.reason });
  }, [fields, start]);

  return (
    <Scroller>
      <View style={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 }}>
        <Txt variant="h1" accessibilityRole="header">
          {Copy.phoneStandaloneFormTitle}
        </Txt>
        <Txt variant="caption" tone="ink3" style={{ marginTop: 6 }}>
          {Copy.phoneStandaloneFormLead}
        </Txt>
      </View>
      <Panel style={{ paddingBottom: 16 }}>
        <Field
          value={fields.address}
          onChange={(v) => setFields((cur) => withAddress(cur, v))}
          label={Copy.phoneStandaloneAddress}
          inputRef={address}
          input={{
            keyboardType: "email-address",
            autoComplete: "username",
            textContentType: "username",
            returnKeyType: "next",
            onSubmitEditing: () => password.current?.focus(),
          }}
        />
        <Field
          value={fields.password}
          onChange={(v) => setFields((cur) => ({ ...cur, password: v }))}
          label={Copy.phoneStandalonePassword}
          inputRef={password}
          secret
          revealed={revealed}
          onReveal={setRevealed}
          revealLabels={{
            show: Copy.phoneStandaloneShowPassword,
            hide: Copy.phoneStandaloneHidePassword,
          }}
          input={{
            autoComplete: "current-password",
            textContentType: "password",
            returnKeyType: "done",
            onSubmitEditing: () => {
              if (ready) void connect();
            },
          }}
        />

        {/* ── SERVER SETTINGS, PRE-FILLED FROM THE ADDRESS ────────────────────────────────────
            A disclosure rather than a nine-field form: behind a recognised domain these are facts
            this app knows, and behind an unrecognised one the person opens it and types them. */}
        <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
          <Tap
            onPress={() => setAdvanced((v) => !v)}
            accessibilityRole="button"
            accessibilityState={{ expanded: advanced }}
            accessibilityLabel={Copy.phoneStandaloneAdvanced}
            style={{ paddingVertical: 8 }}
          >
            <Txt variant="settingsLabel" tone="accent">
              {Copy.phoneStandaloneAdvanced}
            </Txt>
          </Tap>
        </View>
        {advanced ? (
          <View>
            <Field
              value={fields.imapHost}
              onChange={(v) => setFields((cur) => setTyped(cur, "imapHost", v))}
              label={Copy.phoneStandaloneImapHost}
              {...(phase.k === "failed" && refusalNamesServerFields(phase.reason)
                ? { error: sayRefusal(phase.reason) }
                : {})}
              input={{ keyboardType: "url" }}
            />
            <Field
              value={fields.imapPort}
              onChange={(v) => setFields((cur) => setImapPort(cur, v))}
              label={Copy.phoneStandaloneImapPort}
              input={{ inputMode: "numeric", keyboardType: "number-pad" }}
            />
            <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
              <Txt variant="sectionLabel" tone="ink3" style={{ paddingBottom: 4 }}>
                {Copy.phoneStandaloneImapTls}
              </Txt>
              <Segmented<"on" | "off">
                segments={[
                  { value: "on", label: Copy.switchOn },
                  { value: "off", label: Copy.switchOff },
                ]}
                value={fields.imapTls ? "on" : "off"}
                onChange={(v) => setFields((cur) => setImapTls(cur, v === "on"))}
              />
              <Txt variant="caption" tone="ink3" style={{ marginTop: 6 }}>
                {Copy.phoneStandaloneImapTlsHint}
              </Txt>
            </View>
            <Field
              value={fields.smtpHost}
              onChange={(v) => setFields((cur) => setTyped(cur, "smtpHost", v))}
              label={Copy.phoneStandaloneSmtpHost}
              input={{ keyboardType: "url" }}
            />
            <Field
              value={fields.smtpPort}
              onChange={(v) => setFields((cur) => setTyped(cur, "smtpPort", v))}
              label={Copy.phoneStandaloneSmtpPort}
              input={{ inputMode: "numeric", keyboardType: "number-pad" }}
            />
          </View>
        ) : null}

        {/* The refusal sits beside the verb unless the OPEN disclosure is already wearing it on the
            field it names — a sentence hidden behind a closed disclosure is a refusal nobody reads,
            and a sentence about a password attached to the host field names the wrong thing. */}
        {phase.k === "failed" && !(advanced && refusalNamesServerFields(phase.reason)) ? (
          <Txt
            variant="caption"
            tone="ink2"
            accessibilityRole="alert"
            style={{ paddingHorizontal: 16, paddingTop: 14 }}
          >
            {sayRefusal(phase.reason)}
          </Txt>
        ) : null}

        <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
          <Button
            label={phase.k === "opening" ? Copy.phoneStandaloneConnecting : Copy.phoneStandaloneConnect}
            variant="solid"
            onPress={ready ? () => void connect() : undefined}
          />
        </View>
      </Panel>
      <View style={{ height: 32 }} />
    </Scroller>
  );
}

/** Named for the route's sake: the focus rule this screen implements. Read by the suite. */
export const FOCUS_ON_MOUNT = {
  limits: focusTargetFor("limits"),
  credentials: focusTargetFor("credentials"),
} as const;

/** The step order, so nothing can render the form before the limitations. */
export const STEP_ORDER: readonly StandaloneStep[] = ["limits", "credentials"];
