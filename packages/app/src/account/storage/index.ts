/** Settings › Storage. A shell's registration draws {@link StoragePane} over `useStorage` and a {@link StorageDoor} it fills. */
export { StoragePane, type StoragePaneProps } from "./StoragePane.js";
export {
  STORAGE_START,
  storageChangeAnswer,
  storageModelOf,
  storageStep,
  type StorageAct,
  type StorageDoor,
  type StorageEvent,
  type StorageFigures,
  type StorageMail,
  type StorageModel,
  type StorageState,
} from "./model.js";
export { useStorage } from "./use-storage.js";
export { storageFactsStates, storageStates, type StorageStateAmounts } from "./states.js";
export { STORAGE_NAMESPACE } from "./namespace.js";
