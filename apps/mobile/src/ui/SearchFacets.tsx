import { useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { civilDay, dayBounds, DATE_WINDOWS, datesOf, dateWindowOf } from "@ohmail/app-logic/search/dates";
import { useSearchPlaceInventory } from "@ohmail/app-logic/search/place-inventory";
import { peopleFor } from "@ohmail/app-logic/search/people";
import { shortCivilDateStamp } from "@ohmail/client-engine";
import { Copy } from "../copy";
import { addressShaped } from "../state/live";
import type { SearchFilters, SearchOrder } from "../state/search-facets";
import { useLiveSession, useWorld } from "../state/world";
import { useTheme } from "../theme";
import { mailColors, mailSize } from "../theme/mail";
import { Rule, Tap, Txt } from "./base";
import { Icon } from "./Icon";
import { Sheet, SheetRow } from "./Sheet";
import { SearchSort } from "./SearchSort";

type Menu = "sender" | "to" | "folder" | "date";

const FILTER_GAP = mailSize.rowInset;

export function SearchFacets({ filters, order, onFilters, onOrder, locale }: {
  filters: SearchFilters;
  order: SearchOrder;
  locale: string;
  onFilters: (filters: SearchFilters) => void;
  onOrder: (order: SearchOrder) => void;
}) {
  const t = useTheme();
  const paper = t.mail ? mailColors(t) : null;
  const world = useWorld();
  const session = useLiveSession();
  const engine = session?.ownerKey === world.worldKey ? session?.engine ?? null : null;
  const inventory = useSearchPlaceInventory(engine, world.worldKey ?? null, !!paper, session?.bearer ?? null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [person, setPerson] = useState("");
  const [custom, setCustom] = useState(false);
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const close = () => setMenu(null);
  const open = (item: Menu) => {
    setPerson("");
    setCustom(false);
    setSince("");
    setUntil("");
    setMenu(item);
  };
  const set = <K extends keyof SearchFilters>(key: K, value: SearchFilters[K]) => {
    onFilters({ ...filters, [key]: value });
    close();
  };
  const dateRange = (from?: string, to?: string) => {
    onFilters({ ...filters, dateFrom: from, dateTo: to });
    close();
  };
  const places = new Map([
    ["INBOX", Copy.ohbox], ["ohmail/News", Copy.reads], ["ohmail/Receipts", Copy.receipts],
    ["ohmail/Screener", Copy.screener], ["ohmail/Screened", paper ? Copy.searchPlaceScreened : Copy.segScreened],
    ["ohmail/Quarantine", Copy.segSpam],
  ]);
  for (const f of world.folders.list) if (!places.has(f.name)) places.set(f.name, f.name);
  const placeLabels = new Map([
    ["ohbox", Copy.ohbox], ["reads", Copy.reads], ["receipts", Copy.receipts], ["screener", Copy.screener],
    ["screened", Copy.searchPlaceScreened], ["spam", Copy.segSpam], ["Sent", Copy.searchPlaceSent],
  ]);
  const placeOptions: { key: string; label: string; count?: number }[] = inventory.length > 0
    ? inventory.map(({ pick, label, count }) => ({ key: pick.raw, label: placeLabels.get(label) ?? label, count }))
    : [...places].map(([key, label]) => ({ key, label }));
  const labels: Record<Menu, string> = {
    sender: Copy.searchFacetFrom, to: Copy.searchTo, folder: Copy.searchFacetPlace,
    date: Copy.searchDateWord,
  };
  const personMenu = menu === "sender" || menu === "to" ? menu : null;
  const typed = person.trim().toLowerCase();
  const people = personMenu === null ? [] : peopleFor(typed, world.addressBook ?? []).slice(0, typed ? 12 : 6);
  const literal = addressShaped(typed);
  const dateWords = { week: Copy.searchDateWeek, month: Copy.searchDateMonth, year: Copy.searchDateYear };
  const start = dayBounds(since);
  const end = dayBounds(until);
  const valid = (since === "" || start !== null) && (until === "" || end !== null) && (start !== null || end !== null)
    && (!start || !end || start.first <= end.last);
  const inputStyle = [t.type.body, { color: t.c.ink, padding: 12, margin: paper ? 0 : 8,
    backgroundColor: t.c.tint2, borderRadius: t.radius.row },
    paper ? { minHeight: Number.parseFloat(paper["h-l"]), borderWidth: 1, borderColor: t.c.hair } : null];
  const fromDay = filters.dateFrom ? civilDay(new Date(filters.dateFrom)) : null;
  const toDay = filters.dateTo ? civilDay(new Date(filters.dateTo)) : null;
  const from = fromDay && shortCivilDateStamp(fromDay, locale);
  const to = toDay && shortCivilDateStamp(toDay, locale);
  const window = dateWindowOf(fromDay, toDay, new Date());
  const dateDetail = window ? dateWords[window]
    : from && to ? `${from} – ${to}` : from ? Copy.searchDateFrom(from) : to ? Copy.searchDateThrough(to) : undefined;
  const chip = (label: string, onPress: () => void, active: boolean, menuChip = true, detail?: string, clear?: () => void) => {
    const press = t.mail && active && clear ? clear : onPress;
    const spoken = t.mail && detail ? detail : label;
    const style = {
      flexDirection: "row", alignItems: "center", gap: FILTER_GAP, paddingHorizontal: t.mail ? 12 : 9,
      minHeight: t.mail ? 36 : 32, maxWidth: t.mail ? undefined : "46%",
      borderWidth: t.mail ? 0 : 1, borderColor: active ? t.c.accent : t.c.hair,
      backgroundColor: active ? paper?.pick ?? t.c.tint2 : paper?.soft ?? t.c.panel, borderRadius: t.radius.pill,
    } as const;
    const content = (
      <>
        <Txt variant={t.mail ? "button" : "meta"} tone={active ? "accent" : t.mail ? "ink" : "ink2"} numberOfLines={1}
          style={{ flexShrink: 1, maxWidth: detail ? 176 : undefined, ...(active && paper ? { color: paper["on-pick"] } : {}) }}>
          {detail ?? label}
        </Txt>
        {paper && active && clear ? <Icon name="x" size={12} color={paper["on-pick"]} />
          : menuChip ? <View style={t.mail ? { transform: [{ rotate: "90deg" }] } : undefined}><Icon name="chev" size={11} color={t.c.ink3} /></View> : null}
      </>
    );
    return menuChip ? (
      <Tap accessibilityRole="button" accessibilityLabel={spoken} onPress={press} style={style}
        accessibilityState={{ selected: active, expanded: !active && menu !== null && labels[menu] === label }}>
        {content}
      </Tap>
    ) : (
      <Tap accessibilityRole="checkbox" accessibilityLabel={spoken} onPress={press} style={style}
        accessibilityState={{ checked: active }}>
        {content}
      </Tap>
    );
  };
  const peopleChips = <>
    {chip(labels.sender, () => open("sender"), !!filters.sender, true, filters.sender, () => set("sender", undefined))}
    {chip(labels.to, () => open("to"), !!filters.to, true, filters.to, () => set("to", undefined))}
  </>;
  const refineChips = <>
    {chip(labels.folder, () => open("folder"), !!filters.folder, true,
      filters.folder ? placeOptions.find((option) => option.key === filters.folder)?.label ?? places.get(filters.folder) ?? filters.folder : undefined,
      () => set("folder", undefined))}
    {chip(Copy.searchFacetAttachment, () => set("hasAttachments", filters.hasAttachments ? undefined : true), !!filters.hasAttachments, false)}
    {chip(Copy.searchFacetUnread, () => set("unread", filters.unread ? undefined : true), !!filters.unread, false)}
    {chip(labels.date, () => open("date"), !!(filters.dateFrom || filters.dateTo), true, dateDetail, () => dateRange())}
  </>;
  const chipsRow = { flexDirection: "row", alignItems: "center", gap: FILTER_GAP } as const;
  return (
    <>
      {t.mail ? <>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled"
          style={{ marginTop: mailSize.inset, flexGrow: 0 }} contentContainerStyle={chipsRow}>
          {peopleChips}
        </ScrollView>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled"
          style={{ marginTop: mailSize.inset, flexGrow: 0 }} contentContainerStyle={chipsRow}>
          {refineChips}
        </ScrollView>
      </> : (
        <View style={[chipsRow, { flexWrap: "wrap", marginTop: 8 }]}>
          {peopleChips}
          {refineChips}
          <SearchSort order={order} onOrder={onOrder} />
        </View>
      )}
      <Sheet open={menu !== null} onClose={close} label={menu ? labels[menu] : Copy.search}
        phoneMenu={!!paper && (menu === "date" ? "card" : true)} title={menu ? labels[menu] : undefined} avoidKeyboard>
        {personMenu ? <>
          <TextInput maxFontSizeMultiplier={t.textCap} keyboardAppearance={t.scheme} disableFullscreenUI
            style={paper ? [...inputStyle, { borderColor: t.c.ink, borderWidth: 2 }] : inputStyle}
            accessibilityLabel={Copy.searchNameOrAddress} placeholder={Copy.searchNameOrAddress}
            autoFocus={!!paper}
            placeholderTextColor={t.c.ink3} autoCapitalize="none" value={person} onChangeText={setPerson} />
          {paper ? null : <SheetRow label={Copy.searchAll} on={filters[personMenu] === undefined} onPress={() => set(personMenu, undefined)} />}
          {literal && !people.some((entry) => entry.address === literal)
            ? <SheetRow label={literal} onPress={() => set(personMenu, literal)} /> : null}
          {people.map((entry) => <SheetRow key={entry.address} label={entry.name || entry.address}
            detail={entry.name ? entry.address : undefined} on={filters[personMenu] === entry.address} onPress={() => set(personMenu, entry.address)} />)}
          {paper && people.length === 0 && !literal
            ? <SheetRow label={Copy.searchNobody} disabled onPress={close} /> : null}
        </> : null}
        {menu === "folder" ? <>
          {paper ? null : <SheetRow label={Copy.searchAll} on={filters.folder === undefined} onPress={() => set("folder", undefined)} />}
          {placeOptions.map(({ key, label, count }) => <SheetRow key={key} label={label}
            detail={count === undefined ? undefined : String(count)}
            on={filters.folder === key || undefined} onPress={() => set("folder", key)} />)}
        </> : null}
        {menu === "date" ? <>
          {paper ? null : <SheetRow label={Copy.searchAll} onPress={() => dateRange()} />}
          {DATE_WINDOWS.map(([window]) => <SheetRow key={window} label={dateWords[window]} onPress={() => {
            const days = datesOf(window, new Date());
            dateRange(dayBounds(days.from)?.first, dayBounds(days.to)?.last);
          }} />)}
          {paper ? <Rule inset={12} /> : <SheetRow label={Copy.searchCustomDate} onPress={() => setCustom(true)} />}
          {custom || paper ? <>
            <TextInput maxFontSizeMultiplier={t.textCap} keyboardAppearance={t.scheme} disableFullscreenUI
              style={inputStyle} accessibilityLabel={Copy.searchSince} placeholder={Copy.searchSinceDate}
              placeholderTextColor={t.c.ink3} value={since} onChangeText={setSince} />
            <TextInput maxFontSizeMultiplier={t.textCap} keyboardAppearance={t.scheme} disableFullscreenUI
              style={inputStyle} accessibilityLabel={Copy.searchUntil} placeholder={Copy.searchUntilDate}
              placeholderTextColor={t.c.ink3} value={until} onChangeText={setUntil} />
            {valid || paper ? <SheetRow label={Copy.searchApply} disabled={!valid} onPress={() => dateRange(start?.first, end?.last)} /> : null}
          </> : null}
        </> : null}
      </Sheet>
    </>
  );
}
