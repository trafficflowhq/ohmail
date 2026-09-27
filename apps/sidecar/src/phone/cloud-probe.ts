/**
 * THE PAIRING CHECK, NOT IN THIS BUILD — substituted for `../cloud-probe.js`.
 *
 * On a desktop the engine answers `POST /cloud/probe` by dialling another computer with a pinned
 * TLS handshake. A phone pairs through its own flow and no door here asks its engine that
 * question, so the dialling code stays out of the artifact and the route refuses by name. The
 * module still LOADS at boot (`engine.ts` imports the binding), so this is a value, not a throw.
 */
import type { CloudProbeDoor } from "../cloud-probe.js";

export const CLOUD_PROBE_ROUTE = "/cloud/probe";

export async function answerCloudProbe(_req: Request, _door: CloudProbeDoor): Promise<Response> {
  return new Response(
    JSON.stringify({
      error: { code: "not_found", message: "this build does not check other computers" },
    }),
    { status: 404, headers: { "content-type": "application/json" } },
  );
}
