import type { CalendarEntry, FramePlaces, FrameStages } from "../frame/contract.js";
import type { None } from "./contract.js";
import type { Appearance, HostAddress, WindowFacts } from "./device.js";
import type { FeatureEntry, FeatureName } from "./features.js";
import type { HostSession } from "./session.js";
import type { Signal } from "./signals.js";
import type { HostWires } from "./wires.js";

/** The transports a shell has, by wire, before it says on which door each is `none`. */
export type Transports<K extends keyof HostWires = keyof HostWires> = {
  readonly [W in K]: Exclude<HostWires[W], None>;
};

/** A wire a shell may have nothing to hand in for: no transport on this door, or a call today's views still make themselves. */
export type MayBeNone<K extends keyof HostWires> = { readonly [W in K]: HostWires[W] };

/** The feature entries a shell imports, before it says in which setting each is `none`. */
export type Entries<K extends FeatureName = FeatureName> = Readonly<Record<K, FeatureEntry>>;

/**
 * What every shell hands the frame, the same on all three: the places and stages it mounts (it imports them), the
 * address bar, the window and the look it stands under, and its way back to a live session.
 */
export interface FrameSupplies {
  readonly places: FramePlaces;
  readonly stages: FrameStages;
  /** The calendar's root export (`calendar` of `@ohmail/app/calendar`) where the shell mounts it, else `none`. */
  readonly calendar: CalendarEntry | None;
  readonly address: HostAddress;
  readonly window: Signal<WindowFacts>;
  readonly appearance: Signal<Appearance>;
  readonly recover: HostSession["recover"];
}
