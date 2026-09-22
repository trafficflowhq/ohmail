/**
 * A DEVELOPMENT-ONLY WAY TO THROW IN THE READER, so the boundary can be watched catching on a
 * device. Reached only through `render-error-trigger-door.ts`, whose `__DEV__` branch Metro folds
 * away in a release bundle — this module is then never bundled, and the needle below is absent
 * from both Hermes string tables (the census in the kit asks). An invisible 32x32 control at the
 * top centre of the reader, named for the accessibility driver; pressed once, the next render
 * throws. Retry remounts the reader and the control is disarmed with it.
 */
import { useState } from "react";
import { Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/** The one token this module puts in a bundle: its label, its message, the census needle. */
export const DEV_RENDER_ERROR_TRIGGER = "dev_render_error_trigger";

export function DevRenderErrorTrigger() {
  const [armed, setArmed] = useState(false);
  const insets = useSafeAreaInsets();
  if (armed) throw new Error(DEV_RENDER_ERROR_TRIGGER);
  return (
    <Pressable
      accessible
      accessibilityRole="button"
      accessibilityLabel={DEV_RENDER_ERROR_TRIGGER}
      testID={DEV_RENDER_ERROR_TRIGGER}
      onPress={() => setArmed(true)}
      style={{ position: "absolute", top: insets.top + 4, left: "50%", marginLeft: -16, width: 32, height: 32 }}
    />
  );
}
