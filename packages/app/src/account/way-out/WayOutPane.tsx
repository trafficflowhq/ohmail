import { Button, type IconName } from "@ohmail/ui/base";
import { SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import { useText } from "../../text/index.js";
import type { WayOutModel, WayOutSection } from "./model.js";

/**
 * Each section's sign and its sentences, by their keys in `settings`, where every shell that draws the card already
 * reads them: what is handled in the browser, why, and what else holds there.
 */
const SAYS: Readonly<
  Record<
    WayOutSection,
    { readonly sign: IconName; readonly title: string; readonly why: string; readonly note: string | null }
  >
> = {
  devices: { sign: "phone", title: "webDevicesTitle", why: "webDevicesWhy", note: "webDevicesNote" },
  security: { sign: "shield", title: "webSecurityTitle", why: "webSecurityWhy", note: null },
  account: { sign: "key", title: "webAccountTitle", why: "webAccountWhy", note: "webAccountNote" },
};

export interface WayOutPaneProps {
  readonly model: WayOutModel;
  readonly openLabel?: string;
  readonly onServer?: boolean;
}

/**
 * The "handled in your browser" card: one sheet that names what the browser holds, the one verb that opens it there,
 * and the reason, said before the press. When this computer started no browser the sheet says so and where the page
 * is, and the verb stays.
 */
export function WayOutPane({ model, openLabel, onServer }: WayOutPaneProps) {
  const t = useText("settings");
  const says = SAYS[model.section];
  const note = onServer && model.section === "account" ? "webAccountNoteServer" : says.note;
  return (
    <SettingsSheet
      title={t(says.title)}
      sign={says.sign}
      hot={model.noBrowser}
      aside={
        <Button kind="two" size="s" icon="go" onPress={model.open}>
          {openLabel ?? t(onServer ? "webOpenServer" : "webOpen")}
        </Button>
      }
    >
      {model.noBrowser ? (
        <SettingNote warn>{t(onServer ? "webNoBrowserServer" : "webNoBrowser")}</SettingNote>
      ) : null}
      <SettingNote>{t(says.why)}</SettingNote>
      {note === null ? null : <SettingNote>{t(note)}</SettingNote>}
    </SettingsSheet>
  );
}
