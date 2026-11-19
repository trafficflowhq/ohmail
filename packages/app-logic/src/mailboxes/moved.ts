/**
 * THE RULES THAT MOVED OUT OF THE WEB SHELL, as the old shell's files still import them: the provider table's door,
 * the two consents' rules and the address-first helper; the readers of a mailbox's filings and of its check; the
 * first run's rules and its step. One path of two names
 * (`@ohmail/app-logic/mailboxes/moved`), which every alias table of the repository resolves: those shell files are in
 * the desktop window's bundle too. It leaves with the last of them.
 */
export * from "./connect/providers.js";
export {
  certificateOfferOf,
  oneLine,
  plaintextClaims,
  sameServerHost,
  trustClaims,
  type Protocols,
  type TrustOffer,
} from "./connect/consents.js";
export {
  LOOKUP_PAUSE_MS,
  LOOKUP_WAIT_MS,
  hostFieldOf,
  tableGuess,
  useAddressFirst,
  type AddressFirst,
  type DiscoverLookup,
} from "./connect/address-first.js";
export { filingGroupsOf, filingWaits, type FilingGroup } from "./pane/filings.js";
export {
  selfCheckPressSentence,
  selfCheckSentence,
  selfCheckWaiting,
  type SelfCheckPress,
} from "./pane/self-check.js";
export {
  DECIDE_LEGEND,
  HOLDER_CHECK_MS,
  HOLDER_REREAD_MS,
  decisionCountSentence,
  firstSentence,
  holderName,
  initialWindow,
  nextStep,
  raiseStamp,
  railFor,
  readIsNotOlder,
  type WindowChoice,
} from "./first-run/rules.js";
export { firstRunStep } from "./first-run/step.js";
