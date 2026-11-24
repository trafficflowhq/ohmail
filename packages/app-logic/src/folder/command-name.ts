import { folderNameError } from "@trafficflow/core/folder-name";
import type { FolderEntity } from "@ohmail/wire";

const problem = {
  empty: "folderNameEmpty",
  spaces: "folderNameSpaces",
  control: "folderNameChars",
  wildcard: "folderNameChars",
  long: "folderNameLong",
  reserved: "folderNameReserved",
} as const;

/** The server's name rules, and names still held by this mailbox's mirror or a failed create. */
export function folderCommandProblem(
  folders: readonly Pick<FolderEntity, "mailboxId" | "name">[],
  mailboxId: string,
  path: string,
): string | null {
  const issue = folderNameError(path);
  if (issue !== null) return problem[issue];
  return folders.some((folder) => folder.mailboxId === mailboxId && folder.name === path)
    ? "folderNameTaken"
    : null;
}
