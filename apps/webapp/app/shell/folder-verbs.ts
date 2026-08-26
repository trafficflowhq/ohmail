"use client";

/**
 * THE FOLDER VERBS' SHELL HALF (FOLDERS-SPEC.md stage 2) — the dispatch seam between the rail's
 * Folders group and the engine's `folder_*` mutations, plus the ONE read the ceremony needs.
 *
 * It lives beside `junk-window.ts` and not in `AppShell.tsx` for `junk-window.ts`'s reason: the
 * shared shell never imports `app/api-client` itself — the desktop build aliases that module to
 * a stub whose calls refuse (`apps/desktop/vite.config.ts`), and the discipline that keeps the
 * boundary legible is that only sibling hook modules touch it, each degrading honestly when the
 * stub answers. Here the degrade is exactly one surface: `summary` (the delete confirm's
 * server-truth numbers) answers `null` where no API client exists, and the confirm states its
 * sentence WITHOUT numbers rather than inventing any. The verbs themselves ride the ENGINE —
 * every host's engine carries its own wire — so create/rename/delete work on every door the
 * folders group renders on.
 *
 * ── THE ROLLBACK SENTENCE (the composer lane's pattern) ────────────────────────────────────
 *
 * Every verb awaits its mutation and speaks ONLY on `rolled_back`: the optimistic marker has
 * already been taken back whole by the engine, and the toast's job is to say that nothing
 * changed — a silent rollback is the interface lying by omission. Success says nothing; the
 * pending row itself is the feedback, and it settles through the wake channel in seconds.
 */

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import type { ToastFn } from "@ohmail/ui";
import { api, apiConfigured } from "../api-client";
import type { FolderVerbs } from "./FoldersRailGroup";

/**
 * Exactly the four members this module dispatches, spelled as the engine's own discriminated
 * shapes — a SUBSET of `EngineMutation`, which is what makes the engine's
 * `(m: EngineMutation) => …` assignable here under contravariance without this module naming
 * the whole union.
 */
type FolderMutation =
  | { kind: "folder_create"; folderId: string; mailboxId: string; name: string }
  | { kind: "folder_rename"; folderId: string; name: string }
  | { kind: "folder_delete"; folderId: string }
  | { kind: "folder_op_dismiss"; folderId: string };

/** The engine surface this module needs — `AppShell`'s own engine object satisfies it. */
interface MutatingEngine {
  mutate: (m: FolderMutation) => Promise<{ status: "confirmed" | "queued" | "rolled_back" }>;
}

export function useFolderVerbs(engine: MutatingEngine, toast: ToastFn): FolderVerbs {
  const t = useTranslations("rail");
  return useMemo<FolderVerbs>(() => {
    const speakIfRolledBack = async (p: Promise<{ status: string }>) => {
      const res = await p;
      if (res.status === "rolled_back") toast(t("folderVerbFailed"));
    };
    return {
      create: (mailboxId, name) =>
        speakIfRolledBack(engine.mutate({
          kind: "folder_create", folderId: crypto.randomUUID(), mailboxId, name,
        })),
      rename: (folderId, name) =>
        speakIfRolledBack(engine.mutate({ kind: "folder_rename", folderId, name })),
      remove: (folderId) =>
        speakIfRolledBack(engine.mutate({ kind: "folder_delete", folderId })),
      dismiss: (folderId) => {
        void engine.mutate({ kind: "folder_op_dismiss", folderId });
      },
      summary: async (folderId) => {
        if (!apiConfigured()) return null;
        try {
          return await api<{ folders: number; messages: number }>(
            `/folders/${encodeURIComponent(folderId)}/summary`,
          );
        } catch {
          // The confirm still asks — with the uncounted sentence. A failed count must never
          // block the ceremony OR pretend a number it does not have.
          return null;
        }
      },
    };
  }, [engine, toast, t]);
}
