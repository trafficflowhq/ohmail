/**
 * THE COMMAND PALETTE, over every place: every product's offers on one line you type on, narrowed word by word. A
 * disabled row neither runs nor closes it; a run closes it first, then runs the offer as it stands at the press.
 * Its own key (`mod+k`) is declared in the registry; while it stands, the kit's overlay holds the keys, so that key
 * closes it from inside.
 */
import { useState, type KeyboardEvent } from "react";
import { Palette as KitPalette } from "@ohmail/ui/base";
import { chordKeys, chordMatches, useKeyBindings, useKeymap } from "@ohmail/app-logic/keys";
import { useFrame, usePaletteFeeds } from "../frame/commands.js";
import type { OverProps } from "../frame/contract.js";
import { useText } from "../text/index.js";
import { keysOf } from "./keys-of.js";
import { narrow } from "./narrow.js";
import { liveOffer, rowsOf } from "./order.js";

const OWN_CHORD = "mod+k";

export function Palette({ open, onClose }: OverProps) {
  const t = useText("palette");
  const keysWords = useText("shortcuts");
  const { commands, over } = useFrame();
  const feeds = usePaletteFeeds();
  const { bindings, mod } = useKeymap();
  const [query, setQuery] = useState("");
  /* The line is empty at every open. */
  const [shown, setShown] = useState(open);
  if (shown !== open) {
    setShown(open);
    if (open) setQuery("");
  }

  useKeyBindings(
    [
      {
        chord: OWN_CHORD,
        group: "app",
        label: keysWords("palette"),
        inInput: true,
        inModal: true,
        run: () => commands.over(over === "palette" ? null : "palette"),
      },
    ],
    "global",
  );

  const rows = narrow(rowsOf(feeds, bindings, mod), query);
  const run = (id: string) => {
    const offer = liveOffer(feeds, id);
    if (!offer) return;
    onClose();
    offer.run();
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!chordMatches(OWN_CHORD, e.nativeEvent)) return false;
    e.preventDefault();
    onClose();
    return true;
  };
  const own = keysOf(OWN_CHORD, bindings, mod);

  return (
    <KitPalette
      open={open}
      onClose={onClose}
      label={t("ariaLabel")}
      inputLabel={t("ariaLabel")}
      placeholder={t("placeholder")}
      query={query}
      onQuery={setQuery}
      commands={rows}
      onRun={run}
      empty={t("empty")}
      {...(own ? { keyHint: own.join("") } : {})}
      foot={[
        { keys: [...chordKeys("ArrowUp", mod), ...chordKeys("ArrowDown", mod)], label: t("footNavigate") },
        { keys: chordKeys("Enter", mod), label: t("footRun") },
        { keys: chordKeys("Escape", mod), label: t("footClose") },
      ]}
      onKey={onKey}
    />
  );
}
