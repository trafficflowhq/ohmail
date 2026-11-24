/**
 * Settings › Account. Its registration (`accountPane`) draws it over what a host alone hands it ({@link
 * AccountPaneParts}: the hooks that answer its {@link AccountDoor} and its {@link PasswordDoor}, and the factor's
 * slot), in the body the host's answer about the account asks for. A host names those parts; the mail's panes record
 * makes the registration.
 */
export { AccountPane, type AccountPaneProps } from "./AccountPane.js";
export { accountPane, type AccountPaneParts } from "./pane.js";
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
