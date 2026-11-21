/** What stands above a folder's columns: its model, and the meeting the reading column reads. */
import { useEffect, useMemo, type ReactNode } from "react";
import { FolderModelContext, type FolderModel } from "@ohmail/app-logic/folder";
import { isProtected, useOlderBodyDoor } from "@ohmail/app-logic/reader";
import { syncMayRead } from "@ohmail/app-logic/session/sync-scheduler";
import { useFrame } from "../frame/commands.js";
import { NONE } from "../host/index.js";
import { PlaceMeeting } from "../place-list/index.js";
import { useText } from "../text/index.js";

export function FolderAbove({ model, children }: { model: FolderModel; children: ReactNode }) {
  const { host, route } = useFrame();
  const wire = host.wires.olderBody;
  const { available, open, bodyFor } = useOlderBodyDoor(wire === NONE ? undefined : wire, () =>
    syncMayRead(host.engine),
  );
  const row = model.older?.items.find((item) => item.id === route.open);
  const id = row === undefined || isProtected(row) ? undefined : row.id;
  useEffect(() => {
    if (id !== undefined) open(id);
  }, [id, open, available]);
  const offMirror = useMemo(
    () =>
      row === undefined
        ? undefined
        : {
            message: row,
            body: available ? bodyFor({ id: row.id, snippet: row.snippet ?? "" }) : undefined,
            retry: available ? () => open(row.id, { retry: true }) : undefined,
          },
    [available, bodyFor, open, row],
  );
  const t = useText("folder");
  const reader = useText("reader");
  const label =
    model.goneName !== null
      ? reader("blank.none")
      : model.empty
        ? t("emptyTitle")
        : t("metaCount", { count: model.count });
  return (
    <FolderModelContext.Provider value={model}>
      <PlaceMeeting
        visit={model.list.visit}
        offMirror={offMirror}
        blank={model.loading ? null : { label, hot: false }}
        steps={{ up: t("step.up"), down: t("step.down") }}
      >
        {children}
      </PlaceMeeting>
    </FolderModelContext.Provider>
  );
}
