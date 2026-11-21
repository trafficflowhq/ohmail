import { useEffect, useRef, useState } from "react";
import { NONE, type HostWires, type Payloads } from "../../host/index.js";
import type { ScreenerFiled } from "./model.js";

export function useFiledLetters(wire: HostWires["autoFiled"]): ScreenerFiled | null {
  const [page, setPage] = useState<Payloads.AutoFiled | null>(null);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    let current = true;
    if (wire !== NONE)
      void wire
        .list()
        .then((result) => {
          if (current) setPage(result);
        })
        .catch(() => {
          if (current) setPage(null);
        });
    return () => {
      current = false;
      alive.current = false;
    };
  }, [wire]);
  if (wire === NONE || !page) return null;
  return {
    letters: page.items.map(({ messageId: id, from, subject, to }) => ({ id, from, subject, to })),
    more: page.more,
    putBack: async (ids) => {
      const result = await wire.putBack(ids);
      if (alive.current) {
        const restored = new Set(result.putBack);
        setPage(
          (previous) =>
            previous && {
              ...previous,
              items: previous.items.filter((item) => !restored.has(item.messageId)),
            },
        );
        const current = await wire.list().catch(() => null);
        if (alive.current && current) setPage(current);
      }
      return { back: result.putBack.length, requested: result.requested.length };
    },
  };
}
