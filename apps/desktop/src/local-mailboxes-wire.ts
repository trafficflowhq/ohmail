import { bridgeFetch, retryingBridgeFetch } from "./bridge-fetch.js";
import { readMailboxRowsVia } from "./mailbox-facts-wire.js";

/** The native bridge reads the complete roster and submits an explicit resync. */
export const desktopMailboxRequests = {
  list: (options: { counts: boolean }) => readMailboxRowsVia(retryingBridgeFetch, options),
  async resync(id: string): Promise<void> {
    const response = await bridgeFetch(`/mailboxes/${encodeURIComponent(id)}/resync`, { method: "POST" });
    if (!response.ok) throw { status: response.status };
  },
};
