/**
 * Settings — appearance, new mail, and what this build is.
 *
 * Every control here is real, and every claim is one this build can keep: the
 * theme switch is the app's own preference, the New mail block registers with
 * the server this phone is paired with, and the About block states what is live
 * and names what is not. The remaining per-server settings (rules, mailboxes)
 * arrive with later updates — until then they are absent, not mocked. The
 * pairing itself is managed on the Servers screen.
 *
 * The New mail block is the reason this header no longer says notifications are
 * absent: it now shows a real choice when the phone has distributors installed,
 * and one sentence with no control when it does not. Which of the two appears is
 * a fact read from the device, never a build-time assumption.
 */
import { useState } from "react";
import { View } from "react-native";
import { Copy } from "../src/copy";
import { type WakeState } from "../src/net/push";
import { useWake } from "../src/state/wake";
import type { ThemePref } from "../src/theme";
import { usePrefs } from "../src/state/store";
import { useWorld } from "../src/state/world";
import { Panel, Rule, Screen, Scroller, Section, TapRow, Txt } from "../src/ui/base";
import { DetailBar } from "../src/ui/chrome";
import { Gated } from "../src/ui/Gated";
import { Segmented } from "../src/ui/Segmented";

/** Gated like the tabs: the About block states a live session's facts, so it needs one. */
export default function SettingsScreen() {
  return (
    <Gated>
      <SettingsBody />
    </Gated>
  );
}

/**
 * The one sentence the New mail block renders, chosen from the wake state.
 *
 * Exported nowhere and pure, so `test/wake-copy.test.ts` can assert that every state has a
 * sentence and that none of them claims a wake this build can deliver. A `switch` over the union
 * rather than a lookup, because adding a state to {@link WakeState} then fails to compile here
 * instead of silently rendering nothing.
 */
export function wakeSentence(state: WakeState): string {
  switch (state.k) {
    case "no_distributor": return Copy.wakeNoDistributor;
    case "not_supported_here": return Copy.wakeDesktopHost;
    case "server_has_no_key": return Copy.wakeServerNoKey;
    case "on": return Copy.wakeOn;
    // `row_remains` is not "we could not set it up" — it is "we could not take it back", and the
    // two have different sentences and different remedies.
    case "off": return state.reason === "row_remains" ? Copy.wakeRowRemains : Copy.wakeOff(state.reason);
  }
}

function SettingsBody() {
  const w = useWorld();
  const { themePref, setTheme } = usePrefs();
  const wake = useWake();

  return (
    <Screen>
      <DetailBar title={Copy.settings} />
      <Scroller>
        <View style={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: 16 }}>
          <Txt variant="h1">{Copy.settings}</Txt>
        </View>

        {/* appearance */}
        <Panel style={{ paddingBottom: 16, marginBottom: 14 }}>
          <Section style={{ paddingTop: 16 }}>{Copy.theme}</Section>
          <View style={{ paddingHorizontal: 16 }}>
            <Segmented<ThemePref>
              value={themePref}
              onChange={setTheme}
              segments={[
                { value: "system", label: "System" },
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
            />
            <Txt variant="caption" tone="ink3" style={{ marginTop: 10 }}>
              {Copy.themeNote}
            </Txt>
          </View>
        </Panel>

        {/*
          NEW MAIL — a real control when there is a real choice, and a sentence otherwise.

          The list comes from the DEVICE (`listDistributors()`), so this block shows rows only when
          the phone actually has distributors installed. On a phone with none — and on every iPhone,
          where UnifiedPush cannot exist — `wake.choices` is empty and the pane is one sentence with
          no control, which is the rule this screen was built on: a toggle that cannot move is worse
          than a paragraph saying why.

          The `None` row is last and separated, because it is the only destructive option here: it
          drops the registration from the server as well as forgetting the distributor.
        */}
        <Panel style={{ paddingVertical: 18, marginBottom: 14 }}>
          <View style={{ paddingHorizontal: 20, gap: 6 }}>
            <Txt variant="settingsLabel">{Copy.wake}</Txt>
            <Txt variant="note" tone="ink2">{wakeSentence(wake.state)}</Txt>
          </View>

          {wake.choices.length > 0 && (
            <View style={{ marginTop: 14 }}>
              <Section>{Copy.wakeDistributor}</Section>
              <View style={{ paddingHorizontal: 12, gap: 2 }}>
                {wake.choices.map((d) => (
                  <TapRow
                    key={d.id}
                    selected={d.id === wake.chosen}
                    disabled={wake.busy}
                    onPress={() => { wake.choose(d.id); }}
                    style={{ paddingHorizontal: 8, paddingVertical: 12 }}
                  >
                    <Txt variant="body">{d.name}</Txt>
                  </TapRow>
                ))}
                <Rule inset={8} />
                <TapRow
                  selected={wake.chosen === null}
                  disabled={wake.busy}
                  onPress={() => { wake.turnOff(); }}
                  style={{ paddingHorizontal: 8, paddingVertical: 12 }}
                >
                  <Txt variant="body" tone="ink2">{Copy.wakeDistributorNone}</Txt>
                </TapRow>
              </View>
              <View style={{ paddingHorizontal: 20, paddingTop: 10 }}>
                {/* THE HINT IS A CLAIM, so it is withheld when the sentence above contradicts it.
                    "Turning this off … removes the registration from your server" is exactly what
                    `row_remains` says did NOT happen, and the two were rendered together: the same
                    screen asserting a take-back and its failure. The state's own sentence stands
                    alone in that case. */}
                <Txt variant="caption" tone="ink3">
                  {wake.state.k === "off" && wake.state.reason === "row_remains"
                    ? ""
                    : wake.chosen === null ? Copy.wakeDistributorNoneHint : Copy.wakeDistributorHint}
                </Txt>
              </View>
            </View>
          )}
        </Panel>

        {/*
          FOLDERS — the feature's master toggle (FOLDERS-SPEC.md §6; owner decision 1: fully
          optional, off by default). The control renders the value the SERVER last answered
          with, never the optimistic pick — a refused write must not draw a folders group the
          account does not have (the webapp FoldersRow's rule; the world layer holds it). A
          plain switch and not a confirm: ON is a read-only act on the mailbox — it shows
          folders that already exist and moves nothing.
        */}
        <FoldersPanel
          on={w.folders.enabled}
          pending={w.folders.pending}
          setEnabled={w.folders.setEnabled}
        />

        {/* about — one sentence, true of the session on screen */}
        <Panel style={{ paddingVertical: 18, marginBottom: 10 }}>
          <View style={{ paddingHorizontal: 20, gap: 6 }}>
            <Txt variant="settingsLabel">{Copy.about}</Txt>
            <Txt variant="note" tone="ink2">
              {Copy.aboutLive(w.account.name)}
            </Txt>
            {/* What leaving actually leaves — including the one thing this build cannot yet
                take back (an iOS backup carries the copied mail). See `Copy.aboutOnDevice`. */}
            <Txt variant="note" tone="ink3">
              {Copy.aboutOnDevice}
            </Txt>
          </View>
        </Panel>
      </Scroller>
    </Screen>
  );
}

/**
 * The Folders pane: the description states the current answer (`useOn`/`useOff` — the webapp
 * catalogue's own sentences), the control moves it, and a refusal is one visible sentence
 * with the control back on the server's value. `pending` guards the double-write exactly
 * like the wake rows above.
 */
function FoldersPanel({
  on,
  pending,
  setEnabled,
}: {
  on: boolean;
  pending: boolean;
  setEnabled: (on: boolean) => Promise<boolean>;
}) {
  const [failed, setFailed] = useState(false);
  const write = (next: "on" | "off") => {
    if (pending) return;
    setFailed(false);
    void setEnabled(next === "on").then((ok) => {
      if (!ok) setFailed(true);
    });
  };
  return (
    <Panel style={{ paddingVertical: 18, marginBottom: 14 }}>
      <View style={{ paddingHorizontal: 20, gap: 6 }}>
        <Txt variant="settingsLabel">{Copy.foldersUseTitle}</Txt>
        <Txt variant="note" tone="ink2">{on ? Copy.foldersUseOn : Copy.foldersUseOff}</Txt>
      </View>
      <View style={{ paddingHorizontal: 16, marginTop: 12 }}>
        <Segmented<"on" | "off">
          value={on ? "on" : "off"}
          onChange={write}
          segments={[
            { value: "off", label: "Off" },
            { value: "on", label: "On" },
          ]}
        />
        <Txt variant="caption" tone="ink3" style={{ marginTop: 10 }}>
          {Copy.foldersMicrocopy}
        </Txt>
        {failed ? (
          <Txt variant="caption" tone="ink3" style={{ marginTop: 6 }}>
            {Copy.foldersFailed}
          </Txt>
        ) : null}
      </View>
    </Panel>
  );
}
