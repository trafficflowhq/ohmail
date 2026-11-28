import { useMemo, useRef, type ReactNode } from "react";
import { OpeningHead, OpeningMenu, OpeningSwitchShape, RowsShape } from "@ohmail/ui/base";
import { Rail, Sheet } from "@ohmail/ui/mail";
import { Columns } from "./Columns.js";
import { FrameSurface } from "./FrameRoot.js";
import type { Appearance, WindowFacts } from "./contract.js";
import { layoutPlan } from "./layout-plan.js";
import { attributesOf } from "./root-attributes.js";
import "./opening-frame.css";

const labels = { list: "", reading: "", railWidth: "", listWidth: "" };

/** The mailbox's frame while there is no host yet. The status is the only content that speaks. */
export function OpeningFrame({
  facts,
  look,
  show,
  status,
  kept,
}: {
  facts: WindowFacts;
  look: Appearance;
  show: boolean;
  status?: ReactNode;
  kept?: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const plan = useMemo(() => layoutPlan(facts, look.layout), [facts, look.layout]);
  const attributes = useMemo(() => attributesOf(plan, look, facts), [plan, look, facts]);
  const railStatus = plan.rail === "words";
  const listShape = show ? (
    <div className="fr-opening-rows" aria-hidden="true">
      <OpeningHead />
      <RowsShape />
    </div>
  ) : null;
  const list =
    kept && !railStatus && status ? (
      <div className="fr-opening-kept">
        {kept}
        <div className="fr-opening-status">{status}</div>
      </div>
    ) : (
      <>
        {kept ?? listShape}
        {railStatus ? null : status}
      </>
    );
  return (
    <FrameSurface drawn={root} attributes={attributes}>
      <div className="fr-frame fr-opening" data-rail={plan.rail} data-wait={show ? undefined : ""}>
        <Columns
          plan={plan}
          passive
          listKeys={false}
          rail={
            plan.rail === "dock" ? null : (
              <div className="fr-opening-rail">
                {railStatus ? (
                  <Rail
                    switcher={show ? <OpeningSwitchShape /> : <></>}
                    groups={show ? [<OpeningMenu hideSwitch />] : []}
                    foot={status}
                  />
                ) : show ? (
                  <OpeningMenu icons />
                ) : null}
              </div>
            )
          }
          list={
            plan.device === "phone" ? (
              <Sheet kind="list" flushBottom>
                {list}
              </Sheet>
            ) : (
              list
            )
          }
          reading={
            show && plan.columns === 2 ? (
              <div className="oh-blankcolumn" data-blank-column="" aria-hidden="true" />
            ) : null
          }
          wide={null}
          above={null}
          labels={labels}
        />
      </div>
    </FrameSurface>
  );
}
