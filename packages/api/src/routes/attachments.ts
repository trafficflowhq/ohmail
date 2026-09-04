import { ServiceError, type DownloadAllInput } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { jsonResponse, errorResponse } from "../responses.js";
import { makeOpenAdapter } from "../attachments-adapter.js";
import type { Route } from "../router.js";
import { attachments, readBody } from "./shared.js";

/**
 * §5.14 — attachments & files. Metadata lives server-side; the BLOB bytes do NOT —
 * `GET /attachments/:id` and the two `download-all` routes fetch bytes ON-DEMAND
 * from IMAP and stream them straight back (never persisted, §13.2/§14).
 *
 * The byte/zip routes are RAW (reduced pipeline — still session-gated): they return
 * `application/octet-stream` / `application/zip`, not the JSON envelope, so they map
 * their own ServiceErrors to the error envelope (`GET /img` in `privacy.ts` is raw
 * for the same reason and does the same). `download-all` is
 * implemented SYNCHRONOUSLY (the zip is assembled from IMAP and returned in the
 * response) rather than the async job model, so `GET /downloads/:jobId` is omitted.
 */

/** Copy a view's bytes into a standalone ArrayBuffer so the body is a plain BodyInit. */
function toBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** RFC 5987-safe Content-Disposition for an attachment filename. */
function contentDisposition(filename: string | null): string {
  const name = filename ?? "attachment";
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(name);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export const attachmentRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/messages/:id/attachments",
    cost: "read",
    handler: async (req, deps, params) => {
      const items = await attachments(deps).listForMessage(serviceContext(deps, req), params.id!);
      return jsonResponse({ items });
    },
  },
  {
    method: "GET",
    pattern: "/attachments/:id/meta",
    cost: "read",
    handler: async (req, deps, params) => {
      const dto = await attachments(deps).getMeta(serviceContext(deps, req), params.id!);
      return jsonResponse(dto);
    },
  },
  {
    method: "GET",
    pattern: "/attachments/:id",
    // `connection`: it opens IMAP against the user's own server and streams the bytes
    // back. All three byte routes in this file are `raw`, and `raw` used to mean OUTSIDE the
    // verification gate entirely (RAW_PIPELINE omitted it), so the three costliest reads in
    // the product could not have been gated even by marking them one at a time.
    cost: "connection",
    options: { raw: true },   // streams the blob fetched live from IMAP (reduced pipeline; still session-gated)
    handler: async (req, deps, params) => {
      try {
        const { contentType, filename, body } = await attachments(deps).fetchBytes(
          serviceContext(deps, req), params.id!, { openAdapter: makeOpenAdapter(deps) },
        );
        return new Response(toBody(body), {
          status: 200,
          headers: {
            "Content-Type": contentType,
            "Content-Length": String(body.byteLength),
            "Content-Disposition": contentDisposition(filename),
            // These bytes and `contentType` are SENDER-CHOSEN, so this is the one
            // API surface where sniffing could matter. The disposition is always
            // `attachment` (never `inline`), which is what closes the render vector;
            // `nosniff` is the belt to that braces.
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=3600",
          },
        });
      } catch (err) {
        if (err instanceof ServiceError) return errorResponse(err.code, err.httpStatus, err.message, err.details);
        /**
         * ── "UPSTREAM" IS A CLAIM ABOUT THE USER'S MAIL SERVER, AND THIS ARM CANNOT KNOW IT ───
         *
         * A non-`ServiceError` reaching here is not evidence of anything upstream. It is an
         * unclassified throw, and the most likely author of one is this process. Until 2026-09-04
         * the commonest cause was a malformed `:id`: the segment reached a `uuid` column, Postgres
         * answered 22P02, and this line reported it as `502 upstream_unavailable` — telling the
         * operator that somebody's IMAP server was unreachable when the truth was an unvalidated
         * path parameter. `createApp.handle` now refuses that shape with a 400 before the route
         * runs, so the 22P02 case is gone; the MISLABEL is not, and it will name the next
         * programming fault the same wrong way.
         *
         * Deliberately left as-is in this slice rather than fixed in passing: separating a genuine
         * IMAP failure from an internal fault means classifying what the open path can throw, which
         * is its own change with its own tests. Recorded as a gap so the wording does not read as
         * settled. The comment is the correction until then.
         */
        return errorResponse("upstream_unavailable", 502, "attachment fetch failed");
      }
    },
  },
  {
    method: "POST",
    pattern: "/messages/:id/attachments/download-all",
    cost: "connection",
    options: { raw: true },   // returns a zip assembled synchronously from IMAP
    handler: async (req, deps, params) => {
      try {
        const { zip, filename } = await attachments(deps).downloadAll(
          serviceContext(deps, req), { messageId: params.id! }, { openAdapter: makeOpenAdapter(deps) },
        );
        return new Response(toBody(zip), {
          status: 200,
          headers: {
            "Content-Type": "application/zip",
            "Content-Length": String(zip.byteLength),
            "Content-Disposition": contentDisposition(filename),
            // These bytes and `contentType` are SENDER-CHOSEN, so this is the one
            // API surface where sniffing could matter. The disposition is always
            // `attachment` (never `inline`), which is what closes the render vector;
            // `nosniff` is the belt to that braces.
            "X-Content-Type-Options": "nosniff",
          },
        });
      } catch (err) {
        if (err instanceof ServiceError) return errorResponse(err.code, err.httpStatus, err.message, err.details);
        return errorResponse("upstream_unavailable", 502, "download-all failed");
      }
    },
  },
  {
    method: "GET",
    pattern: "/files",
    cost: "read",
    handler: async (req, deps) => {
      const url = new URL(req.url);
      const typeParam = url.searchParams.get("type");
      const page = await attachments(deps).listFiles(serviceContext(deps, req), {
        type: typeParam === "big" || typeParam === "all" ? typeParam : undefined,
        q: url.searchParams.get("q") ?? undefined,
        cursor: url.searchParams.get("cursor") ?? undefined,
        limit: url.searchParams.get("limit") != null ? Number(url.searchParams.get("limit")) : undefined,
      });
      return jsonResponse({ items: page.items, nextCursor: page.nextCursor });
    },
  },
  {
    method: "POST",
    pattern: "/files/download-all",
    cost: "connection",
    options: { raw: true },   // returns a zip of the filtered/selected set
    handler: async (req, deps) => {
      try {
        const body = await readBody<DownloadAllInput>(req);
        const { zip, filename } = await attachments(deps).downloadAll(
          serviceContext(deps, req),
          { fileIds: body.fileIds, filter: body.filter },
          { openAdapter: makeOpenAdapter(deps) },
        );
        return new Response(toBody(zip), {
          status: 200,
          headers: {
            "Content-Type": "application/zip",
            "Content-Length": String(zip.byteLength),
            "Content-Disposition": contentDisposition(filename),
            // These bytes and `contentType` are SENDER-CHOSEN, so this is the one
            // API surface where sniffing could matter. The disposition is always
            // `attachment` (never `inline`), which is what closes the render vector;
            // `nosniff` is the belt to that braces.
            "X-Content-Type-Options": "nosniff",
          },
        });
      } catch (err) {
        if (err instanceof ServiceError) return errorResponse(err.code, err.httpStatus, err.message, err.details);
        return errorResponse("upstream_unavailable", 502, "download-all failed");
      }
    },
  },
];
