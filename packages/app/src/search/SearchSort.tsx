/**
 * The current order beside Results. The menu offers the applicable orders and checks the selected one.
 */
import { useRef, useState } from "react";
import { SEARCH_SORTS, type SearchListModel } from "@ohmail/app-logic/search";
import { Button, Menu, MenuItem } from "@ohmail/ui/base";
import { useText } from "../text/index.js";

const NO_WORDS_SORTS = ["relevance", "date_desc"] as const;

export function SearchSort({ model }: { model: SearchListModel }) {
  const t = useText("search");
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  if (model.text === "" && !model.narrowed) return null;
  /* With no words the store answers in two orders only. */
  const sorts = model.text === "" ? NO_WORDS_SORTS : SEARCH_SORTS;
  return (
    <>
      <Button
        ref={opener}
        kind="two"
        size="s"
        mark="down"
        opens="menu"
        expanded={open}
        label={t("sortedBy", { order: t(`sort_${model.sort}`) })}
        onPress={() => setOpen((was) => !was)}
      >
        {t(`sort_${model.sort}`)}
      </Button>
      <Menu open={open} onClose={() => setOpen(false)} anchor={opener} right label={t("sortLabel")}>
        {sorts.map((sort) => (
          <MenuItem
            key={sort}
            checked={sort === model.sort}
            onPress={() => {
              setOpen(false);
              model.setSort(sort);
            }}
          >
            {t(`sort_${sort}`)}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
