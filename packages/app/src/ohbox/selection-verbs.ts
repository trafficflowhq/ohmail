/**
 * THE VERBS ON THE SELECTION'S BAR, in the bar's order: Later, Read, Unread, Park, Resurface, Tag, Move, Screening.
 * Each runs on the picked rows through the model; Move and Screening open their question (`pickPanel`), and Tag
 * anchors its picker on the bar's foot, read when it is pressed.
 */
import type { RefObject } from "react";
import { ariaShortcut, chordKeys } from "@ohmail/app-logic/keys";
import type { OhboxListModel } from "@ohmail/app-logic/ohbox";
import type { PanelVerb } from "@ohmail/ui/mail";
import type { useText } from "../text/index.js";

export function pickVerbs(
  model: OhboxListModel,
  t: ReturnType<typeof useText>,
  foot: RefObject<HTMLDivElement | null>,
  mod: string,
  filingHold: Pick<PanelVerb, "disabled" | "disabledHint">,
): PanelVerb[] {
  return [
    {
      id: "later",
      label: t("actionLater"),
      icon: "later",
      ...selectionHint(model, t("keySelLater"), mod),
      ...filingHold,
      onPress: () => model.runBulk("later"),
    },
    {
      id: "read",
      label: t("actionRead"),
      icon: "read",
      ...selectionHint(model, t("keyMarkPicked"), mod),
      onPress: model.markPicked,
    },
    {
      id: "unread",
      label: t("pickedMarkUnseen"),
      icon: "unread",
      ...selectionHint(model, t("keySelUnread"), mod),
      onPress: () => model.runBulk("unread"),
    },
    {
      id: "aside",
      label: t("actionSetAside"),
      icon: "parked",
      ...selectionHint(model, t("keySelPark"), mod),
      ...filingHold,
      onPress: () => model.runBulk("aside"),
    },
    {
      id: "resurface",
      label: t("actionResurface"),
      icon: "resurface",
      ...selectionHint(model, t("keySelResurface"), mod),
      onPress: () => model.runBulk("resurface"),
    },
    {
      id: "tag",
      label: t("actionTag"),
      icon: "tags",
      ...selectionHint(model, t("keySelTag"), mod),
      onPress: () => model.tagPicked(foot.current),
    },
    {
      id: "move",
      label: t("actionMove"),
      icon: "move",
      ...selectionHint(model, t("keySelMove"), mod),
      onPress: () => model.setPickPanel({ kind: "move" }),
    },
    {
      id: "screen",
      label: t("bar.screen"),
      icon: "screener",
      ...selectionHint(model, t("keySelScreen"), mod),
      onPress: () => model.setPickPanel({ kind: "screen" }),
    },
  ];
}

/** Each button describes the key for the same operation on the selection. */
export function selectionHint(
  model: OhboxListModel,
  label: string,
  mod: string,
): Pick<PanelVerb, "keyHint" | "shortcut"> {
  const key = model.keys.find((binding) => binding.label === label && !binding.disabled);
  if (!key) return {};
  const cap = chordKeys(key.chord, mod).join("");
  return {
    keyHint: key.chord.startsWith("shift+") ? cap.toUpperCase() : cap,
    shortcut: ariaShortcut(key.chord, mod),
  };
}
