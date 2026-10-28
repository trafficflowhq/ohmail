/**
 * The account-level face, coordinated — "apply on all devices" against the consent read that carries the
 * answer back. The device pin needs no coordination; the account value needs the rules `folders-flag.ts`
 * arrived at: user-wins ({@link FaceScope.applyAll} bumps the epoch before writing, so a read issued earlier
 * is discarded — hence two-phase {@link FaceScope.beginRead}); no read may overlap a write (this coordinator
 * cannot make the shared `GET /consent` wait, so it refuses the overlapping answer — the write's echo already
 * published the value); freshest successful read wins (`undefined` supersedes nothing); and {@link
 * FaceScopeDeps.clearPin} releases only a pin equal to the submitted face. `null` = "no preference" (clears
 * the adopted value); `undefined` = "could not ask" (changes nothing).
 *
 * Signed in to an account ({@link FaceScopeDeps.follows}), the account governs, as on the web and the desktop:
 * {@link FaceScope.choose} writes it, and once the account holds a look a read retires the device pin. A
 * standalone phone keeps its own pin. The adopted answer is kept on the phone ({@link faceMirrorStore}), as the
 * web keeps `ohmail.face.account`, so a cold start or an offline session wears it before any read lands.
 */
import { faceOf, type FaceName } from "../theme/face";
import type { SecureKV } from "./servers";

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
  /** This device's pin as it stands now. */
  pin(): FaceName | null;
  /** Pin a press: it shows at once, and stays if the account cannot take it. */
  setPin(face: FaceName): void;
  /** Keep an adopted answer for the next launch; called only where the account follows. */
  remember(face: FaceName | null): void;
  /** Signed in to an account that stores the look; false on the standalone door. */
  follows: boolean;
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
  /**
   * The Look control. Pins the press at once; where the account follows, writes it there too
   * ({@link applyAll}), or, before the account's look was read, on the first read. A refused
   * write leaves the press as this device's pin and resolves `false`.
   */
  choose(face: FaceName): Promise<boolean>;
}

export function faceScope(deps: FaceScopeDeps): FaceScope {
  /** Bumped by every write, BEFORE it goes out: reads issued earlier are out. */
  let epoch = 0;
  /** Writes on the wire right now. A read that overlaps one at EITHER end is ambiguous. */
  let unsettled = 0;
  /** Issue order for reads, and the newest that has actually APPLIED. */
  let readSeq = 0;
  let appliedSeq = 0;
  /** An answer was adopted this session: the account's look is known. */
  let known = false;
  /** A press made before that, owed to the account. */
  let owed: FaceName | null = null;
  /** A press the account refused: this device's pin, which no read retires. */
  let kept: FaceName | null = null;

  const adopt = (face: FaceName | null): void => {
    known = true;
    deps.adopt(face);
    if (deps.follows) deps.remember(face);
  };
  const write = async (face: FaceName): Promise<boolean> => {
    const ok = await scope.applyAll(face);
    kept = ok ? null : face;
    return ok;
  };
  /** After a read: pay the owed press, or retire a pin the account's look supersedes. */
  const follow = (answer: FaceName | null): void => {
    if (!deps.follows) return;
    const pin = deps.pin();
    const press = owed;
    owed = null;
    if (press !== null && pin === press && press !== answer) {
      void write(press);
      return;
    }
    if (answer !== null && pin !== null && pin !== kept) deps.clearPin(pin);
  };

  const scope: FaceScope = {
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
        adopt(answer);
        follow(answer);
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
        adopt(stored);
        deps.clearPin(face);
        kept = null;
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
    async choose(face) {
      deps.setPin(face);
      if (!deps.follows) return true;
      if (!known) {
        owed = face;
        return true;
      }
      return write(face);
    },
  };
  return scope;
}

/** The keystore row with the account's look as this phone last adopted it. */
export const FACE_MIRROR_KEY = "ohmail.face.account";

/** That look, and the account (`ConnectedSession.ownerKey`) it belongs to. */
export interface FaceMirror {
  owner: string;
  face: FaceName;
}

export function decodeFaceMirror(raw: string | null): FaceMirror | null {
  if (raw === null) return null;
  try {
    const row = JSON.parse(raw) as { owner?: unknown; face?: unknown } | null;
    const face = faceOf(row?.face);
    return face !== null && typeof row?.owner === "string" ? { owner: row.owner, face } : null;
  } catch {
    return null;
  }
}

export interface FaceMirrorStore {
  boot: () => Promise<void>;
  set: (mirror: FaceMirror | null) => void;
  dispose: () => void;
}

/** `appearance-store.ts`'s ordering: a boot read resolving after a set does not publish the older row. */
export function faceMirrorStore(
  kv: SecureKV | undefined,
  apply: (mirror: FaceMirror | null) => void,
): FaceMirrorStore {
  let set = false;
  let dropped = false;
  return {
    async boot() {
      if (!kv) return;
      const stored = decodeFaceMirror(await kv.get(FACE_MIRROR_KEY).catch(() => null));
      if (dropped || set || stored === null) return;
      apply(stored);
    },
    set(mirror) {
      set = true;
      if (!dropped) apply(mirror);
      const done = mirror === null ? kv?.remove(FACE_MIRROR_KEY) : kv?.set(FACE_MIRROR_KEY, JSON.stringify(mirror));
      void done?.catch(() => {});
    },
    dispose() { dropped = true; },
  };
}

/**
 * The account's look to wear: this session's answer once known; before that the kept one, for the
 * same account or, with no session yet (`owner` null), for the launch's first frames.
 */
export function accountFaceShown(
  live: FaceName | null,
  known: boolean,
  mirror: FaceMirror | null,
  owner: string | null,
): FaceName | null {
  if (known) return live;
  return mirror !== null && (owner === null || owner === mirror.owner) ? mirror.face : null;
}

/** Does the kept look still belong here: not after a sign-out, a mid-use end, another account or the standalone door. */
export function faceMirrorStands(
  mirror: FaceMirror,
  state: { k: string; session?: { ownerKey: string; standalone: boolean } },
): boolean {
  if (state.k === "idle" || state.k === "ended") return false;
  if (state.k !== "live" || !state.session) return true;
  return !state.session.standalone && state.session.ownerKey === mirror.owner;
}
