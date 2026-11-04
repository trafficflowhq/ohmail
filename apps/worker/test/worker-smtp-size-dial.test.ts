import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:net";
import {
  classifySmtpSizeFailure, learnSmtpMaxSize, type SmtpSizeCreds,
} from "@trafficflow/core/adapters/imap";
import {
  ALLOW_ANY_DIAL_HOST, MailboxHostRefused, makeDialHostGuard, type DialHostGuard,
} from "../src/dial-host-guard.js";
import { makeSmtpSizeDial } from "../src/smtp-size.js";

/**
 * THE ORGANIZER'S FIFTH DIAL — the `SIZE` back-fill's submission probe, which was the one site
 * that handed a stored name to a fresh socket with no check and no pin while the four adapter
 * sites beside it checked. It is measured HERE rather than at the helper, because the question is
 * not whether `checkedDial` refuses (`worker-dial-host-guard.test.ts` measures that) but whether
 * a refusal means NO SOCKET IS OPENED on the path the pass actually runs: `learnSmtpMaxSize` owns
 * the try/catch around the dial, so a guard wired one call too high would be swallowed silently.
 * The reading is a real listener's own connection count, never an assertion about intent.
 */

/** A listener that counts connections and speaks nothing — no bytes are read, none are written. */
async function countingListener(): Promise<{ port: number; seen: string[]; close: () => Promise<void> }> {
  const seen: string[] = [];
  const server: Server = createServer((s) => { seen.push("connected"); s.destroy(); });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  return {
    port: (server.address() as { port: number }).port,
    seen,
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}

/** The credential shape `loadMailboxCreds` hands the pass, with a placeholder nobody can dial. */
const creds = (host: string, port: number): SmtpSizeCreds => ({
  host, port, secure: false, auth: { user: "probe", pass: "inert-entry-password" },
});

/** A resolver the test owns — the managed guard takes one at construction for exactly this. */
const noAnswers = { resolve: async (): Promise<string[]> => { throw new Error("no answer"); } };

/** A policy that CLEARS a name to a chosen address. Not a deployment's policy — a seam driver. */
const clearsTo = (addresses: readonly string[]): DialHostGuard => ({ check: async () => addresses });

async function learnThrough(guard: DialHostGuard | undefined, smtp: SmtpSizeCreds): Promise<unknown> {
  return learnSmtpMaxSize({
    mailboxId: "11111111-1111-1111-1111-111111111111",
    announced: null,
    smtp,
    attempted: new Set<string>(),
    dial: makeSmtpSizeDial(guard),
  });
}

describe("the SIZE back-fill dials under the deployment's host policy", () => {
  it("REFUSES a submission host the policy will not dial, and opens no socket at all", async () => {
    const listener = await countingListener();
    try {
      // The stored submission host IS the listener. Under the managed policy a private literal is
      // decided with no lookup at all, so the listener's own count is the whole reading.
      const out = await learnThrough(makeDialHostGuard(noAnswers), creds("127.0.0.1", listener.port));
      expect(out, "a refused probe costs this mailbox its ceiling and nothing else")
        .toEqual({ outcome: "failed", code: "unreachable" });
      expect(listener.seen, "the refusal must happen before a socket exists").toEqual([]);
    } finally {
      await listener.close();
    }
  });

  it("DOES dial the same listener under the admitting policy — the refusal above is the POLICY's", async () => {
    // The positive control. Without it "nothing connected" is satisfied by a back-fill that never
    // dials on any policy, which is precisely the state a bug in the factory would produce.
    const listener = await countingListener();
    try {
      await learnThrough(ALLOW_ANY_DIAL_HOST, creds("127.0.0.1", listener.port));
      expect(listener.seen, "the self-hosted organizer must still reach its own LAN server")
        .toEqual(["connected"]);
    } finally {
      await listener.close();
    }
  });

  it("THREADS THE CLEARED ADDRESS into the dial — the name alone would never have connected", async () => {
    // The pin's own arm, and it discriminates by construction: `mail.example.test` resolves
    // nowhere in this suite, so a connection at the listener can only have come from the cleared
    // address travelling through `verifySmtpLogin`. Drop the spread in `makeSmtpSizeDial` and the
    // dial goes to the NAME, which reaches no listener.
    const listener = await countingListener();
    try {
      await learnThrough(clearsTo(["127.0.0.1"]), creds("mail.example.test", listener.port));
      expect(listener.seen, "the cleared address never reached the socket").toEqual(["connected"]);
    } finally {
      await listener.close();
    }
  });

  it("REFUSES TO DIAL when no policy was composed — a site added later that forgets to thread it", async () => {
    const listener = await countingListener();
    try {
      const out = await learnThrough(undefined, creds("127.0.0.1", listener.port)) as { outcome: string };
      expect(out.outcome, "a composition with no policy is a refusal, never a silent dial").toBe("failed");
      expect(listener.seen, "no policy must mean no socket").toEqual([]);
    } finally {
      await listener.close();
    }
  });

  it("classifies the refusal as `unreachable`, not as `unknown`", async () => {
    // The closed set stays at five members — `mailboxes.smtp_size_probe_code` carries a CHECK
    // constraint over it — so the refusal joins the member that is true of it: no connection was
    // made. The second arm is what stops this being a rename of `unknown`.
    expect(classifySmtpSizeFailure(new MailboxHostRefused("smtp"))).toBe("unreachable");
    expect(classifySmtpSizeFailure(new Error("something else"))).toBe("unknown");
  });
});
