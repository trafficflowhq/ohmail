/**
 * THE HOST CONTRACT. What a shell hands the shared views, in eight parts.
 *
 * Every key of every part is present in every shell. No key is optional. A shell that cannot do
 * a thing says so in words: `none` for a wire, a read, a feature, a device verb or a signal, and
 * for a capability the answer `capabilities.ts` names. Shared code never supplies a default for
 * what a shell must hand in, and never asks which setting it runs in: it asks this record.
 *
 * The record replaces the 48 inputs the old shell takes. Each key says which input it replaces;
 * a key that replaces none says what a mount does by hand today.
 */
import type { OhmailEngine } from "@ohmail/client-engine";
import type { HostCapabilities } from "./capabilities.js";
import type { HostDevice } from "./device.js";
import type { HostFeatures } from "./features.js";
import type { HostReads } from "./reads.js";
import type { HostSession } from "./session.js";
import type { HostSignals } from "./signals.js";
import type { HostWires } from "./wires.js";

/** The word a shell answers where it has nothing to hand in. */
export const NONE = "none";
export type None = typeof NONE;

export interface HostContract {
  /**
   * The engine, built by the shell: its transport, its store, the kinds of record it names.
   * Replaces the input `engine`. The input `demo` has no key: the invented world is a host of
   * its own, for tests.
   */
  readonly engine: OhmailEngine;
  readonly session: HostSession;
  readonly reads: HostReads;
  readonly wires: HostWires;
  readonly capabilities: HostCapabilities;
  readonly features: HostFeatures;
  readonly device: HostDevice;
  readonly signals: HostSignals;
}
