/**
 * THE SERVERS SCREEN — the pairings this phone holds, and the door chooser for adding one.
 *
 * The pairings half is this file's own: switch, forget, and the live session's numbers (the
 * mirror's, straight off the engine's reader). The adding half is `ui/Doors.tsx`, shared with the
 * first-run screen, so one decision has one vocabulary — see the note above where it renders.
 *
 * ── WHAT THIS HEADER USED TO CLAIM, AND WHY IT WAS WRONG ────────────────────────────────────────
 *
 * It said *"today the hosted service answers `pairing: false` because it mounts no redeem"*. That
 * was true when it was written and is not now: measured 2026-09-01, `GET /hello` on the hosted
 * service answers `features.pairing: true` and its redeem is mounted.
 * The mechanism was built exactly so that change needed no client edit and it did not — the
 * negotiation started offering the pair step on its own. What did NOT self-correct was the prose
 * and the copy deck around it, which went on describing a state the server had left, which is the
 * quiet way a comment becomes a false claim.
 */
import { useCallback, useState, useSyncExternalStore } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { Copy } from "../src/copy";
import { useConnection } from "../src/net/connection";
import type { ServerProfile } from "../src/state/servers";
import { useTheme } from "../src/theme";
import { Button, Panel, Screen, Scroller, Section, TapRow, Txt } from "../src/ui/base";
import { DetailBar } from "../src/ui/chrome";
import { Doors } from "../src/ui/Doors";

export default function ServersScreen() {
  const conn = useConnection();
  /** What a forget could not take back. Held HERE — see the note beside where it renders. */
  const [forgetFailure, setForgetFailure] = useState<string | null>(null);

  return (
    <Screen>
      <DetailBar title={Copy.serversTitle} />
      <Scroller>
        <View style={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: 14 }}>
          <Txt variant="h1">{Copy.serversTitle}</Txt>
          <Txt variant="caption" tone="ink3" style={{ marginTop: 6, lineHeight: 16 }}>
            {Copy.serversNote}
          </Txt>
        </View>

        <StatusPanel />

        {conn.profiles.length > 0 ? (
          <Panel style={{ marginTop: 14, paddingBottom: 12 }}>
            <Section style={{ paddingTop: 16 }}>{Copy.serversProfiles}</Section>
            {conn.profiles.map((p) => (
              <ProfileRow
                key={p.id}
                profile={p}
                active={p.id === conn.activeId}
                onForgetFailed={(r) => setForgetFailure(r === "" ? null : r)}
              />
            ))}
            <View style={{ paddingHorizontal: 20, paddingTop: 6 }}>
              <Txt variant="caption" tone="ink3" style={{ lineHeight: 16 }}>
                {Copy.serversForgetNote}
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
              <Txt variant="caption" tone="ink2" style={{ lineHeight: 16 }}>
                {Copy.serversForgetFailed(forgetFailure)}
              </Txt>
            </View>
          </Panel>
        )}

        <View style={{ marginTop: 14 }}>
          <Doors onScan={() => router.push("/scan")} onTypeToken={() => router.push("/connect")} />
        </View>
      </Scroller>
    </Screen>
  );
}

/** The connection's own words: live numbers, a boot in progress, a refusal, a death. */
function StatusPanel() {
  const conn = useConnection();
  const s = conn.state;
  if (s.k === "starting" || s.k === "idle") {
    return conn.profiles.length === 0 ? (
      <Panel style={{ paddingVertical: 16 }}>
        <View style={{ paddingHorizontal: 20 }}>
          <Txt variant="caption" tone="ink3" style={{ lineHeight: 16 }}>
            {Copy.serversEmpty}
          </Txt>
        </View>
      </Panel>
    ) : null;
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
            <Txt variant="caption" tone="ink2" style={{ lineHeight: 16 }}>{s.reason}</Txt>
          </>
        ) : null}
        {s.k === "live" ? <LiveFacts /> : null}
      </View>
      {s.k === "live" ? (
        <View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 10 }}>
          <Button label={Copy.connectSyncNow} onPress={conn.syncing ? undefined : conn.syncNow} />
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
      <Txt variant="settingsLabel">{s.session.profile.origin}</Txt>
      <Txt variant="caption" tone="ink3" tabular>
        {conn.syncing ? Copy.connectSyncing : Copy.connectMirrored(total, s.session.store.getCursor())}
      </Txt>
      {conn.syncError ? (
        <Txt variant="caption" tone="ink2" style={{ lineHeight: 16 }}>
          {/* WHETHER THIS PAIRING HOLDS A PIN decides which sentence a handshake failure gets.
              A pinned pairing is a computer whose key this phone agreed to, so a failure there
              means that key changed. An unpinned one — the hosted service, a self-hosted server
              on a real name — has no key to change, and the honest reading is that the phone
              would not accept the certificate at that address. See `connectSyncFailed`. */}
          {Copy.connectSyncFailed(conn.syncError, s.session.profile.pin !== null)}
        </Txt>
      ) : null}
    </>
  );
}

function ProfileRow({ profile, active, onForgetFailed }: {
  profile: ServerProfile;
  active: boolean;
  /** Raised to the SCREEN, because a partial forget removes this very row. See its note there. */
  onForgetFailed: (reason: string) => void;
}) {
  const conn = useConnection();
  const t = useTheme();
  const needsPair = profile.refreshToken === null;
  // Forgetting the FINAL pairing returns to the welcome screen — explicitly, from the
  // action itself. The tabs' redirect cannot be trusted to fire here: while /servers is
  // the focused route, the gated layouts behind it may never re-render their verdict, and
  // "the app went back to its first screen" must not depend on which screen was focused.
  // Counted before the await (this handler's `conn` is the render's snapshot; the forget
  // removes exactly this row).
  const forget = async () => {
    const wasLast = conn.profiles.length === 1;
    onForgetFailed("");
    const outcome = await conn.forget(profile.id);
    if (!outcome.ok) {
      // NOT a local setState: the credential half succeeds first, so this component is usually
      // already unmounted by the time the outcome arrives. The screen holds it instead.
      onForgetFailed(outcome.reason);
      return;
    }
    if (wasLast) router.replace("/welcome");
  };
  return (
    <View style={{ marginHorizontal: 8 }}>
      <TapRow
        selected={active}
        onPress={() => {
          // A row whose credential is gone re-pairs (one scan); a live one switches. BY ID:
          // this rendered row may be stale (a rotation may have landed since), and the
          // connection layer re-reads the keystore row inside its gate.
          if (needsPair) router.push("/scan");
          else void conn.switchTo(profile.id);
        }}
        accessibilityRole="button"
        accessibilityLabel={`${profile.origin}, ${profile.flavor}`}
        style={{ paddingHorizontal: 12, paddingVertical: 10, gap: 2 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {active ? (
            <View style={{ width: 7, height: 7, borderRadius: t.radius.dot, backgroundColor: t.c.accent }} />
          ) : null}
          <Txt variant="navLabel" numberOfLines={1} style={{ flexShrink: 1 }}>
            {profile.origin}
          </Txt>
          <View style={{ flex: 1 }} />
          <Txt variant="caption" tone="ink3">{profile.flavor}</Txt>
        </View>
        <Txt variant="caption" tone="ink3" numberOfLines={1}>
          {needsPair ? Copy.serversNeedsPair : profile.accountId}
        </Txt>
      </TapRow>
      <View style={{ flexDirection: "row", paddingHorizontal: 12, paddingBottom: 6 }}>
        <Button label={Copy.serversForget} variant="quiet" onPress={() => void forget()} />
      </View>
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
