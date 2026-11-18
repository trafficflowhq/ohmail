import type { AttachmentWire } from "@ohmail/wire";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { OhmailEngine } from "../src/engine.js";
import { MutationRejectedError } from "../src/types.js";
import { attachmentFaultClass } from "../src/index.js";
import type { EngineAdapter } from "../src/adapters/adapter.js";

/**
 * A FAILED FILE KEEPS THE REFUSAL'S FACTS. The engine's item held only `state` and the server's
 * English `error`, so no reader could tell a refused sign-in from ohmail failing, and every
 * reader offered the same retry. The item now carries `code`, `retryable` and `status` as the
 * list's failed arm does, and one pure table names the side.
 */

beforeEach(() => {
  (globalThis as { URL: unknown }).URL = { createObjectURL: () => "blob:1", revokeObjectURL: () => {} };
});
afterEach(() => {
  delete (globalThis as { URL?: unknown }).URL;
});

const wire: AttachmentWire = {
  id: "a1", filename: "f.pdf", contentType: "application/pdf", sizeBytes: 10, inline: false, messageId: "m1",
};

function engineFailingWith(thrown: unknown): OhmailEngine {
  const adapter: EngineAdapter = {
    sync: async () => ({ changes: [], cursor: "1", hasMore: false }) as never,
    mutate: async () => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
    listAttachments: async () => [wire],
    fetchAttachment: async () => { throw thrown; },
  };
  return new OhmailEngine({ adapter });
}

async function failedItem(thrown: unknown) {
  const engine = engineFailingWith(thrown);
  await engine.loadAttachments("m1");
  await engine.openAttachment("m1", "a1");
  const held = engine.attachmentsOf("m1");
  if (held.state !== "ready") throw new Error("the list did not land");
  return held.items[0]!;
}

describe("the failed item carries the refusal's facts", () => {
  it("a refusal the server stated: its code, its flag, its status", async () => {
    const i = await failedItem(new MutationRejectedError("refused", {
      status: 424, code: "mail_server_login_refused", retryable: false,
    }));
    expect({ state: i.state, code: i.code, retryable: i.retryable, status: i.status })
      .toEqual({ state: "failed", code: "mail_server_login_refused", retryable: false, status: 424 });
  });

  it("a throw nothing classified: no code, no status, and asking again is honest", async () => {
    const i = await failedItem(new TypeError("fetch broke"));
    expect({ state: i.state, code: i.code, retryable: i.retryable, status: i.status })
      .toEqual({ state: "failed", code: null, retryable: true, status: null });
  });

  it("CONTROL: the size ceiling stays its own state, not a failure", async () => {
    const i = await failedItem(new MutationRejectedError("too big", { status: 413, code: "payload_too_large" }));
    expect(i.state).toBe("too_large");
  });
});

describe("attachmentFaultClass — one class per side, code first, then status", () => {
  it.each([
    ["mailbox_busy", 429, "busy"],
    ["mail_server_unreachable", 424, "unreachable"],
    ["mailbox_read_timeout", 504, "unreachable"],
    ["mail_server_not_secured", 424, "not_secured"],
    ["mail_server_login_refused", 424, "login_refused"],
    ["mailbox_reconnect_required", 424, "reconnect"],
    ["mail_server_busy", 424, "server_busy"],
    ["mailbox_not_signed_in", 424, "not_signed_in"],
    // A build older than the two codes reads them by status: refused, with no Try again.
    [undefined, 424, "refused"],
    ["not_found", 404, "gone"],
    ["network", null, "offline"],
    ["timeout", null, "offline"],
    ["unauthorized", 401, "signed_out"],
    ["csrf_failed", 403, "signed_out"],
    ["internal", 500, "ohmail"],
    ["db_busy", 503, "ohmail"],
    ["upstream_unavailable", 502, "ohmail"],
    ["step_up_required", 403, "refused"],
    [null, 401, "signed_out"],
    [null, 400, "refused"],
    [null, 502, "ohmail"],
    ["something_new", null, "ohmail"],
  ] as const)("%s at %s → %s", (code, status, cls) => {
    expect(attachmentFaultClass(code, status)).toBe(cls);
  });

  it("no code and no answer at all — the adapter threw first — is offline", () => {
    expect(attachmentFaultClass(null)).toBe("offline");
    expect(attachmentFaultClass(undefined, null)).toBe("offline");
  });
});
