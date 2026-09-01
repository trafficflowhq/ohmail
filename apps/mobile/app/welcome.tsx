/**
 * FIRST RUN — the one screen a phone with no pairing sees, and it asks the product's own question.
 *
 * ── IT WAS A SCAN BUTTON; IT IS THE THREE DOORS NOW ─────────────────────────────────────────
 *
 * This screen used to lead with "Scan the pairing QR" and hide everything else behind "Other ways
 * to connect". That was true of the mechanism and wrong about the decision: a person opening this
 * app has not yet chosen WHICH machine organizes their mail, and the scan is the last step of an
 * answer, not the question. The desktop's chooser asks "which mailbox is this?" and offers three
 * machines; this asks the same thing, with the phone's own three answers — see `ui/Doors.tsx` for
 * why they are not the desktop's three and why they are in this order.
 *
 * No sample data, no tour: the app is empty until it is connected, and this screen says so.
 *
 * The screen exists only while nothing is paired: the tabs gate routes here, and the redirect
 * below hands the screen back the moment a session goes live.
 */
import { View } from "react-native";
import { Redirect, router } from "expo-router";
import { Copy } from "../src/copy";
import { useConnection } from "../src/net/connection";
import { useTheme } from "../src/theme";
import { Screen, Scroller, Txt } from "../src/ui/base";
import { Doors } from "../src/ui/Doors";
import { Wordmark } from "../src/ui/Icon";

export default function WelcomeScreen() {
  const conn = useConnection();
  const t = useTheme();
  if (conn.state.k === "live") return <Redirect href="/" />;

  return (
    <Screen>
      {/* SCROLLABLE, and that is a change forced by the content rather than a style choice: three
          doors with a factual line each, an address step that can open under the middle one, and
          the travel sentence do not fit a centred column on a small phone. A chooser whose third
          door is below the fold on a 5" screen would be a chooser with two doors. */}
      <Scroller>
        <View style={{ paddingHorizontal: 16, paddingTop: 28, paddingBottom: 14, gap: 12 }}>
          <Wordmark color={t.c.ink} dot={t.c.accent} size={30} />
          <Txt variant="h2">{Copy.welcomeTitle}</Txt>
          <Txt variant="note" tone="ink2" style={{ lineHeight: 21 }}>
            {Copy.welcomeLead}
          </Txt>
          <Txt variant="caption" tone="ink3" style={{ lineHeight: 17 }}>
            {Copy.welcomeHow}
          </Txt>
        </View>
        <Doors
          lead
          onScan={() => router.push("/scan")}
          onTypeToken={() => router.push("/connect")}
        />
      </Scroller>
    </Screen>
  );
}
