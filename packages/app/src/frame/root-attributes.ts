/**
 * THE ROOT'S ATTRIBUTES. The new design's variants are written on `:root[data-…]`, so the frame stamps them
 * on the document's element. Pure: the plan, the look the shell stands under, the window. `null` removes an
 * attribute. The face and the old theme stay the old theme provider's (see `FrameRoot`).
 */
import type { Appearance, LayoutPlan, WindowFacts } from "./contract.js";

export const ROOT_ATTRIBUTES = [
  "data-scheme",
  "data-device",
  "data-touch",
  "data-pose",
  "data-icons",
  "data-product",
  "data-rm",
] as const;
export type RootAttribute = (typeof ROOT_ATTRIBUTES)[number];

export function attributesOf(
  plan: LayoutPlan,
  look: Appearance,
  w: WindowFacts,
): Record<RootAttribute, string | null> {
  return {
    "data-scheme": look.scheme,
    "data-device": plan.device,
    /* The pointer alone: a narrow desktop window is a phone's layout under a mouse. */
    "data-touch": plan.pointer === "coarse" ? "1" : "0",
    "data-pose": plan.pose,
    /* Signs on the places: the sidebar-icons setting's own default. Turning it off is Settings' to ask. */
    "data-icons": "1",
    "data-product": "mail",
    "data-rm": w.reducedMotion ? "1" : null,
  };
}
