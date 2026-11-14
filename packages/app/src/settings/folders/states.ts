/** Folders' registered states, as models (`screen=settings&sec=folders`, `&state=on`). */
import type { FoldersModel } from "./model.js";

const kept = () => Promise.resolve();

export function foldersState(on = false): FoldersModel {
  return {
    on,
    set: kept,
    mailboxes: on
      ? [
          { id: "m1", address: "mila@brunner.example", on: true },
          { id: "m2", address: "mila.brunner@work.example", on: true },
        ]
      : null,
    setMailbox: kept,
  };
}

export const FOLDERS_STATES: Readonly<Record<string, () => FoldersModel>> = {
  "": () => foldersState(false),
  on: () => foldersState(true),
};
