/**
 * WHAT THE READING COLUMN SAYS WITH NOTHING OPEN. The list that stands above says it (`useListBlank`); with no list,
 * the column says its own word; where the list says nothing, nothing.
 */
import type { ListBlank } from "../reading/list-meeting.js";

export function blankOf(handed: ListBlank | null | undefined, ownWord: string): ListBlank | null {
  if (handed === undefined) return { label: ownWord, hot: false };
  return handed;
}
