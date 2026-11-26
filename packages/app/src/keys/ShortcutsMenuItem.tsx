import { useContext, type KeyboardEvent } from "react";
import { chordMatches, useBinding } from "@ohmail/app-logic/keys";
import { MenuItem } from "@ohmail/ui/base";
import { FrameContext } from "../frame/commands.js";
import { SHEET_CHORD } from "./availability.js";
import { useText } from "../text/index.js";

/** Menus consume letter keys. The menu item and its key take the same local path to the sheet. */
export function useShortcutsMenu(close: () => void) {
  const frame = useContext(FrameContext);
  const binding = useBinding(SHEET_CHORD);
  const t = useText("shortcuts");
  if (!frame || !binding || frame.api.plan.device === "phone") return {};
  const open = () => {
    close();
    frame.api.commands.over("keys");
  };
  return {
    onKey: (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.nativeEvent.isComposing || !chordMatches(binding.chord, event.nativeEvent)) return false;
      event.preventDefault();
      open();
      return true;
    },
    item: (
      <MenuItem icon="key" shortcut={binding.chord} className="fr-shortcut-menuitem" onPress={open}>
        {t("title")}
      </MenuItem>
    ),
  };
}
