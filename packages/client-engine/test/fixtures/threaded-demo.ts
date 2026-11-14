import { FixturesAdapter, DEMO_NOW } from "@ohmail/testing/adapter";
import type { EngineAdapter } from "../../src/adapters/adapter.js";
import { OhmailEngine } from "../../src/engine.js";
import { MutationRejectedError, type SyncChange } from "../../src/types.js";
import { managedDomain } from "../../../../test/support/fixture-credentials.js";

/**
 * THE OWNER'S CONVERSATION (2026-09-28), over the demo world: `giulia` is H, the newest unread
 * member of thread T; `techcheck` and `glazecall` are T's read history and `t-sent` the account's
 * own earlier reply in it; `petra` is an unrelated unread conversation U. Every page and every
 * echo is stamped, so a drain never un-threads a row. `fault` makes the next sends answer 202,
 * refuse, or fail retryably. Shared by the engine's and the webapp's tests.
 */
export const THREAD: Readonly<Record<string, string>> = { giulia: "T", techcheck: "T", glazecall: "T", petra: "U" };
export const OWN_REPLY_AT = "2026-07-29T08:41:00.000Z";
export type SendFault = "none" | "queued" | "refused" | "offline";

export function threadedAdapter(): { adapter: EngineAdapter; fault: (f: SendFault) => void } {
  const inner = new FixturesAdapter();
  let fault: SendFault = "none";
  let seeded = false;
  const stamp = (c: SyncChange): SyncChange =>
    c.type === "message" && c.entity && THREAD[c.id]
      ? { ...c, entity: { ...(c.entity as object), threadId: THREAD[c.id] } }
      : c;
  const adapter: EngineAdapter = {
    fetchBody: () => inner.fetchBody(),
    withdrawSend: (key, draftId) => inner.withdrawSend(key, draftId),
    async sync(params) {
      const r = await inner.sync(params);
      const creates = r.changes.creates.map(stamp);
      const base = creates.find((c) => c.type === "message" && c.id === "techcheck");
      if (!seeded && base) {
        seeded = true;
        creates.push({ ...base, id: "t-sent", entity: {
          ...(base.entity as object), id: "t-sent", folder: "Sent", unread: false,
          date: OWN_REPLY_AT, sortAt: OWN_REPLY_AT, messageIdHeader: `<t-sent@demo.${managedDomain()}>`,
        } });
      }
      return { ...r, changes: { ...r.changes, creates, updates: r.changes.updates.map(stamp), moves: r.changes.moves.map(stamp) } };
    },
    async mutate(m, o) {
      if (m.kind === "mail_send" && fault === "queued") {
        return { settlement: "queued", queuedWith: { name: null }, requestId: null, changes: [], seq: null };
      }
      if (m.kind === "mail_send" && fault === "refused") {
        throw new MutationRejectedError("refused", { status: 422, code: "invalid", retryable: false });
      }
      if (m.kind === "mail_send" && fault === "offline") {
        throw new MutationRejectedError("socket closed", { code: "network", retryable: true });
      }
      const out = await inner.mutate(m, o);
      return { ...out, changes: out.changes.map(stamp) };
    },
  };
  return { adapter, fault: (f) => { fault = f; } };
}

export async function threadedEngine(): Promise<{ engine: OhmailEngine; fault: (f: SendFault) => void }> {
  const { adapter, fault } = threadedAdapter();
  const engine = new OhmailEngine({ adapter, now: () => DEMO_NOW });
  await engine.start();
  return { engine, fault };
}
