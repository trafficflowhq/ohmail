import { View } from "react-native";
import { Copy } from "../copy";
import { Badge, Txt } from "./base";

export function StreamRecipient({ toYou }: { toYou?: true }) {
  return toYou ? <Txt variant="caption" tone="ink2">{Copy.streamToYouDetails}</Txt> : null;
}

export function StreamContentChips({ images, tracker }: { images?: true; tracker?: string }) {
  if (!images && !tracker) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {images ? <Badge icon="shield">{Copy.mailImagesCaption}</Badge> : null}
      {tracker ? <Badge icon="shield">{Copy.mailTrackerCaption}</Badge> : null}
    </View>
  );
}
