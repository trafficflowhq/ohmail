import { handleApiRequest } from "../../src/handler.js";

/**
 * The whole HTTP surface of `apps/api-vercel`: one optional catch-all that hands the NATIVE
 * `Request` to `createApp(apiRoutes)`. There is no other route file, no page, and no
 * per-endpoint Next code — `packages/api` owns routing, so adding an endpoint there needs
 * no change here.
 *
 * The four module options are all load-bearing:
 *
 *  • `runtime = "nodejs"` — NOT edge. The API opens raw TCP to IMAP :993 and SMTP :587 for
 *    on-demand attachment fetch and gated send: the edge
 *    runtime has no `node:net`, so this would fail at the first attachment, not at build.
 *  • `maxDuration = 60` — a cold IMAP LOGIN costs 1–3 s and `download-all` fetches parts
 *    sequentially on one connection; anything less turns a slow provider into a timeout.
 *    `/events` has its own module (`app/events/route.ts`).
 *  • `dynamic = "force-dynamic"` — every response depends on a session cookie or bearer
 *    header. Any static optimisation here would be one account's data served to another.
 *  • `preferredRegion = "fra1"` — in the database's region, so the pooled round trip stays
 *    intra-region, and EU processing stays EU.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const preferredRegion = "fra1";

export async function GET(req: Request): Promise<Response> {
  return handleApiRequest(req);
}
/**
 * HEAD is exported EXPLICITLY even though Next would route it to `GET`, because that implicit
 * mapping is exactly what hid the bug: the inner router reads `req.method`, so a HEAD arriving
 * through the GET function matched `/health` with the wrong method and answered 405. Every
 * uptime monitor that probes with HEAD saw a dead API. `handleApiRequest` performs the RFC 9110
 * mapping itself (dispatch as GET, return no body), and this export is what makes the behaviour
 * a declared part of the surface rather than a framework side effect.
 */
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
/**
 * There is no CORS on this API by design (the browser talks to a same-origin path, and
 * native clients are not browsers). OPTIONS is still routed rather than left to Next so a
 * preflight gets the API's own JSON 405/404 instead of a framework page — the honest answer
 * to "may I call you cross-origin?" being "no".
 */
export async function OPTIONS(req: Request): Promise<Response> {
  return handleApiRequest(req);
}
