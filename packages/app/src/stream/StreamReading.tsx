/**
 * A STREAM PLACE'S READING COLUMN: the stream itself beside the list. On a phone's width the list is the stream, and
 * an item pressed there opens in the reader.
 */
import { useStreamModel } from "@ohmail/app-logic/streams";
import type { PaneProps } from "../frame/contract.js";
import { useFrame } from "../frame/index.js";
import { NONE } from "../host/index.js";
import { StreamColumn } from "./StreamColumn.js";
import { useStreamKeys } from "./keys.js";

export function StreamReading(props: PaneProps) {
  const model = useStreamModel();
  const { host } = useFrame();
  useStreamKeys(props.keysHere && props.plan.device !== "phone", model.scroller, model);
  if (props.plan.device !== "phone") return <StreamColumn phone={false} keysHere={props.keysHere} />;
  const reader = host.features.reader;
  return reader === NONE ? null : <reader.Reading {...props} />;
}
