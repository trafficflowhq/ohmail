/** A sibling site such as hosted billing opens a new document in the mailbox. */
export function showMailboxOpening(headers: Pick<Headers, "get">): boolean {
  const firstPage = headers.get("x-ohmail-first-page");
  return (firstPage === "now" || firstPage === "wait") &&
    headers.get("sec-fetch-site") === "same-site" &&
    headers.get("sec-fetch-mode") === "navigate" &&
    headers.get("sec-fetch-dest") === "document";
}
