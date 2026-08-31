/**
 * THE ACCOUNT-LEVEL FACE, COORDINATED — "apply on all devices" against the consent read that
 * carries the answer back.
 *
 * The face has TWO scopes (OHMARCHY-PLAN.md §3a): a device pin, which is local and instant, and
 * the account's synced choice, which is one field on the consent row (`themeFace`). The pin needs
 * no coordination — nothing else writes it. The account value does, and it needs exactly the two
 * rules `folders-flag.ts` arrived at the hard way, for exactly the same reasons:
 *
 *  · **USER-WINS.** A session's `GET /consent` can resolve AFTER an "apply on all devices" press,
 *    and an unguarded apply would publish the PRE-write face — the account ohmarchy, the phone
 *    paper, for the rest of the session. {@link FaceScope.applyAll} bumps the epoch before it
 *    writes, so any read ISSUED earlier is discarded whatever it answers. That is why the read
 *    side is two-phase ({@link FaceScope.beginRead}): the stamp has to be taken when the request
 *    goes out, not when its answer arrives.
 *  · **FRESHEST *SUCCESSFUL* READ WINS.** Two reads overlap routinely here (the session's boot
 *    read still in the air when a drain-completed refresh fires) and can settle out of issue
 *    order. Each read takes a sequence number and applies only while no NEWER read has applied.
 *    A read that could not be made (`undefined`) is not an answer and supersedes nothing — the
 *    folders machine's round-3 rule, and the same defect it was written for: discarding a valid
 *    older answer because a newer request failed.
 *
 * `null` and `undefined` are DIFFERENT and the distinction is the whole of the read contract:
 * `null` is the account saying "I have no face preference" (which clears this device's adopted
 * value — otherwise an account whose choice went away would keep re-skinning the phone from a
 * stale copy), and `undefined` is "could not ask" (which changes nothing).
 *
 * Pure and renderer-free (the `live.ts` charter), so `test/ohmarchy-face.test.ts` drives every
 * race with deferred promises instead of a device.
 */
import type { FaceName } from "../theme/face";

export interface FaceScopeDeps {
  /**
   * `PATCH /consent/settings {themeFace}` → the value the ACCOUNT now holds. Rejects on refusal
   * or transport failure. The echo, never the argument — a refused-but-200 write must not leave
   * the phone believing the account adopted a face it did not.
   */
  write(face: FaceName): Promise<FaceName | null>;
  /** Publish the account's answer to the UI. `null` clears the adopted value. */
  adopt(face: FaceName | null): void;
  /**
   * Drop this device's pin, so the account governs here too — which is what the press asked
   * for. Called only after a CONFIRMED write: clearing it on a refusal would hand the device to
   * an account answer nobody stored.
   */
  clearPin(): void;
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
  /** Issue order for reads, and the newest that has actually APPLIED. */
  let readSeq = 0;
  let appliedSeq = 0;

  return {
    beginRead() {
      const at = epoch;
      const mine = ++readSeq;
      return (answer) => {
        if (answer === undefined) return; // could not ask — not an answer, supersedes nothing
        if (epoch !== at) return; // a write happened after this read went out; the user wins
        if (mine <= appliedSeq) return; // a newer read already applied
        appliedSeq = mine;
        deps.adopt(answer);
      };
    },
    async applyAll(face) {
      epoch += 1;
      try {
        const stored = await deps.write(face);
        /* THE ECHO, THEN THE PIN. Adopt what the account now holds (which may differ from what
           was asked — a server may store something else, and that is the value this device must
           show), then drop the pin so the account governs here. Both only on success. */
        deps.adopt(stored);
        deps.clearPin();
        return true;
      } catch {
        /* A REJECTED write changed nothing on the account. The epoch bump above did invalidate
           the reads in flight, and that is correct rather than a leak: those reads were issued
           against a row this press may or may not have moved, so the next drain's read — issued
           after the bump — is the authoritative one, and it is asked for on the machine's own
           cadence with no help from here. */
        return false;
      }
    },
  };
}
