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
function faceMirrorDoor(door: StorageDoor, expectedOwner?: string | null): StorageDoor {
  return {
    get: (key) => door.get(key),
    set(key, value) {
      if (key !== FACE_ACCOUNT_KEY) return door.set(key, value);
      const owner = readOwner();
      if (expectedOwner !== undefined && (expectedOwner === null || owner !== expectedOwner)) return "lost";
      if (door.remove(FACE_ACCOUNT_OWNER_KEY) !== "stored") return "lost";
      const out = door.set(key, value);
      if (out !== "stored" || owner === null) return out;
      if (readOwner() !== owner) {
        door.remove(FACE_ACCOUNT_OWNER_KEY);
        return "lost";
      }
      const stamped = door.set(FACE_ACCOUNT_OWNER_KEY, owner);
      if (stamped === "stored" && (door.get(FACE_ACCOUNT_KEY) !== value || readOwner() !== owner)) {
        door.remove(FACE_ACCOUNT_OWNER_KEY);
        return "lost";
      }
      return stamped;
    },
    remove(key) {
      if (key !== FACE_ACCOUNT_KEY) return door.remove(key);
      if (expectedOwner !== undefined) {
        if (expectedOwner === null || readOwner() !== expectedOwner) return "lost";
        if (door.get(FACE_ACCOUNT_OWNER_KEY) !== expectedOwner) return "stored";
      }
      if (door.remove(FACE_ACCOUNT_OWNER_KEY) !== "stored") return "lost";
      return door.remove(key);
    },
  };
}

let themeStorage: StorageDoor | undefined;

function themeDoor(): StorageDoor {
  return (themeStorage ??= localStorageDoor("theme"));
}

/** The browser opens the storage door on use. The server only reads the request's owner. */
const THEME_STORAGE: StorageDoor = {
  get: (key) => themeDoor().get(key),
  set: (key, value) => themeDoor().set(key, value),
  remove: (key) => themeDoor().remove(key),
};
export const THEME_DOOR = faceMirrorDoor(THEME_STORAGE);

export function currentFaceOwner(): string | null {
  return readOwner();
}

/** A remembered owner can supply colours while confirmation is pending. Only the confirmed owner can write. */
export function accountThemeDoor(confirmedOwner: string | null, rememberedOwner?: string | null): StorageDoor {
  return {
    ...faceMirrorDoor(THEME_STORAGE, confirmedOwner),
    get(key) {
      if (key === FACE_ACCOUNT_KEY) {
        const live = readOwner();
        // Read the live marker here, including during hydration when the request had no owner.
        const expected = confirmedOwner ?? rememberedOwner;
        if (live === null || (expected !== null && live !== expected)
          || THEME_STORAGE.get(FACE_ACCOUNT_OWNER_KEY) !== live) return null;
      }
      return THEME_STORAGE.get(key);
    },
  };
}
