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
import { folderCommands } from "@ohmail/app-logic/folder";
import type { FolderAct } from "@ohmail/wire";
import { useTranslations } from "next-intl";
import type { ToastFn } from "@ohmail/ui";
import type { MutationStatus } from "@ohmail/client-engine";
import { api, apiConfigured } from "../api-client";
import type { FolderVerbs } from "./FoldersRailGroup";

/**
 * The engine surface this module needs — `AppShell`'s own engine object satisfies it. The status
 * is the engine's OWN union rather than a copy of three of its members: a narrower spelling here
 * refuses the real engine the day a fourth arrives, which is how this type earned its import.
 */
interface MutatingEngine {
  mutate: (m: FolderAct) => Promise<{ status: MutationStatus }>;
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
        speakIfRolledBack(engine.mutate(folderCommands.create(mailboxId, name))),
      rename: (folderId, name) =>
        speakIfRolledBack(engine.mutate(folderCommands.rename(folderId, name))),
      remove: (folderId) =>
        speakIfRolledBack(engine.mutate(folderCommands.remove(folderId))),
      dismiss: (folderId) => {
        void engine.mutate(folderCommands.dismiss(folderId));
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
