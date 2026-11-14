/** The frame's door: its contract, the frame, and what a feature reaches of it. */
export * from "./contract.js";
export { FRAME_NAMESPACES } from "./namespaces.js";
export { Frame } from "./Frame.js";
export {
  useConnectionFeed,
  useFrame,
  useKeptPane,
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
export {
  useOwnAddresses,
  usePress,
  usePressWhereOn,
  useResurfaceTime,
  useRoomHandOver,
  useRoomHolds,
  type ResurfaceTime,
  type RoomHolds,
} from "./room.js";
export { useSignal } from "./feeds.js";
export {
  CALENDAR_HOME,
  MAIL_HOME,
  SWITCH_CHORDS,
  eventRefOf,
  eventRefString,
  isCalendarPlace,
  productOf,
} from "./product.js";
export { CALENDAR_ADDRESS, isCalendarFragment, isRealDay } from "./route.js";
