import { useKeyBindings } from "@ohmail/app-logic/keys";
import { Switcher } from "@ohmail/ui/mail";
import { NONE } from "../host/index.js";
import { useText } from "../text/index.js";
import { useFrame } from "./commands.js";
import { SWITCH_CHORDS } from "./product.js";

export function ProductSwitch({ kind, onRail }: { kind: "pair" | "round"; onRail?: boolean }) {
  const { host, product, commands } = useFrame();
  const t = useText("frame");
  if (host.features.calendar === NONE || host.capabilities.products !== "both") return null;
  return (
    <Switcher
      kind={kind}
      label={t("products.label")}
      current={product}
      mail={{ word: "ohmail", label: t("products.mail"), keyHint: SWITCH_CHORDS.mail }}
      cal={{ word: "ohcal", label: t("products.cal"), keyHint: SWITCH_CHORDS.cal }}
      onRail={onRail}
      onSwitch={commands.switchProduct}
    />
  );
}

export function ProductKeys() {
  const { commands } = useFrame();
  const t = useText("frame");
  useKeyBindings(
    [
      {
        chord: SWITCH_CHORDS.mail,
        group: "navigate",
        label: t("products.mail"),
        run: () => commands.switchProduct("mail"),
      },
      {
        chord: SWITCH_CHORDS.cal,
        group: "navigate",
        label: t("products.cal"),
        run: () => commands.switchProduct("cal"),
      },
    ],
    "global",
  );
  return null;
}
