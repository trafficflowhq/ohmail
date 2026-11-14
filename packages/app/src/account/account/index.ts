/**
 * Settings › Account. A shell's registration draws it over an {@link AccountDoor} and a {@link PasswordDoor} it
 * fills and its factor slot, in the body its host's answer about the account asks for.
 */
export { AccountPane, type AccountPaneProps } from "./AccountPane.js";
export {
  accountStart,
  accountStep,
  type AccountBody,
  type AccountDoor,
  type AccountEvent,
  type AccountModel,
  type AccountPaneState,
  type AccountStepped,
} from "./model.js";
export { useAccount } from "./use-account.js";
export { accountPaneStates, type AccountDrawn, type AccountShown } from "./states.js";
export { ACCOUNT_NAMESPACE } from "./namespace.js";
export * from "./password-entry.js";
