/** The door of `press`: the one seam a press leaves the interface through, and Undo. */
export { useShellDispatch, type ShellDispatch, type ShellDispatchInput, type UndoLink } from "./shell-dispatch.js";
export { createUndoDoor } from "./undo-door.js";
export { UNDO_MS } from "./undo-window.js";
export { hideMessages, useDeleteUndo } from "./delete-undo.js";
export { useRoutingUndo } from "./routing-undo.js";
export { usePressWatch } from "./press-watch.js";
export { screeningVerdict, writtenRuleIds } from "./press-verdict.js";
/* THE ONE READING OF A MUTATION RESULT, for the new shell's parts, which take only the engine's types. */
export { pressVerdict } from "@ohmail/client-engine";
export type { ToastFn, ToastOptions } from "./report.js";
