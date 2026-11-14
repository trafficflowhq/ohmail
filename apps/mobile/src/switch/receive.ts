/**
 * THE RECEIVING SIDE OF THE SWITCH, IN THE CONNECTION LAYER: what this app does with the one arrival native hands over,
 * taken up only once the launch order has finished.
 *
 *  - An app that holds a live pairing never takes a handoff: a code beside the place is dropped, and the place opens
 *    only inside the account the sender named, in the session in front (`receiver.ts`). It never changes account.
 *  - An app that holds none takes the sibling's code only with the verifier of its own pending challenge, the one
 *    native made for that very challenge: the pairing link is parsed, its origin probed as a scanned code's is, and
 *    the code redeemed as the handoff's grant. The new session must be the account the sender named by its digest, or
 *    it is signed out and dropped at once. Then the app goes live on it and opens at the place.
 *
 * On Android the code comes in the very call that opens this app (the sibling asked this app's provider first). On
 * the iPhone it takes three legs: a signed-out app answers the opening leg by asking back once with a challenge
 * (`askBack`); the sibling, armed by its own press, answers that ask with a code (`answer`, the `ask` leg here when
 * this app is the sender); the `done` leg is then spent here with the verifier, digest and place native kept.
 *
 * A failed handoff is silent: the app shows what it would have shown when opened signed out. Nothing of a code, a
 * verifier, a challenge, an origin or an account is logged or handed to the page; what happened is a closed word.
 */
import { challengeOf, pairingDigest, type Sha256Base64 } from "./digest";
import { readPayload } from "./payload";
import { decodePlace } from "./place";
import { stepArrival } from "./receiver";
import type { SwitchNative } from "./switch-port";
import {
  forgetProfile, livePairings, pairByHandoff, parsePairLink, probePairing,
  type PairingEnv, type PairOutcome, type ShellOutcome,
} from "../net/pairing";

/** What taking up one arrival came to, as a closed word. */
export type Received =
  /** No arrival, or one this app reads nothing in. */
  | "nothing"
  /** A place inside this app's own account, handed to the surface. */
  | "place"
  /** An arrival that leaves the app where it was. */
  | "stayed"
  /** The sibling's code spent: the app went live on the sender's account. */
  | "signedIn"
  /** A handoff that failed on its way, silently. */
  | "refused"
  /** A handoff that signed in to an account the sender did not name: signed out again and never shown. */
  | "dropped"
  /** A handoff whose session a newer transition overtook: kept as a pairing, not entered. */
  | "superseded"
  /** The iPhone, signed out: this app asked the sibling back for a code. */
  | "asked"
  /** The iPhone, this app the sender: the sibling's ask answered with a code. */
  | "granted";

/** A session a handoff made, ready to go live. */
export type HandedSession = Extract<PairOutcome, { kind: "paired" }> | Extract<ShellOutcome, { kind: "shell" }>;

export interface ReceiveDeps {
  readonly env: PairingEnv;
  readonly native: SwitchNative;
  /** The sender's app: this app's sibling. */
  readonly from: "ohmail" | "ohcal";
  /** Where a session a handoff makes is shown: the screens' boots the engine here, the shell's never does. */
  readonly surface: "screens" | "shell";
  readonly sha256: Sha256Base64;
  /** The connection's transitions: one at a time, and only the newest may adopt (`net/transitions.ts`). */
  readonly transition: <T>(op: (stillCurrent: () => boolean) => Promise<T>) => Promise<T>;
  /** The digest of the session in front now; null where none is live or it is this phone's own mailbox. */
  readonly liveDigest: () => Promise<string | null>;
  /**
   * The session in front's mint, read when the sibling asks: present only for a session on a paired door
   * (`handoffMinter`), never for this phone's own mailbox or with none live.
   */
  readonly minter: () => ((challenge: string) => Promise<string | null>) | undefined;
  /** Go live on the session a handoff made: the connection's own adoption, inside the transition. */
  readonly adopt: (handed: HandedSession) => void;
  /** A place inside this app's own account, for the surface that draws it. */
  readonly place: (to: ArrivedPlace) => void;
}

/** A place an arrival opens. */
export type ArrivedPlace = { readonly to: "event" | "message"; readonly id: string };

/**
 * THE INTAKE, one for the app's life: an arrival is taken up only once the launch order has finished (`launched`),
 * then at each arrival native announces, one at a time; one announced while another is taken up is taken next.
 */
export function switchIntake(
  native: SwitchNative | null, take: () => Promise<unknown>,
): { launched(): void; stop(): void } {
  let open = false;
  let busy = false;
  let again = false;
  const pump = (): void => {
    if (!open) return;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    void (async () => {
      do {
        again = false;
        await take().catch(() => undefined);
      } while (again && open);
      busy = false;
    })();
  };
  const listening = native?.addListener("onArrival", pump) ?? null;
  return {
    launched() {
      open = true;
      pump();
    },
    stop() {
      open = false;
      listening?.remove();
    },
  };
}

/**
 * THE PLACE AN ARRIVAL OPENS, held for the surface that draws it: the shell's page takes it once it has drawn, and
 * only the session it was judged in may take it. A place held for another session is dropped, never shown.
 */
export function placeHolder(): {
  hold(profileId: string, to: ArrivedPlace): void;
  take(profileId: string): ArrivedPlace | null;
  onHeld(listener: () => void): () => void;
} {
  let held: { readonly profileId: string; readonly to: ArrivedPlace } | null = null;
  const listeners = new Set<() => void>();
  return {
    hold(profileId, to) {
      held = { profileId, to };
      for (const l of listeners) l();
    },
    take(profileId) {
      const h = held;
      held = null;
      return h !== null && h.profileId === profileId ? h.to : null;
    },
    onHeld(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** The app's one holder of an arrived place, between the connection layer and the shell's screen. */
export const switchPlaces = placeHolder();

/**
 * THIS APP'S LIVE PAIRINGS, BY THEIR DIGESTS, written for its switch provider (Android) to answer the sibling from:
 * at the launch and at each change of its pairings. An empty list says this app holds none. False where nothing was
 * written (no provider on this system, a store that cannot be read).
 */
export async function notePairings(
  native: SwitchNative | null, env: Pick<PairingEnv, "profiles">, sha256: Sha256Base64,
): Promise<boolean> {
  if (native === null || native.notePairings === undefined) return false;
  try {
    const live = await livePairings(env);
    const digests = await Promise.all(live.map((p) => pairingDigest(sha256, p.origin, p.accountId)));
    return await native.notePairings([...new Set(digests)]);
  } catch {
    return false;
  }
}

/** A verifier as RFC 7636 shapes it, which the server's redeem holds it to as well. */
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
/** A digest as the switch carries it: 32 bytes, base64url, no padding. */
const DIGEST = /^[A-Za-z0-9_-]{43}$/;

/** Take up the one arrival native holds, if any. Never throws. */
export async function takeUpArrival(deps: ReceiveDeps): Promise<Received> {
  const payload = readPayload(await deps.native.takeArrival().catch(() => null));
  if (payload === null) return "nothing";
  if (payload.k === "ask") return grant(deps, payload.c).catch((): Received => "refused");
  if (payload.k === "done") return handoff(deps, { c: payload.c, l: payload.l, d: null, p: null }).catch((): Received => "refused");
  const held = await livePairings(deps.env).catch(() => null);
  // A store that cannot be read counts as holding a pairing: nothing is taken on a maybe.
  if (held === null || held.length > 0) {
    const step = stepArrival(payload, { k: "live", digest: await deps.liveDigest().catch(() => null) }, deps.from);
    if (step.act !== "go") return "stayed";
    deps.place(step.to);
    return "place";
  }
  if (payload.c !== undefined && payload.l !== undefined && payload.d !== undefined) {
    return handoff(deps, { c: payload.c, l: payload.l, d: payload.d, p: payload.p }).catch((): Received => "refused");
  }
  // The iPhone asks back once for a code, and only for a sender that named its pairing.
  if (deps.native.askBack === undefined || payload.d === undefined || decodePlace(payload.p, deps.from) === null) return "stayed";
  return (await deps.native.askBack(payload.d, payload.p).catch(() => false)) ? "asked" : "stayed";
}

/** This app pressed, and the sibling asks for a code: the session in front mints one for that challenge alone. */
async function grant(deps: ReceiveDeps, challenge: string): Promise<Received> {
  const mint = deps.minter();
  if (deps.native.answer === undefined || mint === undefined) return "stayed";
  const link = await mint(challenge).catch(() => null);
  if (link === null) return "refused";
  return (await deps.native.answer(challenge, link).catch(() => false)) ? "granted" : "refused";
}

/**
 * Spend the sibling's code for this app's own pending challenge, as one transition of the connection. The digest and
 * the place come with the code on Android, and from what native kept with the ask on the iPhone.
 */
function handoff(deps: ReceiveDeps, h: { c: string; l: string; d: string | null; p: string | null }): Promise<Received> {
  return deps.transition(async (stillCurrent): Promise<Received> => {
    // Read again inside the transition: a pairing made meanwhile drops the code.
    if ((await livePairings(deps.env).catch(() => null))?.length !== 0) return "stayed";
    const held = await (deps.native.takeVerifier?.(h.c) ?? Promise.resolve(null)).catch(() => null);
    const verifier = held?.verifier;
    const d = h.d ?? held?.d;
    const p = h.p ?? held?.p;
    if (typeof verifier !== "string" || !VERIFIER.test(verifier) || typeof d !== "string" || !DIGEST.test(d)) return "refused";
    if ((await challengeOf(deps.sha256, verifier).catch(() => null)) !== h.c) return "refused";
    const link = parsePairLink(h.l);
    if (link === null) return "refused";
    const probed = await probePairing(deps.env, { origin: link.origin, pin: link.pin });
    if (probed.kind === "refused") return "refused";
    const outcome = await pairByHandoff(deps.env, { admission: probed.admission, token: link.token, verifier }, deps.surface);
    if (outcome.kind === "refused") return "refused";
    const { profile } = outcome.session;
    const named = (await pairingDigest(deps.sha256, profile.origin, profile.accountId).catch(() => null)) === d;
    if (!named || !stillCurrent()) {
      const closed = outcome.kind === "paired" ? Promise.resolve().then(() => outcome.session.store.close()) : Promise.resolve();
      if (named) {
        await closed.catch(() => undefined);
        return "superseded";
      }
      await forgetProfile(deps.env, profile.id, { closed: closed.catch(() => undefined) }).catch(() => undefined);
      return "dropped";
    }
    deps.adopt(outcome);
    const place = decodePlace(p, deps.from);
    if (place !== null && place.to !== "last") deps.place(place);
    return "signedIn";
  });
}
