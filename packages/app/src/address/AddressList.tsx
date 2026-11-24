/**
 * Everything from and to one address, with the place each letter is in on its row.
 */
import type { ReactNode } from "react";
import { useAddressModel, type AddressModel, type AddressSide } from "@ohmail/app-logic/address";
import { Button, Empty, FindField, Seg } from "@ohmail/ui/base";
import { ListHead, ListLine } from "@ohmail/ui/mail";
import type { PaneProps } from "../frame/contract.js";
import { LetterRows, ListColumn } from "../place-list/index.js";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { useText, type Text } from "../text/index.js";
import "../search/search.css";

export function AddressList({ plan }: PaneProps) {
  const model = useAddressModel();
  const t = useText("address");
  const search = useText("search");
  const sides: readonly AddressSide[] = ["all", "from", "to"];
  const head = (
    <ListHead
      title={model.name}
      meta={
        model.name.toLowerCase() === model.address.toLowerCase() ? undefined : displayAddress(model.address)
      }
      aside={
        model.back === null ? null : (
          <Button kind="quiet" icon="x" label={model.back.label} onPress={model.back.run} />
        )
      }
      below={
        <div className="sr-below">
          <FindField
            label={search("aria")}
            placeholder={search("inTheirMail")}
            value={model.query}
            onChange={model.setQuery}
            clear={{ label: search("clear"), onPress: () => model.setQuery("") }}
          />
          <Seg
            label={t("side.label")}
            options={sides.map((value) => ({
              value,
              label: t(`sideCount.${value}`, { count: model.counts[value] }),
            }))}
            value={model.side}
            onChange={model.choose}
          />
        </div>
      }
    />
  );
  return (
    <ListColumn head={head} plan={plan} cursor={model.list.cursor}>
      {model.list.rows.length > 0 ? (
        <LetterRows
          verbs={model.list.verbs}
          label={t(`side.${model.side}`)}
          rows={model.list.rows}
          cursor={model.list.cursor}
          press={model.list.press}
          stamp={model.stamp}
          who={(m) =>
            m.from.address.toLowerCase() === model.address.toLowerCase()
              ? (m.from.name ?? m.from.address)
              : t("row.to", { name: model.name })
          }
          where={model.placeOf}
          file={t("row.file")}
          spoken={(m) => (m.unread ? t("row.unread") : t("row.read"))}
        />
      ) : null}
      {model.empty ? (
        <Empty
          label={
            model.query.trim()
              ? search("nothingMatched")
              : model.archive
                ? t(`archive.empty.${model.side}`, { address: displayAddress(model.address) })
                : t(`empty.${model.side}`)
          }
        />
      ) : null}
      {model.loading ? <Empty label={t("loading")} /> : null}
      <ArchiveScope model={model} t={t} />
    </ListColumn>
  );
}

function ArchiveScope({ model, t }: { model: AddressModel; t: Text }) {
  const view = model.archive;
  if (!view) return null;
  const { archive } = view;
  const reading = view.indexing ? <ListLine busy>{t("archive.indexing")}</ListLine> : null;
  if (archive.state === "failed") {
    const offline = archive.errorClass.split(" ").includes("offline_read_only");
    return (
      <>
        {reading}
        <ListLine
          warn={offline}
          act={offline ? undefined : { label: t("archive.retry"), onPress: archive.retry }}
        >
          {offline
            ? t.rich("archive.offline", {
                device: (name: ReactNode) => <strong style={{ fontWeight: 500 }}>{name}</strong>,
              })
            : t("archive.unanswered")}
        </ListLine>
      </>
    );
  }
  if (archive.state === "searching") {
    return (
      <>
        {reading}
        <ListLine busy>{t("archive.searching")}</ListLine>
      </>
    );
  }
  if (archive.state !== "ready") return reading;
  const senderOnly = view.coverage === "senders-only";
  if (senderOnly && model.side === "to") return <ListLine fine>{t("archive.noRecipientsWhy")}</ListLine>;
  return (
    <>
      {reading}
      {senderOnly ? <ListLine fine>{t("archive.bySenderWhy")}</ListLine> : null}
      {archive.total > archive.items.length ? (
        <ListLine fine>{t("archive.shown", { shown: archive.items.length })}</ListLine>
      ) : null}
      {archive.importing ? <ListLine fine>{t("archive.importing")}</ListLine> : null}
    </>
  );
}
