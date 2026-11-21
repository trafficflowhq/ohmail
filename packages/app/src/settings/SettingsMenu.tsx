import { useLayoutEffect, useRef, type ReactNode } from "react";
import { GroupHeading, ListHead, Rows, Sheet } from "@ohmail/ui/mail";
import { useText } from "../text/index.js";
import type { PaneGroup, SettingsPaneId, SettingsPane } from "./contract.js";
import { usePaneName } from "./label.js";
import { groupsOf } from "./menu.js";
import { PaneRow } from "./PaneRow.js";
import { useNotificationSummary } from "./notifications/summary.js";
import "./settings-menu.css";

const GROUP_KEY: Readonly<Record<Exclude<PaneGroup, "calendar">, string>> = {
  mail: "groupMail",
  account: "groupAccount",
  about: "groupAbout",
};

export interface SettingsMenuProps {
  readonly menu: readonly SettingsPane[];
  /** The section standing beside the menu, where one does. */
  readonly current: SettingsPaneId | null;
  readonly phone?: boolean;
  readonly leading?: ReactNode;
  readonly calendarFirst?: boolean;
  readonly tools?: ReactNode;
  readonly go: (pane: SettingsPaneId) => void;
}

/** The sections a host lists, in their three groups. A press goes through the place's leave hold. */
export function SettingsMenu({ menu, current, phone, leading, calendarFirst, tools, go }: SettingsMenuProps) {
  const t = useText("settings");
  const cal = useText("calsettings");
  const name = usePaneName();
  // The same flag the notifications row wears its dot from: a blocked Notifications stands open under its head.
  const attention = useNotificationSummary()?.hot ?? false;
  const list = useRef<HTMLDivElement>(null);
  // The host can list more sections once its account capabilities arrive.
  const currentIndex = menu.findIndex((pane) => pane.id === current);

  useLayoutEffect(() => {
    if (currentIndex < 0) return;
    const scroller = list.current;
    const row = scroller?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!scroller || !row) return;
    const reveal = () => {
      const { offsetTop, offsetHeight } = row;
      const { clientHeight, scrollTop } = scroller;
      if (offsetTop < scrollTop) {
        scroller.scrollTop = offsetTop;
      } else if (offsetTop + offsetHeight > scrollTop + clientHeight) {
        // Leave room for the entry beneath the selected section.
        scroller.scrollTop = offsetTop + 2 * offsetHeight - clientHeight;
      }
    };
    reveal();
    if (typeof ResizeObserver !== "function") return;
    const resize = new ResizeObserver(reveal);
    resize.observe(scroller);
    return () => resize.disconnect();
  }, [current, currentIndex]);

  const sections = (
    <div className="settings-menu-scroll" data-in-sheet={phone ? "" : undefined} ref={list}>
      {groupsOf(menu, calendarFirst).map(({ group, panes }) => (
        <section key={group}>
          <GroupHeading hot={attention && panes.some((pane) => pane.id === "notifications")}>
            {group === "calendar" ? cal("group") : t(GROUP_KEY[group])}
          </GroupHeading>
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
    </div>
  );

  return (
    <nav aria-label={t("navAria")} data-settings-menu={calendarFirst ? "calendar" : ""}>
      <ListHead
        title={t("title")}
        hot={calendarFirst || attention}
        lead={leading}
        aside={calendarFirst ? tools : undefined}
      />
      {phone ? (
        <Sheet kind={calendarFirst ? "plain" : "list"} flushBottom>
          {sections}
        </Sheet>
      ) : (
        sections
      )}
    </nav>
  );
}
