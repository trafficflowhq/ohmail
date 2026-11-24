/**
 * THE PLACE AN INVITATION HELD IN THE SCREENER STANDS IN: the calendar's part, handed beside the model, for a letter
 * of the Waiting section. A letter kept out (Screened out, Spam, Junk) gets no invitation note: nobody let it in.
 */
import { NONE } from "../../host/index.js";
import { useScreenerBeside, type ScreenerSegment } from "../contract.js";

export function HeldInvitation({ messageId, segment }: { messageId: string; segment: ScreenerSegment }) {
  const { invitation: Invitation } = useScreenerBeside();
  if (segment !== "waiting" || Invitation === NONE) return null;
  return <Invitation messageId={messageId} />;
}
