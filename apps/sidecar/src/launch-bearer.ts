import { timingSafeEqual } from "node:crypto";
import { hashToken, resolveSession, type ResolvedSessionCore } from "@trafficflow/services/mail";
import type { LocalDb } from "./db.js";
import { mintLaunchSession, type LocalWorld } from "./identity.js";

/**
 * THIS PROCESS'S LAUNCH BEARER, DECIDED IN MEMORY BY THE ONE WRITER THAT OWNS IT.
 *
 * The Cloud door mints one bearer per launch and nothing else in the process writes its row: the
 * next launch's mint revokes it, after this process has let go of the store's lock. So the store's
 * answer is read once at the mint and held, refused past the row's own expiry and from `end()` on,
 * with no store read either way; a request carrying it no longer queues behind a mirror page. Any
 * other token is not this holder's to answer, and the store decides it as before.
 */
export type BearerDecision = { held: ResolvedSessionCore } | "refused" | "unknown";

export interface LaunchBearer {
  /** The bearer itself. In memory only — the database holds its hash. */
  readonly token: string;
  readonly sessionId: string;
  decide(token: string, now: Date): BearerDecision;
  /** The store this decision was read from is closing: every later request is refused. */
  end(): void;
}

export async function mintLaunchBearer(db: LocalDb, world: LocalWorld, now: Date): Promise<LaunchBearer> {
  const session = await mintLaunchSession(db, world, now);
  // The held answer IS the store's answer, read once. A fresh mint that does not resolve is a store
  // that cannot admit its own window, and the launch says so rather than refusing every request.
  const core = await resolveSession(db, session.token, now);
  if (core === null) throw new Error("the launch bearer this process minted does not resolve in its own store");
  const hash = Buffer.from(hashToken(session.token));
  let ended = false;
  return {
    token: session.token,
    sessionId: session.sessionId,
    decide(token: string, at: Date): BearerDecision {
      const presented = Buffer.from(hashToken(token));
      if (presented.length !== hash.length || !timingSafeEqual(presented, hash)) return "unknown";
      if (ended || at.getTime() >= session.expiresAt.getTime()) return "refused";
      return { held: core };
    },
    end(): void {
      ended = true;
    },
  };
}
