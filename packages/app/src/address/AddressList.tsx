/**
 * AN ADDRESS'S LIST: everything from and to one address, as All, From them or To them, each with its count, and the
 * place each letter is in on its row. Its head closes it, back to the list it was opened from.
 */
import { useAddressModel, type AddressSide } from "@ohmail/app-logic/address";
import { Button, Empty, Seg } from "@ohmail/ui/base";
import { ListHead } from "@ohmail/ui/mail";
import type { PaneProps } from "../frame/contract.js";
import { LetterRows, ListColumn } from "../place-list/index.js";
import { useText } from "../text/index.js";

export function AddressList({ plan }: PaneProps) {
  const model = useAddressModel();
  const t = useText("address");
  const sides: readonly AddressSide[] = ["all", "from", "to"];
  const head = (
    <ListHead
      title={model.name}
      meta={model.name.toLowerCase() === model.address.toLowerCase() ? undefined : model.address}
      aside={
        model.back === null ? null : (
          <Button kind="quiet" icon="x" label={t("close")} onPress={model.back.run} />
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
    <ListColumn head={head} plan={plan}>
      {model.list.rows.length > 0 ? (
        <LetterRows
          label={t(`side.${model.side}`)}
          rows={model.list.rows}
          openId={model.list.openId}
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
      {model.empty ? <Empty label={t(`empty.${model.side}`)} /> : null}
      {model.loading ? <Empty label={t("loading")} /> : null}
    </ListColumn>
  );
}
