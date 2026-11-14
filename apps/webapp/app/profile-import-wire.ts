import type { ProfileImportTransport } from "@ohmail/app/profile-import";
import { ApiError, profileImport } from "./api-client";

/** The shared card displays only a refusal that the server wrote. */
async function answer<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (error) {
    if (error instanceof ApiError && error.wire.coded) throw error;
    throw new Error();
  }
}

export function profileImportFor(expectedOwner?: string): ProfileImportTransport {
  return {
    candidate: (id) => profileImport.candidate(id, expectedOwner),
    apply: (id, fingerprint, signatureReplaces) => answer(profileImport.apply(id, fingerprint, signatureReplaces, expectedOwner)),
    status: (id, fingerprint) => profileImport.status(id, fingerprint, expectedOwner),
    decline: (id, subject) => answer(profileImport.decline(id, subject, expectedOwner)),
    replace: (id, fingerprint) => answer(profileImport.replace(id, fingerprint, expectedOwner)),
  };
}

export const HOSTED = profileImportFor();
