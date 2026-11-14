import { useResolvedDemoMode } from "@ohmail/app-logic/engine";
import { UI_KEYS, usePersistedFlag } from "@ohmail/app-logic/storage/persisted-ui";
import { useFrame, type FrameNotice } from "../../frame/index.js";
import { NONE } from "../../host/index.js";
import { useText } from "../../text/index.js";

export function useDesktopOffer(): FrameNotice | null {
  const { device } = useFrame().host;
  const { surface, desktopDownload } = device.build;
  const { openLink } = device;
  const demo = useResolvedDemoMode();
  const t = useText("rail");
  const [dismissed, dismiss] = usePersistedFlag(UI_KEYS.desktopCtaDismissed, false);
  if (surface !== "web" || demo || openLink === NONE || !desktopDownload || dismissed) return null;

  return {
    kind: "desktopOffer",
    title: t("getDesktop"),
    acts: [
      { label: t("getDesktopOpen"), onPress: () => openLink(desktopDownload) },
      { label: t("getDesktopDismiss"), onPress: () => dismiss(true) },
    ],
  };
}
