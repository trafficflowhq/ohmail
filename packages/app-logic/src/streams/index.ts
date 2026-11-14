/** The door of `streams`: the read rule of News and Receipts, its adapter on the scroller, the leave and the model. */
export {
  STREAM_REST_MS,
  createStreamReadRule,
  type StreamHand,
  type StreamItemBox,
  type StreamLook,
  type StreamReadRule,
} from "./read-rule.js";
export {
  leaveSaysSomething,
  streamLeaveCommit,
  type StreamLeaveCommit,
  type StreamLeaveState,
} from "./leave.js";
export {
  measureStream,
  restingAt,
  useStreamRead,
  type StreamItemFacts,
  type StreamReadDom,
  type StreamReadDomOptions,
} from "./stream-read-dom.js";
export {
  STREAM_HOLD_QUIET_MS,
  useStreamScroll,
  type StreamCardNames,
  type StreamRange,
  type StreamScroll,
  type StreamScrollOptions,
  type StreamScrollSeam,
} from "./stream-scroll.js";
export {
  STREAM_ITEM,
  StreamModelContext,
  lineStampOf,
  useStream,
  useStreamModel,
  type StreamInput,
  type StreamModel,
  type StreamPlace,
} from "./use-stream.js";
