import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { messages } from "@trafficflow/db";
import { materializeMessages } from "../src/dto/materialize.js";
import { MessageService } from "../src/message-service.js";
import { makeCtx, seedMessage } from "./helpers.js";

/**
 * `MessageDTO.authVerdict` — THE SERIALIZER HALF OF A WIRE FIELD WITH THREE HOMES: the type in
 * `dto/types.ts`, this projection, and the readers (`EngineMessage` in the client engine, the
 * sidecar's Cloud mirror). The column is `messages.auth_verdict`; the wire carries routing's four
 * words (`asAuthVerdict`), so a word from the other vocabulary is `null`, never passed through.
 */

const KEYS_EVERY_MESSAGE_CARRIES = [
  "accountId", "arrivedAt", "attachmentCount", "authVerdict", "autoReplyByUs", "awayRepliedAt", "cc", "date",
  "folder", "from", "hasAttachments", "id", "invitationWithoutEvent", "itipReplyHeader", "labels",
  "lastReadAt", "mailboxId", "messageIdHeader", "openReadAt", "remoteContent", "sensitivity", "snippet", "subject",
  "threadId", "to", "triage", "unread", "updatedAt",
];

describe("MessageDTO.authVerdict", () => {
  it("carries the stored verdict in routing's words, and null where nobody asked", async () => {
    const c = await makeCtx();
    const seed = (authVerdict: string | null, from: string) =>
      seedMessage(c.db, c.accountId, c.mailboxId, { folder: "INBOX", authVerdict, from });
    const fail = await seed("fail", "forged@x.test");
    const pass = await seed("pass", "real@x.test");
    const none = await seed(null, "quiet@x.test");
    const other = await seed("aligned", "dkim@x.test");
    const dtos = await materializeMessages(c.db, c.accountId, [fail, pass, none, other]);
    expect([fail, pass, none, other].map((id) => dtos.get(id)?.authVerdict))
      .toEqual(["fail", "pass", null, null]);
  });

  it("THE KEY CENSUS — every message on the wire names exactly these keys, authVerdict among them", async () => {
    const c = await makeCtx();
    await seedMessage(c.db, c.accountId, c.mailboxId, { folder: "INBOX", desired: "INBOX" });
    const page = await new MessageService().list(c.ctx, { view: "imbox", limit: 5 });
    expect(page.items).toHaveLength(1);
    expect(Object.keys(page.items[0]!).sort()).toEqual([...KEYS_EVERY_MESSAGE_CARRIES].sort());
  });
});

describe("MessageDTO.missingOnServer (mail 0164)", () => {
  it("says so only for a letter marked missing on the server, so a reader can show it", async () => {
    const c = await makeCtx();
    const lost = await seedMessage(c.db, c.accountId, c.mailboxId, { folder: "ohmail/News", from: "a@x.test" });
    const held = await seedMessage(c.db, c.accountId, c.mailboxId, { folder: "ohmail/News", from: "b@x.test" });
    await c.db.update(messages).set({ serverMissingAt: new Date() }).where(eq(messages.id, lost));
    const dtos = await materializeMessages(c.db, c.accountId, [lost, held]);
    expect(dtos.get(lost)?.missingOnServer).toBe(true);
    expect(Object.keys(dtos.get(held)!)).not.toContain("missingOnServer");
  });
});
