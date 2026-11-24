/**
 * WHICH PAIRING THE PHONE KEEPS AS THE SIGNED-IN ONE. The connection says who is signed in; this decides what the
 * native side is told to keep, and native keeps it where a closed app's wake can read it (`notices-port.ts`). The
 * kept pairing is the only one a notice is drawn for, so every change here also closes what is shown for any other.
 *
 *  · a session is live: its pairing is kept (sign-in, a switch's arrival, each launch);
 *  · nobody is signed in (nothing paired, signed out, a session the server ended or refused): none is kept;
 *  · on the way from one live session to the next (a switch): none is kept until the next one is live;
 *  · starting cold, before the connection knows: what the last run kept stands.
 *
 * A pairing whose id is not of the minted shape is kept as none. Each telling waits for the one before it, so the
 * last word native hears is the newest; one native did not confirm is told again at the next reading.
 */
import { isInstance, type NoticesNative } from "./notices-port";

/** What the connection says of who is signed in. */
export type SignedIn =
  /** A session is live: this pairing is the signed-in one. */
  | { readonly k: "live"; readonly instance: string }
  /** Nobody is signed in. */
  | { readonly k: "none" }
  /** Not known yet: the app is starting, or on its way into a session. */
  | { readonly k: "pending" };

/** The connection's states by name, as this reads them. */
export type ConnectionKind = "starting" | "idle" | "connecting" | "live" | "shell" | "refused" | "ended";

/** Each state of the connection once: one added there does not compile here until it is classed. */
const READS: Record<ConnectionKind, SignedIn["k"]> = {
  starting: "pending", connecting: "pending",
  live: "live", shell: "live",
  idle: "none", refused: "none", ended: "none",
};

/** The connection's state as a reading of who is signed in. A live state with no pairing to name reads as nobody. */
export function signedInOf(state: {
  readonly k: ConnectionKind; readonly session?: { readonly profile: { readonly id: string } };
}): SignedIn {
  const reads = READS[state.k];
  if (reads !== "live") return { k: reads };
  const instance = state.session?.profile.id;
  return typeof instance === "string" ? { k: "live", instance } : { k: "none" };
}

export class LiveInstanceKeeper {
  /** What native last confirmed it keeps: a pairing, none (`null`), or not known (`undefined`). */
  private kept: string | null | undefined = undefined;
  /** This process has had a live session: a reading that is not live after it is a pairing left. */
  private wasLive = false;
  private chain: Promise<void> = Promise.resolve();

  /** `native`: the notices' module, or null where the build has none (the iPhone): nothing is kept, nothing drawn. */
  constructor(private readonly native: Pick<NoticesNative, "setLive"> | null) {}

  /** The connection moved. */
  see(now: SignedIn): void {
    if (now.k === "live") {
      this.wasLive = true;
      this.keep(isInstance(now.instance) ? now.instance : null);
    } else if (now.k === "none" || this.wasLive) {
      this.keep(null);
    }
  }

  /** Settles once native has answered every telling so far. */
  settled(): Promise<void> {
    return this.chain;
  }

  private keep(instance: string | null): void {
    const native = this.native;
    if (native === null) return;
    this.chain = this.chain.then(async () => {
      if (this.kept === instance) return;
      this.kept = undefined;
      let confirmed = false;
      try {
        confirmed = (await native.setLive(instance)) === true;
      } catch {
        confirmed = false;
      }
      if (confirmed) this.kept = instance;
    });
  }
}
