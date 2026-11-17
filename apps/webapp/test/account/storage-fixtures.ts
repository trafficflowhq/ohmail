/**
 * The storage blocks the account's access answer carries, as the server sends them: what Settings › Storage's cases
 * draw and walk. Amounts are the test's own, in the offer's minor unit.
 */
export const OFFER = {
  currency: "usd",
  interval: "month",
  plans: [
    { plan: "solo", mailboxes: 2, roomBytes: 2_000_000_000, amount: 900 },
    { plan: "plus", mailboxes: 5, roomBytes: 5_000_000_000, amount: 1500 },
    { plan: "pro", mailboxes: 10, roomBytes: 10_000_000_000, amount: 2900 },
  ],
  addon: { unitBytes: 10_000_000_000, amount: 1000, maxUnits: 10 },
  current: { plan: "solo", addonUnits: 0, roomBytes: 2_000_000_000, roomFrom: "now" },
  fit: { plan: "plus", addonUnits: 1, roomBytes: 15_000_000_000, amount: 2500, keepsAll: true },
  canChange: true,
  reason: null,
};

const ESTIMATE = {
  expectedBytes: 12_500_000_000,
  expectedLetters: 500_000,
  storedLetters: 128_000,
  avgLetterBytes: 25_000,
  avgMeasured: false,
  complete: true,
  at: "2026-11-07T08:00:00.000Z",
};

const MAILBOXES = [
  { id: "mb_1", usedBytes: 2_600_000_000, letters: 400_000, expectedLetters: 400_000, expectedBytes: 10_000_000_000, importing: true },
  { id: "mb_2", usedBytes: 600_000_000, letters: 100_000, expectedLetters: 100_000, expectedBytes: 2_500_000_000, importing: false },
];

/** A trial near its room while a first import runs, with the program's offer. */
export const NEAR = {
  usedBytes: 3_200_000_000,
  limitBytes: 4_000_000_000,
  emptiedForSpace: 0,
  firstEmptiedAt: null,
  keptFrom: null,
  withheldOnArrival: 0,
  emptyingNow: false,
  planLimitBytes: 2_000_000_000,
  limitDropsAt: null,
  limitReason: "trial",
  importing: true,
  card: "near",
  mail: true,
  estimate: ESTIMATE,
  mailboxes: MAILBOXES,
  offer: OFFER,
};

/** Every form the shipped pane draws a block in: by name, each a block as the server sends it. */
export const BLOCKS: Readonly<Record<string, Record<string, unknown>>> = {
  near: NEAR,
  full: {
    ...NEAR,
    usedBytes: 4_000_000_000,
    importing: false,
    card: "full",
    emptiedForSpace: 1_204,
    keptFrom: "2021-03",
    estimate: { ...ESTIMATE, avgMeasured: true },
  },
  keptSome: { ...NEAR, usedBytes: 4_100_000_000, importing: false, card: "full", emptiedForSpace: 312 },
  heldUntil: {
    ...NEAR,
    limitReason: "held",
    limitDropsAt: "2026-11-26T12:00:00.000Z",
    importing: false,
    card: "drop",
  },
  heldUndated: { ...NEAR, limitReason: "held", importing: false, card: null },
  /* The program's offer by the year: every amount is said for the year. */
  yearly: { ...NEAR, offer: { ...OFFER, interval: "year" } },
  plan: {
    ...NEAR,
    usedBytes: 235_000_000,
    limitBytes: 5_000_000_000,
    planLimitBytes: null,
    limitReason: "plan",
    importing: false,
    card: null,
    estimate: { ...ESTIMATE, complete: false },
    offer: { ...OFFER, current: { ...OFFER.current, plan: "plus" }, fit: { ...OFFER.fit, plan: "plus", addonUnits: 0 } },
  },
  noEstimate: { ...NEAR, estimate: null, mailboxes: [], importing: false, offer: null },
  noOffer: { ...NEAR, offer: null, mail: false },
  noAddon: { ...NEAR, offer: { ...OFFER, addon: null, fit: { ...OFFER.fit, addonUnits: 0 } } },
};

/** The access answer of a metered account whose block is the one given. */
export const open = (storage: unknown): Record<string, unknown> => ({
  metered: true,
  access: "open",
  canAddMailbox: true,
  mailboxes: 2,
  aiEnabled: true,
  lifecycle: { state: "trialing", closedReason: null, trialEndsAt: null, graceUntil: null },
  ...(storage === undefined ? {} : { storage }),
});

/** The account's mailboxes as the shell holds them. */
export const ROSTER = [
  { id: "mb_1", address: "sam@example.com", status: "connected", initialImportCompletedAt: null },
  { id: "mb_2", address: "office@example.com", status: "connected", initialImportCompletedAt: "2026-10-01T00:00:00.000Z" },
];
