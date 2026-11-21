import { useEffect, useState } from "react";
import { useOptionalKeyBindings } from "@ohmail/app-logic/keys";
import { JumpBack } from "@ohmail/ui/base";
import { useText } from "../text/index.js";

export function StreamBackToTop({
  scroller,
  keysHere,
  onPress,
  lifted,
}: {
  scroller: HTMLElement | null;
  keysHere: boolean;
  onPress: () => void;
  lifted?: boolean;
}) {
  const t = useText("ohbox");
  const label = t("end.top");
  const [far, setFar] = useState(false);
  useEffect(() => {
    if (scroller === null) {
      setFar(false);
      return;
    }
    const look = () => setFar(scroller.scrollTop > Math.max(240, scroller.clientHeight / 2));
    look();
    scroller.addEventListener("scroll", look, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(look);
    observer?.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", look);
      observer?.disconnect();
    };
  }, [scroller]);
  useOptionalKeyBindings(
    keysHere && scroller ? [{ chord: "g g", group: "navigate", label, run: onPress }] : [],
  );
  return <JumpBack label={label} to="top" shown={far} lifted={lifted} onPress={onPress} />;
}
