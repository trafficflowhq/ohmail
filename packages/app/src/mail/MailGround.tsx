/**
 * THE MAIL GROUND: what of mail must outlive a place. A host hands it as `features.above`, so it stands once per
 * mounted frame, above every pane, under the scope; the frame never imports it. It reads its host through
 * `useFrame().host` and nothing else of a shell, every hook it calls is `@ohmail/app-logic`'s, and it draws no box.
 *
 * This file is the tree in its order, and nothing else. Each piece is one mount of its own (`ground/`); a piece
 * stands here once it is built, and until then its reader throws for want of a provider. Standing: the mail state,
 * the consent row, the partition with the presented mirror, the two doors of a letter, the Screener's model, the one
 * composer. To come, with the step that moves them: the headless feeders. The press seam is not among them: it is the
 * frame's room's own, for the frame's life.
 *
 * A place MAY RELY ON: what stands here is mounted with the frame and again only by another scope, never by a walk
 * between places; it reaches every pane, the rail, the dock, a stage and an over alike; one instance of each piece
 * per frame.
 *
 * A place MAY NEVER: mount this or import this folder (a host alone does; no place's folder and no file of the
 * frame reaches `mail/`); stand a provider of one of its contexts a second time; call a hook one of its pieces
 * calls. A place reads, through the readers `@ohmail/app-logic` exports.
 */
import type { ReactNode } from "react";
import { ConsentMount } from "./ground/ConsentMount.js";
import { DoorsMount } from "./ground/DoorsMount.js";
import { MailStateMount } from "./ground/MailStateMount.js";
import { PresentedMount } from "./ground/PresentedMount.js";
import { ScreenerMount } from "./ground/ScreenerMount.js";
import { WritingMount } from "./ground/WritingMount.js";

export function MailGround({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <MailStateMount>
      <ConsentMount>
        <PresentedMount>
          <DoorsMount>
            <ScreenerMount>
              <WritingMount>{children}</WritingMount>
            </ScreenerMount>
          </DoorsMount>
        </PresentedMount>
      </ConsentMount>
    </MailStateMount>
  );
}
