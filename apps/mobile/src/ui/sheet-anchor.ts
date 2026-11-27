import { useRef, useState, type RefObject } from "react";
import type { View } from "react-native";
import type { SheetAnchor } from "./sheet-bounds";

export function useSheetAnchor() {
  const anchorRef = useRef<View>(null);
  const request = useRef(0);
  const [anchor, setAnchor] = useState<SheetAnchor>();
  const anchorTo = (open: () => void, target: RefObject<View | null> = anchorRef, host?: RefObject<View | null>) => {
    const ticket = ++request.current;
    const finish = (place?: SheetAnchor) => {
      if (ticket !== request.current) return;
      setAnchor(place);
      open();
    };
    const view = target.current;
    if (!view?.measureInWindow) {
      finish();
      return;
    }
    view.measureInWindow((x, y, width, height) => {
      if (width <= 0 || height <= 0) {
        finish();
        return;
      }
      const place = { x, y, width, height };
      const hostView = host?.current;
      if (hostView?.measureInWindow) {
        hostView.measureInWindow((xHost, yHost, wHost, hHost) => {
          finish(wHost > 0 && hHost > 0 ? { ...place, host: { x: xHost, y: yHost, width: wHost, height: hHost } } : place);
        });
      } else {
        finish(place);
      }
    });
  };
  return { anchor, anchorRef, anchorTo };
}
