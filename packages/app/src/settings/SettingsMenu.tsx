import { GroupHeading, ListHead, Rows } from "@ohmail/ui/mail";
import { useText } from "../text/index.js";
import type { PaneGroup, PaneId, SettingsPane } from "./contract.js";
import { usePaneName } from "./label.js";
import { groupsOf } from "./menu.js";
import { PaneRow } from "./PaneRow.js";

const GROUP_KEY: Readonly<Record<PaneGroup, string>> = {
  mail: "groupMail",
  account: "groupAccount",
  about: "groupAbout",
};

export interface SettingsMenuProps {
  readonly menu: readonly SettingsPane[];
  /** The section standing beside the menu, where one does. */
  readonly current: PaneId | null;
  readonly go: (pane: PaneId) => void;
}

/** The sections a host lists, in their three groups. A press goes through the place's leave hold. */
export function SettingsMenu({ menu, current, go }: SettingsMenuProps) {
  const t = useText("settings");
  const name = usePaneName();
  return (
    <nav aria-label={t("navAria")}>
      <ListHead title={t("title")} />
      {groupsOf(menu).map(({ group, panes }) => (
        <section key={group}>
          <GroupHeading>{t(GROUP_KEY[group])}</GroupHeading>
          <Rows>
            {panes.map((pane) => (
              <PaneRow
                key={pane.id}
                pane={pane}
                name={name(pane)}
                open={pane.id === current}
                onOpen={() => go(pane.id)}
              />
            ))}
          </Rows>
        </section>
      ))}
    </nav>
  );
}
