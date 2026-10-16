import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import { AwsClient } from "aws4fetch";
import {
  makeS3StagingStorage, reconcileStagingOrphans, sweepExpiredStaging, stagingObjectPath,
  type S3StagingStorageConfig, type StagedObjectListing,
} from "../src/attachment-staging.js";

/**
 * ═══ THE LIVE RustFS ROUND TRIP — the wire the unit suite cannot decide ══════════════════════
 *
 * `attachment-staging-s3.test.ts` proves the SIGNATURE against an independent SigV4
 * implementation; this file proves the signature against a real object-store SERVER, which is
 * the only judge that counts. It drives the exact sequence a deployment lives:
 * sign → the CLIENT's PUT against the presigned URL (grant headers verbatim, our credential
 * nowhere in the request) → download → remove → remove-again-is-success. Presigning is local
 * key derivation, so a drifted canonical form is invisible until a server refuses it — that is
 * why this suite exists and why the compose carries RustFS (`docker compose up -d rustfs`, :3902).
 *
 * Same gating pattern as `realPgAvailable`: skipped when RustFS is not listening, and
 * `TF_REQUIRE_RUSTFS=1` turns absence into a hard failure so CI can never green by skipping.
 */

const RUSTFS_URL = process.env.TF_RUSTFS_URL || "http://127.0.0.1:3902";

const CFG: S3StagingStorageConfig = {
  endpoint: RUSTFS_URL,
  region: "us-east-1",
  // The compose's root credential (docker-compose.yml `rustfs` service).
  accessKeyId: "tf-staging",
  secretAccessKey: "tf-staging-password",
  bucket: "staging-live",
};

async function rustfsAvailable(): Promise<boolean> {
  let up = false;
  try {
    // Ready, not merely listening: RustFS answers /health before its storage and IAM are up.
    const res = await fetch(`${RUSTFS_URL}/health/ready`, { signal: AbortSignal.timeout(3000) });
    up = res.ok;
  } catch {
    up = false;
  }
  if (!up && process.env.TF_REQUIRE_RUSTFS === "1") {
    throw new Error(
      `TF_REQUIRE_RUSTFS=1 but no RustFS answers at ${new URL(RUSTFS_URL).host} — ` +
        "start it (docker compose up -d rustfs) or unset the variable. Not optional in CI.",
    );
  }
  return up;
}

const RUSTFS_UP = await rustfsAvailable();

const storage = makeS3StagingStorage(CFG);
/** The test's own signer, for the one call the port deliberately lacks: CreateBucket. */
const admin = new AwsClient({
  accessKeyId: CFG.accessKeyId, secretAccessKey: CFG.secretAccessKey,
  service: "s3", region: CFG.region, retries: 0,
});

beforeAll(async () => {
  if (!RUSTFS_UP) return;
  const res = await fetch(await admin.sign(`${RUSTFS_URL}/${CFG.bucket}`, { method: "PUT" }));
  // 200 created; 409 it already exists from an earlier run. Anything else fails loudly here
  // rather than as forty confusing 404s below.
  if (!res.ok && res.status !== 409) {
    throw new Error(`could not create the RustFS test bucket: ${res.status} ${await res.text()}`);
  }
  await res.arrayBuffer().catch(() => {});
});

describe.skipIf(!RUSTFS_UP)("the presigned round trip, against real RustFS", () => {
  it("sign → client PUT → download → remove → remove again — the whole transport, in the client's shoes", async () => {
    const path = stagingObjectPath(`acc-${randomUUID()}`, randomUUID());
    const bytes = new Uint8Array(64 * 1024).map((_, i) => i % 251);

    // 1. The grant. Path-style, since the endpoint is an IP: the bucket rides in the path and
    //    the host is RustFS itself — the property that makes the signature verifiable at all here.
    const grant = await storage.signUpload(path, "application/octet-stream");
    const url = new URL(grant.uploadUrl);
    expect(url.host).toBe(new URL(RUSTFS_URL).host);
    expect(url.pathname.startsWith(`/${CFG.bucket}/`)).toBe(true);

    // 2. The upload, exactly as a browser or engine would perform it: the grant's method and
    //    headers verbatim, no credential of ours anywhere in the request.
    const put = await fetch(grant.uploadUrl, {
      method: grant.uploadMethod, headers: grant.uploadHeaders, body: bytes,
    });
    expect(put.status, await put.clone().text()).toBe(200);

    // 3. The service-credential read the send path performs.
    expect([...await storage.download(path)]).toEqual([...bytes]);

    // 4. Remove, then remove AGAIN — the sweep's abandoned-upload contract, against the real
    //    server's answer for a key that is already gone.
    await storage.remove([path]);
    await expect(storage.remove([path])).resolves.toBeUndefined();
    await expect(storage.download(path)).rejects.toMatchObject({ status: 404 });
  });

  it("the grant BINDS the content type: a PUT that lies about its type is refused", async () => {
    const path = stagingObjectPath(`acc-${randomUUID()}`, randomUUID());
    const grant = await storage.signUpload(path, "application/pdf");
    const put = await fetch(grant.uploadUrl, {
      method: "PUT",
      headers: { "content-type": "text/html" }, // not what was signed
      body: new Uint8Array([1, 2, 3]),
    });
    expect(put.status).toBe(403);
    await put.arrayBuffer().catch(() => {});
  });

  it("a tampered signature is refused — the grant is not a naming convention", async () => {
    const path = stagingObjectPath(`acc-${randomUUID()}`, randomUUID());
    const grant = await storage.signUpload(path, "application/octet-stream");
    const url = new URL(grant.uploadUrl);
    url.searchParams.set("X-Amz-Signature", "0".repeat(64));
    const put = await fetch(url, {
      method: "PUT", headers: grant.uploadHeaders, body: new Uint8Array([1]),
    });
    expect(put.status).toBe(403);
    await put.arrayBuffer().catch(() => {});
  });

  it("the grant BINDS the Host: presigned for one host, presented under another, refused — the proxy split's other guard", async () => {
    // The self-host browser path presigns against the PUBLIC origin precisely because RustFS
    // recomputes the signature over the Host it RECEIVES. This is the direct proof: take a grant
    // signed for RustFS's own host and present the identical request under a different Host
    // header — the exact wire shape a Host-REWRITING proxy would produce — and the store must
    // refuse it. If this ever passes with 200, the Host-preserved proxy route stops being
    // load-bearing and the public-endpoint split needs re-ruling.
    const path = stagingObjectPath(`acc-${randomUUID()}`, randomUUID());
    const grant = await storage.signUpload(path, "application/octet-stream");
    const url = new URL(grant.uploadUrl);
    const put = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({
        host: url.hostname, port: url.port,
        path: `${url.pathname}${url.search}`, method: "PUT",
        headers: { ...grant.uploadHeaders, host: "somewhere-else.example" },
      }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", reject);
      req.end(new Uint8Array([1, 2, 3]));
    });
    expect(put).toBe(403);
  });

  it("the retention sweep clears real objects AND the abandoned row whose object never existed", async () => {
    const acc = `acc-${randomUUID()}`;
    const real = stagingObjectPath(acc, randomUUID());
    const ghost = stagingObjectPath(acc, randomUUID()); // minted, never uploaded
    const grant = await storage.signUpload(real, "application/octet-stream");
    const put = await fetch(grant.uploadUrl, {
      method: grant.uploadMethod, headers: grant.uploadHeaders, body: new Uint8Array([9, 9]),
    });
    expect(put.status).toBe(200);

    const deletedRows: string[][] = [];
    const gone = await sweepExpiredStaging({
      storage,
      expired: async () => [
        { id: "r1", objectPath: real },
        { id: "r2", objectPath: ghost },
      ],
      deleteRows: async (ids) => { deletedRows.push([...ids]); return ids.length; },
    });
    // BOTH rows clear in one pass: the real object went, and the ghost's absence was success —
    // the trap a 404-is-failure implementation would fail right here, against the real server.
    expect(gone).toBe(2);
    expect(deletedRows).toEqual([["r1", "r2"]]);
    await expect(storage.download(real)).rejects.toMatchObject({ status: 404 });
  });
});

/**
 * ═══ THE SELF-HOST BROWSER PATH: PUBLIC ENDPOINT + HOST-PRESERVING PROXY + PRIVATE BUCKET ═══
 *
 * The compose's browser uploads presign against the PUBLIC origin and ride a Caddy route
 * (`/<bucket>/*` → rustfs, Host PRESERVED) — `deploy/selfhost/proxy/Caddyfile`. This block is that
 * route in miniature, against real RustFS: a ~20-line Node proxy that forwards everything and
 * KEEPS the incoming Host header, which is the one property the signature depends on.
 * The boot smoke proves the same wire through the real Caddy on the real compose; this proves
 * it on every ordinary test run, where the compose is not standing.
 */
describe.skipIf(!RUSTFS_UP)("the public-endpoint split, through a Host-preserving proxy", () => {
  let proxy: Server;
  let proxyOrigin = "";

  beforeAll(async () => {
    const target = new URL(RUSTFS_URL);
    proxy = createServer((req, res) => {
      const up = httpRequest({
        host: target.hostname, port: target.port,
        path: req.url, method: req.method,
        // The load-bearing line: `req.headers` still holds the CLIENT's Host, and it is
        // forwarded untouched — exactly what Caddy's reverse_proxy does by default, and the
        // only reason a signature computed for the public origin verifies at the store.
        headers: req.headers,
      }, (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      });
      up.on("error", () => { res.statusCode = 502; res.end(); });
      req.pipe(up);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const addr = proxy.address();
    proxyOrigin = typeof addr === "object" && addr !== null ? `http://127.0.0.1:${addr.port}` : "";
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });

  it("presign against the public origin → PUT through the proxy → 200; the service reads it back internally", async () => {
    const split = makeS3StagingStorage({ ...CFG, publicEndpoint: proxyOrigin });
    const path = stagingObjectPath(`acc-${randomUUID()}`, randomUUID());
    const bytes = new Uint8Array(32 * 1024).map((_, i) => (i * 7) % 251);

    // The grant is addressed at the proxy — the browser-reachable, same-origin shape.
    const grant = await split.signUpload(path, "application/octet-stream");
    expect(new URL(grant.uploadUrl).origin).toBe(proxyOrigin);

    // The browser's PUT, verbatim: grant URL, grant headers, through the proxy hop.
    const put = await fetch(grant.uploadUrl, {
      method: grant.uploadMethod, headers: grant.uploadHeaders, body: bytes,
    });
    expect(put.status, await put.clone().text()).toBe(200);

    // The send path's read runs on the INTERNAL endpoint and must see the same bytes.
    expect([...await split.download(path)]).toEqual([...bytes]);
    await split.remove([path]);
  });

  it("THE BUCKET STAYS PRIVATE: unsigned requests 403 — the invariant that makes exposing /<bucket>/* safe at all", async () => {
    const split = makeS3StagingStorage({ ...CFG, publicEndpoint: proxyOrigin });
    const path = stagingObjectPath(`acc-${randomUUID()}`, randomUUID());
    const grant = await split.signUpload(path, "application/octet-stream");
    const put = await fetch(grant.uploadUrl, {
      method: grant.uploadMethod, headers: grant.uploadHeaders, body: new Uint8Array([4, 5, 6]),
    });
    expect(put.status).toBe(200);

    // The object URL with NO signature, through the public door AND directly: both must refuse.
    // An anonymous bucket policy (`rc bucket anonymous set download …`) is the one-liner that would
    // silently turn the proxy route into a public byte store — this is the tripwire that goes
    // red if anything ever grants it.
    const bare = new URL(grant.uploadUrl);
    bare.search = "";
    for (const origin of [proxyOrigin, RUSTFS_URL]) {
      const at = new URL(bare.pathname, origin);
      const anonGet = await fetch(at);
      expect(anonGet.status, `unsigned GET via ${origin} must be refused`).toBe(403);
      await anonGet.arrayBuffer().catch(() => {});
      const anonPut = await fetch(at, { method: "PUT", body: new Uint8Array([9]) });
      expect(anonPut.status, `unsigned PUT via ${origin} must be refused`).toBe(403);
      await anonPut.arrayBuffer().catch(() => {});
    }
    await split.remove([path]);
  });
});

/**
 * ═══ THE BUCKET WALK: ListObjectsV2, PAGE BY PAGE — the orphan sweep's only call ═══════════════
 *
 * `reconcileStagingOrphans` finds the bytes no ticket points at by walking the bucket, and the
 * walk is `list()`: ListObjectsV2 read out of the XML by hand, its continuation token the cursor.
 * The unit suite pins that parse against a canned answer; this pins it against the server's own:
 * every key exactly once across pages smaller than the bucket, a date and a size on each, and a
 * cursor that ends. It runs in a bucket of its own, made empty for this run, because a walk over
 * the shared test bucket would read every earlier run's leftovers.
 */
describe.skipIf(!RUSTFS_UP)("the bucket walk, against real RustFS", () => {
  const WALK: S3StagingStorageConfig = { ...CFG, bucket: `staging-walk-${randomUUID().slice(0, 8)}` };
  const walker = makeS3StagingStorage(WALK);
  const keys = Array.from({ length: 5 }, () => stagingObjectPath(randomUUID(), randomUUID())).sort();
  const sizes = new Map(keys.map((k, i) => [k, 10 + i]));
  const startedAt = Date.now();

  beforeAll(async () => {
    const made = await fetch(await admin.sign(`${RUSTFS_URL}/${WALK.bucket}`, { method: "PUT" }));
    if (!made.ok) throw new Error(`could not create the walk bucket: ${made.status} ${await made.text()}`);
    await made.arrayBuffer().catch(() => {});
    for (const k of keys) {
      const grant = await walker.signUpload(k, "application/octet-stream");
      const put = await fetch(grant.uploadUrl, {
        method: grant.uploadMethod, headers: grant.uploadHeaders, body: new Uint8Array(sizes.get(k)!),
      });
      if (put.status !== 200) throw new Error(`upload of a walk object answered ${put.status}`);
      await put.arrayBuffer().catch(() => {});
    }
  });

  afterAll(async () => {
    await walker.remove(keys);
    const res = await fetch(await admin.sign(`${RUSTFS_URL}/${WALK.bucket}`, { method: "DELETE" }));
    await res.arrayBuffer().catch(() => {});
  });

  it("pages of two walk five objects in three pages, each key once, dated and sized, then stop", async () => {
    const seen: StagedObjectListing[] = [];
    const pageSizes: number[] = [];
    let cursor: string | null = null;
    do {
      const page = await walker.list!(cursor, 2);
      pageSizes.push(page.objects.length);
      seen.push(...page.objects);
      cursor = page.cursor;
    } while (cursor !== null && pageSizes.length < 10);
    expect(pageSizes).toEqual([2, 2, 1]);
    expect(seen.map((o) => o.objectPath)).toEqual(keys);
    for (const o of seen) {
      expect(o.sizeBytes, o.objectPath).toBe(sizes.get(o.objectPath));
      expect(o.lastModifiedAt, `${o.objectPath} has no LastModified`).toBeInstanceOf(Date);
      // The store's clock against this process's, a second of slack each way for its rounding.
      expect(o.lastModifiedAt!.getTime()).toBeGreaterThanOrEqual(startedAt - 1000);
      expect(o.lastModifiedAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    }
  });

  it("the orphan sweep walks the same pages and removes only what no ticket holds", async () => {
    const keep = stagingTicketOf(keys[0]!);
    const result = await reconcileStagingOrphans({
      storage: walker,
      ticketsPresent: async (ids) => new Set(ids.filter((id) => id === keep)),
      now: new Date(Date.now() + 1000),
      minAgeMs: 0,
      pageSize: 2,
    });
    expect(result).toMatchObject({ scanned: 5, orphans: 4, deleted: 4, unrecognised: 0, pages: 3, complete: true });
    const left = await walker.list!(null, 10);
    expect(left.objects.map((o) => o.objectPath)).toEqual([keys[0]]);
    expect(left.cursor).toBeNull();
  });
});

/** The ticket half of `<accountId>/<ticketId>`. */
function stagingTicketOf(objectPath: string): string {
  return objectPath.split("/")[1]!;
}
