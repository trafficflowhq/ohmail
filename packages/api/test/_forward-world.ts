import { vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createApp, apiRoutes, makeOpenAdapter } from "@trafficflow/api";
import { attachments, drafts, mailboxCredentials, outboundSends } from "@trafficflow/db";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core/mail";
import { FIXED_NOW, makeDeps, req, seedBody, seedMailbox, seedMessage, seedSession } from "./helpers.js";

/**
 * A FORWARD WHOSE ORIGINAL IS READ THROUGH THE SHIPPING FETCH DOOR. `POST /drafts/:id/send` builds
 * its own `makeOpenAdapter(deps)` for the original, so the per-mailbox cap, its two-second slot wait
 * and the shared counter's refusal are the real code; the IMAP socket and the SMTP leg are the only
 * doubles. `admission` is the host's shared counter: `"device"` admits every slot, as the Desktop and
 * phone engines compose it (`apps/sidecar/src/engine.ts`, the in-process gate still applies);
 * `"cloud"` is the database counter, which only the Postgres store carries.
 */

const PDF = new Uint8Array([37, 80, 68, 70]);

export async function forwardWorld(o: { admission: "device" | "cloud" }) {
  const smtp = { dials: 0, delivered: [] as OutboundMessage[] };
  const open: OpenSendAdapter = async () => {
    smtp.dials += 1;
    return {
      async send(msg) { smtp.delivered.push(msg); return { providerMessageId: msg.messageId ?? "<none>" }; },
      async messageInSent() { return false; },
      async close() { /* nothing to tear down */ },
    };
  };
  const made = await makeDeps(FIXED_NOW, {}, { sendAdapter: open });
  // `makeDeps` stubs the dial and the close; the part read and the abandon path are this world's.
  vi.spyOn(ImapAdapter.prototype, "fetchPart").mockResolvedValue({ contentType: "application/pdf", filename: "plan.pdf", body: PDF });
  vi.spyOn(ImapAdapter.prototype, "forceClose").mockImplementation(() => { /* no socket to destroy */ });
  if (o.admission === "device") {
    (made.deps.services as { imapAdmission: unknown }).imapAdmission = { acquire: async () => true, release: async () => {} };
  }
  const s = await seedSession(made.db, { now: FIXED_NOW });
  const mailboxId = await seedMailbox(made.db, { accountId: s.accountId });
  const sealed = await made.deps.keyProvider.encrypt(randomUUID());
  await made.db.insert(mailboxCredentials).values({
    mailboxId, transport: "imap", secretEnc: sealed.ciphertext, keyVersion: sealed.keyVersion,
    meta: { host: "imap.forward-cap.example", port: 993, secure: true, user: "me@forward-cap.example" },
  });
  const original = await seedMessage(made.db, {
    accountId: s.accountId, mailboxId, subject: "Q3 plan", fromAddress: "lena@atelier.example",
    date: FIXED_NOW, nativeLocator: { folder: "INBOX", ref: "12:7" },
  });
  await seedBody(made.db, { messageId: original.id, text: "Here is the plan.", html: null });
  await made.db.insert(attachments).values({
    accountId: s.accountId, messageId: original.id, filename: "plan.pdf", contentType: "application/pdf",
    sizeBytes: PDF.byteLength, partId: "2", inline: false,
  });
  const [d] = await made.db.insert(drafts).values({
    accountId: s.accountId, mailboxId, subject: "Fwd: Q3 plan", body: "Passing this along.",
    to: [{ name: null, address: "sam@example.test" }], cc: [], bcc: [], status: "draft",
    createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  } as never).returning();
  const draftId = (d as { id: string }).id;
  const app = createApp(apiRoutes);
  return {
    ...made, smtp, mailboxId, draftId,
    press: (key: string): Promise<Response> => app.handle(req("POST", `/drafts/${draftId}/send`, {
      bearer: s.token, headers: { "idempotency-key": key }, body: JSON.stringify({ forwardOf: original.id }),
    }), { ...made.deps, session: null, idempotency: null }),
    /** Both of the mailbox's slots, taken through the door itself (as two downloads would) and held until released. */
    holdBothSlots: async (): Promise<() => Promise<void>> => {
      const door = makeOpenAdapter(made.deps);
      const held = [await door(mailboxId), await door(mailboxId)];
      return async () => { for (const h of held) await h.close(); };
    },
    row: async () => (await made.db.select().from(outboundSends).where(eq(outboundSends.draftId, draftId)))[0],
    draftStatus: async () => (await made.db.select({ status: drafts.status }).from(drafts).where(eq(drafts.id, draftId)))[0]?.status,
  };
}

/** The fields of an answer a case reads, the wait in both places a client could find it. */
export async function answer(res: Response) {
  const body = await res.json() as { status?: string; error?: { code?: string; retryable?: boolean; details?: { retryAfter?: unknown } } };
  return {
    status: res.status, code: body.error?.code, retryable: body.error?.retryable,
    retryAfter: body.error?.details?.retryAfter, header: res.headers.get("retry-after"), wire: body.status,
  };
}
