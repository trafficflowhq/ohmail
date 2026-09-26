/**
 * THE PICTURE QUALITY THIS PHONE KEEPS — one level, the web's dial (`@ohmail/client-engine`'s
 * table), stored on this phone like the appearance record beside it and read by the composer at
 * the moment a picture is picked. `appearance-store.ts`'s ordering rule holds: a boot read that
 * resolves after a press does not publish the pre-press value.
 */
import { DEFAULT_IMAGE_QUALITY_LEVEL, isImageQualityLevel, type ImageQualityLevel } from "../compose/attach";
import type { SecureKV } from "./servers";

export const PICTURE_QUALITY_KEY = "ohmail.compose.pictureQuality";

/** The stored level, or `null` for anything that is not one. */
export function decodePictureQuality(raw: string | null): ImageQualityLevel | null {
  return isImageQualityLevel(raw) ? raw : null;
}

export interface PictureQualityStore {
  boot: () => Promise<void>;
  set: (level: ImageQualityLevel) => void;
  dispose: () => void;
}

export function pictureQualityStore(
  kv: SecureKV | undefined,
  apply: (level: ImageQualityLevel) => void,
): PictureQualityStore {
  let chosen = false;
  let dropped = false;
  return {
    async boot() {
      if (!kv) return;
      const raw = await kv.get(PICTURE_QUALITY_KEY).catch(() => null);
      const stored = decodePictureQuality(raw);
      if (dropped || chosen || stored === null) return;
      apply(stored);
    },
    set(level) {
      chosen = true;
      apply(level);
      /* A refused keystore keeps the choice for the session; a thrown write would take the press. */
      void kv?.set(PICTURE_QUALITY_KEY, level).catch(() => {});
    },
    dispose() { dropped = true; },
  };
}

export { DEFAULT_IMAGE_QUALITY_LEVEL };
