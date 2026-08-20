/**
 * THE SERVER PICKER — three plain choices, each honest about what the server it names offers.
 *
 * Every choice negotiates via `GET /hello` (through the connection layer's seam — this file
 * touches no network itself) and shows a NEXT STEP only when the server's `features.pairing`
 * allows it: no dead buttons. The managed card makes that rule visible: it negotiates like
 * the others, and today the hosted service answers `pairing: false` because it mounts no
 * redeem — so the card says sign-in-arrives-later in words. When the hosted service mounts
 * the ceremony, the same negotiation starts offering the pair step with no client change.
 *
 * The screen also holds the pairings this phone already has: switch, forget, and the live
 * session's own numbers (the mirror's, straight off the engine's reader).
 */
import { useCallback, useState, useSyncExternalStore } from "react";
import { TextInput, View } from "react-native";
import { router } from "expo-router";
import { Copy } from "../src/copy";
import { useConnection } from "../src/net/connection";
import type { Negotiation, PickerStep } from "../src/net/pairing";
import { MANAGED_ORIGIN, nextStep } from "../src/net/pairing";
import type { ServerProfile } from "../src/state/servers";
import { useTheme } from "../src/theme";
import { Button, Panel, Rule, Screen, Scroller, Section, TapRow, Txt } from "../src/ui/base";
import { DetailBar } from "../src/ui/chrome";

export default function ServersScreen() {
  const conn = useConnection();

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
              <ProfileRow key={p.id} profile={p} active={p.id === conn.activeId} />
            ))}
            <View style={{ paddingHorizontal: 20, paddingTop: 6 }}>
              <Txt variant="caption" tone="ink3" style={{ lineHeight: 16 }}>
                {Copy.serversForgetNote}
              </Txt>
            </View>
          </Panel>
        ) : null}

        <AddPanel />
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
          {Copy.connectSyncFailed(conn.syncError)}
        </Txt>
      ) : null}
    </>
  );
}

function ProfileRow({ profile, active }: { profile: ServerProfile; active: boolean }) {
  const conn = useConnection();
  const t = useTheme();
  const needsPair = profile.refreshToken === null;
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
        <Button label={Copy.serversForget} variant="quiet" onPress={() => void conn.forget(profile.id)} />
      </View>
    </View>
  );
}

/* ── the three choices ──────────────────────────────────────────────────────────────────────── */

type Probe =
  | { k: "idle" }
  | { k: "asking" }
  | { k: "answered"; origin: string; flavor: string }
  | { k: "failed"; sentence: string };

/** One sentence per non-pairing outcome — the honest end of a flow, never a dead control. */
function sentenceFor(n: Negotiation, step?: PickerStep): string {
  if (n.kind === "unreachable") return Copy.unreachable(n.detail);
  if (n.kind === "not-ohmail") return Copy.notOhmail;
  if (step?.kind === "managed-signin-later") return Copy.managedDeferred;
  return Copy.noPairing;
}

function AddPanel() {
  const conn = useConnection();
  const [own, setOwn] = useState(false);
  const [address, setAddress] = useState("");
  const [probe, setProbe] = useState<Probe>({ k: "idle" });

  const ask = useCallback(
    async (origin: string) => {
      setProbe({ k: "asking" });
      const answer = await conn.ask(origin);
      if (answer.kind !== "hello") {
        setProbe({ k: "failed", sentence: sentenceFor(answer) });
        return;
      }
      const step = nextStep(answer.hello);
      if (step.kind !== "pair") {
        setProbe({ k: "failed", sentence: sentenceFor(answer, step) });
        return;
      }
      setProbe({ k: "answered", origin, flavor: answer.hello.flavor });
    },
    [conn],
  );

  return (
    <Panel style={{ marginTop: 14, paddingBottom: 16 }}>
      <Section style={{ paddingTop: 16 }}>{Copy.serversAdd}</Section>

      <Choice
        label={Copy.choiceDesktop}
        note={Copy.choiceDesktopNote}
        onPress={() => router.push("/scan")}
      />
      <Rule inset={20} />
      <Choice
        label={Copy.choiceSelf}
        note={Copy.choiceSelfNote}
        onPress={() => {
          setOwn((v) => !v);
          setProbe({ k: "idle" });
        }}
      />
      {own ? (
        <View style={{ paddingHorizontal: 16, paddingTop: 4, gap: 10 }}>
          <AddressField value={address} onChange={setAddress} />
          <Button
            label={probe.k === "asking" ? Copy.askChecking : Copy.askGo}
            variant="solid"
            onPress={probe.k === "asking" || !address.trim() ? undefined : () => void ask(address)}
          />
          <ProbeResult probe={probe} />
        </View>
      ) : null}
      <Rule inset={20} />
      <Choice
        label={Copy.choiceManaged}
        note={Copy.choiceManagedNote}
        onPress={() => {
          // The managed card negotiates for real: the answer — today,
          // sign-in-arrives-later — comes from the server's own descriptor, not a hardcode.
          setOwn(false);
          void ask(MANAGED_ORIGIN);
        }}
      />
      {!own ? (
        <View style={{ paddingHorizontal: 16, paddingTop: 4 }}>
          <ProbeResult probe={probe} />
        </View>
      ) : null}
    </Panel>
  );
}

function ProbeResult({ probe }: { probe: Probe }) {
  if (probe.k === "failed") {
    return (
      <Txt variant="caption" tone="ink2" style={{ lineHeight: 16, paddingHorizontal: 4 }}>
        {probe.sentence}
      </Txt>
    );
  }
  if (probe.k !== "answered") return null;
  // The pairing step exists because /hello said so — the two ways to spend a token.
  return (
    <View style={{ gap: 10 }}>
      <Txt variant="caption" tone="ink3" style={{ lineHeight: 16, paddingHorizontal: 4 }}>
        {Copy.stepPairOffered(probe.flavor)}
      </Txt>
      <Button label={Copy.stepScan} onPress={() => router.push("/scan")} />
      <Button
        label={Copy.stepManual}
        onPress={() => router.push({ pathname: "/connect", params: { origin: probe.origin } })}
      />
    </View>
  );
}

function Choice({ label, note, onPress }: { label: string; note: string; onPress: () => void }) {
  return (
    <TapRow
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={{ marginHorizontal: 8, paddingHorizontal: 12, paddingVertical: 12, gap: 2 }}
    >
      <Txt variant="navLabel">{label}</Txt>
      <Txt variant="caption" tone="ink3">{note}</Txt>
    </TapRow>
  );
}

function AddressField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useTheme();
  return (
    <View>
      <View
        style={[
          { paddingHorizontal: 14, borderRadius: t.radius.input, backgroundColor: t.c.canvas },
          t.lift("l0"),
        ]}
      >
        <TextInput
          value={value}
          onChangeText={onChange}
          autoCorrect={false}
          autoCapitalize="none"
          keyboardType="url"
          accessibilityLabel={Copy.askAddress}
          style={[t.type.msgBody, { color: t.c.ink, paddingVertical: 12 }]}
        />
      </View>
      <Txt variant="caption" tone="ink3" style={{ marginTop: 6 }}>
        {Copy.askAddressHint}
      </Txt>
    </View>
  );
}
