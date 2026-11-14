import { describe, expect, it } from "vitest";
import { accounts, mailboxes, mailboxCredentials } from "@trafficflow/db";
import { SendConnections, type KeepTimers } from "@trafficflow/core/mail";
import type { ImapConfig } from "@trafficflow/core/adapters/imap";
import { SEND_RECONCILE_NET_TIMEOUTS } from "@trafficflow/services";
import { makeSendAdapter } from "../src/send-adapter.js";
import { makeDeps } from "./helpers.js";

/**
 * `makeSendAdapter` DIALS THROUGH THE KEEPER. The wire reading (one LOGIN over three presses)
 * lives in `apps/worker/test/send-warm-connection.e2e.test.ts` over the keeper and a real
 * adapter; this pins the factory's half — the production door reaches the keeper at all, and a
 * double without `isLive` (every existing fake) is never kept. THE MUTATION THAT MAKES THIS RED:
 * `return keep.open(mailboxId, …)` in `send-adapter.ts` replaced by calling the dial closure
 * directly — (1) builds and connects twice. Watched fail and restored.
 */

const USER = "u@keeper.example";

async function seed(d: Awaited<ReturnType<typeof makeDeps>>): Promise<string> {
  const [acct] = await d.db.insert(accounts).values({ name: "keeper" }).returning();
  const [mb] = await d.db.insert(mailboxes).values({ accountId: acct!.id, provider: "imap", address: USER }).returning();
  for (const transport of ["imap", "smtp"] as const) {
    const enc = await d.deps.keyProvider.encrypt(`${transport}-pass`);
    await d.db.insert(mailboxCredentials).values({
      mailboxId: mb!.id, transport, secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
      meta: { host: `${transport}.keeper.example`, port: transport === "imap" ? 993 : 587, secure: transport === "imap", user: USER },
    });
  }
  return mb!.id;
}

/** A recorder like the pin test's, with `isLive` when asked for — the keeper's admission. */
function recorder(withIsLive: boolean) {
  const built: ImapConfig[] = [];
  let connects = 0;
  let forced = 0;
  const newAdapter = ((cfg: ImapConfig) => {
    built.push(cfg);
    return {
      connect: async (): Promise<void> => { connects += 1; },
      close: async (): Promise<void> => undefined,
      forceClose: (): void => { forced += 1; },
      send: async () => ({ providerMessageId: "<m@x>", sentLocator: { folder: "Sent", ref: "1:1" }, raw: Buffer.alloc(0) }),
      messageInSent: async () => false,
      ...(withIsLive ? { isLive: (): boolean => true } : {}),
    };
  }) as never;
  return { built, connects: () => connects, forced: () => forced, newAdapter };
}

const timers: KeepTimers = { set: () => 0, clear: () => undefined };

describe("makeSendAdapter — the production door dials through the keeper", () => {
  it("(1) two presses on one mailbox build and connect ONE adapter when it can say it is live", async () => {
    const d = await makeDeps();
    const mailboxId = await seed(d);
    const rec = recorder(true);
    const keep = new SendConnections({ timers });
    const one = await makeSendAdapter(d.deps, mailboxId, {}, rec.newAdapter, keep);
    await one.close();
    const two = await makeSendAdapter(d.deps, mailboxId, {}, rec.newAdapter, keep);
    await two.close();
    expect(rec.built).toHaveLength(1);
    expect(rec.connects()).toBe(1);
    expect(keep.size()).toBe(1);
  });

  it("(2) a double that cannot say it is live is dialled every time — the existing fakes' shape (the control)", async () => {
    const d = await makeDeps();
    const mailboxId = await seed(d);
    const rec = recorder(false);
    const keep = new SendConnections({ timers });
    await (await makeSendAdapter(d.deps, mailboxId, {}, rec.newAdapter, keep)).close();
    await (await makeSendAdapter(d.deps, mailboxId, {}, rec.newAdapter, keep)).close();
    expect(rec.built).toHaveLength(2);
    expect(rec.connects()).toBe(2);
    expect(keep.size()).toBe(0);
  });

  it("(3) a mailbox with no credential rows still refuses before the keeper is asked", async () => {
    const d = await makeDeps();
    const keep = new SendConnections({ timers });
    // The shared credential reader's refusal (`requireImapCredential`); consumer: the send's sentence.
    await expect(makeSendAdapter(d.deps, "00000000-0000-4000-8000-000000000000", {}, recorder(true).newAdapter, keep))
      .rejects.toMatchObject({ code: "mailbox_not_signed_in", httpStatus: 424, retryable: false });
    expect(keep.size()).toBe(0);
  });
});

describe("makeSendAdapter — what a caller asks of the door reaches the connection it built", () => {
  // A pass that abandons a hung command escapes only through this: a polite close queues behind the hang.
  it("forceClose on the adapter it hands back destroys that connection, kept or not", async () => {
    for (const kept of [false, true]) {
      const d = await makeDeps();
      const mailboxId = await seed(d);
      const rec = recorder(kept);
      const adapter = await makeSendAdapter(d.deps, mailboxId, {}, rec.newAdapter, new SendConnections({ timers }));
      expect(adapter.forceClose, "the door hands back no way to abandon the connection").toBeTypeOf("function");
      adapter.forceClose!();
      expect({ kept, forced: rec.forced() }).toEqual({ kept, forced: 1 });
    }
  });

  it("the deadlines a pass hands in are the ones its connection is built with; a press hands none", async () => {
    const d = await makeDeps();
    const mailboxId = await seed(d);
    const rec = recorder(false);
    const keep = new SendConnections({ timers });
    await (await makeSendAdapter(d.deps, mailboxId, { timeouts: SEND_RECONCILE_NET_TIMEOUTS }, rec.newAdapter, keep)).close();
    await (await makeSendAdapter(d.deps, mailboxId, {}, rec.newAdapter, keep)).close();
    expect(rec.built.map((cfg) => cfg.timeouts)).toEqual([SEND_RECONCILE_NET_TIMEOUTS, undefined]);
  });
});
