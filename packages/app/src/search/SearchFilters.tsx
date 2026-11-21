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

function FacetMenu({
  word,
  items,
  nameOf,
  pick,
}: {
  word: string;
  items: readonly SearchFacetItem[];
  nameOf: (it: SearchFacetItem) => string;
  pick: SearchListModel["pick"];
}) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const set = items.find((it) => it.pressed);
  if (set) {
    return (
      <Button kind="two" size="s" mark="x" pressed onPress={() => pick(set.pick)}>
        {nameOf(set)}
      </Button>
    );
  }
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
        onPress={() => setOpen((was) => !was)}
      >
        {word}
      </Button>
      <Menu open={open} onClose={() => setOpen(false)} anchor={opener} label={word}>
        {items.map((it) => (
          <MenuItem
            key={it.pick.group === "refine" ? "refine" : it.pick.key}
            note={it.count === null ? undefined : String(it.count)}
            onPress={() => {
              setOpen(false);
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
