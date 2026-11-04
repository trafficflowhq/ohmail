import { handleApiRequest } from "../../src/handler.js";

/**
 * `/events` keeps its own module for `maxDuration` (`TF_SSE_LIFETIME_MS` is checked against it,
 * `host-wiring.test.ts` pins the relation) and request cancellation. On Fluid an instance bills its
 * whole memory for every wall-clock second an invocation is in flight, parked or not, so a held
 * stream is the most expensive answer this host can give: it holds none (`holds: false`, 204) and
 * clients poll `GET /sync`. The self-hosted server, which pays nothing per stream, still holds them.
 *
 * Everything else is the catch-all's contract verbatim: same handler, same runtime, same region,
 * every method exported so a non-GET `/events` still gets the API's own JSON 405.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export const preferredRegion = "fra1";

export async function GET(req: Request): Promise<Response> {
  return handleApiRequest(req);
}
export async function HEAD(req: Request): Promise<Response> {
  return handleApiRequest(req);
}
export async function POST(req: Request): Promise<Response> {
  return handleApiRequest(req);
}
export async function PUT(req: Request): Promise<Response> {
  return handleApiRequest(req);
}
export async function PATCH(req: Request): Promise<Response> {
  return handleApiRequest(req);
}
export async function DELETE(req: Request): Promise<Response> {
  return handleApiRequest(req);
}
export async function OPTIONS(req: Request): Promise<Response> {
  return handleApiRequest(req);
}
