/** Settings › AI: the account's off switch. A shell's hook steps {@link aiStep} through an {@link AiDoor}. */
export { AiPane, type AiPaneProps } from "./AiPane.js";
export { AI_START, aiStep, type AiDoor, type AiEvent, type AiModel, type AiState } from "./model.js";
export { aiStates, type AiPaneState, type AiStateWords } from "./states.js";
export { useAiSummary } from "./summary.js";
export { AI_NAMESPACE } from "./namespace.js";
export { useAiDoor } from "./use-ai-door.js";
