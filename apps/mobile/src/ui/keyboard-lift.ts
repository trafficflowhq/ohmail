/**
 * HOW FAR A SHEET RISES FOR THE KEYBOARD. iOS lifts a sheet through `KeyboardAvoidingView`'s
 * padding; on Android that view does nothing inside a `Modal` drawn edge to edge, so a reply typed
 * on a foldable's cover sat under the keyboard with nothing of it visible. There the sheet pads its
 * foot by the keyboard's own reported height, from the show/hide events, and by nothing on iOS.
 */
import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";

export function keyboardLift(platform: string, keyboardHeight: number): number {
  return platform === "android" ? Math.max(0, keyboardHeight) : 0;
}

export function useKeyboardLift(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (Platform.OS !== "android") return undefined;
    const shown = Keyboard.addListener("keyboardDidShow", (e) => setHeight(e.endCoordinates.height));
    const hidden = Keyboard.addListener("keyboardDidHide", () => setHeight(0));
    return () => { shown.remove(); hidden.remove(); };
  }, []);
  return keyboardLift(Platform.OS, height);
}
