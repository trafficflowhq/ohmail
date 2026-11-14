import { localStorageDoor } from "@ohmail/app-logic/storage/durable";
import { scopeSuffix, type StorageScope } from "@ohmail/app-logic/storage/scope";

export type SubjectDisplay = "head" | "each";

const storage = localStorageDoor("reader.subject");
const keyOf = (scope: StorageScope) => `ohmail.ui.reader.subject:${scopeSuffix(scope)}`;

export function readSubjectDisplay(scope: StorageScope): SubjectDisplay {
  return storage.get(keyOf(scope)) === "each" ? "each" : "head";
}

export function writeSubjectDisplay(scope: StorageScope, display: SubjectDisplay): void {
  storage.set(keyOf(scope), display);
}
