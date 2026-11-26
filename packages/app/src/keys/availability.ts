import { useEffect, useState } from "react";
import { useFrameElement } from "../frame/FrameRoot.js";

export const SHEET_CHORD = "?";
export const TOUCH_ONLY = "(pointer: coarse) and (hover: none)";

export function useKeyboardHelpAvailable(phone: boolean): boolean {
  const frame = useFrameElement();
  const [touchOnly, setTouchOnly] = useState(false);
  useEffect(() => {
    const view = frame?.current?.ownerDocument.defaultView;
    const query = view?.matchMedia?.(TOUCH_ONLY);
    if (!query) return;
    const update = () => setTouchOnly(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, [frame]);
  return !phone && !touchOnly;
}
