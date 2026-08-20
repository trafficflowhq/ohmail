/**
 * FIRST RUN — the one screen a phone with no pairing sees.
 *
 * One statement of what this app is, then straight into connecting: the QR scan as the
 * primary path (the desktop's Devices screen and the self-host setup page both show one),
 * the server picker behind it for the typed-address and pasted-link paths. No sample data,
 * no tour — the app is empty until it is connected, and this screen says so plainly.
 *
 * The screen exists only while nothing is paired: the tabs gate routes here, and the
 * redirect below hands the screen back the moment a session goes live.
 */
import { View } from "react-native";
import { Redirect, router } from "expo-router";
import { Copy } from "../src/copy";
import { useConnection } from "../src/net/connection";
import { useTheme } from "../src/theme";
import { Button, Screen, Txt } from "../src/ui/base";
import { Wordmark } from "../src/ui/Icon";

export default function WelcomeScreen() {
  const conn = useConnection();
  const t = useTheme();
  if (conn.state.k === "live") return <Redirect href="/" />;

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: "center", paddingHorizontal: 28, gap: 14 }}>
        <Wordmark color={t.c.ink} dot={t.c.accent} size={30} />
        <Txt variant="h2" style={{ marginTop: 6 }}>
          {Copy.welcomeTitle}
        </Txt>
        <Txt variant="note" tone="ink2" style={{ lineHeight: 21 }}>
          {Copy.welcomeLead}
        </Txt>
        <Txt variant="caption" tone="ink3" style={{ lineHeight: 17 }}>
          {Copy.welcomeHow}
        </Txt>
        <View style={{ gap: 10, marginTop: 14 }}>
          <Button label={Copy.welcomeScan} variant="solid" onPress={() => router.push("/scan")} />
          <Button label={Copy.welcomeOther} onPress={() => router.push("/servers")} />
        </View>
      </View>
    </Screen>
  );
}
