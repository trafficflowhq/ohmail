/** The frame's door: its contract, the frame, and what a feature reaches of it. */
export * from "./contract.js";
export { FRAME_NAMESPACES } from "./namespaces.js";
export { Frame } from "./Frame.js";
export {
  useConnectionFeed,
  useFrame,
  useLinkedDraft,
  useNotice,
  useRailModel,
  useRailOpen,
  useReport,
  useSelectionBar,
} from "./commands.js";
export type { ConnectionFeed, ConnectionReason } from "./commands.js";
export { CONNECTION_KINDS, connectionOf } from "./connection.js";
export type { ConnectionInput, ConnectionKind } from "./connection.js";
export { layoutPlan } from "./layout-plan.js";
export { attributesOf, ROOT_ATTRIBUTES } from "./root-attributes.js";
export { ADDRESS, fragmentOf, routeOf } from "./route.js";
export { Scoped } from "./scope.js";
export { useSignal } from "./feeds.js";
