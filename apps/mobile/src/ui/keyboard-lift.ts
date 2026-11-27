/**
 * HOW FAR A SHEET RISES FOR THE KEYBOARD. iOS lifts a sheet through `KeyboardAvoidingView`'s
 * padding; on Android that view does nothing inside a `Modal` drawn edge to edge, so a reply typed
 * on a foldable's cover sat under the keyboard with nothing of it visible. There the sheet pads its
 * foot by the keyboard's reported height. Android reports that height above the navigation
 * bar, so callers that draw behind the bar also supply the bottom safe inset.
 */
import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";

/** A composer drawn behind the navigation bar includes that inset in its Android lift. */
export function keyboardLift(platform: string, keyboardHeight: number, bottomInset = 0): number {
  return platform === "android" && keyboardHeight > 0 ? keyboardHeight + bottomInset : 0;
}

export function useKeyboardHeight(enabled = true): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    setHeight(Keyboard.metrics?.()?.height ?? 0);
    const ios = Platform.OS === "ios";
    const shown = Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", (e) => setHeight(e.endCoordinates.height));
    const hidden = Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", () => setHeight(0));
    return () => { shown.remove(); hidden.remove(); };
  }, [enabled]);
  return enabled ? height : 0;
}

export function useKeyboardLift(): number {
  return keyboardLift(Platform.OS, useKeyboardHeight(Platform.OS === "android"));
}
