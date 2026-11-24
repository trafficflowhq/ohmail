/** Stored bits are permanent. Assign a new bit to each new confirmation. */
export const SCREENER_ACKNOWLEDGEMENTS = {
  spamUnsubscribe: 1,
  screenOutUnsubscribe: 2,
  applySuggestions: 4,
  bulkSpamUnsubscribe: 8,
  bulkScreenOutUnsubscribe: 16,
  moveToJunk: 32,
} as const;

export type ScreenerAcknowledgement = keyof typeof SCREENER_ACKNOWLEDGEMENTS;

export function isScreenerAcknowledgement(value: unknown): value is ScreenerAcknowledgement {
  return typeof value === "string" && Object.hasOwn(SCREENER_ACKNOWLEDGEMENTS, value);
}

export function screenerAcknowledgementsOf(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0x7fffffff
    ? value
    : 0;
}
