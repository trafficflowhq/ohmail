/**
 * THE ONE ORDER of the notice slot. Lower stands in front. Taken from the simulation's table; the kinds
 * marked * are the shipped app's alone, placed beside their nearest drawn neighbour.
 */
export const NOTICE_RANK = {
  signedOut: 0,
  ownerLost: 1, // *
  noMailbox: 5,
  offline: 10,
  hostQuiet: 11, // *
  mailServerDown: 12,
  reconnecting: 14,
  late: 15, // *
  mailboxPassword: 20,
  calendarSignIn: 21,
  calendarConnection: 21,
  mailboxSync: 22,
  notSent: 28,
  sentCopy: 29,
  unsaved: 30,
  notKept: 31, // *
  organizingStopped: 40,
  notOrganizing: 41,
  filingStopped: 42,
  waiting: 43,
  organizedElsewhere: 44,
  reader: 45,
  filingElsewhere: 46,
  gap: 47,
  unscreened: 48,
  filingStuck: 49,
  filingWaits: 50,
  mailboxFull: 60,
  storageFull: 61,
  storage: 62,
  payment: 70,
  grace: 71,
  trial: 72,
  update: 80,
  settingsFound: 81,
  away: 82,
  noMail: 83,
  signInCopies: 84,
  ohmarchy: 85,
  caughtUp: 86,
  demo: 87, // *
  sending: 89, // *
  behind: 90,
  firstSync: 91,
  filing: 92,
  mailLinks: 94, // *
  desktopOffer: 95, // *
} as const;
export type NoticeKind = keyof typeof NOTICE_RANK;
