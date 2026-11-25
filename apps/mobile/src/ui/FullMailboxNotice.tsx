import { router } from "expo-router";
import { View } from "react-native";
import { Copy } from "../copy";
import { useWorldToast } from "../state/world";
import { useTheme } from "../theme";
import { mailSize } from "../theme/mail";
import { Button, Panel, Txt } from "./base";

export function FullMailboxNotice() {
  const theme = useTheme();
  const { copyQuota, dismissCopyQuota } = useWorldToast();
  if (!copyQuota) return null;
  return (
    <Panel style={{
      marginHorizontal: mailSize.inset, marginBottom: mailSize.inset,
      paddingHorizontal: mailSize.edge, paddingVertical: mailSize.inset, gap: mailSize.inset,
      borderWidth: 1, borderColor: theme.c.hairSoft, shadowOpacity: 0, elevation: 0,
    }}>
      <Txt variant="note" accessibilityRole="summary" accessibilityLiveRegion="polite">
        <Txt variant="rowSubject">{Copy.quotaTitle}<Txt variant="rowSubject" tone="accent">.</Txt></Txt>{" "}
        {copyQuota.until ? Copy.sentCopyWaitingUntil("full", "", copyQuota.until).trim() : Copy.quotaWaiting}
      </Txt>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button label={Copy.quotaMailboxes} variant="solid"
          onPress={() => router.push({ pathname: "/settings", params: { pane: "mailboxes" } })} />
        <Button label={Copy.quotaNotNow} variant="quiet" onPress={dismissCopyQuota} />
      </View>
    </Panel>
  );
}
