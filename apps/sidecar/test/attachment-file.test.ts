import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ATTACHMENT_MAX_FETCH_BYTES } from "@trafficflow/services/mail";
import { ATTACHMENT_FILE_TARGET_HEADER, relayAttachmentToFile } from "../src/attachment-file.js";

/**
 * THE HOSTED DOOR'S SAVE: the account's `GET /attachments/:id` streamed into the file the shell
 * named. Driven against a stand-in for the relay: a 200 lands byte for byte with its size and sha
 * answered, the account's refusal is handed back as it came with nothing left on disk, a body past
 * the ceiling is refused mid-stream, and the target header never travels to the account.
 */

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** The staging folder, under a Cyrillic profile name as on a Windows account. */
let STAGING = "";
function target(): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-relay-file-"));
  dirs.push(root);
  STAGING = join(root, "Дмитрий", "opened");
  mkdirSync(STAGING, { recursive: true });
  return join(STAGING, `${randomBytes(16).toString("hex")}.part`);
}

const ID = "0b5e8d3c-1f2a-4c3b-9d8e-7f6a5b4c3d2e";
const ask = (path: string): Request => new Request(`http://sidecar/attachments/${ID}/file`, {
  method: "POST", headers: { [ATTACHMENT_FILE_TARGET_HEADER]: Buffer.from(path, "utf8").toString("base64") },
});

/** A body delivered in 64 KiB chunks, as a relayed response arrives. */
function chunked(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(c) {
      if (at >= bytes.byteLength) { c.close(); return; }
      c.enqueue(bytes.subarray(at, at + 65536));
      at += 65536;
    },
  });
}

describe("relayAttachmentToFile", () => {
  it("writes the account's bytes into the named file and answers their size and sha", async () => {
    const path = target();
    const bytes = randomBytes(3 * 1024 * 1024);
    const seen: Request[] = [];
    const res = await relayAttachmentToFile(ask(path), ID, async (req) => {
      seen.push(req);
      return new Response(chunked(bytes), { status: 200, headers: { "content-type": "video/mp4" } });
    }, STAGING);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      contentType: "video/mp4", bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(readFileSync(path).equals(bytes)).toBe(true);
    expect(seen[0]!.method).toBe("GET");
    expect(new URL(seen[0]!.url).pathname).toBe(`/attachments/${ID}`);
    expect(seen[0]!.headers.get(ATTACHMENT_FILE_TARGET_HEADER)).toBeNull();
  });

  it("hands back the account's refusal and leaves no file", async () => {
    const path = target();
    const refusal = { error: { code: "payload_too_large", message: "over", retryable: false } };
    const res = await relayAttachmentToFile(ask(path), ID, async () =>
      new Response(JSON.stringify(refusal), { status: 413, headers: { "content-type": "application/json" } }), STAGING);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual(refusal);
    expect(existsSync(path)).toBe(false);
  });

  it("refuses a body past the ceiling mid-stream and leaves no file", async () => {
    const path = target();
    const res = await relayAttachmentToFile(ask(path), ID, async () =>
      new Response(chunked(new Uint8Array(ATTACHMENT_MAX_FETCH_BYTES + 1)), { status: 200 }), STAGING);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("payload_too_large");
    expect(existsSync(path)).toBe(false);
  });

  it("refuses a target of any other shape before asking the account", async () => {
    let asked = false;
    target();
    const res = await relayAttachmentToFile(ask(join(tmpdir(), "notes.txt")), ID, async () => { asked = true; return new Response("x"); }, STAGING);
    expect(res.status).toBe(400);
    expect(asked).toBe(false);
  });
});
