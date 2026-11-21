import { Row } from "@ohmail/ui/mail";
import { useOptionalTheme } from "@ohmail/ui/theme";
import { useLocale, useTextLookup } from "../text/index.js";
import type { PaneSummary, SettingsPane, SettingsPaneId } from "./contract.js";
import { useNotificationSummary } from "./notifications/summary.js";
import { useTagSummary } from "./tags/summary.js";

export interface PaneRowProps {
  readonly pane: SettingsPane;
  readonly name: string;
  readonly open: boolean;
  readonly onOpen: () => void;
}

const DETAIL: Partial<Record<SettingsPaneId, string>> = {
  notifications: "notifyMaster",
  screener: "screening.title",
  ai: "aiLabel",
  tags: "tagNew",
  folders: "folders.useTitle",
  signatures: "signatures.title",
  devices: "webDevicesTitle",
  billing: "webBillingTitle",
  storage: "storagePlanHead",
  security: "webSecurityTitle",
  account: "webAccountTitle",
};

const MENU_SUMMARY: Partial<Record<SettingsPaneId, NonNullable<SettingsPane["useSummary"]>>> = {
  notifications: useNotificationSummary,
  tags: useTagSummary,
};

function useMenuSummary(id: SettingsPaneId): PaneSummary | null {
  const textOf = useTextLookup();
  const locale = useLocale();
  const theme = useOptionalTheme();
  const t = textOf("settings");
  if (id === "general") {
    const face = theme?.face === "ohmarchy" ? "faceOhmarchy" : "facePaper";
    const mode =
      theme?.preference === "system"
        ? "themeAuto"
        : theme?.preference === "dark"
          ? "themeDark"
          : "themeLight";
    return {
      value: [face, mode]
        .filter((key) => t.has(key))
        .map((key) => t(key))
        .join(" · "),
      detail: t.has(`languageName.${locale}`) ? t(`languageName.${locale}`) : undefined,
    };
  }
  if (id === "help") {
    const help = textOf("help");
    return help.has("write") && help.has("diag")
      ? { detail: [help("write"), help("diag")].join(" · ") }
      : null;
  }
  const detail = DETAIL[id];
  return detail && t.has(detail) ? { detail: t(detail) } : null;
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
