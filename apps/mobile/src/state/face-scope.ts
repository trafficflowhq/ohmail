/**
 * The account-level face, coordinated — "apply on all devices" against the consent read that carries the
 * answer back. The device pin needs no coordination; the account value needs the rules `folders-flag.ts`
 * arrived at: user-wins ({@link FaceScope.applyAll} bumps the epoch before writing, so a read issued earlier
 * is discarded — hence two-phase {@link FaceScope.beginRead}); no read may overlap a write (this coordinator
 * cannot make the shared `GET /consent` wait, so it refuses the overlapping answer — the write's echo already
 * published the value); freshest successful read wins (`undefined` supersedes nothing); and {@link
 * FaceScopeDeps.clearPin} releases only a pin equal to the submitted face. `null` = "no preference" (clears
 * the adopted value); `undefined` = "could not ask" (changes nothing).
 */
import type { FaceName } from "../theme/face";

export interface FaceScopeDeps {
  /**
   * `PATCH /consent/settings {themeFace}` → the value the ACCOUNT now holds. Rejects on refusal
   * or transport failure. The echo, never the argument — a refused-but-200 write must not leave
   * the phone believing the account adopted a face it did not.
   */
  write(face: FaceName): Promise<FaceName | null>;
  /**
   * Publish the account's answer to the UI. `null` clears the adopted value.
   *
   * Being called at all is also what makes the account's face KNOWN: a value adopted here came
   * from a successful read or from a write's echo, and nothing else may make the account-wide
   * control pressable — see {@link FaceScope.applyAll}'s counterpart in the world layer.
   */
  adopt(face: FaceName | null): void;
  /**
   * Drop this device's pin, so the account governs here too — which is what the press asked for.
   *
   * Called only after a CONFIRMED write (clearing it on a refusal would hand the device to an
   * account answer nobody stored), and given the face that was SUBMITTED: the caller must release
   * only a pin that still equals it, because a newer choice made while the PATCH flew is a
   * decision this write knows nothing about.
   */
  clearPin(submitted: FaceName): void;
}

export interface FaceScope {
  /**
   * Announce that an account read is going out, and take back the applier for its answer. The
   * epoch and sequence number are captured HERE — see the header's first rule.
   *
   * The applier takes the answer's `themeFace`: a face, `null` for "the account has none", or
   * `undefined` for "could not ask", which applies nothing.
   */
  beginRead(): (answer: FaceName | null | undefined) => void;
  /**
   * "Apply on all devices." Writes the account, adopts the ECHO, and drops the device pin.
   * Resolves `true` only when the account confirmed it; `false` is the failure sentence's cue
   * and leaves both the adopted value and the pin exactly as they were.
   */
  applyAll(face: FaceName): Promise<boolean>;
}

export function faceScope(deps: FaceScopeDeps): FaceScope {
  /** Bumped by every write, BEFORE it goes out: reads issued earlier are out. */
  let epoch = 0;
  /** Writes on the wire right now. A read that overlaps one at EITHER end is ambiguous. */
  let unsettled = 0;
  /** Issue order for reads, and the newest that has actually APPLIED. */
  let readSeq = 0;
  let appliedSeq = 0;

  return {
    beginRead() {
      const at = epoch;
      const mine = ++readSeq;
      /* A read that goes out while a write is unsettled already carries the bumped epoch, so the
         epoch check below cannot see it once that write lands. Recorded here instead. */
      const busyAtIssue = unsettled > 0;
      return (answer) => {
        if (answer === undefined) return; // could not ask — not an answer, supersedes nothing
        if (epoch !== at) return; // a write happened after this read went out; the user wins
        if (busyAtIssue || unsettled > 0) return; // it overlapped a write; the row it saw is unknown
        if (mine <= appliedSeq) return; // a newer read already applied
        appliedSeq = mine;
        deps.adopt(answer);
      };
    },
    async applyAll(face) {
      epoch += 1;
      unsettled += 1;
      try {
        const stored = await deps.write(face);
        /* THE ECHO, THEN THE PIN. Adopt what the account now holds (which may differ from what
           was asked — a server may store something else, and that is the value this device must
           show), then release the pin so the account governs here — but only the pin this press
           was made under. Both only on success. */
        deps.adopt(stored);
        deps.clearPin(face);
        return true;
      } catch {
        /* A REJECTED write changed nothing on the account. The epoch bump above did invalidate
           the reads in flight, and that is correct rather than a leak: those reads were issued
           against a row this press may or may not have moved, so the next drain's read — issued
           after the bump — is the authoritative one, and it is asked for on the machine's own
           cadence with no help from here. */
        return false;
      } finally {
        /* The write is off the wire either way, so reads may be believed again. Decremented in
           `finally` rather than on the success path: a refusal that left the barrier standing
           would refuse every later read for the life of the session. */
        unsettled -= 1;
      }
    },
  };
}
