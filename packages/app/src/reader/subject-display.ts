import { localStorageDoor } from "@ohmail/app-logic/storage/durable";
import { type StorageScope } from "@ohmail/app-logic/storage/scope";
import { subjectDisplayKey } from "@ohmail/app-logic/storage/persisted-ui";

export type SubjectDisplay = "head" | "each";

const storage = localStorageDoor("reader.subject");

export function readSubjectDisplay(scope: StorageScope): SubjectDisplay {
  return storage.get(subjectDisplayKey(scope)) === "each" ? "each" : "head";
}

export function writeSubjectDisplay(scope: StorageScope, display: SubjectDisplay): void {
  storage.set(subjectDisplayKey(scope), display);
}
