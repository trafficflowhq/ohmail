/**
 * THE LIST'S HEAD: where you are, and beside it the three sections with their counts. A count is said only once its list may
 * be counted: Waiting once the queue has settled, the other two once this copy has caught up.
 */
import { sharedNotOrganizedWhy, type NotOrganizingYet } from "@ohmail/app-logic/mail-state/mail-state";
import type { ScreenerView } from "@ohmail/app-logic/screener";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { Seg } from "@ohmail/ui/base";
import { ListHead } from "@ohmail/ui/mail";
import { useText, type Text } from "../../text/index.js";
import { NONE } from "../../host/index.js";
import { useScreener, useScreenerBeside, type ScreenerSegment } from "../contract.js";
import { useScreenerEmpty } from "./Empty.js";

function emptyWaitingStatus(t: Text, unorganized: NotOrganizingYet | null): string {
  if (unorganized === null) return t("metaWaiting", { count: 0 });
  if (!unorganized.every) {
    return t("metaNotOrganizingSome", {
      count: unorganized.mailboxes.length,
      address: displayAddress(unorganized.mailboxes[0]?.address ?? ""),
    });
  }
  const status = {
    never_agreed: "metaNotYet",
    handed_back: "metaHandedBack",
    stopped: "metaNotOrganizing",
  };
  return t(status[sharedNotOrganizedWhy(unorganized)]);
}

export function Head({ view, go }: { view: ScreenerView; go: (segment: ScreenerSegment) => void }) {
  const t = useText("screener");
  const model = useScreener();
  const { facts, junk } = useScreenerBeside();
  const empty = useScreenerEmpty(view);
  const emptyWaiting = view.segment === "waiting" && empty.kind === "empty";
  const copied = model.queueSettled && !facts.owed && model.copyBehind !== true;
  const countedOnDevice =
    view.segment === "waiting" &&
    model.queueSettled &&
    model.waitingSource === "device" &&
    model.waitingCount > 0;
  const meta = countedOnDevice
    ? t("metaCountOnDevice")
    : emptyWaiting
      ? emptyWaitingStatus(t, facts.notOrganizingYet)
      : undefined;
  const options = [
    {
      value: "waiting" as const,
      label: t("segWaiting"),
      count: model.queueSettled ? model.waitingCount : undefined,
      title:
        model.queueSettled && model.waitingCount > 0
          ? t("metaWaiting", { count: model.waitingCount })
          : undefined,
    },
    {
      value: "screened" as const,
      label: t("segScreened"),
      count: copied ? model.screenedOut.length : undefined,
    },
    /* Junk is read live, a page at a time: a number would say "loaded so far", so it says none. */
    junk === NONE
      ? { value: "spam" as const, label: t("segSpam"), count: copied ? model.spam.length : undefined }
      : { value: "spam" as const, label: t("segJunk"), count: undefined },
  ].map((option) => (option.count ? { ...option, ariaLabel: `${option.label} ${option.count}` } : option));
  return (
    <ListHead
      title={t("title")}
      meta={meta}
      hot={model.queueSettled && model.waitingCount > 0}
      sections={<Seg label={t("segAria")} options={options} value={view.segment} onChange={go} />}
    />
  );
}
