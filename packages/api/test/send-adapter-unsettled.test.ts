import { describe, expect, it } from "vitest";
import { accounts, mailboxes, mailboxCredentials } from "@trafficflow/db";
import { makeSendAdapter } from "../src/send-adapter.js";
import { makeDeps } from "./helpers.js";

/**
 * ═══ A SEND REFUSES WHEN THE SUBMISSION SERVER WAS TRIED AND REFUSED ═══════════════════════
 *
 * `makeSendAdapter` falls back to `imap host:587` with the imap secret when a mailbox has no
 * `smtp` credential row. That is the single-credential generic-IMAP convention and it is right for
 * a mailbox that never named a submission server — many providers use one password for both, and a
 * send that then fails at the server is an honest failure.
 *
 * It is WRONG for a mailbox whose submission server was dialled and refused. The local door stores
 * the incoming credential in that case and records the reason, precisely so a working mailbox is
 * not held hostage to a blocked port — and in that state the fallback would dial a server the
 * person has already been told does not work, with a password it has already refused, and report
 * whatever came back as a fresh failure. They are owed the sentence they were given at connect.
 *
 * So the ABSENCE of an smtp row is read together with the marker on the imap row: no marker, guess
 * as before; a marker, refuse with it. Both halves are here, because the refusal is only correct
 * if the guess still happens for everybody else.
 */

async function seed(
  deps: Awaited<ReturnType<typeof makeDeps>>,
  imapMetaExtra: Record<string, unknown>,
  withSmtpRow: boolean,
): Promise<string> {
  const [acct] = await deps.db.insert(accounts).values({ email: "a@example.test" }).returning();
  const [mb] = await deps.db.insert(mailboxes).values({
    accountId: acct!.id, provider: "imap", address: "u@example.net",
  }).returning();
  const imapSecret = await deps.deps.keyProvider.encrypt("imap-pass");
  await deps.db.insert(mailboxCredentials).values({
    mailboxId: mb!.id, accountId: mb!.accountId, transport: "imap",
    secretEnc: imapSecret.ciphertext, keyVersion: imapSecret.keyVersion,
    meta: {
      host: "imap.example.net", port: 993, secure: true, user: "u@example.net",
      ...imapMetaExtra,
    },
  });
  if (withSmtpRow) {
    const enc = await deps.deps.keyProvider.encrypt("smtp-pass");
    await deps.db.insert(mailboxCredentials).values({
      mailboxId: mb!.id, accountId: mb!.accountId, transport: "smtp",
      secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
      meta: { host: "smtp.example.net", port: 587, secure: false, user: "u@example.net" },
    });
  }
  return mb!.id;
}

/**
 * What the adapter was CONSTRUCTED with — the seam `makeSendAdapter` takes for exactly this.
 *
 * It is the FOURTH argument. The third is `opts` (network timeouts), which every existing caller
 * already passes there, and `{}` is what these cases hand it: nothing in them is about a timeout.
 */
function recorder() {
  const built: Array<{ smtpHost: string }> = [];
  return {
    built,
    newAdapter: ((cfg: { smtp?: { host?: string } }) => {
      built.push({ smtpHost: cfg.smtp?.host ?? "" });
      return {
        connect: async (): Promise<void> => undefined,
        close: async (): Promise<void> => undefined,
      };
    }) as never,
  };
}

describe("a mailbox whose submission server is unsettled", () => {
  it("REFUSES the send with that state rather than falling back to a guess", async () => {
    const d = await makeDeps();
    const id = await seed(d, { smtpUnsettled: "auth", smtpHost: "smtp.blocked.test" }, false);
    const rec = recorder();

    await expect(makeSendAdapter(d.deps, id, {}, rec.newAdapter))
      .rejects.toThrow(/Sending is not set up/);
    /* AND NO TRANSPORT WAS BUILT. Not "the message was right" — nothing dialled, so the person
       cannot be shown a second, different failure from a server they were already told about. */
    expect(rec.built, "a transport was constructed for an unsettled submission server").toEqual([]);
  });

  it("and the refusal says RECEIVING WORKS, because it does", async () => {
    // The whole point of the state: an outgoing server is not a reason to stop receiving, and the
    // sentence a person meets at the send has to agree with the mailbox they can see syncing.
    const d = await makeDeps();
    const id = await seed(d, { smtpUnsettled: "connect" }, false);
    await expect(makeSendAdapter(d.deps, id, {}, recorder().newAdapter))
      .rejects.toThrow(/Receiving works/);
  });

  it("STILL GUESSES for a mailbox that never named a submission server", async () => {
    /* The positive control, and it is what keeps the refusal narrow: a mailbox with no smtp row
       and NO marker is the ordinary shared-credential provider, and it must go on sending through
       `imap host:587` exactly as it always has. Without this the case above could pass because the
       fallback had been removed for everybody. */
    const d = await makeDeps();
    const id = await seed(d, {}, false);
    const rec = recorder();
    await makeSendAdapter(d.deps, id, {}, rec.newAdapter);
    expect(rec.built.map((b) => b.smtpHost)).toEqual(["imap.example.net"]);
  });

  it("and a mailbox WITH an smtp row is untouched by the marker", async () => {
    /* A stale marker must not outrank a proven row. The repair writes `smtpUnsettled: ""` in the
       same patch that stores the row, so this state should not occur — and if it ever does, the
       row is the stronger evidence: something was proved against that server. */
    const d = await makeDeps();
    const id = await seed(d, { smtpUnsettled: "auth" }, true);
    const rec = recorder();
    await makeSendAdapter(d.deps, id, {}, rec.newAdapter);
    expect(rec.built.map((b) => b.smtpHost)).toEqual(["smtp.example.net"]);
  });
});
