import { localStorageDoor, type StorageDoor } from "./durable";
import { readOwner } from "./owner-cookie";

/**
 * THE ACCOUNT FACE'S MIRROR NAMES ITS ACCOUNT. `ohmail.face.account` holds the account's look for the next
 * boot's pre-paint stamp (`ThemeProvider`'s `accountFaceStorageKey`), and nothing in it says whose look it is,
 * so a revoke of that account while another holds the jar could not take it (`sign-out.ts`'s one-account
 * sweep). The account goes beside it, in a key the stamp never reads.
 */
export const FACE_ACCOUNT_KEY = "ohmail.face.account";
export const FACE_ACCOUNT_OWNER_KEY = "ohmail.face.account.owner";

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

/** The product door's theme storage, at module scope as `ThemeProvider` asks (`(product)/providers.tsx`). */
export const THEME_DOOR = faceMirrorDoor(localStorageDoor("theme"));
