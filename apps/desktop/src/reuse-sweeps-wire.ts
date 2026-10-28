/**
 * OK ON THE REUSE SWEEPS, from this window: the engine relays `POST /auth/reuse-sweeps/ack` to the
 * account's server, managed or self-hosted, so a browser and this window agree it has been seen.
 */
import { bridgeFetch } from "./bridge-fetch.js";

/** MUST REJECT on failure: the strip reads a resolved promise as acknowledged and stays away. */
export async function reuseSweepsOverBridge(ids: string[]): Promise<void> {
  const res = await bridgeFetch("/auth/reuse-sweeps/ack", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw Object.assign(new Error(`${res.status}`), { status: res.status });
}
