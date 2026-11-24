import { WayOutPane, useWayOut, type WayOutDoor } from "@ohmail/app/account/way-out";
import { useTranslations } from "next-intl";

/** The hosted Devices pane delegates its protected actions to the browser. */
export function DesktopWebSection({ door, onServer }: { door: WayOutDoor; onServer: boolean }) {
  const t = useTranslations("settings");
  return <WayOutPane model={useWayOut(door, "devices")} onServer={onServer} openLabel={t(onServer ? "webOpenServer" : "webOpen")} />;
}
