import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { KeyProvider } from "./auth/crypto.js";
import {
  SCHEDULE_FILES_MAX_AHEAD_MS, SCHEDULED_FILES_QUOTA,
  type PiecePlace, type ScheduledFileSealer, type ScheduledFilesKeeping,
} from "./scheduled-send-files.js";
import { SEND_STAGED_OBJECT_MAX_BYTES } from "./send-service.js";

/**
 * A SERVER'S SEAL ON A SCHEDULED LETTER'S FILES (mail 0180). Every piece gets its own random
 * AES-256-GCM key, and that key is wrapped by the key ring exactly as a mailbox password is
 * (`KeyProvider.encrypt`, the current version), so a rotation re-wraps the key
 * (`WRAPPED_SECRET_SITES`) and never the bytes. The additional data binds the piece to its account,
 * draft, file and place; the appointment's key is left out, so the same piece stays openable under a
 * new appointment key. Server-only: a host hands it to the route and the pass through
 * `ApiServices.scheduledFiles`, and neither packages/api nor an engine bundle imports this module.
 */

const AES = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

const placeOf = (at: PiecePlace): Buffer =>
  Buffer.from(`ohmail/scheduled-file/1\n${at.accountId}\n${at.draftId}\n${at.fileNo}\n${at.seq}`, "utf8");

export function scheduledFileSealer(kp: KeyProvider): ScheduledFileSealer {
  return {
    async seal(piece, at) {
      const key = randomBytes(KEY_BYTES);
      try {
        const iv = randomBytes(IV_BYTES);
        const c = createCipheriv(AES, key, iv);
        c.setAAD(placeOf(at));
        const sealed = Buffer.concat([iv, c.update(piece), c.final(), c.getAuthTag()]);
        const wrapped = await kp.encrypt(key.toString("base64"));
        return { rawB64: sealed.toString("base64"), dekEnc: wrapped.ciphertext, dekKeyVersion: wrapped.keyVersion };
      } finally {
        key.fill(0);
      }
    },
    async open(row, at) {
      const key = Buffer.from(await kp.decrypt(row.dekEnc, row.dekKeyVersion), "base64");
      try {
        const sealed = Buffer.from(row.rawB64, "base64");
        if (key.byteLength !== KEY_BYTES || sealed.byteLength < IV_BYTES + TAG_BYTES) {
          throw new Error("a sealed piece is not whole");
        }
        const d = createDecipheriv(AES, key, sealed.subarray(0, IV_BYTES));
        d.setAAD(placeOf(at));
        d.setAuthTag(sealed.subarray(sealed.byteLength - TAG_BYTES));
        return Buffer.concat([d.update(sealed.subarray(IV_BYTES, sealed.byteLength - TAG_BYTES)), d.final()]);
      } finally {
        key.fill(0);
      }
    },
  };
}

/** A server's declaration: sealed under this ring, seven days ahead, the staging object ceiling, the quota. */
export function keepScheduledFilesSealed(kp: KeyProvider): ScheduledFilesKeeping {
  return {
    atRest: "sealed",
    sealer: scheduledFileSealer(kp),
    maxAheadMs: SCHEDULE_FILES_MAX_AHEAD_MS,
    // The largest file any door can hand a server (the staging bucket's per-object ceiling).
    maxTotalBytes: SEND_STAGED_OBJECT_MAX_BYTES,
    quota: SCHEDULED_FILES_QUOTA,
  };
}
