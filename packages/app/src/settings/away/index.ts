/** Settings › Away responder: the one control that sends mail on its own. A shell's hook steps {@link awayStep}. */
export { AwayPane } from "./AwayPane.js";
export { AwaySettings } from "./AwaySettings.js";
export {
  AWAY_START,
  awayPileChoices,
  awayPilesAfter,
  awayStep,
  awayUnsaved,
  sameRow,
  type AwayAudience,
  type AwayEvent,
  type AwayModel,
  type AwayOutcome,
  type AwayPileChoice,
  type AwayRefusal,
  type AwayRow,
  type AwayRules,
  type AwayRunsOn,
  type AwayState,
  type AwayThrottle,
} from "./model.js";
export { AWAY_NAMESPACE } from "./namespace.js";
export { AWAY_STATE_PILES, AWAY_STATE_RULES, awayStates, type AwayPaneState } from "./states.js";
export { useAwayLeave } from "./use-away-leave.js";
export { awayFeedOver, useAwayNotice } from "./notice.js";
