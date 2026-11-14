import { folderLeafOf } from "@ohmail/app-logic/lists/folders";
import type { FolderEntity } from "@ohmail/wire";
import type { Text } from "../text/index.js";

const failure: Readonly<Record<string, string>> = {
  bad_name: "folderErrBadName",
  exists: "folderErrExists",
  gone: "folderErrGone",
  no_trash_folder: "folderErrNoTrash",
  received_mail: "folderErrGotMail",
};

export function folderCommandWord(t: Text, folder: FolderEntity): string | undefined {
  const { op } = folder;
  if (!op) return undefined;
  if (op.error !== undefined) return t(failure[op.error] ?? "folderErrRefused");
  if (op.kind === "create") return t("folderCreating");
  if (op.kind === "delete") return t("folderDeleting");
  return t("folderRenaming", { name: folderLeafOf(op.to ?? folder.name) });
}
