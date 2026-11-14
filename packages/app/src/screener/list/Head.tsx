/**
 * THE LIST'S HEAD: where you are, and beside it the three sections with their counts. A count is said only once its list may
 * be counted: Waiting once the queue has settled, the other two once this copy has caught up.
 */
import type { ScreenerView } from "@ohmail/app-logic/screener";
import { Seg } from "@ohmail/ui/base";
import { ListHead } from "@ohmail/ui/mail";
import { useText } from "../../text/index.js";
import { NONE } from "../../host/index.js";
import { useScreener, useScreenerBeside, type ScreenerSegment } from "../contract.js";

export function Head({ view, go }: { view: ScreenerView; go: (segment: ScreenerSegment) => void }) {
  const t = useText("screener");
  const model = useScreener();
  const { junk } = useScreenerBeside();
  const copied = model.queueSettled && model.copyBehind !== true;
  const options = [
    {
      value: "waiting" as const,
      label: t("segWaiting"),
      count: model.queueSettled ? model.waitingCount : undefined,
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
  ].map((option) => option.count ? { ...option, ariaLabel: `${option.label} ${option.count}` } : option);
  return (
    <ListHead
      title={t("title")}
      hot={model.queueSettled && model.waitingCount > 0}
      sections={<Seg label={t("segAria")} options={options} value={view.segment} onChange={go} />}
    />
  );
}
