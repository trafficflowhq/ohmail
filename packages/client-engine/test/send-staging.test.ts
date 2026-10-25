import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  HttpAdapter, MutationRejectedError, SEND_INLINE_MAX_TOTAL_BYTES,
  type ComposeAttachment, type EngineMutation, type FetchLike,
} from "../src/index.js";

/**
 * ═══ WHICH TRANSPORT A SEND'S ATTACHMENT BYTES TAKE, DECIDED HERE ══════════════════════════
 *
 * This adapter is the wire client for the browser app AND for every door of the desktop app, and
 * only the hosted ones may stage. The mechanism is one boolean whose default is `false`, so the
 * property is structural: a construction that does not ask cannot stage.
 *
 * ## The guards, and the mutation each was watched against
 *
 *  · **OFF ⇒ byte-identical.** A send with attachments and no staging produces exactly the request
 *    a shipped 0.9.3 desktop produces — `{attachments:[…]}`, no `stagedAttachmentIds`, no mint
 *    call. Mutation: default `stageAttachments` to `true` → the desktop-shaped cases go red.
 *  · **ON but UNDER the ceiling ⇒ still inline.** Mutation: drop the threshold comparison → the
 *    small-file case starts minting and goes red.
 *  · **ON and OVER the ceiling ⇒ mint, upload, reference.** Mutation: send inline anyway → the
 *    request-shape assertion goes red.
 *  · **The upload carries NO session credential.** Mutation: route the PUT through `request()` →
 *    the bearer/CSRF assertion goes red. The signed URL is the authority; adding ours widens what
 *    a server-supplied URL can do.
 *  · **A staging failure REFUSES the send.** There is no inline fallback from here and there must
 *    not be: this path only runs when the total already exceeds what inline can carry, so a
 *    fallback produces a request the server refuses — a second, more confusing failure.
 *  · **THE DESKTOP ASKS ONLY ON ITS HOSTED DOOR**, asserted over its construction's source here
 *    and driven per door in `apps/desktop/test/desktop-cloud-staged-attach.test.ts`, because an
 *    edit there is how a standalone install would start posting bytes to hosted storage.
 */

const MIB = 1024 * 1024;

/** `n` bytes of base64 payload — the content is never inspected, only its decoded length. */
function file(bytes: number, filename = "a.bin"): ComposeAttachment {
  return {
    filename,
    contentType: "application/octet-stream",
    contentBase64: Buffer.alloc(bytes, 7).toString("base64"),
  };
}

interface Call { method: string; url: string; body: unknown; headers: Record<string, string> }

/**
 * A fetch that answers the three requests a staged send makes and RECORDS every one of them.
 * `sendStatus` lets a test drive the mint or the upload into failure.
 */
function harness(over: {
  mintStatus?: number; uploadStatus?: number;
  /** What `GET /drafts/:id/send-attempt` answers: a reservation, none, or a server without it. */
  attempt?: "found" | "none" | "no-route";
} = {}) {
  const calls: Call[] = [];
  let minted = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers as HeadersInit | undefined).forEach((v, k) => { headers[k] = v; });
    const path = new URL(url, "http://localhost").pathname;
    let body: unknown = null;
    if (typeof init?.body === "string") { try { body = JSON.parse(init.body); } catch { body = init.body; } }
    else if (init?.body) body = `<${(init.body as Uint8Array).byteLength ?? 0} bytes>`;
    calls.push({ method: init?.method ?? "GET", url, body, headers });

    if (path.endsWith("/send-attempt")) {
      // A server that predates the route answers the router's 404 — the default here, because it
      // is what every caller of this harness that says nothing is entitled to assume.
      const mode = over.attempt ?? "no-route";
      if (mode === "no-route") {
        return new Response(JSON.stringify({ error: { code: "not_found", message: "no route" } }), {
          status: 404, headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(
        mode === "found" ? { found: true, firstSend: { status: "sent", at: "2026-09-22T10:00:00.000Z" } } : { found: false },
      ), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (path === "/drafts" && init?.method === "POST") {
      return new Response(JSON.stringify({ id: "draft-1", bcc: [] }), {
        status: 201, headers: { "content-type": "application/json" },
      });
    }
    if (path === "/attachments/staging") {
      const status = over.mintStatus ?? 201;
      if (status !== 201) {
        return new Response(JSON.stringify({ error: { code: "unavailable", message: "no storage" } }), {
          status, headers: { "content-type": "application/json" },
        });
      }
      minted += 1;
      return new Response(JSON.stringify({
        id: `ticket-${minted}`,
        uploadUrl: `https://storage.example/o/${minted}?token=abc`,
        uploadMethod: "PUT",
        uploadHeaders: { "content-type": "application/octet-stream", "x-upsert": "false" },
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith("https://storage.example/")) {
      return new Response("", { status: over.uploadStatus ?? 200 });
    }
    if (path.endsWith("/send")) {
      return new Response(JSON.stringify({ status: "sent", providerMessageId: "<id@x>" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchImpl };
}

const send = (attachments: ComposeAttachment[]): EngineMutation => ({
  kind: "mail_send",
  mailboxId: "mbx-1",
  inReplyTo: null,
  subject: "with files",
  body: "here you go",
  to: [{ name: null, address: "you@example.com" }],
  attachments,
} as EngineMutation);

const sendBodyOf = (calls: Call[]): Record<string, unknown> =>
  (calls.find((c) => c.url.endsWith("/send"))?.body ?? {}) as Record<string, unknown>;

describe("STAGING OFF — the shape a shipped desktop sends, unchanged", () => {
  it("puts the bytes inline and never touches the mint route, whatever the size", async () => {
    const { calls, fetchImpl } = harness();
    const a = new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl });
    await a.mutate(send([file(6 * MIB)]), { idempotencyKey: "k1" });

    expect(calls.map((c) => new URL(c.url, "http://localhost").pathname))
      .not.toContain("/attachments/staging");
    const body = sendBodyOf(calls);
    expect(Array.isArray(body.attachments)).toBe(true);
    expect(body.stagedAttachmentIds).toBeUndefined();
  });

  it("a small inline send is the exact request it has always been", async () => {
    const { calls, fetchImpl } = harness();
    const a = new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl });
    await a.mutate(send([file(1024, "note.txt")]), { idempotencyKey: "k2" });
    const body = sendBodyOf(calls);
    expect(body).toEqual({
      attachments: [{
        filename: "note.txt",
        contentType: "application/octet-stream",
        contentBase64: Buffer.alloc(1024, 7).toString("base64"),
      }],
    });
  });
});

describe("STAGING ON — the threshold, not `always`", () => {
  it("UNDER the inline ceiling the request is still byte-identical", async () => {
    // The live path and the compatibility path stay THE SAME path for the common send. Routing a
    // one-small-file send through storage would add a failure mode for no gain.
    const { calls, fetchImpl } = harness();
    const a = new HttpAdapter({
      baseUrl: "http://localhost", fetch: fetchImpl, stageAttachments: true,
    });
    await a.mutate(send([file(SEND_INLINE_MAX_TOTAL_BYTES)]), { idempotencyKey: "k3" });

    expect(calls.map((c) => new URL(c.url, "http://localhost").pathname))
      .not.toContain("/attachments/staging");
    expect(sendBodyOf(calls).attachments).toBeDefined();
  });

  it("OVER it: one mint and one upload per file, and the send carries only references", async () => {
    const { calls, fetchImpl } = harness();
    const a = new HttpAdapter({
      baseUrl: "http://localhost", fetch: fetchImpl, stageAttachments: true,
    });
    await a.mutate(send([file(3 * MIB, "one.bin"), file(3 * MIB, "two.bin")]), { idempotencyKey: "k4" });

    const mints = calls.filter((c) => c.url.endsWith("/attachments/staging"));
    const uploads = calls.filter((c) => c.url.startsWith("https://storage.example/"));
    expect(mints).toHaveLength(2);
    expect(uploads).toHaveLength(2);
    // The mint is told the DECODED length and the sending mailbox — the ceiling has no other source.
    expect(mints[0]!.body).toMatchObject({ mailboxId: "mbx-1", filename: "one.bin", sizeBytes: 3 * MIB });
    expect(uploads[0]!.method).toBe("PUT");
    expect(uploads[0]!.body).toBe(`<${3 * MIB} bytes>`);

    const body = sendBodyOf(calls);
    expect(body.stagedAttachmentIds).toEqual(["ticket-1", "ticket-2"]);
    // ALL OR NOTHING. A mixed request is legal on the wire and would be capped as if nothing had
    // been staged, which is the refusal staging exists to remove.
    expect(body.attachments).toBeUndefined();
  });

  it("the UPLOAD carries no session credential — its authority is the signed URL alone", async () => {
    const { calls, fetchImpl } = harness();
    const a = new HttpAdapter({
      baseUrl: "http://localhost", fetch: fetchImpl, stageAttachments: true,
      headers: () => ({ authorization: "Bearer session-token" }),
    });
    await a.mutate(send([file(4 * MIB)]), { idempotencyKey: "k5" });

    const upload = calls.find((c) => c.url.startsWith("https://storage.example/"))!;
    expect(upload.headers.authorization).toBeUndefined();
    expect(upload.headers["x-csrf-token"]).toBeUndefined();
    // …and the headers it DOES carry are the server's, verbatim.
    expect(upload.headers["x-upsert"]).toBe("false");
    // The mint, by contrast, is an ordinary API call and does carry the session.
    const mint = calls.find((c) => c.url.endsWith("/attachments/staging"))!;
    expect(mint.headers.authorization).toBe("Bearer session-token");
  });

  it("a send with no attachments stays a bodyless request", async () => {
    const { calls, fetchImpl } = harness();
    const a = new HttpAdapter({
      baseUrl: "http://localhost", fetch: fetchImpl, stageAttachments: true,
    });
    await a.mutate(send([]), { idempotencyKey: "k6" });
    expect(calls.find((c) => c.url.endsWith("/send"))!.body).toBeNull();
  });
});

describe("A STAGING FAILURE REFUSES THE SEND — there is no silent inline fallback", () => {
  it("a mint the deployment cannot serve rejects, and nothing is sent", async () => {
    const { calls, fetchImpl } = harness({ mintStatus: 503 });
    const a = new HttpAdapter({
      baseUrl: "http://localhost", fetch: fetchImpl, stageAttachments: true,
    });
    await expect(a.mutate(send([file(4 * MIB)]), { idempotencyKey: "k7" }))
      .rejects.toBeInstanceOf(MutationRejectedError);
    expect(calls.some((c) => c.url.endsWith("/send"))).toBe(false);
  });

  it("a failed upload rejects, and a 5xx is retryable while a 4xx is not", async () => {
    for (const [status, retryable] of [[500, true], [403, false]] as const) {
      const { calls, fetchImpl } = harness({ uploadStatus: status });
      const a = new HttpAdapter({
        baseUrl: "http://localhost", fetch: fetchImpl, stageAttachments: true,
      });
      const err = await a.mutate(send([file(4 * MIB)]), { idempotencyKey: `k8-${status}` })
        .catch((e: unknown) => e) as MutationRejectedError;
      expect(err).toBeInstanceOf(MutationRejectedError);
      expect(err.retryable, `status ${status}`).toBe(retryable);
      expect(calls.some((c) => c.url.endsWith("/send"))).toBe(false);
    }
  });

  it("a grant this client may not reach ends the send — final, the row named, no upload and no send", async () => {
    const { calls, fetchImpl } = harness({ attempt: "none" });
    const asked: string[] = [];
    const a = new HttpAdapter({
      baseUrl: "http://localhost", fetch: fetchImpl, stageAttachments: true,
      uploadAdmits: (url) => { asked.push(url); return !url.startsWith("https://storage.example/"); },
    });
    const err = await a.mutate(send([file(4 * MIB)]), { idempotencyKey: "k-refused" })
      .catch((e: unknown) => e) as MutationRejectedError;
    expect(err).toBeInstanceOf(MutationRejectedError);
    expect(err).toMatchObject({ code: "staging_refused", retryable: false, entityId: "draft-1" });
    expect(asked).toEqual(["https://storage.example/o/1?token=abc"]);
    expect(calls.some((c) => c.url.startsWith("https://storage.example/")), "the refused grant was PUT").toBe(false);
    expect(calls.some((c) => c.url.endsWith("/send"))).toBe(false);

    // CONTROL: the same send to a client that may reach the grant uploads and goes.
    const ok = harness({ attempt: "none" });
    await new HttpAdapter({
      baseUrl: "http://localhost", fetch: ok.fetchImpl, stageAttachments: true,
      uploadAdmits: (url) => url.startsWith("https://storage.example/"),
    }).mutate(send([file(4 * MIB)]), { idempotencyKey: "k-admitted" });
    expect(sendBodyOf(ok.calls).stagedAttachmentIds).toEqual(["ticket-1"]);
  });

  it("an upload that throws is `staging_unreachable` — retried, and the row named", async () => {
    const { calls, fetchImpl } = harness({ attempt: "none" });
    const blocked: FetchLike = async (url, init) => {
      if (url.startsWith("https://storage.example/")) throw new TypeError("Failed to fetch");
      return fetchImpl(url, init);
    };
    const err = await new HttpAdapter({ baseUrl: "http://localhost", fetch: blocked, stageAttachments: true })
      .mutate(send([file(4 * MIB)]), { idempotencyKey: "k-unreachable" })
      .catch((e: unknown) => e) as MutationRejectedError;
    expect(err).toMatchObject({ code: "staging_unreachable", retryable: true, status: null, entityId: "draft-1" });
    expect(calls.some((c) => c.url.endsWith("/send"))).toBe(false);
  });

  it("a send with no resolvable mailbox is refused rather than staged blind", async () => {
    const { fetchImpl } = harness();
    const a = new HttpAdapter({
      baseUrl: "http://localhost", fetch: fetchImpl, stageAttachments: true,
    });
    const m = { ...(send([file(4 * MIB)]) as Record<string, unknown>) };
    delete m.mailboxId;
    await expect(a.mutate(m as EngineMutation, { idempotencyKey: "k9" }))
      .rejects.toBeInstanceOf(MutationRejectedError);
  });
});

/**
 * ═══ THE MINT'S KEY IS THE SEND'S KEY, SO A RETRY DOES NOT UPLOAD TWICE ════════════════════
 *
 * A mint writes a durable row on the server and a grant to put bytes in its storage. Without a
 * stable key a retry after a lost response mints a second ticket and uploads a second copy — a
 * duplicate the sender cannot see, on every attempt, for as long as the send keeps failing. The
 * server's half is to make the ticket's identity its key; this is the client's half, and the only
 * thing that makes the server's half worth anything: a key minted fresh per attempt would be as
 * useless as none.
 */
describe("the staging key is derived from the send, not minted per attempt", () => {
  /**
   * The send's own idempotency key is already durable and RESUMED on a retry rather than
   * re-minted, so deriving from it is what makes this key survive a reload, a crash and a fresh
   * tab.
   *
   * WATCHED RED by minting a `crypto.randomUUID()` per mint instead: the two attempts send four
   * different keys and the server has four tickets for one send.
   */
  it("the same send retried sends the SAME staging keys", async () => {
    const attach = [file(3 * MIB, "one.bin"), file(3 * MIB, "two.bin")];
    const keysOf = (calls: Call[]): string[] => calls
      .filter((c) => c.url.endsWith("/attachments/staging"))
      .map((c) => c.headers["idempotency-key"] ?? "(none)");

    const first = harness();
    await new HttpAdapter({
      baseUrl: "http://localhost", fetch: first.fetchImpl, stageAttachments: true,
    }).mutate(send(attach), { idempotencyKey: "send-key-A" });

    // The response was lost. The engine resumes the SAME send key — a different adapter instance,
    // which is what a reload is.
    const retry = harness();
    await new HttpAdapter({
      baseUrl: "http://localhost", fetch: retry.fetchImpl, stageAttachments: true,
    }).mutate(send(attach), { idempotencyKey: "send-key-A" });

    expect(keysOf(first.calls)).toEqual(["send-key-A:att:0", "send-key-A:att:1"]);
    expect(keysOf(retry.calls)).toEqual(keysOf(first.calls));
  });

  /**
   * THE FAILURE THIS COULD HAVE OPENED, and it is the worse one of the two.
   *
   * A key derived from the send alone would make the same file attached twice ONE ticket, and the
   * send route walks the DISTINCT ids — so the message would leave with one copy of a file the
   * composer showed twice. A message that quietly goes out without something the sender attached
   * is a wrong send; the duplicate upload this whole change removes is merely wasteful.
   *
   * WATCHED RED by dropping the `:att:${index}` suffix: both mints carry one key.
   */
  it("two attachments of ONE send are two keys, identical files included", async () => {
    const { calls, fetchImpl } = harness();
    const same = file(3 * MIB, "twice.bin");
    await new HttpAdapter({
      baseUrl: "http://localhost", fetch: fetchImpl, stageAttachments: true,
    }).mutate(send([same, same]), { idempotencyKey: "send-key-B" });

    const keys = calls
      .filter((c) => c.url.endsWith("/attachments/staging"))
      .map((c) => c.headers["idempotency-key"]);
    expect(keys).toEqual(["send-key-B:att:0", "send-key-B:att:1"]);
    expect(new Set(keys).size).toBe(2);
  });

  /** Two DIFFERENT sends never share a staging key. The vacuity guard for the case above. */
  it("a different send is a different set of keys", async () => {
    const a = harness();
    const b = harness();
    await new HttpAdapter({
      baseUrl: "http://localhost", fetch: a.fetchImpl, stageAttachments: true,
    }).mutate(send([file(6 * MIB, "one.bin")]), { idempotencyKey: "send-key-C" });
    await new HttpAdapter({
      baseUrl: "http://localhost", fetch: b.fetchImpl, stageAttachments: true,
    }).mutate(send([file(6 * MIB, "one.bin")]), { idempotencyKey: "send-key-D" });

    const key = (calls: Call[]): string | undefined => calls
      .find((c) => c.url.endsWith("/attachments/staging"))?.headers["idempotency-key"];
    expect(key(a.calls)).toBe("send-key-C:att:0");
    expect(key(b.calls)).toBe("send-key-D:att:0");
  });
});

/**
 * a staged retry re-uploaded every attachment BEFORE presenting its key,
 * so a storage refusal orphaned a message that may already have gone and invited a resend under
 * a NEW key. The probe is a READ; every uncertain answer stages as before. The three cases below
 * are that partition: a reservation, none, and a server that has never heard of the question.
 */
describe("a staged send presents its key before it re-uploads anything", () => {
  const big = (): EngineMutation => send([file(4 * MIB)]);

  it("a key the server already holds a reservation for re-uploads NOTHING", async () => {
    const { calls, fetchImpl } = harness({ attempt: "found" });
    const a = new HttpAdapter({
      baseUrl: "http://localhost", fetch: fetchImpl, stageAttachments: true,
    });
    await a.mutate(big(), { idempotencyKey: "send-key-R" });

    const paths = calls.map((c) => new URL(c.url, "http://localhost").pathname);
    expect(paths).toContain("/drafts/draft-1/send-attempt");
    expect(paths, "the retry re-minted an upload ticket").not.toContain("/attachments/staging");
    expect(calls.some((c) => c.url.startsWith("https://storage.example/")),
      "the retry re-uploaded bytes").toBe(false);
    // The send still goes, carrying neither list: the server answers from its reservation.
    const body = sendBodyOf(calls);
    expect(body.stagedAttachmentIds).toBeUndefined();
    expect(body.attachments).toBeUndefined();
  });

  /** THE POSITIVE CONTROL: nothing was sent under this key, so the ordinary staged send runs. */
  it("a key with no reservation stages and sends exactly as before", async () => {
    const { calls, fetchImpl } = harness({ attempt: "none" });
    const a = new HttpAdapter({
      baseUrl: "http://localhost", fetch: fetchImpl, stageAttachments: true,
    });
    await a.mutate(big(), { idempotencyKey: "send-key-S" });

    const paths = calls.map((c) => new URL(c.url, "http://localhost").pathname);
    expect(paths).toContain("/attachments/staging");
    expect(sendBodyOf(calls).stagedAttachmentIds).toEqual(["ticket-1"]);
  });

  /** AND A SERVER THAT PREDATES THE ROUTE answers 404, which must read as "stage", not "sent". */
  it("a 404 from the probe is not a reservation — the send stages as it always did", async () => {
    const { calls, fetchImpl } = harness({ attempt: "no-route" });
    const a = new HttpAdapter({
      baseUrl: "http://localhost", fetch: fetchImpl, stageAttachments: true,
    });
    await a.mutate(big(), { idempotencyKey: "send-key-T" });

    expect(sendBodyOf(calls).stagedAttachmentIds).toEqual(["ticket-1"]);
  });

  /** AND THE PROBE IS NOT PAID FOR BY A SEND THAT WAS NEVER GOING TO STAGE. */
  it("an inline send asks nothing — the probe is a staged-path cost only", async () => {
    const { calls, fetchImpl } = harness({ attempt: "found" });
    const a = new HttpAdapter({
      baseUrl: "http://localhost", fetch: fetchImpl, stageAttachments: true,
    });
    await a.mutate(send([file(1024)]), { idempotencyKey: "send-key-U" });

    expect(calls.map((c) => new URL(c.url, "http://localhost").pathname))
      .not.toContain("/drafts/draft-1/send-attempt");
  });
});

/**
 * the mint DECLARES what the bytes are, so the send can hold the upload to it. Absent where
 * the runtime has no WebCrypto; node has it, so this file measures the declaring half and the
 * comment on `sha256Hex` carries the other.
 */
describe("a staged mint declares its content digest", () => {
  it("carries `contentSha256` of the file's own bytes", async () => {
    const { calls, fetchImpl } = harness({ attempt: "none" });
    const a = new HttpAdapter({
      baseUrl: "http://localhost", fetch: fetchImpl, stageAttachments: true,
    });
    const files = [file(4 * MIB)];
    await a.mutate(send(files), { idempotencyKey: "send-key-V" });

    const mint = calls.find((c) => c.url.endsWith("/attachments/staging"))!;
    const declared = (mint.body as { contentSha256?: unknown }).contentSha256;
    const expected = createHash("sha256")
      .update(Buffer.from(files[0]!.contentBase64, "base64")).digest("hex");
    expect(declared).toBe(expected);
  });
});

describe("THE DESKTOP STAGES ON ITS HOSTED DOOR ONLY — from source", () => {
  it("`apps/desktop/src/bridge-fetch.ts` turns the option on only when its caller asks", () => {
    // ONE construction serves every door. The standalone and paired doors have no hosted storage
    // behind them; the hosted door stages and its PUT is carried by the local engine. The window
    // asks for it through `stagesAttachments` (managed flavor only), driven in the desktop suite.
    const src = readFileSync(
      new URL("../../../apps/desktop/src/bridge-fetch.ts", import.meta.url), "utf8",
    );
    expect(src).toContain('baseUrl: "", fetch: bridgeFetch,');
    expect(src).toContain("...(stage ? { stageAttachments: true } : {})");
    expect(src.match(/stageAttachments: true/g) ?? []).toHaveLength(1);
  });

  it("the hosted webapp is the ONE place the option is turned on", () => {
    const src = readFileSync(
      new URL("../../../apps/webapp/app/shell/engine-config.ts", import.meta.url), "utf8",
    );
    expect(src).toContain("stageAttachments: true");
  });
});
