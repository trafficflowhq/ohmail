// @services: none — signs URLs for the RustFS port, dials nothing
import { describe, it, expect } from "vitest";
import { createHash, createHmac } from "node:crypto";
import {
  makeS3StagingStorage, s3StagingObjectUrl, S3_UPLOAD_GRANT_TTL_SECONDS,
  AttachmentStagingStorageError, StagedObjectTooLargeError,
  type S3StagingStorageConfig,
} from "../src/attachment-staging.js";

/**
 * ═══ THE SIGNED-URL HALF OF THE OBJECT STORE: ADDRESSING, THE PRESIGNED GRANT, AND THE WIRE ═══
 *
 * Everything here runs against an injected `fetch` — no network in this file, same rule as the
 * hosted-storage suite above it. The live RustFS round trip is `attachment-staging-s3.rustfs.test.ts`.
 * What IS decidable here, and pinned:
 *
 *  · **Addressing is endpoint-driven.** RustFS (an IP or operator hostname) takes PATH-STYLE URLs
 *    — the bucket in the path — and real AWS takes virtual-host style. The choice is baked into
 *    the SIGNATURE (SigV4 signs the Host header), so getting it wrong is not a redirect, it is a
 *    403 on every request. Mutation: force one style → the other family's test goes red.
 *  · **The grant's signature is INDEPENDENTLY RECOMPUTED** from the SigV4 spec with node:crypto,
 *    not compared against a copy of the library's own output. If aws4fetch or our URL builder
 *    drifts from the canonical form, this goes red rather than agreeing with itself.
 *  · **A DELETE 404 is SUCCESS** — same contract as the hosted-storage impl, same abandoned-upload
 *    reason, plus the wire's own: DeleteObject on a missing key answers 204, but a compatible server that
 *    answers 404 must not wedge the sweep.
 */

const CFG: S3StagingStorageConfig = {
  endpoint: "http://127.0.0.1:3902",
  region: "us-east-1",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wjalrxutnfemi-khmdeng-bpxrficyexamplekey-fixture-token",
  bucket: "staging",
};

/**
 * The SigV4 presigned-PUT signature, recomputed FROM THE SPEC with node:crypto — never compared
 * against a copy of the library's own output. The canonical request embeds the URL's `host`,
 * which is what makes this the judge of the public-endpoint split: whichever host the grant was
 * built against is the only host the signature can verify for.
 */
function independentSignature(url: URL, contentType: string, secretAccessKey: string): string {
  const q = url.searchParams;
  const datetime = q.get("X-Amz-Date")!;
  const scope = q.get("X-Amz-Credential")!.split("/").slice(1).join("/"); // date/region/s3/aws4_request

  // Canonical query: every parameter except the signature itself, sorted, RFC3986-encoded.
  const pairs: Array<[string, string]> = [];
  q.forEach((v, k) => { if (k !== "X-Amz-Signature") pairs.push([k, v]); });
  const enc = (s: string): string =>
    encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const canonicalQuery = pairs
    .map(([k, v]) => [enc(k), enc(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const canonicalRequest = [
    "PUT",
    url.pathname,
    canonicalQuery,
    `content-type:${contentType}`,
    `host:${url.host}`,
    "",
    "content-type;host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    datetime,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");

  const hmac = (key: Buffer | string, data: string): Buffer =>
    createHmac("sha256", key).update(data).digest();
  const [date, region, service] = scope.split("/");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date!), region!), service!), "aws4_request");
  return createHmac("sha256", signingKey).update(stringToSign).digest("hex");
}

/** A recording fetch whose answers the test scripts. */
function recordingFetch(respond: (req: Request) => Response) {
  const calls: Request[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req);
    return respond(req);
  }) as typeof fetch;
  return { impl, calls };
}

describe("s3StagingObjectUrl — addressing is a property of the ENDPOINT", () => {
  it("path-style for RustFS and any operator endpoint: bucket in the path, host untouched", () => {
    expect(s3StagingObjectUrl(CFG, "acc-1/tick-2"))
      .toBe("http://127.0.0.1:3902/staging/acc-1/tick-2");
  });

  it("virtual-host style for real AWS: bucket as a host label, never in the path", () => {
    const aws = { ...CFG, endpoint: "https://s3.eu-central-1.amazonaws.com" };
    expect(s3StagingObjectUrl(aws, "acc-1/tick-2"))
      .toBe("https://staging.s3.eu-central-1.amazonaws.com/acc-1/tick-2");
  });

  it("an AWS endpoint with a DOTTED bucket falls back to path-style — a dot in a host label breaks the wildcard TLS cert", () => {
    const aws = { ...CFG, endpoint: "https://s3.eu-central-1.amazonaws.com", bucket: "staging.ohmail" };
    expect(s3StagingObjectUrl(aws, "a/b"))
      .toBe("https://s3.eu-central-1.amazonaws.com/staging.ohmail/a/b");
  });

  it("tolerates a trailing slash on the endpoint and keeps a reverse-proxy base path", () => {
    expect(s3StagingObjectUrl({ ...CFG, endpoint: "http://127.0.0.1:3902/" }, "a/b"))
      .toBe("http://127.0.0.1:3902/staging/a/b");
    expect(s3StagingObjectUrl({ ...CFG, endpoint: "https://mail.example.com/s3" }, "a/b"))
      .toBe("https://mail.example.com/s3/staging/a/b");
  });

  it("encodes each key segment — a key is ids by construction, but the builder must not trust that", () => {
    expect(s3StagingObjectUrl(CFG, "acc 1/ti#ck"))
      .toBe("http://127.0.0.1:3902/staging/acc%201/ti%23ck");
  });
});

describe("signUpload — the presigned PUT grant", () => {
  it("mints a query-signed URL: algorithm, credential scope, expiry, and the content-type BOUND into SignedHeaders", async () => {
    const storage = makeS3StagingStorage(CFG); // presigning is local — no fetch is ever needed
    const grant = await storage.signUpload("acc-1/tick-2", "application/pdf");

    expect(grant.uploadMethod).toBe("PUT");
    // The header the client must present VERBATIM — the signature covers it, so a PUT that lies
    // about its content type is a 403, exactly the property the hosted-storage grant has.
    expect(grant.uploadHeaders).toEqual({ "content-type": "application/pdf" });

    const url = new URL(grant.uploadUrl);
    expect(`${url.origin}${url.pathname}`).toBe("http://127.0.0.1:3902/staging/acc-1/tick-2");
    const q = url.searchParams;
    expect(q.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(q.get("X-Amz-Credential")).toMatch(
      new RegExp(`^${CFG.accessKeyId}/\\d{8}/${CFG.region}/s3/aws4_request$`),
    );
    expect(q.get("X-Amz-Expires")).toBe(String(S3_UPLOAD_GRANT_TTL_SECONDS));
    expect(q.get("X-Amz-SignedHeaders")).toBe("content-type;host");
    expect(q.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("KNOWN-ANSWER: the signature verifies against an independent SigV4 implementation", async () => {
    const storage = makeS3StagingStorage(CFG);
    const grant = await storage.signUpload("acc-1/tick-2", "application/pdf");
    const url = new URL(grant.uploadUrl);
    expect(url.searchParams.get("X-Amz-Signature"))
      .toBe(independentSignature(url, "application/pdf", CFG.secretAccessKey));
  });
});

describe("signUpload with a PUBLIC endpoint — the grant is addressed (and signed) for the browser", () => {
  /** The self-host shape: internal RustFS for the service wire, the proxy origin for the browser. */
  const SPLIT: S3StagingStorageConfig = { ...CFG, publicEndpoint: "https://mail.example.com" };

  it("builds the upload URL from publicEndpoint — path-style under the proxy origin, not the store's host", async () => {
    const storage = makeS3StagingStorage(SPLIT);
    const grant = await storage.signUpload("acc-1/tick-2", "application/pdf");
    const url = new URL(grant.uploadUrl);
    // The browser-reachable, same-origin shape: CSP `connect-src 'self'` is satisfied and no
    // compose-internal DNS name ever reaches a browser.
    expect(`${url.origin}${url.pathname}`).toBe("https://mail.example.com/staging/acc-1/tick-2");
  });

  it("KNOWN-ANSWER: the signature is computed against the PUBLIC Host — the Host the browser presents", async () => {
    const storage = makeS3StagingStorage(SPLIT);
    const grant = await storage.signUpload("acc-1/tick-2", "application/pdf");
    const url = new URL(grant.uploadUrl);
    // SigV4 signs the Host header. A Host-preserving proxy hop hands the store exactly
    // `mail.example.com`, so the signature must verify against THAT host — recomputed here from
    // the spec, independent of aws4fetch. Sign against the internal host instead and this red.
    expect(url.host).toBe("mail.example.com");
    expect(independentSignature(url, "application/pdf", CFG.secretAccessKey)).toBe(
      url.searchParams.get("X-Amz-Signature"),
    );
  });

  it("download and remove stay on the INTERNAL endpoint — publicEndpoint is signUpload's alone", async () => {
    const { impl, calls } = recordingFetch(() => new Response(new Uint8Array([1]), { status: 200 }));
    const storage = makeS3StagingStorage(SPLIT, impl);
    await storage.download("acc-1/tick-2");
    await storage.remove(["acc-1/tick-2"]);
    // The service processes reach the store by its in-network name; routing THEIR wire through
    // the public proxy would add a hop and make the organizer's sweep depend on the front door.
    expect(calls.map((c) => new URL(c.url).origin)).toEqual([
      "http://127.0.0.1:3902", "http://127.0.0.1:3902",
    ]);
  });

  it("absent publicEndpoint falls back to the endpoint — the single-network deployment unchanged", async () => {
    const storage = makeS3StagingStorage(CFG);
    const grant = await storage.signUpload("acc-1/tick-2", "application/pdf");
    expect(new URL(grant.uploadUrl).origin).toBe("http://127.0.0.1:3902");
  });
});

describe("download and remove — the authenticated wire", () => {
  it("download GETs the object with a SigV4 Authorization header and returns the bytes", async () => {
    const { impl, calls } = recordingFetch(() => new Response(new Uint8Array([7, 8, 9])));
    const storage = makeS3StagingStorage(CFG, impl);
    const bytes = await storage.download("acc-1/tick-2");
    expect([...bytes]).toEqual([7, 8, 9]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe("http://127.0.0.1:3902/staging/acc-1/tick-2");
    expect(calls[0]!.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=/);
    // Payload signing is explicitly waived on this wire — request bodies are empty here and the
    // response is what matters; this is the header aws4fetch sets for exactly that statement.
    expect(calls[0]!.headers.get("x-amz-content-sha256")).toBe("UNSIGNED-PAYLOAD");
  });

  it("a failed download carries the status so the caller can tell 'misconfigured' from 'gone'", async () => {
    const { impl } = recordingFetch(() => new Response("denied", { status: 403 }));
    const storage = makeS3StagingStorage(CFG, impl);
    await expect(storage.download("acc-1/tick-2")).rejects.toMatchObject({
      name: "AttachmentStagingStorageError", operation: "download", status: 403,
    });
  });

  it("remove DELETEs each object; 404 and 204 are both SUCCESS (the abandoned upload must clear)", async () => {
    const answers = [new Response(null, { status: 204 }), new Response("no such key", { status: 404 })];
    const { impl, calls } = recordingFetch(() => answers.shift()!);
    const storage = makeS3StagingStorage(CFG, impl);
    await storage.remove(["acc-1/kept", "acc-1/ghost"]);
    expect(calls.map((c) => c.method)).toEqual(["DELETE", "DELETE"]);
    /**
     * A SET, not a sequence — and the previous version of this line asserted the sequence and was
     * therefore FLAKY rather than strict.
     *
     * `remove` deletes a batch through `Promise.all` and signs each request asynchronously
     * (`client.sign` is awaited inside the mapped function), so which DELETE reaches the fetch
     * double first is genuinely undetermined. It is stable when this file runs alone and flips
     * under a loaded full suite, which is the worst shape a test can have: it reads as a
     * regression in the sweep and is a property the implementation never promised. Caught in a
     * whole-repo run — `expected ['/staging/acc-1/ghost', …] to deeply equal ['/staging/acc-1/kept',
     * …]`, both DELETEs present, only the order different.
     *
     * The claim keeps its full strength: EXACTLY two DELETEs (asserted above), to EXACTLY these
     * two paths, with nothing extra and nothing missing. What is dropped is only the part that was
     * never true. Concurrency here is deliberate — a 200-object sweep page is not going to be
     * serialised for the sake of a test's convenience.
     */
    expect(calls.map((c) => new URL(c.url).pathname).sort())
      .toEqual(["/staging/acc-1/ghost", "/staging/acc-1/kept"]);
  });

  it("any other DELETE failure throws and keeps the page for the next drain", async () => {
    const { impl } = recordingFetch(() => new Response("AccessDenied", { status: 403 }));
    const storage = makeS3StagingStorage(CFG, impl);
    await expect(storage.remove(["acc-1/tick-2"])).rejects.toBeInstanceOf(AttachmentStagingStorageError);
  });

  it("remove of nothing performs no request", async () => {
    const { impl, calls } = recordingFetch(() => new Response(null, { status: 204 }));
    const storage = makeS3StagingStorage(CFG, impl);
    await storage.remove([]);
    expect(calls).toHaveLength(0);
  });
});

/**
 * THE PORT'S OWN CEILING, on a real `Response` stream.
 *
 * `resolveStagedAttachments` passes the ticket's declared `sizeBytes` as `maxBytes`, and its own
 * suite proves it passes it — against a purpose-built fake that does the refusing. That leaves
 * the production property untested: replace both `download` implementations with an
 * unconditional `res.arrayBuffer()` and that suite stays green while the streaming refusal is
 * gone. A review round said so, and it is right — a guard proven only against a fake that
 * implements the guard proves the argument, not the code.
 *
 * So these drive `readObjectWithin` through the real factory with real `Response` bodies. The
 * presigned PUT signs only the content TYPE, so a caller can mint a one-byte ticket and upload
 * an object of any size to the path it named: the declared-length case is the honest oversized
 * object and the chunked case is the one that lies.
 */
describe("the storage port refuses an oversized object DURING the read", () => {
  const CHUNK = 16 * 1024;

  /** A response whose body is a stream we can watch being consumed. */
  function streamingResponse(bytes: number, declareLength: boolean): {
    res: Response; pulled: () => number;
  } {
    let pulled = 0;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= bytes) { controller.close(); return; }
        const n = Math.min(CHUNK, bytes - sent);
        sent += n;
        pulled += n;
        controller.enqueue(new Uint8Array(n));
      },
    });
    const headers = new Headers();
    if (declareLength) headers.set("content-length", String(bytes));
    return { res: new Response(body, { status: 200, headers }), pulled: () => pulled };
  }

  /**
   * The stream's own queue pulls a chunk or two AHEAD of any consumer, so `pulled()` is never
   * exactly zero and never exactly the ceiling. The property under test is not the byte count —
   * it is that the read stops near the ceiling instead of at the end of the object, so each
   * assertion is stated against the OBJECT's size with the look-ahead allowed for.
   */
  const LOOKAHEAD = 4 * CHUNK;

  it("refuses a DECLARED over-cap object essentially without reading it", async () => {
    const size = 4 * 1024 * 1024;
    const { res, pulled } = streamingResponse(size, true);
    const storage = makeS3StagingStorage(CFG, (async () => res) as unknown as typeof fetch);

    await expect(storage.download("acc/t1", { maxBytes: 1024 })).rejects.toBeInstanceOf(
      StagedObjectTooLargeError,
    );
    // Consulting `Content-Length` first is what makes an honest oversized object cost nothing:
    // whatever the stream queued ahead of us, the four megabytes were never transferred.
    expect(pulled()).toBeLessThanOrEqual(LOOKAHEAD);
    expect(pulled()).toBeLessThan(size / 10);
  });

  it("cuts off an object that DECLARES NOTHING and overruns", async () => {
    const cap = 64 * 1024;
    const size = cap * 16;
    const { res, pulled } = streamingResponse(size, false);
    const storage = makeS3StagingStorage(CFG, (async () => res) as unknown as typeof fetch);

    await expect(storage.download("acc/t1", { maxBytes: cap })).rejects.toBeInstanceOf(
      StagedObjectTooLargeError,
    );
    // Stopped NEAR the ceiling rather than at the end of the object — which is the whole
    // difference between this and a check after `arrayBuffer()`.
    expect(pulled()).toBeLessThanOrEqual(cap + LOOKAHEAD);
    expect(pulled()).toBeLessThan(size / 2);
  });

  it("returns the bytes of an object inside the ceiling, unchanged", async () => {
    const { res } = streamingResponse(1024, true);
    const storage = makeS3StagingStorage(CFG, (async () => res) as unknown as typeof fetch);

    const out = await storage.download("acc/t1", { maxBytes: 4096 });

    expect(out.byteLength).toBe(1024);
  });

  it("with NO ceiling it reads whatever arrives — every existing caller is unaffected", async () => {
    const { res } = streamingResponse(2048, true);
    const storage = makeS3StagingStorage(CFG, (async () => res) as unknown as typeof fetch);

    const out = await storage.download("acc/t1");

    expect(out.byteLength).toBe(2048);
  });
});

/**
 * THE BUCKET WALK — what the reconciliation reads, and the only thing that can find an object
 * whose ticket is gone. Parsed out of `ListObjectsV2`'s XML by hand, so what is pinned here is
 * the parse: the three fields, the continuation token, and an untruncated answer ending the walk.
 */
describe("makeS3StagingStorage.list", () => {
  const LIST = (contents: string, more?: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>${contents}${more ?? "<IsTruncated>false</IsTruncated>"}</ListBucketResult>`;
  const entry = (key: string, modified: string, size: number): string =>
    `<Contents><Key>${key}</Key><LastModified>${modified}</LastModified><Size>${size}</Size><StorageClass>STANDARD</StorageClass></Contents>`;

  const respond = (xml: string, seen?: (url: string) => void): typeof fetch =>
    (async (req: Request) => {
      seen?.(typeof req === "string" ? req : req.url);
      return new Response(xml, { status: 200 });
    }) as unknown as typeof fetch;

  it("reads key, last-modified and size, and ends the walk on an untruncated answer", async () => {
    const xml = LIST(
      entry("a/1", "2026-09-13T08:00:00.000Z", 12) + entry("a/2", "2026-09-13T09:00:00.000Z", 34),
    );
    const storage = makeS3StagingStorage(CFG, respond(xml));

    const page = await storage.list!(null, 200);

    expect(page.objects.map((o) => o.objectPath)).toEqual(["a/1", "a/2"]);
    expect(page.objects[0]!.lastModifiedAt?.toISOString()).toBe("2026-09-13T08:00:00.000Z");
    expect(page.objects[1]!.sizeBytes).toBe(34);
    expect(page.cursor, "an untruncated answer must END the walk").toBeNull();
  });

  it("carries the continuation token BOTH ways — out as the cursor, back as the parameter",
    async () => {
      const seen: string[] = [];
      const truncated = LIST(
        entry("a/1", "2026-09-13T08:00:00.000Z", 1),
        "<IsTruncated>true</IsTruncated><NextContinuationToken>tok/en+1</NextContinuationToken>",
      );
      const storage = makeS3StagingStorage(CFG, respond(truncated, (u) => seen.push(u)));

      const first = await storage.list!(null, 50);
      expect(first.cursor).toBe("tok/en+1");
      await storage.list!(first.cursor, 50);

      const url = new URL(seen[1]!);
      expect(url.searchParams.get("list-type")).toBe("2");
      expect(url.searchParams.get("max-keys")).toBe("50");
      expect(url.searchParams.get("continuation-token")).toBe("tok/en+1");
    });

  it("decodes an escaped key rather than handing back the entity", async () => {
    const xml = LIST(entry("a&amp;b/1", "2026-09-13T08:00:00.000Z", 1));
    const storage = makeS3StagingStorage(CFG, respond(xml));

    const page = await storage.list!(null, 10);

    expect(page.objects[0]!.objectPath).toBe("a&b/1");
  });

  it("refuses a listing the store would not serve", async () => {
    const storage = makeS3StagingStorage(
      CFG, (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch);

    await expect(storage.list!(null, 10)).rejects.toBeInstanceOf(AttachmentStagingStorageError);
  });
});
