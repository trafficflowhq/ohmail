/**
 * THE VERBS ON THE SELECTION'S BAR, in the bar's order: Later, Read, Unread, Park, Resurface, Tag, Move, Screening.
 * Each runs on the picked rows through the model; Move and Screening open their question (`pickPanel`), and Tag
 * anchors its picker on the bar's foot, read when it is pressed.
 */
import type { RefObject } from "react";
import type { OhboxListModel } from "@ohmail/app-logic/ohbox";
import type { PanelVerb } from "@ohmail/ui/mail";
import type { useText } from "../text/index.js";

export function pickVerbs(
  model: OhboxListModel,
  t: ReturnType<typeof useText>,
  foot: RefObject<HTMLDivElement | null>,
): PanelVerb[] {
  return [
    {
      id: "later",
      label: t("actionLater"),
      icon: "later",
      keyHint: "a",
      onPress: () => model.runBulk("later"),
    },
    { id: "read", label: t("actionRead"), icon: "read", keyHint: "⇧U", onPress: model.markPicked },
    {
      id: "unread",
      label: t("pickedMarkUnseen"),
      icon: "unread",
      keyHint: "u",
      onPress: () => model.runBulk("unread"),
    },
    {
      id: "aside",
      label: t("actionSetAside"),
      icon: "parked",
      keyHint: "e",
      onPress: () => model.runBulk("aside"),
    },
    {
      id: "resurface",
      label: t("actionResurface"),
      icon: "resurface",
      keyHint: "b",
      onPress: () => model.runBulk("resurface"),
    },
    {
      id: "tag",
      label: t("actionTag"),
      icon: "tags",
      keyHint: "t",
      onPress: () => model.tagPicked(foot.current),
    },
    {
      id: "move",
      label: t("actionMove"),
      icon: "move",
      keyHint: "m",
      onPress: () => model.setPickPanel({ kind: "move" }),
    },
    {
      id: "screen",
      label: t("bar.screen"),
      icon: "screener",
      keyHint: "s",
      onPress: () => model.setPickPanel({ kind: "screen" }),
    },
  ];
}
