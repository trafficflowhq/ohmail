import { onboardingType } from "../src/theme/type";
/**
 * The Servers screen — the pairings this phone holds, and the door chooser
 * for adding one. The pairings half is this file's own: switch, forget, and
 * the live session's numbers (the mirror's, straight off the engine's
 * reader). The adding half is `ui/Doors.tsx`, shared with the first-run
 * screen, so one decision has one vocabulary. The hosted service answers
 * `features.pairing: true` and mounts its redeem (measured 2026-09-01); the
 * negotiation offers the pair step on its own, so no client edit was needed
 * when that changed.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { sayArg, sayRefusal, type Refusal } from "../src/refusal";
import { BackHandler, View } from "react-native";
import { Stack, router, useIsFocused } from "expo-router";
import { Copy } from "../src/copy";
import { organizesHere } from "../src/engine/standalone-door";
import { organizerSettingsLeftOnlyHere } from "../src/engine/organizer-session";
import {
  stopAndRemoveAsks, stopAndRemoveKept, stopAndRemoveLines, stopAndRemoveVerb, type StopAndRemoveAsk,
} from "../src/ui/standalone-form";
import { MAIL_SURFACE, useConnection } from "../src/net/connection";
import { isPairEnded } from "../src/net/session-death";
import { gateFor } from "../src/state/gate";
import type { ServerProfile } from "../src/state/servers";
import { useTheme } from "../src/theme";
import { MailAppearance, mailSize } from "../src/theme/mail";
import { Button, Panel, Screen, Scroller, Section, Tap, TapRow, Txt, ViewHead, useTopPad } from "../src/ui/base";
import { DetailBar, PaneTop } from "../src/ui/chrome";
import { Doors } from "../src/ui/Doors";
import { Icon } from "../src/ui/Icon";
import { useOnboardingLook } from "../src/ui/OnboardingPage";
import { useLocale } from "../src/i18n/LocaleProvider";
import { SurfaceBoundary } from "../src/ui/ErrorBoundary";

/** The first screen, as the gate opens it: under the shell the door's ways in, else today's welcome. */
const FIRST_SCREEN = MAIL_SURFACE === "shell" ? "/door" : "/welcome";

export default function ServersScreen({ inPane = false }: { inPane?: boolean }) {
  return (
    <SurfaceBoundary surface="servers">
      <MailAppearance>
        <ServersBody inPane={inPane} />
      </MailAppearance>
    </SurfaceBoundary>
  );
}

function ServersBody({ inPane }: { inPane: boolean }) {
  /* Subscribed to the language, so a switch in Settings redraws this screen instead of
     waiting for the next navigation — see `src/i18n/LocaleProvider.tsx`. */
  useLocale();
  const conn = useConnection();
  const state = conn.state;
  const ended = (state.k === "refused" || state.k === "ended") && isPairEnded(state.reason);
  /** What a forget could not take back. Held HERE — see the note beside where it renders. */
  const [forgetFailure, setForgetFailure] = useState<Refusal | null>(null);

  /* ── THIS PANE IS NEVER A DEAD END ──────────────────────────────────────────────────────────
     With nothing paired the stack under it can be EMPTY (a first run, the last pairing forgotten,
     a door that replaced its way here), and then the bar has nothing to pop. And where the GATE
     holds the phone here (a pairing ended, no live session), a pop lands on the tabs and their
     gate sends it straight back: a Back that does nothing. So there Back opens this phone's own
     mailbox when it has one, else a pairing that keeps its credential (the active one first), and
     the first-run door otherwise (a pairing whose credential is gone re-pairs from there); a
     refused switch keeps the pane with its sentence. Elsewhere it pops, or routes by the gate.
     The system Back (Android) takes the same way out while the pane is in front, and iOS's edge
     swipe, which would pop into the same redirect, is off while held. */
  const verdict = gateFor(conn.state, conn.profiles.length);
  const held = verdict.to === "servers";
  const reopen =
    conn.profiles.find(organizesHere) ??
    conn.profiles.find((p) => p.id === conn.activeId && p.refreshToken !== null) ??
    conn.profiles.find((p) => p.refreshToken !== null) ??
    null;
  const leave = async () => {
    if (held && reopen !== null) {
      if ((await conn.switchTo(reopen.id)).ok) router.replace("/");
      return;
    }
    if (held) {
      router.replace(FIRST_SCREEN);
      return;
    }
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace(verdict.to === "welcome" ? FIRST_SCREEN : "/");
  };
  const ownBack = held || !router.canGoBack();
  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  const focused = useIsFocused();
  useEffect(() => {
    if (!held || !focused) return undefined;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => { void leaveRef.current(); return true; });
    return () => sub.remove();
  }, [held, focused]);

  return (
    <Screen>
      {inPane ? null : <Stack.Screen options={{ gestureEnabled: !held }} />}
      {inPane ? <PaneTop /> : ended ? (
        <RecoveryBack opensMailbox={held && reopen !== null} onPress={() => void leave()} />
      ) : <DetailBar backCapsule back={ownBack ? () => void leave() : undefined} />}
      <Scroller bounded avoidKeyboard>
        <ViewHead title={Copy.serversTitle} attention={ended} />

        <StatusPanel />

        {conn.profiles.length > 0 ? (
          <Panel style={{ marginTop: mailSize.edge, paddingBottom: mailSize.inset }}>
            <Section>{ended ? Copy.phoneServersPaired : Copy.serversProfiles}</Section>
            {conn.profiles.map((p) => (
              <ProfileRow
                key={p.id}
                profile={p}
                active={p.id === conn.activeId}
                recovery={ended}
                onForgetFailed={setForgetFailure}
              />
            ))}
            {/* ── THE NOTE NAMES A DEVICES LIST ONLY WHERE THERE IS A SERVER TO HOLD ONE ────
                A list holding nothing but this phone's own mailbox has no server and no Devices
                pane, so that sentence had no referent — a true-sounding instruction a person
                cannot follow. Decided by the ROWS rather than by the live session: the note is
                about every row under it. */}
            <View style={{ paddingHorizontal: 20, paddingTop: 6 }}>
              <Txt variant={ended ? "body" : "hint"} tone={ended ? "ink2" : "ink3"}>
                {conn.profiles.some(organizesHere)
                  ? conn.profiles.every(organizesHere) ? Copy.serversForgetNoteHere : Copy.serversForgetNote
                  : ended ? Copy.phoneServersForget : Copy.serversForgetNote}
              </Txt>
            </View>
          </Panel>
        ) : null}

        {/* ── THE FAILURE OUTLIVES THE ROW IT IS ABOUT ────────────────────────────────────
            A partial forget removes the CREDENTIAL and leaves the mail, so by the time the
            outcome comes back the profile row is gone from `conn.profiles` and the component
            that asked for the forget has unmounted. Holding the sentence in the row meant a
            `setState` into a tree that no longer existed: the server vanished from the list and
            the only notice that mail was still on the phone was thrown away — the exact
            false-success shape this whole change is about. So it lives here, above the list,
            and survives the row's removal. */}
        {forgetFailure === null ? null : (
          <Panel style={{ marginTop: 14, paddingVertical: 14 }}>
            <View style={{ paddingHorizontal: 20 }}>
              <Txt variant="hint" tone="ink2">
                {Copy.serversForgetFailed(sayRefusal(forgetFailure))}
              </Txt>
            </View>
          </Panel>
        )}

        <View style={{ marginTop: mailSize.edge }}>
          <Doors
            recovery={ended}
            onScan={() => router.push("/scan")}
            onTypeToken={() => router.push("/connect")}
            onStandalone={() => router.push("/standalone")}
          />
        </View>
      </Scroller>
    </Screen>
  );
}

function RecoveryBack({ opensMailbox, onPress }: { opensMailbox: boolean; onPress: () => void }) {
  const { palette } = useOnboardingLook();
  const t = useTheme();
  const top = useTopPad(8);
  const label = opensMailbox ? Copy.ohbox : Copy.back;
  return (
    <View style={{ paddingTop: top, paddingHorizontal: 12, paddingBottom: 8, alignItems: "flex-start" }}>
      <Tap accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={{
        minHeight: mailSize.back, paddingHorizontal: mailSize.edge, flexDirection: "row", alignItems: "center", gap: mailSize.rowInset,
        borderRadius: t.radius.pill, borderWidth: 1, borderColor: palette["ctl-ring"], backgroundColor: palette.sheet,
      }}>
        <Icon name="back" size={16} color={palette.ink} />
        <Txt variant="settingsLabel" style={{ color: palette.ink }}>{label}</Txt>
      </Tap>
    </View>
  );
}

/** The connection's own words: live numbers, a boot in progress, a refusal, a death. */
function StatusPanel() {
  const conn = useConnection();
  const { palette } = useOnboardingLook();
  const s = conn.state;
  if (s.k === "starting" || s.k === "idle") {
    return conn.profiles.length === 0 ? (
      <Panel style={{ paddingVertical: 16 }}>
        <View style={{ paddingHorizontal: 20 }}>
          <Txt variant="hint" tone="ink3">
            {Copy.serversEmpty}
          </Txt>
        </View>
      </Panel>
    ) : null;
  }
  if ((s.k === "refused" || s.k === "ended") && isPairEnded(s.reason)) {
    return (
      <Panel style={{ padding: 20, gap: 16, backgroundColor: palette["sheet-new"] }}>
        <Txt variant="settingsLabel" style={{ color: palette.ink, ...onboardingType.label }}>
          {Copy.connectRefusedTitle}<Txt style={{ color: palette.hot, ...onboardingType.dot }}>●</Txt>
        </Txt>
        <View style={{ flexDirection: "row", gap: 8 }} accessibilityRole="alert">
          <Icon name="info" color={palette.ink2} size={18} />
          <Txt variant="body" style={{ flex: 1, color: palette.ink2, ...onboardingType.body }}>
            {sayRefusal(s.reason)}
          </Txt>
        </View>
        <Button
          label={Copy.pairAgain}
          onPress={() => router.push("/scan")}
          style={{ minHeight: 44, alignSelf: "flex-start", backgroundColor: palette.sheet }}
        />
      </Panel>
    );
  }
  return (
    <Panel style={{ paddingVertical: 16 }}>
      <View style={{ paddingHorizontal: 20, gap: 6 }}>
        {s.k === "connecting" ? (
          <>
            <Txt variant="settingsLabel">{s.origin}</Txt>
            <Txt variant="caption" tone="ink3">{Copy.connectBooting}</Txt>
          </>
        ) : null}
        {s.k === "refused" || s.k === "ended" ? (
          <>
            <Txt variant="settingsLabel" tone="accent">{Copy.connectRefusedTitle}</Txt>
            <Txt variant="hint" tone="ink2">{sayRefusal(s.reason)}</Txt>
          </>
        ) : null}
        {s.k === "live" ? <LiveFacts /> : null}
      </View>
      {s.k === "live" ? (
        <View style={{ paddingHorizontal: mailSize.edge, paddingTop: mailSize.inset, gap: mailSize.inset,
          flexDirection: "row", flexWrap: "wrap" }}>
          <Button label={Copy.connectSyncNow} variant="solid" disabled={conn.syncing} onPress={conn.syncNow} />
          <Button label={Copy.connectDisconnect} variant="quiet" onPress={() => void conn.disconnect()} />
        </View>
      ) : null}
    </Panel>
  );
}

/** The mirror's numbers under the engine's own change signal — never a copy of them. */
function LiveFacts() {
  const conn = useConnection();
  const s = conn.state;
  const engine = s.k === "live" ? s.session.engine : null;
  const version = useSyncExternalStore(
    useCallback((cb: () => void) => (engine ? engine.subscribe(cb) : () => undefined), [engine]),
    () => (engine ? engine.read().version() : 0),
  );
  void version;
  if (s.k !== "live" || engine === null) return null;
  const total = engine.read().list("message").length;
  return (
    <>
      {/* THE SAME RULE AS THE ROW BELOW: on this door the origin is a name nothing dials. */}
      <Txt variant="settingsLabel">
        {organizesHere(s.session.profile) ? Copy.standaloneName : s.session.profile.origin}
      </Txt>
      <Txt variant="caption" tone="ink3" tabular>
        {conn.syncing ? Copy.connectSyncing : Copy.connectMirrored(total)}
      </Txt>
      {conn.syncError ? (
        <Txt variant="hint" tone="ink2">
          {/* WHETHER THIS PAIRING HOLDS A PIN decides which sentence a handshake failure gets.
              A pinned pairing is a computer whose key this phone agreed to, so a failure there
              means that key changed. An unpinned one — the hosted service, a self-hosted server
              on a real name — has no key to change, and the honest reading is that the phone
              would not accept the certificate at that address. See `connectSyncFailed`. */}
          {Copy.connectSyncFailed(sayArg(conn.syncError), s.session.profile.pin !== null)}
        </Txt>
      ) : null}
    </>
  );
}

function ProfileRow({ profile, active, recovery, onForgetFailed }: {
  profile: ServerProfile;
  active: boolean;
  recovery: boolean;
  /** Raised to the SCREEN, because a partial forget removes this very row. See its note there. */
  onForgetFailed: (reason: Refusal | null) => void;
}) {
  const conn = useConnection();
  const t = useTheme();
  /* ── THIS PHONE'S OWN MAILBOX IS A ROW HERE TOO, AND THE ORIGIN IS WHAT TELLS IT APART ──────
     It carries no refresh token BY DESIGN (`state/servers.ts`), so the needs-pair reading below —
     right for every pairing whose token a server cleared — would send somebody to the QR scanner
     for the mailbox on the phone in their hand. The name is the phone's own claim name, because
     that row's origin is an address nothing dials and nobody should be shown. */
  const here = organizesHere(profile);
  const needsPair = !here && profile.refreshToken === null;
  const state = conn.state;
  const connected = (state.k === "live" || state.k === "shell") && state.session.profile.id === profile.id;
  // Forgetting the FINAL pairing returns to the welcome screen — explicitly, from the
  // action itself. The tabs' redirect cannot be trusted to fire here: while /servers is
  // the focused route, the gated layouts behind it may never re-render their verdict, and
  // "the app went back to its first screen" must not depend on which screen was focused.
  // Counted before the await (this handler's `conn` is the render's snapshot; the forget
  // removes exactly this row).
  const forget = async (anyway = false) => {
    const wasLast = conn.profiles.length === 1;
    onForgetFailed(null);
    const outcome = await conn.forget(profile.id, { anyway });
    if (!outcome.ok && "settingsKept" in outcome) {
      /* NOTHING WAS REMOVED: the hand-back could not leave this phone's settings in the mailbox. The row
         stands, so the confirm opens on it again, about the settings. */
      setAsking(stopAndRemoveKept(outcome.settingsKept));
      return;
    }
    if (!outcome.ok) {
      // NOT a local setState: the credential half succeeds first, so this component is usually
      // already unmounted by the time the outcome arrives. The screen holds it instead.
      onForgetFailed(outcome.reason);
      return;
    }
    if (wasLast) router.replace(FIRST_SCREEN);
  };
  /* ── THIS PHONE'S OWN MAILBOX ASKS FIRST WHILE THE STORE HOLDS WHAT NO SERVER HAS ────────
     The forget deletes the whole store: an unsent draft is on no server, and settings waiting for
     the settings question (or behind a newer ohmail's copy) are not in the mailbox. A known zero and
     a known `none` keep the single press; anything else opens the confirm below the row. A mailbox
     that refuses the hand-back's write is found only then: the forget keeps the store and the
     confirm opens after it. A pairing's Forget is unchanged: its drafts are on its server. */
  const [asking, setAsking] = useState<StopAndRemoveAsk | null>(null);
  const pressRemove = async () => {
    if (!here) { void forget(); return; }
    const drafts = conn.unsentDraftsHere(profile.id);
    const ask = stopAndRemoveAsks(drafts, await organizerSettingsLeftOnlyHere());
    if (ask === null) { void forget(); return; }
    setAsking(ask);
  };
  return (
    <View style={{ marginHorizontal: 8 }}>
      <TapRow
        selected={active && !recovery}
        onPress={() => {
          // A row whose credential is gone re-pairs (one scan); a live one switches. BY ID:
          // this rendered row may be stale (a rotation may have landed since), and the
          // connection layer re-reads the keystore row inside its gate.
          if (needsPair) router.push("/scan");
          else void conn.switchTo(profile.id);
        }}
        accessibilityRole="button"
        accessibilityLabel={Copy.ariaLabelDetail(here ? Copy.standaloneName : profile.origin,
          connected ? Copy.serversActive : profile.flavor)}
        style={{ paddingHorizontal: mailSize.edge, paddingVertical: mailSize.inset, gap: mailSize.rowInset }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon name={here ? "phone" : "computer"} size={18} color={t.c.ink2} />
          <Txt variant="settingsLabel" numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>
            {here ? Copy.standaloneName : profile.origin}
          </Txt>
          {connected ? <Txt variant="caption" tone="ink2">{Copy.serversActive}</Txt> : null}
        </View>
        <Txt variant="caption" tone="ink2" numberOfLines={2} style={{ marginLeft: 26 }}>
          {here ? Copy.serversOrganizedHere : needsPair ? Copy.pairEnded : profile.accountId}
        </Txt>
      </TapRow>
      <View style={{ flexDirection: recovery ? "row-reverse" : "row", flexWrap: "wrap",
        paddingHorizontal: mailSize.edge, paddingBottom: mailSize.rowInset }}>
        {/* ONE VERB, AND IT READS AS WHAT IT DOES. Forgetting a pairing removes a credential;
            forgetting this one stops the engine on this phone and hands the mailbox back — see
            `connection.tsx`'s forget arm, which does all three before the row goes. */}
        <Button
          label={here ? Copy.serversStopHere : Copy.serversForget}
          variant="quiet"
          onPress={() => void pressRemove()}
        />
        {/* The row press already re-pairs, and a gesture with no name is invisible to a screen
            reader — the verb is spelled out, the same word the panel above uses. */}
        {needsPair ? <Button label={Copy.pairAgain} variant="quiet" onPress={() => router.push("/scan")} /> : null}
      </View>
      {asking !== null ? (
        <View style={{ paddingHorizontal: 12, paddingBottom: 10, gap: 8 }}>
          {stopAndRemoveLines(asking).map((line) => (
            <Txt key={line} variant="hint" tone="ink2">{line}</Txt>
          ))}
          {/* The safe answer first, and after a kept store it opens the mailbox again; the forget only on
              this second, explicit press, which answers a named settings risk. The row wraps and a
              button longer than the row wraps its words: the composer footer's rule. */}
          <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 8, rowGap: 8 }}>
            <Button
              label={Copy.serversStopHereKeep}
              style={{ flexShrink: 1, maxWidth: "100%" }}
              onPress={() => { setAsking(null); if (asking.kept) void conn.switchTo(profile.id); }}
            />
            <Button
              label={stopAndRemoveVerb(asking)}
              variant="quiet"
              style={{ flexShrink: 1, maxWidth: "100%" }}
              onPress={() => { setAsking(null); void forget(asking.settings !== null); }}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

/*
 * ── "ADD A SERVER" IS THE DOOR CHOOSER, NOT A SECOND VOCABULARY FOR IT ─────────────────────────
 *
 * This panel used to hold its own three cards, its own address field and its own probe, and they
 * had drifted from the first-run screen's wording into a different name for each door. Both
 * surfaces ask one question at two moments, so both render `ui/Doors.tsx` — which also means the
 * self-hosted arm's address parse and the `<origin>/api` measurement exist once rather than twice.
 * `lead` is off here: the Servers screen already carries its own explanatory line above the list.
 */
