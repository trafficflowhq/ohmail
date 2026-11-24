/**
 * WHAT STANDS ABOVE A STREAM PLACE'S COLUMNS (News, Receipts): the model, made once, for the list and the stream.
 */
import { createContext, type ReactNode } from "react";
import { StreamModelContext, useStream, type StreamInput, type StreamModel } from "@ohmail/app-logic/streams";
import { useFrame } from "../frame/commands.js";
import { NONE, type ReaderEntry } from "../host/index.js";

type StreamReply = ReturnType<NonNullable<ReaderEntry["useInlineReply"]>>;
export const StreamReplyContext = createContext<StreamReply>(null);
const noReply = (): null => null;

export function StreamState({ model, children }: { model: StreamModel; children: ReactNode }) {
  const { host } = useFrame();
  const reader = host.features.reader;
  const useInlineReply = reader === NONE ? noReply : (reader.useInlineReply ?? noReply);
  const reply = useInlineReply(model.items);
  return (
    <StreamModelContext.Provider value={model}>
      <StreamReplyContext.Provider value={reply}>{children}</StreamReplyContext.Provider>
    </StreamModelContext.Provider>
  );
}

export function StreamAbove({ input, children }: { input: StreamInput; children: ReactNode }) {
  const model = useStream(input);
  return <StreamState model={model}>{children}</StreamState>;
}
