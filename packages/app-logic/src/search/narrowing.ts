/**
 * THE DEVICE'S FIRST PAINT, NARROWED as the question is: a person on their side, unread, the days. The store answers
 * the narrowed question by itself; this keeps the device's rows from showing what the question leaves out while the
 * store's page is on its way.
 */
import type { EngineMessage } from "@ohmail/wire";
import type { SearchHit } from "@ohmail/client-engine";
import { dayBounds, type SearchNarrowing } from "./question.js";

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function onSide(m: EngineMessage, address: string, dir: "any" | "from" | "to"): boolean {
  const from = same(m.from.address, address);
  const to = [...m.to, ...m.cc].some((p) => same(p.address, address));
  return dir === "from" ? from : dir === "to" ? to : from || to;
}

export function applyNarrowing(
  list: readonly SearchHit[],
  n: SearchNarrowing,
  openId?: string | null,
): readonly SearchHit[] {
  if (n.person === null && !n.unread && n.date === null) return list;
  const first = n.date?.from ? (dayBounds(n.date.from)?.first ?? null) : null;
  const last = n.date?.to ? (dayBounds(n.date.to)?.last ?? null) : null;
  return list.filter(({ message: m }) => {
    if (n.person !== null && !onSide(m, n.person.address, n.person.dir)) return false;
    if (m.id !== openId && n.unread && !m.unread) return false;
    if (first !== null || last !== null) {
      if (!m.date) return false;
      const at = new Date(m.date).getTime();
      if (first !== null && at < new Date(first).getTime()) return false;
      if (last !== null && at > new Date(last).getTime()) return false;
    }
    return true;
  });
}
