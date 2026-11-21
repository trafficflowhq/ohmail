/**
 * Search shows its confirmed scope below the rows. An empty result uses that same verdict,
 * with a temporary title while the device is still reading and a local title when no store answered.
 */
import type { SearchListModel } from "@ohmail/app-logic/search";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { Empty } from "@ohmail/ui/base";
import { ListLine } from "@ohmail/ui/mail";
import { NONE } from "../host/index.js";
import { useText } from "../text/index.js";
import type { SearchBeside } from "./beside.js";
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
  const screener = useText("screener");
  if (model.egg) {
    return (
      <>
        <Empty label={t("egg")} />
        <ListLine fine>{t("eggHint")}</ListLine>
      </>
    );
  }
  const title = model.indexing
    ? t("stillReading")
    : model.settledEmpty || model.nothingMatched
      ? t("nothingMatched")
      : null;
  const junk = beside.junk;
  /* The pass that does not exist: nothing here ever searched the provider's Junk folder. */
  const junkSaid =
    junk === NONE ? null : junk === "unnamed" ? t("saidJunk") : t("saidJunkNamed", { folder: junk.named });
  return (
    <>
      {title !== null ? <Empty label={title} /> : null}
      <SearchVerdictLine model={model} lines={lines} />
      {model.nothingMatched ? <ListLine fine>{t("scopeDepth")}</ListLine> : null}
      {/* The address's own view holds its scopes. */}
      {model.addressOnly ? (
        <ListLine
          act={{ label: t("addressOpen"), quiet: true, onPress: () => beside.go.address(model.text) }}
        >
          {t("emptyAddressScopes", { address: displayAddress(model.text) })}
        </ListLine>
      ) : null}
      {junkSaid !== null ? <ListLine fine>{junkSaid}</ListLine> : null}
      {junkSaid !== null && beside.junkReadable ? (
        <ListLine fine>{screener("junkElsewhere")}</ListLine>
      ) : null}
      {model.partsSaid ? <ListLine fine>{t("saidPart")}</ListLine> : null}
    </>
  );
}
