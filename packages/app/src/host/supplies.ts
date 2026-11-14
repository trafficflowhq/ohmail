import type { None } from "./contract.js";
import type { FeatureEntry, FeatureName } from "./features.js";
import type { HostWires } from "./wires.js";

/** The transports a shell has, by wire, before it says on which door each is `none`. */
export type Transports<K extends keyof HostWires = keyof HostWires> = {
  readonly [W in K]: Exclude<HostWires[W], None>;
};

/** The feature entries a shell imports, before it says in which setting each is `none`. */
export type Entries<K extends FeatureName = FeatureName> = Readonly<Record<K, FeatureEntry>>;
