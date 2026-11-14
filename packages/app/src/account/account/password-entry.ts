/**
 * The password form alone: what a place that is not Settings mounts, so that a closed account can still take back a
 * password somebody else knows. A shell draws it over a {@link PasswordDoor} it fills and its factor slot.
 */
export { PasswordForm, type PasswordFormProps } from "./PasswordForm.js";
export { usePassword } from "./use-password.js";
export {
  MAX_LENGTH,
  MIN_LENGTH,
  PASSWORD_START,
  passwordCheck,
  passwordModelOf,
  passwordOwed,
  passwordStep,
  type PasswordAct,
  type PasswordCheck,
  type PasswordDoor,
  type PasswordEvent,
  type PasswordModel,
  type PasswordState,
  type PasswordStepped,
  type PasswordTyped,
} from "./password.js";
export { PASSWORD_STATES } from "./states.js";
