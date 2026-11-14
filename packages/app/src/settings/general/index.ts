/**
 * Settings › General. The pane draws a `GeneralModel`; a shell builds the model from its own sources and
 * registers `{ Body }` as the `general` pane, where `Body` renders `<GeneralPane model={…} />`.
 */
export { GeneralPane, type GeneralPaneProps } from "./GeneralPane.js";
export type { GeneralModel, LookFace, LookScope, ServerSwitch, ThemeChoice } from "./model.js";
export { GENERAL_NAMESPACE } from "./namespace.js";
export { GENERAL_STATES, generalState } from "./states.js";
