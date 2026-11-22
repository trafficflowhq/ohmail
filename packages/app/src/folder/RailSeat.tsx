/**
 * THE RAIL'S FOLDERS GROUP, drawn by the folder place for the frame's life while the account uses folders: the shelf
 * and All folders (`FolderRail`), fed off the ground alone (`useFolderRailLive`), never a folder's own model. A
 * folder opens its place, and is then the shelf's newest used one.
 *
 * THE PINS AND THE FOLDERS USED LAST are kept here for the frame's life only: the device's record of them (two
 * stored keys per account, with sign-out's and the erasure's sweeps) is not built yet, and no row is dragged onto
 * the shelf (the rail takes no drop yet). Both are named in the seat's handover.
 */
import { useState } from "react";
import type { FolderAct, FolderEntity } from "@ohmail/wire";
import { RECENT_SIZE, shelfKeyOf, useFolderRailLive, usedNow } from "@ohmail/app-logic/folder";
import { useConsent } from "@ohmail/app-logic/consent";
import { isRemovedMailbox } from "@ohmail/app-logic/mail-state/mail-state";
import { useStableCallback } from "@ohmail/app-logic/press/stable-callback";
import { syncMayRead } from "@ohmail/app-logic/session/sync-scheduler";
import { mailboxAddressCount } from "@ohmail/app-logic/reader";
import { useMailState } from "@ohmail/app-logic/mail-state";
import { useFrame } from "../frame/commands.js";
import { usePressWhereOn } from "../frame/room.js";
import { NONE } from "../host/index.js";
import { useText } from "../text/index.js";
import { FolderRail } from "./FolderRail.js";

export function FolderRailSeat() {
  const live = useFolderRailLive();
  const { mailboxes } = useMailState();
  const { host, route, commands, report, plan } = useFrame();
  const consent = useConsent();
  const press = usePressWhereOn();
  const rail = useText("rail");
  const [pinned, setPinned] = useState<readonly string[]>([]);
  const [recent, setRecent] = useState<readonly string[]>([]);
  const summary = host.wires.folderSummary;
  const writable = live?.ready === true && consent.foldersStorable && press !== null && summary !== NONE;
  const available = (mailboxes ?? []).filter(
    (mailbox) =>
      !isRemovedMailbox(mailbox) &&
      mailbox.status !== "disabled" &&
      consent.folderMailboxesOff[mailbox.id] === undefined,
  );
  const run = useStableCallback(async (act: FolderAct, target?: FolderEntity) => {
    if (!writable || press === null || !syncMayRead(host.engine)) return;
    if (act.kind === "folder_create" && !available.some((mailbox) => mailbox.id === act.mailboxId)) return;
    if (target !== undefined) {
      const liveFolder = host.engine.verbRead().get<FolderEntity>("folder", target.id);
      if (
        !liveFolder ||
        liveFolder.mailboxId !== target.mailboxId ||
        liveFolder.name !== target.name ||
        !available.some((mailbox) => mailbox.id === target.mailboxId)
      )
        return;
      if (act.kind === "folder_op_dismiss" ? liveFolder.op?.error === undefined : liveFolder.op !== undefined)
        return;
    }
    const verdict = await press.dispatchPress(act);
    if (verdict.kind === "refused") report(rail("folderVerbFailed"));
  });
  if (live === null || (live.ready && live.folders.length === 0 && !(writable && available.length > 0)))
    return null;
  const visitId = route.place === "folder" ? route.sub : null;
  const opened = visitId === null ? undefined : live.folders.find((f) => f.id === visitId);
  const go = (folder: FolderEntity): void => {
    setRecent((was) => usedNow(was, shelfKeyOf(folder), pinned));
    commands.go({ place: "folder", sub: folder.id });
  };
  return (
    <FolderRail
      narrow={plan.rail === "dock"}
      tapMenus={plan.rail === "dock" || plan.pointer === "coarse"}
      scope={host.session.scope}
      folders={live.folders}
      mailboxCount={mailboxes === null ? undefined : mailboxAddressCount(mailboxes)}
      writable={
        writable
          ? {
              run,
              summary,
              mailboxes: available.map(({ id, address }) => ({ id, label: address })),
            }
          : undefined
      }
      messages={live.messages}
      shelf={{
        pinned,
        recent,
        /* Pinning takes the folder out of the ones used last; taking a pin off puts it first of them. */
        pin: (key) => {
          setPinned((was) => (was.includes(key) ? was : [...was, key]));
          setRecent((was) => was.filter((k) => k !== key));
        },
        unpin: (key) => {
          setPinned((was) => was.filter((k) => k !== key));
          setRecent((was) => [key, ...was.filter((k) => k !== key)].slice(0, RECENT_SIZE));
        },
      }}
      open={opened === undefined ? null : shelfKeyOf(opened)}
      visitId={visitId}
      go={go}
      drag={null}
    >
      {!live.ready && live.folders.length === 0 ? (
        <p className="rsub-empty" role="status" aria-busy="true" aria-label={rail("folderLoading")}>
          {rail("folderLoading")}
        </p>
      ) : null}
    </FolderRail>
  );
}
