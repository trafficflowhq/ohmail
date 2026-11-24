/**
 * Search shows its confirmed scope below the rows. An empty result uses that same verdict,
 * with a title once the device has finished reading.
 */
import type { SearchListModel } from "@ohmail/app-logic/search";
import { Empty } from "@ohmail/ui/base";
import { GroupHeading, ListLine, Row, Rows } from "@ohmail/ui/mail";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { NONE } from "../host/index.js";
import { useText } from "../text/index.js";
import type { SearchBeside } from "./beside.js";
import { SearchEvents } from "./SearchEvents.js";
import { SearchVerdictLine } from "./SearchVerdictLine.js";
import type { SaidLine } from "./verdict-words.js";

export function SearchEmpty({
  model,
  beside,
  lines,
}: {
  model: SearchListModel;
  beside: SearchBeside;
  /** What was searched and the count it confirmed. */
  lines: readonly SaidLine[];
}) {
  const t = useText("search");
  const title = !model.indexing && (model.settledEmpty || model.nothingMatched) ? t("nothingMatched") : null;
  const junk = beside.junk;
  /* The pass that does not exist: nothing here ever searched the provider's Junk folder. */
  const junkSaid =
    junk === NONE ? null : junk === "unnamed" ? t("saidJunk") : t("saidJunkNamed", { folder: junk.named });
  const address = model.addressOnly ? displayAddress(model.text) : null;
  return (
    <>
      {address !== null ? (
        <>
          <GroupHeading>{t("people")}</GroupHeading>
          <Rows listLabel={t("people")}>
            <div role="listitem">
              <Row
                who={address}
                people={[{ name: address, address: model.text }]}
                subject=""
                onOpen={() => beside.go.address(model.text)}
              />
            </div>
          </Rows>
        </>
      ) : null}
      {title !== null ? <Empty label={title} /> : null}
      <SearchEvents beside={beside} text={model.text} />
      <SearchVerdictLine model={model} lines={lines} />
      {junkSaid !== null ? <ListLine fine>{junkSaid}</ListLine> : null}
      {model.partsSaid ? <ListLine fine>{t("saidPart")}</ListLine> : null}
    </>
  );
}
