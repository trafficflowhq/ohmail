/**
 * The Outlook Web App invitation stub as Exchange serves it over IMAP (reported 2026-10-19), shared by
 * the recognizer's tests and the phone's.
 */
export const OWA_BASE = "https://outlook.office365.com/owa/tenant.example/";
export const OWA_ITEM = `${OWA_BASE}?itemid=AAMkADJh%2FTaHJ8AAV95f1jAAA%3D&exvsurl=1&path=/calendar/item`;
export const OWA_OPTIONS = `${OWA_BASE}?path=/options/popandimap`;
/** The setting link ohmail offers: built from constants, never the message's /owa/<segment>/. */
export const OWA_SETTING_HREF = "https://outlook.office365.com/owa/?path=/options/popandimap";

export const OWA_STUB = [
  "Microsoft Outlook Web Access:",
  OWA_ITEM,
  "",
  "To receive meeting invitations as .iCalendar attachments instead of Outlook Web App links, go to",
  `${OWA_OPTIONS} and select Send meeting invitations in iCalendar format.`,
  "",
].join("\n");

/** The same stub from an on-premises Exchange server: recognized, no link offered. */
export const OWA_STUB_ONPREM = OWA_STUB.replaceAll(OWA_BASE, "https://mail.corp.example/owa/");

/** Ordinary mail that links to the options page: not a stub. */
export const OWA_ORDINARY = `Here is the calendar:\n${OWA_OPTIONS}\nSee you.`;
