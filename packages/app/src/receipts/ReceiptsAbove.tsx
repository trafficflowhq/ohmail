/** What stands above Receipts' columns: the stream's model over Receipts' pile. */
import type { ReactNode } from "react";
import type { StreamInput } from "@ohmail/app-logic/streams";
import { StreamAbove } from "../stream/index.js";

export function ReceiptsAbove({
  input,
  children,
}: {
  input: Omit<StreamInput, "place">;
  children: ReactNode;
}) {
  return <StreamAbove input={{ ...input, place: "receipts" }}>{children}</StreamAbove>;
}
