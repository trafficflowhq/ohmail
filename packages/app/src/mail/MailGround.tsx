/**
 * THE MAIL GROUND: what of mail must outlive a place. A host hands it as `features.above`, so it stands once per
 * mounted frame, above every pane, under the scope; the frame never imports it. It reads its host through
 * `useFrame().host` and nothing else of a shell, every hook it calls is `@ohmail/app-logic`'s, and it draws no box.
 *
 * This file is the tree in its order, and nothing else. Each piece is one mount of its own (`ground/`); a piece
 * stands here once it is built, and until then its reader throws for want of a provider. Standing: whether the
 * service is the managed one (outermost: every piece and pane reads it), the mail state, the consent row, the
 * partition with the presented mirror, the two doors of a letter, the boot duties, the Screener's model, and the
 * headless feeders (the restart hold's relay over the one send machine, the mail's own keys, its notices, the
 * connection, the rail's foot, the device's badge, the one caller of the surface's system notices), and the one
 * composer, inside the Screener's model (its price reads the Screener's standing) and outside the feeders (the
 * restart hold's relay and the send machine's lines read it), and inside it the one binding of Pull new mail, which
 * the rail's foot and the places read. The press seam is not among them: it is the frame's
 * room's own, for the frame's life.
 *
 * WHY THE BOOT DUTIES STAND ABOVE THE SCREENER: they provide the offer of the review of who the person writes to,
 * and the Screener's Junk window is held back while that review is owed. They read the mail state and the consent
 * row alone. The feeders stand last, inside everything: a feeder may read any piece.
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
import { HandedDay } from "@ohmail/app-logic/session/day-clock";
import { useFrame } from "../frame/index.js";
import { NONE } from "../host/index.js";
import { RestingRestore } from "../trash/keys.js";
import { ReplyRunShortcut } from "../piles/index.js";
import type { ScreenerBeside } from "../screener/index.js";
import { ProfileImportGround } from "../profile-import/ground.js";
import { ConsentMount } from "./ground/ConsentMount.js";
import { DoorsMount } from "./ground/DoorsMount.js";
import { MailBadge } from "./ground/MailBadge.js";
import { MailBoot } from "./ground/MailBoot.js";
import { MailConnection } from "./ground/MailConnection.js";
import { MailKeys } from "./ground/MailKeys.js";
import { MailNotices } from "./ground/MailNotices.js";
import { MailRail } from "./ground/MailRail.js";
import { MailStateMount } from "./ground/MailStateMount.js";
import { MailSystemNotices } from "./ground/MailSystemNotices.js";
import { ManagedMount } from "./ground/ManagedMount.js";
import { PresentedMount } from "./ground/PresentedMount.js";
import { PullMount } from "./ground/PullMount.js";
import { ScreenerMount } from "./ground/ScreenerMount.js";
import { SendWaitsHold } from "./ground/SendWaitsRelay.js";
import { StreamGround } from "./ground/StreamGround.js";
import { WritingMount } from "./ground/WritingMount.js";

export function MailGround({
  children,
  subjectRule,
}: {
  readonly children: ReactNode;
  readonly subjectRule?: ScreenerBeside["subjectRule"];
}): ReactNode {
  /* The day the host says it is (the demo's frozen day; absent on every real host): every day clock and dated
     sentence below reads it. */
  const { host, product } = useFrame();
  const said = host.session.today;
  const today = said === NONE ? null : said;
  return (
    <HandedDay.Provider value={today}>
      <ManagedMount>
        <MailStateMount>
          <ConsentMount>
            <PresentedMount>
              <DoorsMount>
                <MailBoot>
                  <ScreenerMount subjectRule={subjectRule}>
                    <WritingMount>
                      <PullMount>
                        <SendWaitsHold />
                        {product === "mail" ? <MailKeys /> : null}
                        <MailNotices />
                        <MailConnection />
                        <MailRail />
                        <MailBadge />
                        <MailSystemNotices />
                        <ProfileImportGround>
                          <StreamGround>
                            <RestingRestore />
                            <ReplyRunShortcut>{children}</ReplyRunShortcut>
                          </StreamGround>
                        </ProfileImportGround>
                      </PullMount>
                    </WritingMount>
                  </ScreenerMount>
                </MailBoot>
              </DoorsMount>
            </PresentedMount>
          </ConsentMount>
        </MailStateMount>
      </ManagedMount>
    </HandedDay.Provider>
  );
}
