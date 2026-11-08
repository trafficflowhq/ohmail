/**
 * The Storage screen's body, drawn from `storagePaneOf`: the figure, the bar, the mailboxes, the
 * estimate, the kept month, what counts and why it is limited, the plans with their rooms. On the
 * store face the manage row is the plain line; a sideload build draws `manage`, the press, instead.
 */
import type { ReactNode } from "react";
import { View } from "react-native";
import { Copy } from "../copy";
import { useLocale } from "../i18n/LocaleProvider";
import type { StorageFacts } from "../net/account";
import type { Distribution } from "../distribution";
import { useTheme } from "../theme";
import { Panel, Section, Txt } from "./base";
import { StorageBar } from "./StorageBar";
import { storagePaneOf } from "./storage-notice";

export function StoragePane({ facts, labelOf, manage, distribution }: {
  facts: StorageFacts;
  /** A mailbox's name by id, from the phone's mailbox read. */
  labelOf: (id: string) => string;
  /** The sideload face's press; never drawn on a store build. */
  manage: ReactNode;
  distribution?: Distribution;
}) {
  const t = useTheme();
  const locale = useLocale();
  const pane = storagePaneOf(facts, Copy, locale, distribution);
  const gap = { paddingHorizontal: 20 };
  return (
    <>
      <Panel style={{ paddingVertical: 18, marginBottom: 14, gap: 14 }}>
        <View style={[gap, { gap: 2 }]}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
            <Txt variant="h2" tabular>{pane.figure}</Txt>
            {pane.tag !== null ? <Txt variant="note" tone="accent">{pane.tag}</Txt> : null}
          </View>
          <Txt variant="note" tone="ink2">{pane.sub}</Txt>
        </View>
        <View style={gap}>
          <StorageBar
            parts={pane.bar.parts.length > 0 ? pane.bar.parts.map((p) => p.bytes) : [facts.usedBytes]}
            scale={pane.bar.scaleBytes}
            limit={pane.bar.limitBytes}
            height={8}
          />
        </View>
        {pane.mailboxes.length > 0 ? (
          <View style={[gap, { gap: 0 }]}>
            {pane.mailboxes.map((m) => (
              <View key={m.id} style={{ flexDirection: "row", gap: 8, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: t.c.hairSoft }}>
                <Txt variant="note" numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>{labelOf(m.id)}</Txt>
                <Txt variant="note" tone="ink2" tabular>{m.said}</Txt>
              </View>
            ))}
          </View>
        ) : null}
        {pane.estimate.length > 0 ? (
          <View style={[gap, { gap: 4 }]}>
            {pane.estimate.map((line) => <Txt key={line} variant="note" tone="ink2">{line}</Txt>)}
          </View>
        ) : null}
        {pane.kept !== null ? <Txt variant="note" style={gap}>{pane.kept}</Txt> : null}
      </Panel>

      <Panel style={{ paddingVertical: 18, marginBottom: 14, gap: 6 }}>
        {pane.plan !== null ? (
          <>
            <Section>{Copy.storageYourPlan}</Section>
            <Txt variant="note" tone="ink2" style={gap}>{pane.plan}</Txt>
          </>
        ) : null}
        {pane.plans.length > 0 ? (
          <>
            <Section style={{ paddingTop: 10 }}>{Copy.storagePlans}</Section>
            <View style={gap}>
              {pane.plans.map((row) => (
                <View key={row.name} style={{ flexDirection: "row", gap: 8, paddingVertical: 4 }}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Txt variant="note" tone={row.fitted !== null ? "accent" : "ink"}>{row.name}</Txt>
                    {row.fitted !== null ? (
                      <Txt variant="caption" tone="accent">{row.fitted === "all" ? Copy.storageFitted : Copy.storageFittedMost}</Txt>
                    ) : null}
                  </View>
                  <Txt variant="note" tone={row.fitted !== null ? "accent" : "ink2"} tabular>{row.room}</Txt>
                </View>
              ))}
            </View>
          </>
        ) : null}
        <View style={[gap, { paddingTop: 10 }]}>
          {pane.manage === "press" ? manage : <Txt variant="note">{Copy.storageManageAt}</Txt>}
        </View>
      </Panel>

      <Panel style={{ paddingVertical: 18, marginBottom: 14, gap: 6 }}>
        <Section>{Copy.storageWhatCounts}</Section>
        <Txt variant="note" tone="ink2" style={gap}>{Copy.storageWhatCountsText}</Txt>
        <Section style={{ paddingTop: 10 }}>{Copy.storageWhyLimited}</Section>
        <Txt variant="note" tone="ink2" style={gap}>{Copy.storageWhyLimitedText}</Txt>
      </Panel>
    </>
  );
}
