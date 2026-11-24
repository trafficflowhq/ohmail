/**
 * THE ACCOUNT RULE, ON THE PAGE'S ENGINE: no page of the feed whose entities name another account is
 * ever handed to the store. Wire records carry their `accountId`, and every `/sync` page and every
 * snapshot page is read here before the engine can apply it; one naming another account is a refused
 * drain (a visible sync error), never a merged copy. The drain routes themselves are held shut
 * natively until the identity verdict has settled (the shell's HTTP door).
 *
 * Every other capability is the adapter's own, unchanged: the wrapper is a proxy over it, so the
 * engine's reading of "does this door serve X" is the bare adapter's, and no capability can go
 * missing on the live path because a hand-written list forgot it.
 */
import { flattenResponse, type HttpAdapter, type SyncChange } from "./engine-package";

/** A refused drain: the feed named another account. */
export class AccountMismatch extends Error {
  readonly code = "account_mismatch";
  constructor(entityAccount: string, accountId: string) {
    super(`this server is syncing mail for account "${entityAccount}", not "${accountId}"`);
    this.name = "AccountMismatch";
  }
}

function check(changes: readonly SyncChange[], accountId: string): void {
  for (const ch of changes) {
    const entityAccount = (ch.entity as { accountId?: unknown } | undefined)?.accountId;
    if (typeof entityAccount === "string" && entityAccount !== accountId) throw new AccountMismatch(entityAccount, accountId);
  }
}

export function accountGuarded<A extends HttpAdapter>(adapter: A, accountId: string): A {
  const sync: HttpAdapter["sync"] = async (params) => {
    const resp = await adapter.sync(params);
    check(flattenResponse(resp), accountId);
    return resp;
  };
  const snapshot: HttpAdapter["snapshot"] = async (params) => {
    const page = await adapter.snapshot(params);
    check(page.changes, accountId);
    return page;
  };
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      if (prop === "sync") return sync;
      if (prop === "snapshot") return snapshot;
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
