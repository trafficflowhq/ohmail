import { router } from "expo-router";
import { View } from "react-native";
import { Copy } from "../copy";
import { useWorldToast } from "../state/world";
import { Button, Panel, Txt } from "./base";

export function FullMailboxNotice() {
  const { copyQuota, dismissCopyQuota } = useWorldToast();
  if (!copyQuota) return null;
  return (
    <Panel style={{ marginHorizontal: 12, marginBottom: 8, paddingHorizontal: 16, paddingVertical: 11, gap: 7 }}>
      <Txt variant="body" accessibilityRole="summary">
        <Txt variant="rowSubject">{Copy.quotaTitle}</Txt>{" "}
        {copyQuota.until ? Copy.sentCopyWaitingUntil("full", "", copyQuota.until).trim() : Copy.quotaWaiting}
      </Txt>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button label={Copy.quotaMailboxes} variant="solid" onPress={() => router.push("/settings")} />
        <Button label={Copy.quotaNotNow} onPress={dismissCopyQuota} />
      </View>
    </Panel>
  );
}
