import { useState } from "react";
import { TextInput, View } from "react-native";
import { Copy } from "../copy";
import { addressShaped } from "../state/live";
import type { SearchFilters, SearchOrder } from "../state/search-facets";
import { useWorld } from "../state/world";
import { useTheme } from "../theme";
import { mailSize } from "../theme/mail";
import { Tap, Txt } from "./base";
import { Icon } from "./Icon";
import { Sheet, SheetRow } from "./Sheet";

type Menu = "sender" | "to" | "folder" | "date" | "sort";

function dateStart(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

export function SearchFacets({ filters, order, onFilters, onOrder, results }: {
  filters: SearchFilters;
  order: SearchOrder;
  results?: number;
  onFilters: (filters: SearchFilters) => void;
  onOrder: (order: SearchOrder) => void;
}) {
  const t = useTheme();
  const world = useWorld();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [person, setPerson] = useState("");
  const [custom, setCustom] = useState(false);
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const close = () => setMenu(null);
  const open = (item: Menu) => {
    setPerson("");
    setCustom(false);
    setMenu(item);
  };
  const set = <K extends keyof SearchFilters>(key: K, value: SearchFilters[K]) => {
    onFilters({ ...filters, [key]: value });
    close();
  };
  const dateRange = (from?: Date, to?: Date) => {
    if (to) to.setHours(23, 59, 59, 999);
    onFilters({ ...filters, dateFrom: from?.toISOString(), dateTo: to?.toISOString() });
    close();
  };
  const places = new Map([
    ["INBOX", Copy.ohbox], ["ohmail/News", Copy.reads], ["ohmail/Receipts", Copy.receipts],
    ["ohmail/Screener", Copy.screener], ["ohmail/Screened", Copy.segScreened], ["ohmail/Quarantine", Copy.segSpam],
  ]);
  for (const f of world.folders.list) if (!places.has(f.name)) places.set(f.name, f.name);
  const orders: Record<SearchOrder, string> = {
    relevance: Copy.searchSort_relevance, date_desc: Copy.searchSort_date_desc, date_asc: Copy.searchSort_date_asc,
    mailbox: Copy.searchSort_mailbox, sender: Copy.searchSort_sender,
  };
  const labels: Record<Menu, string> = {
    sender: Copy.searchFacetFrom, to: Copy.searchTo, folder: Copy.searchFacetPlace,
    date: Copy.searchDateWord, sort: Copy.searchSortLabel,
  };
  const personMenu = menu === "sender" || menu === "to" ? menu : null;
  const typed = person.trim().toLowerCase();
  const people = personMenu === null ? [] : (world.addressBook ?? []).filter((entry) =>
    entry.address.includes(typed) || entry.name.toLowerCase().includes(typed)).slice(0, 12);
  const literal = addressShaped(typed);
  const dates = [
    [Copy.searchDateWeek, (d: Date) => d.setDate(d.getDate() - (d.getDay() + 6) % 7)],
    [Copy.searchDateMonth, (d: Date) => d.setDate(1)],
    [Copy.searchDateYear, (d: Date) => d.setMonth(0, 1)],
  ] as const;
  const start = dateStart(since);
  const end = dateStart(until);
  const valid = (since === "" || start !== null) && (until === "" || end !== null) && (start !== null || end !== null)
    && (!start || !end || start <= end);
  const inputStyle = [t.type.body, { color: t.c.ink, padding: 12, margin: 8, backgroundColor: t.c.tint2, borderRadius: t.radius.row }];
  const chip = (label: string, onPress: () => void, active: boolean, menuChip = true, detail?: string) => (
    <Tap
      accessibilityRole={menuChip ? "button" : "checkbox"}
      accessibilityLabel={label}
      accessibilityState={{ selected: menuChip && active, checked: !menuChip && active }}
      onPress={onPress}
      style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: t.mail ? 11 : 9,
        minHeight: t.mail ? (label === labels.sort && results !== undefined ? 26 : 36) : 32,
        maxWidth: "46%", borderWidth: t.mail ? 0 : 1, borderColor: active ? t.c.accent : t.c.hair,
        backgroundColor: t.mail ? (active ? t.c.accentSoft : t.c.panel) : active ? t.c.tint2 : t.c.panel, borderRadius: t.radius.pill }}
    >
      <Txt variant={t.mail ? "button" : "meta"} tone={active ? "accent" : t.mail ? "ink" : "ink2"} numberOfLines={1} style={{ flexShrink: 1 }}>{detail ?? label}</Txt>
      {menuChip ? <View style={t.mail ? { transform: [{ rotate: "90deg" }] } : undefined}><Icon name="chev" size={11} color={t.c.ink3} /></View> : null}
    </Tap>
  );
  const peopleChips = <>
    {chip(labels.sender, () => open("sender"), !!filters.sender, true, filters.sender)}
    {chip(labels.to, () => open("to"), !!filters.to, true, filters.to)}
  </>;
  const chipsRow = { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 5, marginTop: 8 } as const;
  return (
    <>
      {t.mail ? <View style={chipsRow}>{peopleChips}</View> : null}
      <View style={chipsRow}>
        {t.mail ? null : peopleChips}
        {chip(labels.folder, () => open("folder"), !!filters.folder, true, filters.folder ? places.get(filters.folder) : undefined)}
        {chip(Copy.searchFacetAttachment, () => set("hasAttachments", filters.hasAttachments ? undefined : true), !!filters.hasAttachments, false)}
        {chip(Copy.searchFacetUnread, () => set("unread", filters.unread ? undefined : true), !!filters.unread, false)}
        {chip(labels.date, () => open("date"), !!(filters.dateFrom || filters.dateTo))}
        {results === undefined ? chip(labels.sort, () => open("sort"), order !== "relevance", true, orders[order]) : null}
      </View>
      {results === undefined ? null : (
        <View style={{
          flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 14, gap: mailSize.inset,
          backgroundColor: t.c.panel, borderRadius: t.radius.card,
          paddingHorizontal: mailSize.edge, paddingVertical: mailSize.inset,
        }}>
          <Txt variant="sectionLabel" accessibilityRole="header" accessibilityLabel={Copy.searchResultsHead(results)}>
            {Copy.searchResultsLine(results)}
          </Txt>
          {chip(labels.sort, () => open("sort"), order !== "relevance", true, orders[order])}
        </View>
      )}
      <Sheet open={menu !== null} onClose={close} label={menu ? labels[menu] : Copy.search} avoidKeyboard>
        {personMenu ? <>
          <TextInput maxFontSizeMultiplier={t.textCap} keyboardAppearance={t.scheme} disableFullscreenUI
            style={inputStyle} accessibilityLabel={Copy.searchNameOrAddress} placeholder={Copy.searchNameOrAddress}
            placeholderTextColor={t.c.ink3} autoCapitalize="none" value={person} onChangeText={setPerson} />
          <SheetRow label={Copy.searchAll} on={filters[personMenu] === undefined} onPress={() => set(personMenu, undefined)} />
          {literal && !people.some((entry) => entry.address === literal)
            ? <SheetRow label={literal} onPress={() => set(personMenu, literal)} /> : null}
          {people.map((entry) => <SheetRow key={entry.address} label={entry.name || entry.address}
            detail={entry.name ? entry.address : undefined} on={filters[personMenu] === entry.address} onPress={() => set(personMenu, entry.address)} />)}
        </> : null}
        {menu === "folder" ? <>
          <SheetRow label={Copy.searchAll} on={filters.folder === undefined} onPress={() => set("folder", undefined)} />
          {[...places].map(([key, label]) => <SheetRow key={key} label={label} on={filters.folder === key} onPress={() => set("folder", key)} />)}
        </> : null}
        {menu === "date" ? <>
          <SheetRow label={Copy.searchAll} onPress={() => dateRange()} />
          {dates.map(([label, change]) => <SheetRow key={label} label={label} onPress={() => {
            const now = new Date();
            const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            change(from);
            dateRange(from, now);
          }} />)}
          <SheetRow label={Copy.searchCustomDate} onPress={() => setCustom(true)} />
          {custom ? <>
            <TextInput maxFontSizeMultiplier={t.textCap} keyboardAppearance={t.scheme} disableFullscreenUI
              style={inputStyle} accessibilityLabel={Copy.searchSince} placeholder={Copy.searchSinceDate}
              placeholderTextColor={t.c.ink3} value={since} onChangeText={setSince} />
            <TextInput maxFontSizeMultiplier={t.textCap} keyboardAppearance={t.scheme} disableFullscreenUI
              style={inputStyle} accessibilityLabel={Copy.searchUntil} placeholder={Copy.searchUntilDate}
              placeholderTextColor={t.c.ink3} value={until} onChangeText={setUntil} />
            {valid ? <SheetRow label={Copy.searchApply} onPress={() => dateRange(start ?? undefined, end ?? undefined)} /> : null}
          </> : null}
        </> : null}
        {menu === "sort" ? (Object.entries(orders) as [SearchOrder, string][]).map(([key, label]) =>
          <SheetRow key={key} label={label} on={order === key} onPress={() => { onOrder(key); close(); }} />) : null}
      </Sheet>
    </>
  );
}
