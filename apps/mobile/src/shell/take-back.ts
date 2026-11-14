/**
 * THE SHELL'S STORES SHARE THE MIRROR'S FATE. A scope's keeper (a person's words and the queue, native) and the web
 * view's copy of its mail are two more places a pairing's mail lives, so wherever a forget, a re-pair or a launch pays
 * a mirror's wipe, these are paid in the same step, before the debt is cleared, each read back. A fresh install wipes
 * every keeper and every view copy before the install is stamped.
 *
 * The view's copies of every scope live under one origin, and no page is trusted to delete its own: a page may be dead,
 * and one that is alive is the less trusted side. So native clears the web view's data whole, which is the safe
 * direction (every copy refills, and every other scope's words and queue are in its keeper), and every live view
 * starts over from its keeper.
 */
import { StoreFault, type ServerProfileStore } from "../state/servers";

/**
 * What the web view's storage says of the shell's origin after a clear: whether it still lists the origin, and the
 * bytes it counts there (null where the platform cannot count them). Android goes on listing an origin it emptied,
 * at no bytes, so the listing alone never shows the copy gone.
 */
export interface WebDataReading {
  readonly listed: boolean;
  readonly usage: number | null;
}

/** The copy is gone when the origin is not listed, or listed with nothing in it. */
export const viewCopyGone = (reading: WebDataReading): boolean => !reading.listed || reading.usage === 0;

/** The shell's native stores, as the connection layer needs them. A port: the module is native. */
export interface ShellStores {
  /** The scope of a mirror's owner key, as the shell names its stores. */
  scopeOf(ownerKey: string): Promise<string>;
  /** The scopes whose keeper is on this phone. */
  keeperScopes(): Promise<readonly string[]>;
  /** One scope's keeper removed; false when a read-back still finds any of its files. */
  forgetKeeper(scope: string): Promise<boolean>;
  /** Every scope's view copy removed; every live view starts over. What the storage reads afterwards. */
  clearViewCopies(): Promise<WebDataReading>;
}

/*
 * A store that stayed throws a coded fault, so the forget's refusal words it in the phone's language
 * (`faultDetail`), and the caller keeps the debt.
 */
async function forgetKeeper(stores: ShellStores, scope: string): Promise<void> {
  if (!(await stores.forgetKeeper(scope))) {
    throw new StoreFault("shell_keeper_not_deleted", `the shell's keeper of ${scope} is still on the phone`);
  }
}

async function clearViewCopies(stores: ShellStores): Promise<void> {
  if (!viewCopyGone(await stores.clearViewCopies())) {
    throw new StoreFault("shell_view_not_cleared", "the web view's copy is still on the phone");
  }
}

/** One owner's keeper and the view's copy, gone and read back. Throws, so the caller keeps the debt, when either stayed. */
export async function payShellWipe(stores: ShellStores, ownerKey: string): Promise<void> {
  await forgetKeeper(stores, await stores.scopeOf(ownerKey));
  await clearViewCopies(stores);
}

/** A fresh install: every keeper and every view copy, gone and read back. Throws when anything stayed. */
export async function wipeShellStores(stores: ShellStores): Promise<void> {
  for (const scope of await stores.keeperScopes()) await forgetKeeper(stores, scope);
  await clearViewCopies(stores);
}

/**
 * THE UPGRADE SENTINEL'S SECOND ARM. A missing install marker reads as a fresh install unless the container still
 * holds something only this install could have written; the screens' mirror was that, and the hand-across removes it.
 * The scope's keeper lives in the same container and is written at the shell's first start, before the old copy goes.
 */
export async function keeperRemembers(stores: ShellStores | undefined, ownerKey: string): Promise<boolean> {
  if (stores === undefined) return false;
  const scope = await stores.scopeOf(ownerKey);
  return (await stores.keeperScopes()).includes(scope);
}

/**
 * The profile store as the install marker reads it, with the shell's stores wiped first in its purge, so a fresh
 * install's wipe lands before the install is stamped, and a wipe that cannot land refuses the purge (the launch stops
 * and every later launch tries again). Every other call is the store's own.
 */
export function purgingShellToo(profiles: ServerProfileStore, stores: ShellStores | undefined): ServerProfileStore {
  if (stores === undefined) return profiles;
  return new Proxy(profiles, {
    get(target, key, receiver) {
      if (key === "purgeAll") {
        return async () => {
          await wipeShellStores(stores);
          await target.purgeAll();
        };
      }
      const value = Reflect.get(target, key, receiver) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
