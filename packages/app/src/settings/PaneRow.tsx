import { Row } from "@ohmail/ui/mail";
import { useOptionalTheme } from "@ohmail/ui/theme";
import { useLocale, useTextLookup } from "../text/index.js";
import type { PaneSummary, SettingsPane, SettingsPaneId } from "./contract.js";
import { useNotificationSummary } from "./notifications/summary.js";
import { useTagSummary } from "./tags/summary.js";
import { useScreenerSummary } from "./screener/summary.js";

export interface PaneRowProps {
  readonly pane: SettingsPane;
  readonly name: string;
  readonly open: boolean;
  readonly onOpen: () => void;
}

const MENU_SUMMARY: Partial<Record<SettingsPaneId, NonNullable<SettingsPane["useSummary"]>>> = {
  notifications: useNotificationSummary,
  tags: useTagSummary,
  screener: useScreenerSummary,
};

function useMenuSummary(id: SettingsPaneId): PaneSummary | null {
  const textOf = useTextLookup();
  const locale = useLocale();
  const theme = useOptionalTheme();
  const t = textOf("settings");
  if (id === "general") {
    const face = theme
      ? theme.face === "ohmarchy"
        ? t("faceOhmarchy")
        : textOf("settingsMenu")("faceOh")
      : undefined;
    const mode =
      theme &&
      t(
        theme.preference === "system"
          ? "themeAuto"
          : theme.preference === "dark"
            ? "themeDark"
            : "themeLight",
      );
    return {
      value: [face, mode].filter(Boolean).join(" · "),
      detail: t.has(`languageName.${locale}`) ? t(`languageName.${locale}`) : undefined,
    };
  }
  return null;
}

function Entry({
  pane,
  name,
  open,
  onOpen,
  summary,
}: PaneRowProps & { readonly summary: PaneSummary | null }) {
  const fallback = useMenuSummary(pane.id);
  const details = summary ?? fallback;
  return (
    <Row
      entry
      who={name}
      people={[]}
      sign={pane.icon}
      subject={details?.value ?? ""}
      preview={details?.detail}
      amount={pane.group === "calendar" ? undefined : details?.count}
      when={pane.group === "calendar" ? details?.count : undefined}
      unread={summary?.hot}
      open={open}
      onOpen={onOpen}
      mark={{ id: pane.id }}
    />
  );
}

/** A section that says something beside its name reads it from memory; one with no summary calls no hook. */
function SummedEntry(props: PaneRowProps & { readonly useSummary: NonNullable<SettingsPane["useSummary"]> }) {
  const { useSummary, ...row } = props;
  return <Entry {...row} summary={useSummary()} />;
}

/** One section in the menu: named by its name alone, the current page while it stands. */
export function PaneRow(props: PaneRowProps) {
  const useSummary = props.pane.useSummary ?? MENU_SUMMARY[props.pane.id];
  return useSummary ? (
    <SummedEntry {...props} useSummary={useSummary} />
  ) : (
    <Entry {...props} summary={null} />
  );
}
