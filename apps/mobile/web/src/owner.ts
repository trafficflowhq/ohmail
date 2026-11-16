/**
 * THE PAGE'S STORAGE IS THE SCOPE'S. Every scope shares the page's one origin, so the key families a person's words
 * and presses live in are told apart by the storage owner alone. It is set to the scope native minted, as the host's
 * answer, and read back before anything mounts: a cookie that named another owner (the page holds none) or an owner
 * that is not the scope refuses the mount, rather than letting one account's words be read under another's.
 */
import { setStorageOwner, storageOwnerState } from "@ohmail/app-logic/storage/storage-owner";

export class StorageNotOwned extends Error {
  constructor(readonly source: string) {
    super(`the page's storage is not the scope's (its owner comes from ${source})`);
    this.name = "StorageNotOwned";
  }
}

export function ownStorage(scope: string): void {
  setStorageOwner(scope);
  const state = storageOwnerState();
  if (state.source !== "host" || state.owner !== scope) throw new StorageNotOwned(state.source);
}
