/**
 * A SEND THAT DEFINITELY DID NOT GO NAMES THE ROW IT LEFT, so the surface can bind it. A press
 * with no `draftId` makes the adapter create the row; when the send is then refused for good the
 * row is an ordinary draft again, and a surface that is never told which row it was creates a
 * second one on the next press (measured on a phone with the network cut: one row per press).
 *
 * The controls: a retryable refusal names nothing (it stays queued under its key), and the
 * `unverified` naming is untouched (send-ambiguity.test.ts owns it).
 */
import type { EngineMutation } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { HttpAdapter, MutationRejectedError } from "@ohmail/client-engine";

const SEND = {
  kind: "mail_send", inReplyTo: null, mailboxId: "mbx-1", subject: "offline", body: "one letter",
  to: [{ name: null, address: "to@example.test" }], cc: [], bcc: [],
} as unknown as EngineMutation;

function scripted(script: Array<() => Response>): HttpAdapter {
  let i = 0;
  const fetchImpl = async (): Promise<Response> => script[Math.min(i++, script.length - 1)]!();
  return new HttpAdapter({ baseUrl: "http://x", fetch: fetchImpl as unknown as typeof fetch } as never);
}

const created = (id: string): Response => new Response(JSON.stringify({ id }), { status: 201 });
const refusal = async (a: HttpAdapter, key: string, m: EngineMutation = SEND): Promise<MutationRejectedError> =>
  a.mutate(m, { idempotencyKey: key }).then(() => { throw new Error("the send was not refused"); }, (e: unknown) => e as MutationRejectedError);

describe("a terminal send refusal names the draft row it left", () => {
  it("409 `failed` — the reservation spent — names the row the press created", async () => {
    const err = await refusal(scripted([
      () => created("row-1"),
      () => new Response(JSON.stringify({ status: "failed", message: "not delivered" }), { status: 409 }),
    ]), "k-1");
    expect(err.code).toBe("send_failed");
    expect(err.retryable).toBe(false);
    expect(err.entityId, "the refused send's row is not named, so the next press makes a second").toBe("row-1");
  });

  it("a typed refusal from the pipeline (not secured) names it too", async () => {
    const err = await refusal(scripted([
      () => created("row-2"),
      () => new Response(JSON.stringify({ error: { code: "send_not_secured", message: "x", retryable: false } }), { status: 502 }),
    ]), "k-2");
    expect(err.code).toBe("send_not_secured");
    expect(err.entityId).toBe("row-2");
  });

  it("a press that carried its row gets that row back", async () => {
    const err = await refusal(scripted([
      () => new Response(JSON.stringify({ id: "mine-1", bcc: [], mailboxId: "mbx-1" }), { status: 200 }),
      () => new Response(JSON.stringify({ status: "failed" }), { status: 409 }),
    ]), "k-3", { ...(SEND as object), draftId: "mine-1" } as unknown as EngineMutation);
    expect(err.entityId).toBe("mine-1");
  });

  it("CONTROL: a retryable refusal names nothing — it stays on the queue under its key", async () => {
    const err = await refusal(scripted([
      () => created("row-4"),
      () => new Response(JSON.stringify({ error: { code: "internal", message: "internal error" } }), { status: 500 }),
    ]), "k-4");
    expect(err.retryable).toBe(true);
    expect(err.entityId).toBeNull();
  });
});
