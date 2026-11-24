/** Settings › Rules. A shell's hook says each rule from the engine's facts and runs its verbs; the pane draws them. */
export { RulesPane } from "./RulesPane.js";
export {
  rulesByDecider,
  rulesRevokable,
  rulesShown,
  type RuleItem,
  type RulePlace,
  type RulesModel,
  type RuleWaiting,
} from "./model.js";
export { RULES_NAMESPACE } from "./namespace.js";
export { rulesStates, type RulesPaneState, type RulesStateWords } from "./states.js";
