import { useKeyBindings } from "@ohmail/app-logic/keys";
import { Switcher, type SwitcherProps } from "@ohmail/ui/mail";
import { NONE, type None } from "../host/contract.js";
import { useText } from "../text/index.js";
import { useFrame } from "./commands.js";
import type { PlaceEntry, Product } from "./contract.js";
import { SWITCH_CHORDS } from "./product.js";

const always = () => true;
const noHome = () => undefined;

function useSwitchProduct() {
  const { host, commands } = useFrame();
  const calendar = host.features.calendar;
  const useHome = calendar === NONE ? noHome : (calendar.useSwitchHome ?? noHome);
  const home = useHome();
  return (to: Product) => commands.switchProduct(to, home);
}

function useSwitchOffered() {
  const { host, product } = useFrame();
  const calendar = host.features.calendar;
  const offered = calendar === NONE ? always : (calendar.useSwitchOffered ?? always);
  const available = offered();
  return product === "cal" || available;
}

export function ProductSwitch({ kind, onRail }: { kind: SwitcherProps["kind"]; onRail?: boolean }) {
  const { host, product, previousProduct } = useFrame();
  const switchProduct = useSwitchProduct();
  const t = useText("frame");
  const offered = useSwitchOffered();
  const calendar = host.features.calendar;
  if (calendar !== NONE && host.capabilities.products === "calendar" && calendar.CompanionSwitch) {
    return <calendar.CompanionSwitch kind={kind} onRail={onRail} />;
  }
  if (!offered || calendar === NONE || host.capabilities.products !== "both") return null;
  const props: SwitcherProps = {
    kind,
    label: t("products.label"),
    current: product,
    from: previousProduct,
    onRail,
    mail: { word: "ohmail", label: t("products.mail"), keyHint: SWITCH_CHORDS.mail },
    cal: { word: "ohcal", label: t("products.cal"), keyHint: SWITCH_CHORDS.cal },
    onSwitch: switchProduct,
  };
  if (kind === "pair") return <Switcher {...props} />;
  return product === "mail" ? (
    <RoundToCalendar {...props} useWants={calendar.useWants} />
  ) : (
    <RoundToMail {...props} />
  );
}

function RoundToCalendar({ useWants, ...props }: SwitcherProps & { useWants: () => boolean }) {
  const wants = useWants();
  const t = useText("frame");
  return (
    <Switcher
      {...props}
      cal={{ ...props.cal, wants, description: wants ? t("products.calendarWaiting") : undefined }}
    />
  );
}

const noCount = () => null;

function usePlaceCount(place: PlaceEntry | None) {
  const useCount = place === NONE ? noCount : (place.rail?.useCount ?? noCount);
  return useCount();
}

function RoundToMail(props: SwitcherProps) {
  const { host } = useFrame();
  const t = useText("frame");
  const ohbox = usePlaceCount(host.features.places.ohbox);
  const screener = usePlaceCount(host.features.places.screener);
  const wants = Boolean(ohbox || screener);
  return (
    <Switcher
      {...props}
      mail={{ ...props.mail, wants, description: wants ? t("products.mailWaiting") : undefined }}
    />
  );
}

export function ProductKeys() {
  const switchProduct = useSwitchProduct();
  const offered = useSwitchOffered();
  const t = useText("frame");
  useKeyBindings(
    offered
      ? [
          {
            chord: SWITCH_CHORDS.mail,
            group: "navigate",
            label: t("products.mail"),
            run: () => switchProduct("mail"),
          },
          {
            chord: SWITCH_CHORDS.cal,
            group: "navigate",
            label: t("products.cal"),
            run: () => switchProduct("cal"),
          },
        ]
      : [],
    "global",
  );
  return null;
}
