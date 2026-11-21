/**
 * WHAT NARROWS THE RESULTS: who sent it and where it is (what the answer counted), each a control that opens its short list with the counts
 * the answer gave; with files, a switch. Once one is set it carries its way off, and a press takes it off. Counted
 * over the whole match set where the store answered, else over what the device painted.
 */
import { useRef, useState, type ReactNode } from "react";
import type { SearchFacetGroup, SearchFacetItem, SearchListModel } from "@ohmail/app-logic/search";
import { Button, Menu, MenuItem } from "@ohmail/ui/base";
import { useText } from "../text/index.js";
import type { SearchBeside } from "./beside.js";

export function SearchFilters({
  model,
  beside,
  more,
}: {
  model: SearchListModel;
  beside: SearchBeside;
  /**
   * The question's own filters, after the answer's (Unread, the days) where the host's server takes them. From is then
   * the person's (`SearchPersonRow`), and the answer's sender facet is not offered beside it.
   */
  more: ReactNode;
}) {
  const t = useText("search");
  if (model.facets.length === 0 && more === null) return null;
  const nameOf = (it: SearchFacetItem): string =>
    it.pick.group === "folder" ? beside.words.placeOfFolder(it.pick.key) : it.label;
  const group = (g: SearchFacetGroup["group"]) => model.facets.find((x) => x.group === g);
  const from = group("from");
  const folder = group("folder");
  const files = group("refine")?.items[0];
  return (
    <div className="sr-filters" data-filter-row="" role="group" aria-label={t("facetRefine")}>
      {from && more === null ? (
        <FacetMenu word={t("facetFrom")} items={from.items} nameOf={nameOf} pick={model.pick} />
      ) : null}
      {folder ? (
        <FacetMenu
          word={t(model.searchBy === "people" ? "facetPlace" : "facetFolder")}
          title={model.searchBy === "people" ? t("facetPlace") : undefined}
          items={folder.items}
          nameOf={nameOf}
          pick={model.pick}
        />
      ) : null}
      {files ? (
        <Button kind="two" size="s" pressed={files.pressed} onPress={() => model.pick(files.pick)}>
          {t("facetAttachment")}
        </Button>
      ) : null}
      {more}
    </div>
  );
}

function itemKey({ pick }: SearchFacetItem): string {
  if (pick.group === "refine") return "refine";
  return pick.group === "folder" ? (pick.raw ?? pick.key) : pick.key;
}

function FacetMenu({
  word,
  title,
  items,
  nameOf,
  pick,
}: {
  word: string;
  title?: string;
  items: readonly SearchFacetItem[];
  nameOf: (it: SearchFacetItem) => string;
  pick: SearchListModel["pick"];
}) {
  const [openedWith, setOpenedWith] = useState<readonly string[] | null>(null);
  const open = openedWith !== null;
  const opener = useRef<HTMLButtonElement>(null);
  const set = items.find((it) => it.pressed);
  if (set) {
    return (
      <Button kind="two" size="s" mark="x" pressed onPress={() => pick(set.pick)}>
        {nameOf(set)}
      </Button>
    );
  }
  // Keep the positions from the opening press. Newly available paths follow those that were visible.
  const byKey = new Map(items.map((item) => [itemKey(item), item]));
  const ordered = (openedWith ?? []).flatMap((key) => {
    const item = byKey.get(key);
    byKey.delete(key);
    return item ? [item] : [];
  });
  ordered.push(...byKey.values());
  return (
    <>
      <Button
        ref={opener}
        kind="two"
        size="s"
        mark="down"
        opens="menu"
        expanded={open}
        disabled={items.length === 0}
        onPress={() => setOpenedWith(open ? null : title ? items.map(itemKey) : [])}
      >
        {word}
      </Button>
      <Menu open={open} onClose={() => setOpenedWith(null)} anchor={opener} label={word} title={title}>
        {ordered.map((it) => (
          <MenuItem
            key={itemKey(it)}
            note={it.count === null ? undefined : String(it.count)}
            onPress={() => {
              setOpenedWith(null);
              pick(it.pick);
            }}
          >
            {nameOf(it)}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
