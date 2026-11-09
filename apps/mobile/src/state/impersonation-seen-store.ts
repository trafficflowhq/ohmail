/**
 * THE NEWEST IMPERSONATION FILING THIS PHONE ACKNOWLEDGED — the Screener line's OK, kept on this
 * device like the picture quality beside it (`picture-quality-store.ts`'s ordering rule: a boot read
 * that resolves after an OK does not publish the older mark). A refused keystore keeps the mark for
 * the session.
 */
import type { SecureKV } from "./servers";

export const IMPERSONATION_SEEN_KEY = "ohmail.screener.impersonationSeen";

export interface ImpersonationSeenStore {
  boot: () => Promise<void>;
  set: (iso: string) => void;
  dispose: () => void;
}

export function impersonationSeenStore(kv: SecureKV | undefined, apply: (iso: string) => void): ImpersonationSeenStore {
  let chosen = false;
  let dropped = false;
  return {
    async boot() {
      if (!kv) return;
      const raw = await kv.get(IMPERSONATION_SEEN_KEY).catch(() => null);
      if (dropped || chosen || typeof raw !== "string" || raw === "") return;
      apply(raw);
    },
    set(iso) {
      chosen = true;
      apply(iso);
      void kv?.set(IMPERSONATION_SEEN_KEY, iso).catch(() => {});
    },
    dispose() { dropped = true; },
  };
}
