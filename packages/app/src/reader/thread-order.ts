import { localStorageDoor } from "@ohmail/app-logic/storage/durable";
import { threadOrderKey } from "@ohmail/app-logic/storage/persisted-ui";
import type { StorageScope } from "@ohmail/app-logic/storage/scope";

export type ThreadOrder = "bottom" | "top";

const storage = localStorageDoor("reader.subject");

export function readThreadOrder(scope: StorageScope): ThreadOrder {
  return storage.get(threadOrderKey(scope)) === "top" ? "top" : "bottom";
}

export function writeThreadOrder(scope: StorageScope, order: ThreadOrder): void {
  storage.set(threadOrderKey(scope), order);
}
