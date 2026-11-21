/** The frame's door: its contract, the frame, and what a feature reaches of it. */
export * from "./contract.js";
export { FRAME_NAMESPACES } from "./namespaces.js";
export { Frame } from "./Frame.js";
export {
  useConnectionFeed,
  useEntered,
  useFrame,
  useLinkedDraft,
  useNotice,
  usePaletteFeeds,
  usePaletteOffers,
  useRailFoot,
  useRailModel,
  useRailOpen,
  useReport,
  useSelectionBar,
  useStageOwed,
} from "./commands.js";
export type { ConnectionFeed, ConnectionReason } from "./commands.js";
export { CONNECTION_KINDS, connectionOf } from "./connection.js";
export type { ConnectionInput, ConnectionKind } from "./connection.js";
export { layoutPlan } from "./layout-plan.js";
export { usePlaceLiveArgs } from "./place-live.js";
export { attributesOf, ROOT_ATTRIBUTES } from "./root-attributes.js";
export { calendarNoticeFragment } from "./notice-route.js";
export { ADDRESS, fragmentOf, routeOf } from "./route.js";
export { Scoped, useScopeHere } from "./scope.js";
export { useRailDrag, useRailDropState } from "./rail-drag.js";
export type { Dragging } from "./rail-drag.js";
export {
  useOwnAddresses,
  usePress,
  usePressWhereOn,
  useResurfaceTime,
  useRoomFacts,
  useRoomHolds,
  useRoomResurface,
  type ResurfaceTime,
  type RoomHolds,
} from "./room.js";
export { useMailboxWord } from "./room-store.js";
export { useOwnGone } from "./own-gone.js";
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

export { ChunkLoadContext, lazyView, LoadFailed, ViewLoadFailed } from "./lazy-view.js";
