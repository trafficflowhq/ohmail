/** The phone's ways in: the page the door draws at `welcome`, its contract, its states and the words it reads. */
export { PhoneDoorPage } from "./PhoneDoorPage.js";
export type {
  PhoneCamera,
  PhoneDoor,
  PhoneDoorAt,
  PhoneDoorConfig,
  PhoneDoorMigrating,
  PhoneDoorState,
  PhoneOffer,
  PhonePairAnswer,
  PhonePairedRow,
  PhonePairFacts,
  PhoneRect,
  PhoneScan,
  PhoneScanned,
  PhoneServerAnswer,
  SaidRefusal,
} from "./contract.js";
export {
  ONBOARDING_PHONE_STATE_DATA,
  ONBOARDING_PHONE_STATES,
  PHONE_DOOR_STATE_DATA,
  PHONE_DOOR_STATES,
  SESSION_SAYS,
  upgradeOf,
  WAY_IN_STEPS,
  type OnboardingPhoneStateId,
  type PhoneDoorStateId,
  type StateData,
  type WayInSeed,
  type WayInStep,
} from "./states.js";
export { PHONE_DOOR_NAMESPACES } from "./namespace.js";
