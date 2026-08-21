/**
 * Settings — appearance, and what this build is.
 *
 * Every control here is real, and every claim is one this build can keep: the
 * theme switch is the app's own preference, and the About block states what is
 * live on this build and names what is not. Per-server settings (notifications,
 * rules, mailboxes) arrive with later updates — until then they are absent, not
 * mocked. The pairing itself is managed on the Servers screen.
 */
import { View } from "react-native";
import { Copy } from "../src/copy";
import { NO_DISTRIBUTOR, type WakeState } from "../src/net/push";
import type { ThemePref } from "../src/theme";
import { usePrefs } from "../src/state/store";
import { useWorld } from "../src/state/world";
import { Panel, Screen, Scroller, Section, Txt } from "../src/ui/base";
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
function wakeSentence(state: WakeState): string {
  switch (state.k) {
    case "no_distributor": return Copy.wakeNoDistributor;
    case "not_supported_here": return Copy.wakeDesktopHost;
    case "on": return Copy.wakeOn;
    case "off": return Copy.wakeOff(state.reason);
  }
}

function SettingsBody() {
  const w = useWorld();
  const { themePref, setTheme } = usePrefs();
  /**
   * No distributor in this build, so no request is made and no state is kept — the pane is a
   * function of one fact. `NO_DISTRIBUTOR.available()` is the fact, read here rather than
   * hard-coded, so the day a connector is wired this line starts telling the truth about it
   * instead of having to be found and changed.
   */
  const wakeState: WakeState = NO_DISTRIBUTOR.available()
    ? { k: "off", reason: "not_registered" }
    : { k: "no_distributor" };

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
          NEW MAIL — one sentence, and no control.

          The wake registration itself is finished (`src/net/push.ts`), and what is missing is a
          UnifiedPush DISTRIBUTOR: a separate app the user installs and chooses. There is no
          connector in this build's dependency graph, so `NO_DISTRIBUTOR` is the honest answer and
          `wakeState` resolves to a sentence rather than to a switch. A toggle here would be a dead
          control, which is the one thing this screen's header comment forbids.

          When a connector lands, this block gains the `on`/`off` sentences that are already
          written for it and a control — and this comment goes with the change.
        */}
        <Panel style={{ paddingVertical: 18, marginBottom: 14 }}>
          <View style={{ paddingHorizontal: 20, gap: 6 }}>
            <Txt variant="settingsLabel">{Copy.wake}</Txt>
            <Txt variant="note" tone="ink2">{wakeSentence(wakeState)}</Txt>
          </View>
        </Panel>

        {/* about — one sentence, true of the session on screen */}
        <Panel style={{ paddingVertical: 18, marginBottom: 10 }}>
          <View style={{ paddingHorizontal: 20, gap: 6 }}>
            <Txt variant="settingsLabel">{Copy.about}</Txt>
            <Txt variant="note" tone="ink2">
              {Copy.aboutLive(w.account.name)}
            </Txt>
          </View>
        </Panel>
      </Scroller>
    </Screen>
  );
}
