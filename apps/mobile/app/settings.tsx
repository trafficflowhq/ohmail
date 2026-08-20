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
import type { ThemePref } from "../src/theme";
import { usePrefs } from "../src/state/store";
import { useWorld } from "../src/state/world";
import { Panel, Screen, Scroller, Section, Txt } from "../src/ui/base";
import { DetailBar } from "../src/ui/chrome";
import { Segmented } from "../src/ui/Segmented";

export default function SettingsScreen() {
  const w = useWorld();
  const { themePref, setTheme } = usePrefs();

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
