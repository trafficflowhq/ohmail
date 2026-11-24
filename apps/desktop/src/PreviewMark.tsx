/**
 * THE MARK A PREVIEW BUILD CARRIES ON EVERY SCREEN: "Preview build" and the commit it was built
 * from, in a corner of the window, over the door chooser, the boot line and the mail alike.
 *
 * A preview runs beside a released install on the same computer, and the two look the same from
 * the first frame on. The mark is what says which window this is. It takes no press and no focus,
 * and a released build draws nothing here.
 */
import { Badge } from "@ohmail/ui";

import { BUILD_SHA } from "./build-id.js";
import { isPreview } from "./distribution.js";
import { DOOR_COPY } from "./door-copy.js";
import "./preview-mark.css";

/** The commit as `git log --oneline` on a small repository prints it. */
const SHORT = 7;

export function PreviewMark({ commit = BUILD_SHA }: { commit?: string }) {
  if (!isPreview()) return null;
  return (
    <div className="preview-mark" role="note">
      <Badge variant="shield">
        {commit ? DOOR_COPY.previewMark(commit.slice(0, SHORT)) : DOOR_COPY.previewMarkUnstamped}
      </Badge>
    </div>
  );
}
