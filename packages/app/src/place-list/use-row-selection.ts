import { useLayoutEffect, useMemo } from "react";
import { useOptionalKeyBindings } from "@ohmail/app-logic/keys";
import { useStableCallback } from "@ohmail/app-logic/press/stable-callback";
import { usePickSet } from "@ohmail/app-logic/ohbox";
import type { RowProps } from "@ohmail/ui/mail";
import { useText } from "../text/index.js";

export function useRowSelection(order: readonly { readonly id: string }[], scope?: string) {
  const t = useText("ohbox");
  const label = t("keyPick");
  const { rows, indices } = useMemo(
    () => ({
      rows: order.map((row) => ({ members: [row] })),
      indices: new Map(order.map((row, index) => [row.id, index])),
    }),
    [order],
  );
  const indexOf = (id: string | null) => (id === null ? -1 : (indices.get(id) ?? -1));
  const { picked, clearPicked, togglePick, pickRangeTo } = usePickSet(rows, indexOf);
  const reset = useStableCallback(clearPicked);
  useLayoutEffect(reset, [scope, reset]);
  const pickedRows = order.filter(({ id }) => picked.has(id));
  const active = pickedRows.length > 0;
  useOptionalKeyBindings(
    active
      ? [
          {
            chord: "Escape",
            group: "message",
            label: t("keyClear"),
            inInput: true,
            run: clearPicked,
          },
        ]
      : [],
  );
  return {
    active,
    pickedRows,
    ids: [...new Set(pickedRows.map(({ id }) => id))],
    clear: clearPicked,
    rowProps: (id: string): Pick<RowProps, "selection" | "picked"> => {
      return !indices.has(id)
        ? {}
        : {
            picked: picked.has(id),
            selection: { label, active, onPress: (extend) => (extend ? pickRangeTo : togglePick)(id) },
          };
    },
  };
}

export type RowSelection = ReturnType<typeof useRowSelection>;
