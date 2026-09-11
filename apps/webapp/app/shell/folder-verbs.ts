"use client";

/**
 * The folder verbs' shell half (FOLDERS-SPEC.md stage 2) — the dispatch seam between the rail's Folders group and the
 * engine's `folder_*` mutations, plus the ONE read the ceremony needs. Beside `junk-window.ts` and not in
 * `AppShell.tsx` for its reason: the shared shell never imports `app/api-client` itself — only sibling hook modules
 * touch it, each degrading honestly when the desktop's stub answers.
 */

/**
 * The degrade here is one surface: `summary` (the delete confirm's server-truth numbers) answers `null` where no API
 * client exists, and the confirm states its sentence WITHOUT numbers rather than inventing any; the verbs ride the
 * ENGINE, so they work on every door. The rollback sentence (the composer lane's pattern): every verb awaits its
 * mutation and speaks ONLY on `rolled_back` — a silent rollback is the interface lying by omission; success says
 * nothing, the pending row is the feedback, settled through the wake channel in seconds.
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
