/**
 * THE LOOK A BROWSER HOST STANDS UNDER, as `useMailSupplies` takes it: the face and the scheme of the theme that
 * stands above the entry, read where the entry mounts the frame. A mount with no theme above stands in paper, light.
 * The rule of which look that is (the device's pin, else the account's face, else ohmarchy on a Linux desktop) is
 * the theme's own and is not said again here.
 */
import { useMemo } from "react";
import { useOptionalTheme } from "@ohmail/ui/theme";
import type { Appearance } from "../host/index.js";

export function useThemeLook(): Appearance {
  const theme = useOptionalTheme();
  const face = theme?.face ?? "paper";
  const scheme = theme?.resolved ?? "light";
  const layout = theme?.layoutEnabled ? theme.layout : undefined;
  return useMemo(() => ({ face, scheme, layout }), [face, scheme, layout]);
}
