import { localStorageDoor, type StorageDoor } from "@ohmail/app-logic/storage/durable";
import { readOwner } from "@ohmail/app-logic/storage/owner-cookie";

/**
 * THE ACCOUNT FACE'S MIRROR NAMES ITS ACCOUNT. `ohmail.face.account` holds the account's look for the next
 * boot's pre-paint stamp (`ThemeProvider`'s `accountFaceStorageKey`), and nothing in it says whose look it is,
 * so its owner goes beside it. The mailbox boot and the one-account sweep both use that owner stamp.
 */
export const FACE_ACCOUNT_KEY = "ohmail.face.account";
export const FACE_ACCOUNT_OWNER_KEY = "ohmail.face.account.owner";

/** The account allowed to supply the mailbox document's saved face. */
export function faceMirrorOwner(cookie: string): string | null {
  return readOwner(cookie);
}

/**
 * `door`, with the face mirror's writes naming the account the jar names. The name goes first and is written
 * last, so a write that stops partway leaves a mirror naming nobody, never the wrong account.
 */
export function faceMirrorDoor(door: StorageDoor): StorageDoor {
  return {
    get: (key) => door.get(key),
    set(key, value) {
      if (key !== FACE_ACCOUNT_KEY) return door.set(key, value);
      door.remove(FACE_ACCOUNT_OWNER_KEY);
      const out = door.set(key, value);
      const owner = readOwner();
      if (out === "stored" && owner !== null) door.set(FACE_ACCOUNT_OWNER_KEY, owner);
      return out;
    },
    remove(key) {
      if (key !== FACE_ACCOUNT_KEY) return door.remove(key);
      door.remove(FACE_ACCOUNT_OWNER_KEY);
      return door.remove(key);
    },
  };
}

let themeStorage: StorageDoor | undefined;

function themeDoor(): StorageDoor {
  return (themeStorage ??= faceMirrorDoor(localStorageDoor("theme")));
}

/** The browser opens the storage door on use. The server only reads the request's owner. */
export const THEME_DOOR: StorageDoor = {
  get: (key) => themeDoor().get(key),
  set: (key, value) => themeDoor().set(key, value),
  remove: (key) => themeDoor().remove(key),
};

export function currentFaceOwner(): string | null {
  return readOwner();
}

/** Only the account confirmed for this document can initialize its face from storage. */
export function accountThemeDoor(confirmedOwner: string | null): StorageDoor {
  return {
    ...THEME_DOOR,
    get(key) {
      if (key === FACE_ACCOUNT_KEY && (confirmedOwner === null || readOwner() !== confirmedOwner
        || THEME_DOOR.get(FACE_ACCOUNT_OWNER_KEY) !== confirmedOwner)) return null;
      return THEME_DOOR.get(key);
    },
  };
}
