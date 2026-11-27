import { useFocusEffect } from "expo-router";
import { useCallback, useState, type ReactNode } from "react";
import { View } from "react-native";
import type { AiCredits } from "@ohmail/app/settings/ai/budget";
import { statusKey } from "@ohmail/app-logic/mailboxes/pane/rows";
import { dayStamp } from "@ohmail/app-logic/text/format";
import { Copy } from "../copy";
import type { AppLocale } from "../i18n/locale";
import { readAway } from "../net/away";
import type { ConnectedSession } from "../net/pairing";
import type { World } from "../state/world";
import { readerZone } from "../state/live";
import { useTheme } from "../theme";
import { mailSize } from "../theme/mail";
import { awaySavedUntil, type AwayRow } from "./away-form";
import { TapRow, Txt } from "./base";
import { HeadingEnd } from "./HeadingEnd";
import { Icon, type IconName } from "./Icon";

interface SettingsSummary {
  value?: string;
  detail?: string;
  count?: string;
  hot?: boolean;
}

export function SettingsGroup({ label, hot, children }: { label: string; hot?: boolean; children: ReactNode }) {
  return (
    <View testID="settings-group" accessibilityLabel={label}>
      <View style={{ minHeight: mailSize.group, paddingHorizontal: mailSize.edge, paddingTop: mailSize.edge }}>
        <Txt variant="sectionLabel" accessibilityRole="header" accessibilityLabel={label}>
          <HeadingEnd variant="sectionLabel" hot={hot}>{label}</HeadingEnd>
        </Txt>
      </View>
      {children}
    </View>
  );
}

export function SettingsEntry({ label, icon, summary, onPress }: {
  label: string;
  icon: IconName;
  summary?: SettingsSummary | null;
  onPress: () => void;
}) {
  const t = useTheme();
  const { value, detail, count, hot } = summary ?? {};
  return (
    <TapRow accessibilityRole="button" accessibilityLabel={label}
      accessibilityHint={[value, detail, count].filter(Boolean).join(" · ") || undefined}
      onPress={onPress}
      style={{
        flexDirection: "row", alignItems: "center", gap: mailSize.inset,
        marginHorizontal: mailSize.inset, paddingHorizontal: mailSize.inset,
        minHeight: mailSize.row, paddingVertical: mailSize.inset,
      }}>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{
        width: mailSize.avatar, height: mailSize.avatar, alignItems: "center", justifyContent: "center",
        borderRadius: t.radius.pill, backgroundColor: t.c.tint2,
      }}>
        <Icon name={icon} size={18} color={hot ? t.c.ink : t.c.ink2} />
        {hot ? (
          <View style={{
            position: "absolute", top: -mailSize.rowInset, left: -mailSize.rowInset,
            width: mailSize.dot, height: mailSize.dot, borderRadius: t.radius.pill,
            borderWidth: 2, borderColor: t.c.panel, backgroundColor: t.c.accent,
          }} />
        ) : null}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: mailSize.inset }}>
          <Txt variant={hot ? "rowSender" : "bodyMedium"} numberOfLines={1} style={{ flex: 1 }}>{label}</Txt>
          {count === undefined ? null : (
            <Txt variant="meta" tone="ink2" numberOfLines={1} tabular style={{ maxWidth: "50%" }}>{count}</Txt>
          )}
        </View>
        {value ? <Txt variant="body" numberOfLines={1}>{value}</Txt> : null}
        {detail ? <Txt variant="body" tone="ink2" numberOfLines={1}>{detail}</Txt> : null}
      </View>
    </TapRow>
  );
}

type FormatCount = (count: number) => string;

export function mailboxSummary(mailboxes: World["mailboxes"], limit: number | undefined, format: FormatCount): SettingsSummary | null {
  if (!mailboxes.known) return null;
  const rows = mailboxes.rows;
  const full = rows.some((row) => row.syncBlockedReason === "mailbox_full");
  const statuses = rows.map((row) =>
    row.status && !row.syncBlockedReason && (row.lastSyncAt !== undefined || "hostedLastSyncAt" in row)
      ? statusKey({ ...row, status: row.status }) : null,
  );
  return {
    count: limit === undefined ? format(rows.length) : Copy.settingsMenuMailboxCount(format(rows.length), format(limit)),
    value: full ? Copy.settingsMenuFull
      : statuses.includes("status_connecting") ? Copy.settingsMenuConnecting
      : statuses.length > 0 && statuses.every((status) => status === "status_connected") ? Copy.settingsMenuConnected
      : undefined,
    detail: rows.map((row) => row.displayName || row.address).join(" · ") || undefined,
    hot: full,
  };
}

export function screenerSummary(screener: World["screener"], settled: boolean, format: FormatCount): SettingsSummary | null {
  if (!settled || screener.waitingPending) return null;
  const count = screener.waiting.length;
  return {
    value: count > 0 ? Copy.settingsMenuScreenerWaiting(format(count)) : Copy.settingsMenuScreenerDecided,
    count: count > 0 ? format(count) : undefined,
    detail: [
      Copy.settingsMenuScreenerScreened(format(screener.screened.length)),
      Copy.settingsMenuScreenerSpam(format(screener.spam.length)),
    ].join(" · "),
  };
}

export function aiSummary(credits: AiCredits | undefined, format: FormatCount): SettingsSummary | null {
  if (!credits) return null;
  const { remaining, total, trial } = credits;
  const month = total === undefined ? remaining : Math.min(remaining, total);
  return {
    detail: total === undefined ? Copy.settingsMenuCredits(format(month))
      : trial ? Copy.settingsMenuCreditsTrial(format(month), format(total))
      : Copy.settingsMenuCreditsMonth(format(month), format(total)),
    hot: remaining === 0,
  };
}

export function signatureSummary(
  mailboxes: World["mailboxes"], signatures: World["signatures"], format: FormatCount,
): SettingsSummary | null {
  if (!mailboxes.known || signatures == null) return null;
  const saved = mailboxes.rows.map((row) => signatures[row.id] ?? "").filter((text) => text.trim());
  if (!saved.length) return { value: Copy.settingsMenuNone };
  const [value, detail] = saved[0]!.split(/\r?\n/, 2);
  return { value, detail, count: format(saved.length) };
}

function awaySummary(row: AwayRow, locale: AppLocale): SettingsSummary | null {
  const now = new Date();
  const until = awaySavedUntil(row, now);
  if (row.enabled && until !== "expired" && row.startsAt && Date.parse(row.startsAt) > +now) return null;
  const end = until && row.endsAt ? dayStamp(row.endsAt, locale, readerZone()) : null;
  if (until === "expired" && end) return { value: Copy.awaySwitchOff, detail: Copy.awayUntilPast(end) };
  const audience = row.audience === "everyone" ? Copy.settingsMenuAwayEveryone
    : row.audience === "screened_in" ? Copy.settingsMenuAwayScreened : undefined;
  const rates: Partial<Record<string, string>> = {
    always: Copy.awayAlways,
    per_message: Copy.awayPerMessage,
    per_day: Copy.awayPerDay,
    per_week: Copy.awayPerWeek,
  };
  const rate = end ? Copy.awayUntilOn(end) : Object.hasOwn(rates, row.throttle) ? rates[row.throttle] : undefined;
  return { value: row.enabled ? Copy.awaySwitchOn : Copy.awaySwitchOff, detail: [audience, rate].filter(Boolean).join(" · ") };
}

export function AwaySettingsEntry({ session, locale, onPress }: {
  session: ConnectedSession;
  locale: AppLocale;
  onPress: () => void;
}) {
  const [seen, setSeen] = useState<{ session: ConnectedSession; row: AwayRow | null } | null>(null);
  useFocusEffect(useCallback(() => {
    let here = true;
    void readAway(session).then((row) => {
      if (here) setSeen({ session, row });
    });
    return () => { here = false; };
  }, [session]));
  const row = seen?.session === session ? seen.row : null;
  return <SettingsEntry label={Copy.awayRow} icon="reply" summary={row ? awaySummary(row, locale) : null} onPress={onPress} />;
}
