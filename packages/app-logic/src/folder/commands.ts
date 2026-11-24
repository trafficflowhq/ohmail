import type { FolderAct } from "@ohmail/wire";

/** Compose the commands that a hosted mailbox's organizer carries out. */
export const folderCommands = {
  create: (mailboxId: string, name: string): FolderAct => ({
    kind: "folder_create",
    folderId: crypto.randomUUID(),
    mailboxId,
    name,
  }),
  rename: (folderId: string, name: string): FolderAct => ({ kind: "folder_rename", folderId, name }),
  remove: (folderId: string): FolderAct => ({ kind: "folder_delete", folderId }),
  dismiss: (folderId: string): FolderAct => ({ kind: "folder_op_dismiss", folderId }),
};
