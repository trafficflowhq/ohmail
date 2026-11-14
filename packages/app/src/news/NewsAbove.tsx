/** What stands above News's columns: the stream's model over News's pile. */
import type { ReactNode } from "react";
import type { StreamInput } from "@ohmail/app-logic/streams";
import { StreamAbove } from "../stream/index.js";

export function NewsAbove({ input, children }: { input: Omit<StreamInput, "place">; children: ReactNode }) {
  return <StreamAbove input={{ ...input, place: "news" }}>{children}</StreamAbove>;
}
