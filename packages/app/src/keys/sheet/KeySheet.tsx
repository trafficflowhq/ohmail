/**
 * THE KEY SHEET, over every place: every key live where the person was when they asked, read once from the registry
 * as it opens and held until it closes (the kit's overlay then holds the keys, and a live read would list its own).
 * Any key closes it and is taken, but Tab, a bare modifier, the scroll keys, and Enter or Space on its close
 * control. Its own key (`?`) is declared in the registry.
 */
import { useContext, useLayoutEffect, useState, type KeyboardEvent } from "react";
import { KeyHelp } from "@ohmail/ui/base";
import { KeymapContext, SCROLL_KEYS, useKeyBindings, type BoundKey } from "@ohmail/app-logic/keys";
import { useFrame, usePaletteOffers } from "../../frame/commands.js";
import type { OverProps } from "../../frame/contract.js";
import { useText } from "../../text/index.js";
import { sheetColumns } from "./rows.js";

import { SHEET_CHORD, useKeyboardHelpAvailable } from "../../frame/keyboard/availability.js";

const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "AltGraph",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Fn",
  "FnLock",
  "Hyper",
  "Super",
  "Symbol",
  "SymbolLock",
]);

/** A key that leaves the sheet standing: moving inside it, half a chord, scrolling it, or pressing its close. */
function keepsTheSheet(e: KeyboardEvent<HTMLDivElement>): boolean {
  if (e.key === "Tab" || MODIFIER_KEYS.has(e.key) || SCROLL_KEYS.has(e.key)) return true;
  return (e.key === "Enter" || e.key === " ") && e.target instanceof HTMLButtonElement;
}

export function KeySheet({ open, onClose }: OverProps) {
  const t = useText("shortcuts");
  const trash = useText("trash");
  const store = useContext(KeymapContext);
  if (!store) throw new Error("the key sheet stands only under a <KeymapProvider>");
  const { commands, over, plan } = useFrame();
  const available = useKeyboardHelpAvailable(plan.device === "phone");
  useLayoutEffect(() => {
    if (open && !available) onClose();
  }, [open, available, onClose]);
  /* One reading, taken in the render that opens it, before focus moves into the sheet. */
  const [held, setHeld] = useState<{ open: boolean; bindings: readonly BoundKey[] }>({
    open: false,
    bindings: [],
  });
  const shown = open && available;
  if (held.open !== shown) setHeld({ open: shown, bindings: shown ? store.snapshot() : [] });

  useKeyBindings(
    available
      ? [
          {
            chord: SHEET_CHORD,
            group: "app",
            label: t("sheet"),
            inWriting: true,
            run: () => commands.over(over === "keys" ? null : "keys"),
          },
        ]
      : [],
    "global",
  );

  usePaletteOffers(
    "mail",
    [
      {
        id: "mail.shortcuts",
        label: t("title"),
        icon: "key",
        chord: available ? SHEET_CHORD : undefined,
        disabled: !available,
        run: () => store.press(SHEET_CHORD),
      },
    ],
    false,
  );

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (keepsTheSheet(e)) return false;
    e.preventDefault();
    onClose();
    return true;
  };
  const bindings = held.open === shown ? held.bindings : shown ? store.snapshot() : [];
  return (
    <KeyHelp
      open={shown}
      onClose={onClose}
      title={t("title")}
      close={t("close")}
      initialFocus="close"
      columns={shown ? sheetColumns(bindings, store.mod, t, trash) : []}
      onKey={onKey}
    />
  );
}
