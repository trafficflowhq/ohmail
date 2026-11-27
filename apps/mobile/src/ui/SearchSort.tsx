import { useState } from "react";
import { View } from "react-native";
import { SERVER_SEARCH_SORTS } from "@ohmail/client-engine";
import { Copy } from "../copy";
import type { SearchOrder } from "../state/search-facets";
import { useTheme } from "../theme";
import { mailColors, mailSize } from "../theme/mail";
import { Tap, Txt } from "./base";
import { Icon } from "./Icon";
import { Sheet, SheetRow } from "./Sheet";

export function SearchSort({ order, onOrder, emptyWords = false }: {
  order: SearchOrder;
  onOrder: (value: SearchOrder) => void;
  emptyWords?: boolean;
}) {
  const t = useTheme();
  const paper = t.mail ? mailColors(t) : null;
  const [open, setOpen] = useState(false);
  const options = emptyWords ? (["relevance", "date_desc"] as const) : SERVER_SEARCH_SORTS;
  return (
    <>
      <Tap accessibilityRole="button" accessibilityLabel={Copy.searchSortLabel} accessibilityHint={Copy.searchSortedBy(Copy[`searchSort_${order}`])}
        accessibilityState={{ expanded: open }} onPress={() => setOpen(true)}
        style={{ justifyContent: "center", minHeight: 32, paddingHorizontal: mailSize.inset }}>
        <View style={{
          flexDirection: "row", alignItems: "center", gap: 2, paddingHorizontal: mailSize.rowInset,
          borderRadius: t.radius.row / 2, backgroundColor: paper ? `${paper.ink}14` : t.c.panel,
        }}>
          <Txt variant={t.mail ? "decision" : "meta"} tone={t.mail ? "ink" : "ink2"}>
            {Copy[`searchSort_${order}`]}
          </Txt>
          <View style={{ transform: [{ rotate: "90deg" }] }}><Icon name="chev" size={9} color={paper?.ink2 ?? t.c.ink2} /></View>
        </View>
      </Tap>
      <Sheet open={open} onClose={() => setOpen(false)} label={Copy.searchSortLabel}
        phoneMenu={!!paper} title={Copy.searchSortLabel}>
        {options.map((option) => (
          <SheetRow key={option} label={Copy[`searchSort_${option}`]} on={option === order} onPress={() => {
            onOrder(option);
            setOpen(false);
          }} />
        ))}
      </Sheet>
    </>
  );
}
