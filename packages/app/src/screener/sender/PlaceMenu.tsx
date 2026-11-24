/**
 * WHERE THE SENDER'S MAIL GOES, as a menu: from the sentence's place word, or from a row's right click. The five
 * places in their one order with their keys, the suggested one checked with how sure; on the row's menu the card
 * after them. A press is the view's `decide`, the one way a decision leaves.
 */
import type { ScreenerSenderDTO } from "@ohmail/wire";
import type { RefObject } from "react";
import {
  DECISION_KEY,
  DECISION_ORDER,
  DECISION_QUIET,
  PILE_VERB_KEY,
  suggestionWords,
  type ScreenerView,
} from "@ohmail/app-logic/screener";
import { Menu, MenuItem } from "@ohmail/ui/base";
import type { Point } from "@ohmail/ui/base";
import { useText } from "../../text/index.js";
import { useNoAdvice, useScreener } from "../contract.js";
import { whoOf } from "./Sentence.js";

export function PlaceMenu({
  view,
  sender,
  open,
  anchor,
  card,
}: {
  view: ScreenerView;
  sender: ScreenerSenderDTO;
  open: boolean;
  anchor: RefObject<Element | null> | Point;
  /** The row's menu also opens the card. */
  card: boolean;
}) {
  const t = useText("screener");
  const screening = useText("screening");
  const words = suggestionWords(sender, useNoAdvice());
  const model = useScreener();
  const scope = view.scopeOf(sender);
  const offered = open && model.unsubClaimOf(sender, scope) !== "none";
  return (
    <Menu
      open={open}
      onClose={() => view.show(null)}
      anchor={anchor}
      label={t("rowMoreAria")}
      kind={card ? "context" : undefined}
      fit={card ? "beside" : undefined}
      title={card ? undefined : whoOf(sender)}
    >
      {DECISION_ORDER.map((dest) => {
        const note = [
          words.dest === dest && words.sure !== null ? t("place.suggested", { sure: words.sure }) : "",
          offered && DECISION_QUIET.has(dest) ? t("place.plusUnsub") : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <MenuItem
            key={dest}
            checked={card ? undefined : words.dest === dest}
            label={t(PILE_VERB_KEY[dest])}
            note={note || undefined}
            keyHint={DECISION_KEY[dest]}
            onPress={() => view.decide(dest, false)}
          >
            {t(PILE_VERB_KEY[dest])}
          </MenuItem>
        );
      })}
      {card ? (
        <MenuItem keyHint="s" onPress={() => view.show("card")}>
          {screening("action")}
        </MenuItem>
      ) : null}
    </Menu>
  );
}
