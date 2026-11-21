/** Add the quote envelope to a simulated server price. A test can supply its own exact pairs. */
export function withQuotedPairs(
  value: unknown, senders: readonly string[], messageIdOf = (sender: string) => "m-" + sender,
): unknown {
  if (typeof value !== "object" || value === null) return value;
  const quote = value as { dryRun?: boolean; quoted?: number; quotedCredits?: number; quoteGrant?: unknown };
  if (!quote.dryRun || quote.quoteGrant !== undefined || typeof quote.quoted !== "number" ||
      typeof quote.quotedCredits !== "number") return value;
  return {
    ...value,
    quoteGrant: {
      proof: "fixture-quote",
      pairs: senders.slice(0, quote.quoted).map((sender) => ({ sender, messageId: messageIdOf(sender) })),
    },
  };
}

export async function quotedResponse(
  response: Response, senders: readonly string[], messageIdOf?: (sender: string) => string,
): Promise<Response> {
  if (!response.ok) return response;
  return Response.json(withQuotedPairs(await response.json(), senders, messageIdOf), {
    status: response.status, headers: response.headers,
  });
}
