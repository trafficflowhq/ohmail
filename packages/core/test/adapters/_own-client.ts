import { vi } from "vitest";
import { ImapFlow } from "imapflow";
import { ImapAdapter, type ImapAdapterOpts, type ImapConfig } from "../../src/adapters/imap.js";

/**
 * An adapter connected the way every product caller connects it (it builds and dials its own
 * client), with that client handed to the test so a case can watch the wire beside the adapter
 * without reaching into it. The client is taken where the adapter dials it, at
 * `ImapFlow.prototype.connect`, only for the span of `connect()`. An injected `opts.client` would
 * be simpler, but it sends `connect()` down its other branch, which skips the adapter's own dial
 * and the patches it applies there.
 */
export async function connectedWithOwnClient(
  cfg: ImapConfig, opts: Omit<ImapAdapterOpts, "client"> = {},
): Promise<{ adapter: ImapAdapter; client: ImapFlow }> {
  const adapter = new ImapAdapter(cfg, opts);
  const dial = vi.spyOn(ImapFlow.prototype, "connect");
  let dialled: ImapFlow[];
  try {
    await adapter.connect();
    dialled = dial.mock.contexts as ImapFlow[];
  } finally {
    dial.mockRestore();
  }
  if (dialled.length !== 1) {
    await adapter.close().catch(() => undefined);
    throw new Error(`the adapter dialled ${dialled.length} clients on connect(), expected one`);
  }
  return { adapter, client: dialled[0]! };
}
