/** Whether this server takes the person filters, or words and facets only. */
export type SearchBy = "people" | "words";

/** Old servers keep word search even when they ignore unrecognized filters. */
export async function readSearchBy(read: (path: string) => Promise<Response>): Promise<SearchBy> {
  const response = await read("/hello");
  if (!response.ok) return "words";
  const answer = (await response.json()) as { features?: { searchPeople?: unknown } };
  return answer?.features?.searchPeople === true ? "people" : "words";
}

/** A total from the store is known only if every mailbox sent its count. */
export function mailboxTotalOf(mailboxes: readonly unknown[]): number | null {
  let total = 0;
  for (const mailbox of mailboxes) {
    if (mailbox === null || typeof mailbox !== "object" || !("messageCount" in mailbox)) return null;
    const { messageCount } = mailbox;
    if (typeof messageCount !== "number" || !Number.isSafeInteger(messageCount) || messageCount < 0)
      return null;
    total += messageCount;
  }
  return total;
}
