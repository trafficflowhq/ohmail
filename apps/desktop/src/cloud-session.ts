import type { HostConnection } from "../../webapp/app/shell/host-connection";
import { bridgeFetch } from "./bridge-fetch.js";
import { DOOR_COPY, machineWord } from "./door-copy.js";

/**
 * WHERE THE HOSTED SESSION STANDS, as the window reads it — `/health.session` from the engine
 * (`apps/sidecar/src/cloud-auth.ts`). One reading for the three things the window does with it:
 * the sign-in dialog's first sentence, the rail's notice while Cloud is not answering, and the
 * Settings note. The VERDICT is not here: the dialog opens on `sessionExpired` alone, which the
 * engine derives from a coded refusal and nothing else.
 */

export interface CloudSessionWire {
  state: "live" | "renewing" | "unreachable" | "refused" | "seal_failed";
  code: string | null;
  since: string;
}

const STATES = new Set(["live", "renewing", "unreachable", "refused", "seal_failed"]);

/** The reading off a `/health` body, or null — an older engine sends none, and none is not a fault. */
export function sessionOf(value: unknown): CloudSessionWire | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as { state?: unknown; code?: unknown; since?: unknown };
  if (typeof v.state !== "string" || !STATES.has(v.state) || typeof v.since !== "string") return null;
  return { state: v.state as CloudSessionWire["state"], code: typeof v.code === "string" ? v.code : null, since: v.since };
}

/** Why the dialog is open, when the engine knows — or null, and the ordinary lead is said. */
export type SignInCause = "revoked" | "expired" | "seal" | null;

export function signInCauseOf(session: CloudSessionWire | null): SignInCause {
  if (session?.state === "refused" && session.code === "refresh_revoked") return "revoked";
  if (session?.state === "refused" && session.code === "refresh_expired") return "expired";
  if (session?.state === "seal_failed" && session.code === "seal_unreadable") return "seal";
  return null;
}

/** The dialog's first sentence for a cause. */
export function signInLead(cause: SignInCause): string {
  const machine = machineWord();
  if (cause === "revoked") return DOOR_COPY.cloudLeadRevoked(machine);
  if (cause === "expired") return DOOR_COPY.cloudLeadExpired(machine);
  if (cause === "seal") return DOOR_COPY.cloudLeadSealFailed(machine);
  return DOOR_COPY.cloudLeadSignIn(machine);
}

/**
 * How long a fault stays silent. The engine retries within a second or two, so a notice at the
 * first failed renewal would announce, on every brief blip, an outage about to not happen.
 */
export const CLOUD_NOTICE_GRACE_MS = 20_000;

/** Has a fault gone on long enough to say so? The probe asks this, so the gate repaints only on a flip. */
export function cloudNoticeDue(session: CloudSessionWire | null, nowMs: number): boolean {
  if (session === null || cloudSessionNotice(session) === undefined) return false;
  const since = Date.parse(session.since);
  return Number.isFinite(since) && nowMs - since >= CLOUD_NOTICE_GRACE_MS;
}

/** The rail's line for a session that is not answering, or `undefined` when there is nothing to say. */
export function cloudSessionNotice(session: CloudSessionWire | null): HostConnection | undefined {
  if (session?.state === "renewing" || session?.state === "unreachable") {
    return { state: "unknown", words: { title: DOOR_COPY.cloudUnreachableTitle, detail: DOOR_COPY.cloudUnreachableWhy, link: null } };
  }
  if (session?.state === "seal_failed" && session.code === "seal_write_failed") {
    return {
      state: "unknown",
      words: {
        title: DOOR_COPY.cloudSealPausedTitle(machineWord()),
        detail: DOOR_COPY.cloudSealPausedWhy,
        link: { href: "#/settings/desktop", label: DOOR_COPY.hostFootSettings },
      },
    };
  }
  return undefined;
}

/** Settings' Try again: renew now rather than on the engine's own clock. Null when it could not ask. */
export async function renewCloudSession(): Promise<CloudSessionWire | null> {
  try {
    const res = await bridgeFetch("/cloud/session/renew", { method: "POST" });
    if (!res.ok) return null;
    return sessionOf(((await res.json()) as { session?: unknown }).session);
  } catch {
    return null;
  }
}
