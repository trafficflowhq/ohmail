/**
 * A ROW'S SWIPE, for the kit's row: the verbs at its sides go to the list's layer, and the row gets back how far it
 * is drawn. Only the pulled row draws again. Where no list's layer stands above (a mouse, a list without one), the
 * answer is undefined and the row is the kit's row as it stands, with no slot of its own.
 */
import { createContext, useContext, useLayoutEffect, useSyncExternalStore } from "react";
import type { RowSwipe } from "@ohmail/ui/mail";
import type { RowSides, UseRowSwipe } from "./contract.js";
import type { ListTouchStore } from "./list-touch.js";

/** The list's layer, where a finger can swipe its rows; null under a mouse. */
export const ListTouchContext = createContext<ListTouchStore | null>(null);

const still = () => () => undefined;
const rest = () => 0;

export const useRowSwipe: UseRowSwipe = (id: string, sides: RowSides): RowSwipe | undefined => {
  const store = useContext(ListTouchContext);
  /* The latest verbs, every render: a verb's call closes over the row as it is drawn now. */
  useLayoutEffect(() => store?.sides(id, sides));
  const pulled = useSyncExternalStore(
    store ? store.subscribe : still,
    store ? () => store.pulledOf(id) : rest,
    rest,
  );
  if (!store) return undefined;
  const { read, later } = sides;
  /* `pulled` is always a number: the row is drawn where the layer says, and never by a gesture of its own. */
  return {
    ...(read ? { right: { label: read.label, icon: read.icon } } : {}),
    ...(later ? { left: { label: later.label, icon: later.icon } } : {}),
    pulled,
  };
};
