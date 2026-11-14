/**
 * AN ADDRESS'S LIST: everything from and to one address, as All, From them or To them, each with its count, and the
 * place each letter is in on its row. Its head closes it, back to the list it was opened from.
 */
import { useAddressModel, type AddressModel, type AddressSide } from "@ohmail/app-logic/address";
import { Button, Empty, Seg } from "@ohmail/ui/base";
import { ListHead, ListLine } from "@ohmail/ui/mail";
import type { PaneProps } from "../frame/contract.js";
import { LetterRows, ListColumn } from "../place-list/index.js";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { useText, type Text } from "../text/index.js";

export function AddressList({ plan }: PaneProps) {
  const model = useAddressModel();
  const t = useText("address");
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
        <Seg
          label={t("side.label")}
          options={sides.map((value) => ({
            value,
            label: t(`sideCount.${value}`, { count: model.counts[value] }),
          }))}
          value={model.side}
          onChange={model.choose}
        />
      }
    />
  );
  return (
    <ListColumn head={head} plan={plan} cursor={model.list.cursor}>
      <ArchiveScope model={model} t={t} />
      {model.list.rows.length > 0 ? (
        <LetterRows
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
            model.archive
              ? t(`archive.empty.${model.side}`, { address: displayAddress(model.address) })
              : t(`empty.${model.side}`)
          }
        />
      ) : null}
      {model.loading ? <Empty label={t("loading")} /> : null}
    </ListColumn>
  );
}

function ArchiveScope({ model, t }: { model: AddressModel; t: Text }) {
  const view = model.archive;
  if (!view) return null;
  const { archive } = view;
  const recent = view.indexing
    ? t("archive.indexing")
    : t("archive.device", { count: view.counts[model.side === "all" ? "any" : model.side] });
  if (archive.state === "failed") {
    const offline = archive.errorClass.split(" ").includes("offline_read_only");
    return (
      <ListLine act={offline ? undefined : { label: t("archive.retry"), onPress: archive.retry }}>
        {`${recent} · ${t(offline ? "archive.offline" : "archive.unanswered")}`}
      </ListLine>
    );
  }
  if (archive.state !== "ready")
    return (
      <ListLine busy={archive.state === "searching"}>
        {`${recent} · ${t(archive.state === "searching" ? "archive.searching" : "archive.unavailable")}`}
      </ListLine>
    );
  const senderOnly = view.coverage === "senders-only";
  const exact = archive.importing ? "synced" : "whole";
  const key =
    senderOnly && model.side === "to"
      ? "noRecipients"
      : `${exact}${senderOnly ? "BySender" : ""}${archive.atLeast ? "AtLeast" : ""}`;
  const why = senderOnly
    ? t(model.side === "to" ? "archive.noRecipientsWhy" : "archive.bySenderWhy")
    : undefined;
  const parts = [recent, t(`archive.${key}`, { count: archive.total })];
  if (archive.total > archive.items.length) parts.push(t("archive.shown", { shown: archive.items.length }));
  if (archive.importing) parts.push(t("archive.importing"));
  return (
    <>
      <ListLine>{parts.join(" · ")}</ListLine>
      {why ? <ListLine fine>{why}</ListLine> : null}
    </>
  );
}
