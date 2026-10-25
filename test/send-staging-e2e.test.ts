import { describe, expect, it } from "vitest";
import { mailboxes } from "@trafficflow/db";
import { attachmentStaging, makeSupabaseStagingStorage } from "@trafficflow/db/cloud";
import { makeAttachmentStagingPort } from "@trafficflow/services";
import { apiRoutes, createApp, type ApiDeps } from "@trafficflow/api";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { FIXED_NOW, makeDeps, seedSession } from "../packages/api/test/helpers.js";
import { HttpAdapter, MutationRejectedError, type EngineMutation, type FetchLike } from "@ohmail/client-engine";
import { stagingAdmits, stagingUploadSource } from "../apps/webapp/staging-origin.mjs";

/**
 * ═══ ACCEPTANCE: A REAL 5 MB FILE THROUGH THE WHOLE STACK, AND THE 0.9.3 REPLAY BESIDE IT ══
 *
 * Everything real except two seams. The wire client, `POST /attachments/staging`, the router and
 * its middleware, `SendService`, the staging port and the `attachment_staging` table are the
 * shipping code; the object store is an in-memory bucket behind the real `AttachmentStagingStorage`
 * interface, and SMTP is the same injected send spy every other send test uses. Five megabytes of
 * genuine bytes go in at the compose surface and are compared byte-for-byte at the transport.
 *
 * ## Why 5 MB is the number
 *
 * The hosted platform refuses a request body past its limit, which is why the inline ceiling
 * is 3 MB of raw bytes (base64 inflates by ~1.33×). Five megabytes is therefore a send that is
 * IMPOSSIBLE on the old transport and merely ordinary for a mailbox that announced 25 MB — which
 * is the entire claim of this slice, expressed as a test rather than as a paragraph.
 *
 * ## Why the replay case sits in the same file
 *
 * A desktop build already on somebody's machine forwards `POST /drafts/:id/send` verbatim to this
 * API, and it knows only the inline shape. Proving the new path works is half the acceptance; the
 * other half is that the old one still does, on the same deployment, at the same time — including
 * its refusal, which is the part a "make it accept everything" mistake would silently remove.
 *
 * This is the acceptance the live service cannot run before it is deployed: there is no bucket and
 * no route until the wave lands. Everything it asserts is deployment-independent.
 *
 * ## Why it lives in the repository's own test/ directory
 *
 * It spans four workspaces — the wire client, the route table, the services and the database — and
 * no single one of them may depend on all of them. `packages/client-engine` in particular has no
 * `drizzle-orm` dependency and must not gain one: it is published with the desktop client. The
 * repository directory is what a guard spanning workspaces is for, exactly as
 * `compose-attach-cap-parity.test.ts` records; its imports resolve through the suite's alias table
 * and the directory is never published.
 */

const app = createApp(apiRoutes);
const MIB = 1024 * 1024;

function makeSendSpy() {
  const delivered: OutboundMessage[] = [];
  const factory: OpenSendAdapter = async () => ({
    async send(msg: OutboundMessage) {
      delivered.push(msg);
      return { providerMessageId: msg.messageId ?? "<none>" };
    },
    async messageInSent() { return false; },
    async close() { /* nothing to release */ },
  });
  return { delivered, factory };
}

/**
 * An in-memory bucket behind the REAL storage interface, plus the fetch that serves its signed
 * URLs. The token is checked rather than decorative: a client that dropped the URL it was handed
 * and reconstructed one would be refused here, which is the property the grant's opacity buys.
 */
function bucket() {
  const objects = new Map<string, Uint8Array>();
  const tokens = new Map<string, string>();
  let n = 0;
  const storage = {
    async signUpload(objectPath: string, contentType: string) {
      const token = `tok-${++n}`;
      tokens.set(objectPath, token);
      return {
        uploadUrl: `http://storage.local/o/${encodeURIComponent(objectPath)}?token=${token}`,
        uploadMethod: "PUT",
        uploadHeaders: { "content-type": contentType, "x-upsert": "false" },
      };
    },
    async download(objectPath: string) {
      const b = objects.get(objectPath);
      if (!b) throw new Error("no such object");
      return b;
    },
    async remove(paths: readonly string[]) {
      for (const p of paths) objects.delete(p);
    },
  };
  const serve = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname.replace(/^\/o\//, ""));
    if (init?.method !== "PUT") return new Response("", { status: 405 });
    if (u.searchParams.get("token") !== tokens.get(path)) return new Response("", { status: 403 });
    const body = init.body as Uint8Array;
    objects.set(path, new Uint8Array(body));
    return new Response("", { status: 200 });
  };
  return { storage, serve, objects };
}

/** A signed-in account with a mailbox whose server announced 25 MB, and staging wired. */
async function world(opts: { announced?: number | null } = {}) {
  const spy = makeSendSpy();
  const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: spy.factory });
  const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
  // Inserted directly rather than through `seedMailbox`, because the announced SIZE is the whole
  // variable here and that helper does not take one. `drizzle-orm` is deliberately NOT imported:
  // this directory has no such dependency and `packages/client-engine` must never gain one.
  const [mb] = await db.insert(mailboxes).values({
    accountId: s.accountId,
    provider: "imap",
    address: `sender-${Math.random().toString(36).slice(2, 10)}@lichtgrat.example`,
    smtpMaxSizeBytes: opts.announced === undefined ? 25 * MIB : opts.announced,
  }).returning();
  const mailboxId = mb!.id;

  const store = bucket();
  const armed: ApiDeps = {
    ...deps,
    services: {
      ...deps.services!,
      // THE REAL PORT over the real table — only the bucket behind it is in memory.
      attachmentStaging: (handle) => makeAttachmentStagingPort({ db: handle, storage: store.storage }),
    },
  };

  const fetchImpl: FetchLike = async (url, init) => {
    if (url.startsWith("http://storage.local/")) return store.serve(url, init);
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    headers.set("authorization", `Bearer ${s.token}`);
    return app.handle(new Request(url, { ...init, headers }), {
      ...armed, session: null, idempotency: null,
    });
  };

  return { db, spy, mailboxId, store, fetchImpl, accountId: s.accountId };
}

const send = (mailboxId: string, files: Array<{ filename: string; bytes: Buffer }>): EngineMutation => ({
  kind: "mail_send",
  mailboxId,
  inReplyTo: null,
  subject: "the files you asked for",
  body: "attached.",
  to: [{ name: null, address: "you@example.com" }],
  attachments: files.map((f) => ({
    filename: f.filename,
    contentType: "application/octet-stream",
    contentBase64: f.bytes.toString("base64"),
  })),
} as EngineMutation);

describe("ACCEPTANCE — five megabytes, end to end", () => {
  it("a 5 MB file reaches the transport intact, on a mailbox that announced 25 MB", async () => {
    const { spy, mailboxId, store, fetchImpl, db, accountId } = await world();
    // Real bytes with a real shape, so a truncation or a re-encode shows up as a mismatch rather
    // than as a length that happens to agree.
    const bytes = Buffer.alloc(5 * MIB);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;

    const adapter = new HttpAdapter({
      baseUrl: "http://localhost", fetch: fetchImpl, stageAttachments: true,
    });
    const out = await adapter.mutate(send(mailboxId, [{ filename: "site-survey.pdf", bytes }]), {
      idempotencyKey: "acceptance-5mb",
    });
    // NARROWED, because `mutate` answers a union now: a 202 queued for the organizer has no
    // provider id to read, and a send is never one — the assertion says both.
    expect(out.settlement, "a send answered as queued for the organizer").not.toBe("queued");
    expect(out.settlement === "queued" ? null : out.providerMessageId).toBeTruthy();

    expect(spy.delivered).toHaveLength(1);
    const att = spy.delivered[0]!.attachments;
    expect(att).toHaveLength(1);
    expect(att![0]!.filename).toBe("site-survey.pdf");
    expect(att![0]!.content.byteLength).toBe(5 * MIB);
    // BYTE FOR BYTE. Everything between the compose surface and the transport — base64, a signed
    // upload, a bucket, a download — has to be lossless, and a length check would not say so.
    expect(Buffer.from(att![0]!.content).equals(bytes)).toBe(true);

    // ONE object, named for the account and the ticket, and the ticket row still stands: a send
    // does not consume it, so a retry under the same key finds the same bytes.
    expect(store.objects.size).toBe(1);
    const rows = await db.select().from(attachmentStaging);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.accountId).toBe(accountId);
    expect([...store.objects.keys()][0]).toBe(rows[0]!.objectPath);
    expect(rows[0]!.expiresAt.getTime()).toBe(FIXED_NOW.getTime() + 24 * 60 * 60 * 1000);
  });

  it("a mailbox that announced 4 MB refuses the same file — at the MINT, before any upload", async () => {
    // The stingy-provider case, which is what the per-file mint ceiling is for: the product must
    // not spend somebody's upload on a file their own server will bounce.
    const { spy, mailboxId, store, fetchImpl } = await world({ announced: 4 * MIB });
    const adapter = new HttpAdapter({
      baseUrl: "http://localhost", fetch: fetchImpl, stageAttachments: true,
    });
    await expect(adapter.mutate(send(mailboxId, [{ filename: "big.bin", bytes: Buffer.alloc(5 * MIB) }]), {
      idempotencyKey: "acceptance-stingy",
    })).rejects.toBeInstanceOf(MutationRejectedError);
    expect(spy.delivered).toHaveLength(0);
    expect(store.objects.size).toBe(0);
  });
});

describe("ACCEPTANCE — the 0.9.3 replay, on the same deployment", () => {
  it("an inline send still delivers, and its 3 MB refusal is still the refusal", async () => {
    // This is the request an already-installed desktop's Cloud door forwards verbatim: attachment
    // bytes in the body, no staged references, no mint call. Staging is armed on this host.
    const { spy, mailboxId, store, fetchImpl } = await world();
    const legacy = new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl });

    const bytes = Buffer.alloc(2 * MIB, 5);
    await legacy.mutate(send(mailboxId, [{ filename: "note.pdf", bytes }]), {
      idempotencyKey: "legacy-ok",
    });
    expect(spy.delivered).toHaveLength(1);
    expect(Buffer.from(spy.delivered[0]!.attachments![0]!.content).equals(bytes)).toBe(true);
    // NOTHING WAS STAGED. The old shape took the old path, on a host that offers the new one.
    expect(store.objects.size).toBe(0);

    // …and the ceiling that shape rides is still enforced. A "make it accept everything" mistake
    // would remove this silently, and the symptom would be a platform 413 nobody can read.
    const err = await legacy.mutate(send(mailboxId, [{ filename: "huge.bin", bytes: Buffer.alloc(4 * MIB) }]), {
      idempotencyKey: "legacy-too-big",
    }).catch((e: unknown) => e) as MutationRejectedError;
    expect(err).toBeInstanceOf(MutationRejectedError);
    expect(err.status).toBe(413);
    expect(spy.delivered).toHaveLength(1);
  });
});

describe("THE WEB PAGE MAY PUT A REAL STORAGE GRANT, AND ONLY ITS OWN PROJECT'S", () => {
  it("a grant `makeSupabaseStagingStorage` signs is under its project's upload source, and no other's", async () => {
    // The page policy (`apps/webapp/staging-origin.mjs`) and the grant the API hands out are two
    // spellings of one URL; were they to drift, every staged send from the browser would be refused.
    const origin = "https://abcdefghijklmnopqrst.storage.example";
    const signed = (async () => new Response(JSON.stringify({
      url: "/object/upload/sign/attachment-staging/acct-1/ticket-1?token=t",
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const storage = makeSupabaseStagingStorage({ url: origin, serviceKey: "test-only", bucket: "attachment-staging" }, signed);
    const grant = await storage.signUpload("acct-1/ticket-1", "application/pdf");

    const page = "https://ohmail.app";
    expect(stagingAdmits(grant.uploadUrl, stagingUploadSource(origin), page)).toBe(true);
    expect(stagingAdmits(grant.uploadUrl, stagingUploadSource("https://zyxwvutsrqponmlkjihg.storage.example"), page)).toBe(false);
    expect(stagingAdmits(grant.uploadUrl, null, page), "a build naming no project admits it").toBe(false);
  });
});
