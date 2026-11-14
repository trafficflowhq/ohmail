/**
 * WHAT THE COMPILER REFUSES. This file builds to nothing; it exists to fail.
 *
 * Each line below hands over a host with one part left out, and is marked as an error the
 * compiler must report. Make that part optional and the mark has nothing to stand on, which is
 * itself an error. The lists under them hold every key of every part the same way.
 */
import type { HostCapabilities } from "./capabilities.js";
import type { HostContract } from "./contract.js";
import type { HostDevice } from "./device.js";
import type { HostFeatures } from "./features.js";
import type { HostReads } from "./reads.js";
import type { HostSession } from "./session.js";
import type { HostSignals } from "./signals.js";
import type { HostWires } from "./wires.js";

type AHost<T extends HostContract> = T;

// @ts-expect-error a host hands in its engine
export type NoEngine = AHost<Omit<HostContract, "engine">>;
// @ts-expect-error a host says who is signed in
export type NoSession = AHost<Omit<HostContract, "session">>;
// @ts-expect-error a host answers every read
export type NoReads = AHost<Omit<HostContract, "reads">>;
// @ts-expect-error a host answers every wire
export type NoWires = AHost<Omit<HostContract, "wires">>;
// @ts-expect-error a host answers every capability
export type NoCapabilities = AHost<Omit<HostContract, "capabilities">>;
// @ts-expect-error a host answers every feature
export type NoFeatures = AHost<Omit<HostContract, "features">>;
// @ts-expect-error a host answers every device verb
export type NoDevice = AHost<Omit<HostContract, "device">>;
// @ts-expect-error a host answers every signal
export type NoSignals = AHost<Omit<HostContract, "signals">>;

/** The keys of `T` a value may leave out. */
type MayLeaveOut<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];
type EveryKeyAnswered<T> = [MayLeaveOut<T>] extends [never] ? true : false;
type Holds<T extends true> = T;

export type NothingOptional = [
  Holds<EveryKeyAnswered<HostContract>>,
  Holds<EveryKeyAnswered<HostSession>>,
  Holds<EveryKeyAnswered<HostReads>>,
  Holds<EveryKeyAnswered<HostWires>>,
  Holds<EveryKeyAnswered<HostCapabilities>>,
  Holds<EveryKeyAnswered<HostFeatures>>,
  Holds<EveryKeyAnswered<HostDevice>>,
  Holds<EveryKeyAnswered<HostSignals>>,
];
