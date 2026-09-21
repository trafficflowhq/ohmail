/**
 * THE ROLE A CONTROL ADVERTISES, PER PLATFORM. React Native maps `tab` to no iOS trait at all —
 * `accessibilityPropsConversions.h` lists button, togglebutton, link, switch, summary, tabbar
 * and progressbar, and everything else falls to `AccessibilityTraits::None` — so a rail
 * destination or a Screener shelf reads as plain text and nothing tells a person driving
 * VoiceOver that it can be pressed. Measured on the iPhone Duo: the five rail destinations and
 * the three shelves each came back `GenericElement` beside a `Button` search pill. Apple's own
 * tab bars expose a button carrying the selected state, which is what this returns; Android
 * keeps `tab`, which Material announces as one.
 */
import type { PlatformName } from "./posture/derive";

export type A11yRole = "button" | "tab";

export function a11yRole(role: A11yRole, platform: PlatformName): A11yRole {
  return role === "tab" && platform === "ios" ? "button" : role;
}
