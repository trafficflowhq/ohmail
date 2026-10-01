import { type AttachmentAdapter, type DownloadAllInput, type OpenAdapter } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import { makeOpenAdapter } from "../attachments-adapter.js";
import { mailServerRefusal } from "../mail-server-refusal.js";
import { withErrorEnvelope, type Middleware } from "../middleware.js";
import type { Route } from "../router.js";
import { attachments, readBody } from "./shared.js";
import { pagingNumber } from "../query-bounds.js";

/**
 * Attachments & files. Metadata lives server-side; the blob bytes do not — `GET /attachments/:id`
 * and the two `download-all` routes fetch bytes on demand from IMAP and stream them straight
 * back, never persisted. The byte/zip routes are raw (reduced pipeline — still session-gated):
 * a success is `application/octet-stream` / `application/zip`, a failure the JSON envelope.
 * `download-all` is synchronous — the zip is assembled from IMAP and returned in the response —
 * so `GET /downloads/:jobId` is omitted.
 */

/**
 * EVERY REFUSAL OF A BYTE ROUTE STATES WHETHER ASKING AGAIN CAN HELP. A source that knows says so
 * (`mailbox_busy`, the 424s); an answer that says nothing gets the status reading every shipped
 * client applies (`retryable ?? (5xx || 429)`), written down — except our own unnamed `internal`,
 * which states `false`: asking again repeats the fault, another mailbox slot and another fault row.
 * The reader keeps that refusal for the tab (`shell/attachments.ts` keeps a non-retryable failure);
 * a reload asks again. Byte routes only: on the other routes one transient 500 must not drop a
 * queued change.
 */
const withStatedRetry: Middleware = (next) => async (req, deps, params) => {
  const res = await next(req, deps, params);
  if (res.ok || !(res.headers.get("Content-Type") ?? "").startsWith("application/json")) return res;
  const body = await res.clone().json().catch(() => null) as { error?: { code?: unknown; retryable?: unknown } } | null;
  if (!body?.error || typeof body.error.retryable === "boolean") return res;
  body.error.retryable = body.error.code === "internal" ? false : res.status >= 500 || res.status === 429;
  return jsonResponse(body, { status: res.status, headers: Object.fromEntries(res.headers) });
};

/**
 * The byte routes carry the envelope FULL routes have: a `ServiceError` keeps its status, code and
 * `retryable`, and an unnamed throw is the 500 `internal` with `request_unhandled` and a fault row
 * — never a 502 blaming the person's mail server for a fault of ours.
 */
const BYTE_ROUTE_MIDDLEWARE: readonly Middleware[] = [withStatedRetry, withErrorEnvelope];

/**
 * THE ZIP ROUTES' OPENER, THROUGH THE SAME ARM. `downloadAll` writes a failed open or part into
 * `_errors.txt` instead of throwing, so the one-file route's `mailServerRefusal` never saw either
 * and a refused sign-in read "mail server unavailable". The opener and every part read hand the
 * service the typed refusal instead, which it words by its own sentence.
 */
function namedOpener(open: OpenAdapter): OpenAdapter {
  return async (mailboxId) => {
    let adapter: AttachmentAdapter;
    try {
      adapter = await open(mailboxId);
    } catch (err) {
      throw mailServerRefusal(err) ?? err;
    }
    return {
      fetchPart: async (locator, partId, o) => {
        try {
          return await adapter.fetchPart(locator, partId, o);
        } catch (err) {
          throw mailServerRefusal(err) ?? err;
        }
      },
      // Forwarded, or the zip routes' repair would run in service tests and never through here.
      ...(adapter.fetchStructure ? {
        fetchStructure: async (locator: Parameters<NonNullable<AttachmentAdapter["fetchStructure"]>>[0]) => {
          try {
            return await adapter.fetchStructure!(locator);
          } catch (err) {
            throw mailServerRefusal(err) ?? err;
          }
        },
      } : {}),
      close: () => adapter.close(),
    };
  };
}

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
    relay: true,
    cost: "read",
    handler: async (req, deps, params) => {
      const items = await attachments(deps).listForMessage(serviceContext(deps, req), params.id!);
      return jsonResponse({ items });
    },
  },
  {
    method: "GET",
    pattern: "/attachments/:id/meta",
    relay: true,
    cost: "read",
    handler: async (req, deps, params) => {
      const dto = await attachments(deps).getMeta(serviceContext(deps, req), params.id!);
      return jsonResponse(dto);
    },
  },
  {
    method: "GET",
    pattern: "/attachments/:id",
    relay: true,
    // `connection`: it opens IMAP against the user's own server and streams the bytes
    // back. All three byte routes in this file are `raw`, and `raw` used to mean OUTSIDE the
    // verification gate entirely (RAW_PIPELINE omitted it), so the three costliest reads in
    // the product could not have been gated even by marking them one at a time.
    cost: "connection",
    options: { raw: true, middleware: BYTE_ROUTE_MIDDLEWARE },   // streams the blob fetched live from IMAP
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
        // What the person's mail server did is its typed 424; everything else is the envelope's.
        throw mailServerRefusal(err) ?? err;
      }
    },
  },
  {
    method: "POST",
    pattern: "/messages/:id/attachments/download-all",
    relay: true,
    cost: "connection",
    options: { raw: true, middleware: BYTE_ROUTE_MIDDLEWARE },   // a zip assembled synchronously from IMAP
    handler: async (req, deps, params) => {
      try {
        const { zip, filename } = await attachments(deps).downloadAll(
          serviceContext(deps, req), { messageId: params.id! }, { openAdapter: namedOpener(makeOpenAdapter(deps)) },
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
        // A refused open or part is an `_errors.txt` line inside the archive (`namedOpener`), so
        // what reaches here is mostly ours; the same arm keeps the three doors one reading.
        throw mailServerRefusal(err) ?? err;
      }
    },
  },
  {
    method: "GET",
    pattern: "/files",
    relay: true,
    cost: "read",
    handler: async (req, deps) => {
      const url = new URL(req.url);
      const typeParam = url.searchParams.get("type");
      const page = await attachments(deps).listFiles(serviceContext(deps, req), {
        type: typeParam === "big" || typeParam === "all" ? typeParam : undefined,
        q: url.searchParams.get("q") ?? undefined,
        cursor: url.searchParams.get("cursor") ?? undefined,
        limit: pagingNumber(url.searchParams.get("limit")),
      });
      return jsonResponse({ items: page.items, nextCursor: page.nextCursor });
    },
  },
  {
    method: "POST",
    pattern: "/files/download-all",
    relay: true,
    cost: "connection",
    options: { raw: true, middleware: BYTE_ROUTE_MIDDLEWARE },   // a zip of the filtered/selected set
    handler: async (req, deps) => {
      try {
        const body = await readBody<DownloadAllInput>(req);
        const { zip, filename } = await attachments(deps).downloadAll(
          serviceContext(deps, req),
          { fileIds: body.fileIds, filter: body.filter },
          { openAdapter: namedOpener(makeOpenAdapter(deps)) },
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
        // A refused open or part is an `_errors.txt` line inside the archive (`namedOpener`), so
        // what reaches here is mostly ours; the same arm keeps the three doors one reading.
        throw mailServerRefusal(err) ?? err;
      }
    },
  },
];
