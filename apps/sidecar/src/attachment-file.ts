import { createHash } from "node:crypto";
import { open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { ATTACHMENT_MAX_FETCH_BYTES, ServiceError } from "@trafficflow/services/mail";

/**
 * THE DESKTOP'S SAVE, WRITTEN BY THE ENGINE. The shell mints a staging path in its own `opened/`
 * directory, names it (base64 of its UTF-8, so any profile name crosses the header) in
 * {@link ATTACHMENT_FILE_TARGET_HEADER}, and moves the file to Downloads. The window never holds
 * the bytes. The shell drops this header from every window request (`engine.rs#window_headers`);
 * the opener below creates only a new `<32 hex>.part` directly in the staging directory the shell
 * named at spawn (`OHMAIL_ATTACHMENT_STAGING_DIR`), compared by real path.
 */
export const ATTACHMENT_FILE_TARGET_HEADER = "x-ohmail-file-target";

/** The route the shell asks, `POST /attachments/:id/file`; the id in group 1. */
export const ATTACHMENT_FILE_ROUTE = /^\/attachments\/([^/]+)\/file$/;

const TARGET_NAME = /^[0-9a-f]{32}\.part$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** A staging file: the sink a save writes through, then `done` or `discard`. */
export interface AttachmentFile {
  write(chunk: Uint8Array): Promise<void>;
  reset(): Promise<void>;
  done(): Promise<void>;
  discard(): Promise<void>;
}

const refuse = (why: string): ServiceError => new ServiceError("validation_failed", 400, why);

/** The target the header names, decoded, or a refusal. */
function targetOf(req: Request): string {
  const raw = req.headers.get(ATTACHMENT_FILE_TARGET_HEADER) ?? "";
  if (!BASE64.test(raw)) throw refuse("this request names no file this engine may write");
  const target = Buffer.from(raw, "base64").toString("utf8");
  if (Buffer.from(target, "utf8").toString("base64") !== raw) throw refuse("this request names no file this engine may write");
  return target;
}

/** Open the file the request names, created new (`wx`, 0600) in `stagingDir` alone, or refuse with a 400. */
export async function openAttachmentFile(req: Request, stagingDir: string | undefined): Promise<AttachmentFile> {
  if (!stagingDir) throw refuse("this engine was given no folder to save attachments into");
  const target = targetOf(req);
  // By name first: no relative, `..`, UNC or device path, and the one name shape the shell mints.
  const lexical = !isAbsolute(target) || /^[\\/]{2}/.test(target) || target.split(/[\\/]/).includes("..")
    || !TARGET_NAME.test(basename(target));
  if (lexical) throw refuse("this request names no file this engine may write");
  // Then by what is on disk: the parent's real path is the staging directory's, symlinks resolved.
  const [dir, want] = await Promise.all([realpath(dirname(target)).catch(() => null), realpath(stagingDir).catch(() => null)]);
  if (dir === null || want === null || dir !== want) throw refuse("this request names no file this engine may write");
  const path = join(dir, basename(target));
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "wx", 0o600);
  } catch {
    throw refuse("the file this save names could not be made");
  }
  let at = 0;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await handle.close();
  };
  return {
    write: async (chunk) => {
      let off = 0;
      while (off < chunk.byteLength) {
        const { bytesWritten } = await handle.write(chunk, off, chunk.byteLength - off, at);
        off += bytesWritten;
        at += bytesWritten;
      }
    },
    reset: async () => {
      await handle.truncate(0);
      at = 0;
    },
    done: async () => {
      await handle.sync();
      await close();
    },
    discard: async () => {
      await close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
    },
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * The same save on the hosted door: the account's `GET /attachments/:id` (verified there by its
 * part gate) is relayed and its body streamed into the file under the same ceiling. A refusal
 * from the account is answered as it came; nothing of it is written.
 */
export async function relayAttachmentToFile(
  req: Request, attachmentId: string, forward: (req: Request) => Promise<Response>, stagingDir: string | undefined,
): Promise<Response> {
  let file: AttachmentFile;
  try {
    file = await openAttachmentFile(req, stagingDir);
  } catch (err) {
    if (err instanceof ServiceError) return json({ error: { code: err.code, message: err.message } }, err.httpStatus);
    throw err;
  }
  const url = new URL(req.url);
  url.pathname = `/attachments/${attachmentId}`;
  url.search = "";
  const headers = new Headers(req.headers);
  headers.delete(ATTACHMENT_FILE_TARGET_HEADER);
  let res: Response;
  try {
    res = await forward(new Request(url, { method: "GET", headers }));
  } catch (err) {
    await file.discard();
    throw err;
  }
  if (!res.ok || res.body === null) {
    await file.discard();
    return res;
  }
  const hash = createHash("sha256");
  let bytes = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > ATTACHMENT_MAX_FETCH_BYTES) {
        await reader.cancel().catch(() => undefined);
        await file.discard();
        return json({
          error: {
            code: "payload_too_large", retryable: false,
            message: `this attachment is larger than the ${Math.round(ATTACHMENT_MAX_FETCH_BYTES / 1048576)} MiB limit for a single download`,
          },
        }, 413);
      }
      hash.update(value);
      await file.write(value);
    }
    await file.done();
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    await file.discard();
    throw err;
  }
  return json({
    contentType: res.headers.get("content-type") ?? "application/octet-stream",
    bytes, sha256: hash.digest("hex"),
  });
}
