/**
 * WHAT STANDS ABOVE A STREAM PLACE'S COLUMNS (News, Receipts): the model, made once, for the list and the stream.
 */
import type { ReactNode } from "react";
import { StreamModelContext, useStream, type StreamInput } from "@ohmail/app-logic/streams";

export function StreamAbove({ input, children }: { input: StreamInput; children: ReactNode }) {
  const model = useStream(input);
  return <StreamModelContext.Provider value={model}>{children}</StreamModelContext.Provider>;
}
