/**
 * Every ceiling and wait of the calendar's providers, each with the reading it rests on. None of
 * the three big readers of subscriptions publishes its limits, so the fetch's are recommendations
 * with no page behind them; where a number is a provider's own, the line says so.
 */
import { MAX_CALENDAR_TEXT_CHARS, MAX_COMPONENTS } from "@ohmail/cal-core";

/**
 * One answer's body, in bytes, counted as they arrive. Equal to what the calendar reader takes in
 * characters: a text's UTF-8 bytes are at least its characters, so nothing that passes here is past
 * the reader's own ceiling. A public holiday feed of ten years read 120,663 characters (2026-11).
 */
export const FETCH_BODY_MAX_BYTES = MAX_CALENDAR_TEXT_CHARS;

/** From the start of one request to its answer's head, the name's lookup included. */
export const CONNECT_TIMEOUT_MS = 10_000;

/** One request with every redirect it follows, to the last byte of the body. */
export const ANSWER_TIMEOUT_MS = 30_000;

/** Redirects followed for an address a person named. Each one passes the address gate again. */
export const MAX_REDIRECTS = 5;

/**
 * An address: typed, named by a redirect, by a server's answer or by a provider's page link. The
 * request line's practical ceiling has been about 8 KB for two decades.
 */
export const MAX_URL_CHARS = 8192;

/** The lowest explicit port dialled besides 80 and 443. Below it are the ports of mail and directory servers; Posteo's 8443, Synology's 5001 and Radicale's 5232 lie above. */
export const MIN_EXPLICIT_PORT = 1024;

/** A change token as a caller stores it. A Microsoft delta link, the longest of the four, is under 2,000 characters. */
export const TOKEN_MAX_CHARS = 4096;

/** A page cursor as a caller hands it back. It can be a provider's whole link. */
export const CURSOR_MAX_CHARS = MAX_URL_CHARS;

/** One of a subscription's validators (ETag, Last-Modified) as kept in its token. A longer one is not kept. */
export const MAX_VALIDATOR_CHARS = 1024;

/** Records asked for in one page. Google's own default; its query is the same every time or its token dies. */
export const MAX_PAGE_LIMIT = 250;

/**
 * Series one page's reading asks the provider about, one request each: Microsoft for a series'
 * rule, Google for the series of a cancelled day. A provider's page cannot be cut short, so a page
 * that names more is `too_large`; none does while a page holds at most `MAX_PAGE_LIMIT` records.
 */
export const MAX_MASTERS_PER_ROUND = 500;

/**
 * Pages one call of the port follows on its own: Google's and Microsoft's list of calendars, and a
 * list that goes on is `page_link_refused`. Pages of events are one a call. CalDAV holds a
 * person's calendar homes and the requests behind one page to the same number.
 */
export const MAX_PAGES_PER_CALL = 20;

/** The longest wait a provider's Retry-After is taken at its word. A longer one is read as this. */
export const MAX_RETRY_AFTER_MS = 86_400_000;

/** Elements nested in a CalDAV answer. A real one nests seven (multistatus, response, propstat, prop, a property, its set, a member). */
export const MAX_MULTISTATUS_DEPTH = 32;

/** Members in one CalDAV answer: as many as a calendar text may hold components. */
export const MAX_MULTISTATUS_RESPONSES = MAX_COMPONENTS;

/** A calendar's name as it is shown. A longer one is nobody's name for a calendar and is not kept. */
export const MAX_CALENDAR_NAME_CHARS = 1024;

/** A calendar's colour as a provider or a file writes it: a colour's name (the longest has 20 letters) or its hex form. */
export const MAX_COLOR_CHARS = 64;

/**
 * Zone definitions of one subscribed file that are looked at. A file defines the zones its events
 * name, a handful; one that defines more is read all the same, and its later definitions stay behind.
 */
export const MAX_FEED_ZONE_DEFINITIONS = 256;

/**
 * How often a subscription is asked again. Outlook.com asks about every 3 hours and Google is
 * quoted with 12; 6 lies between. Never more often than hourly, whatever the file or the person
 * says: a service that fetches a small publisher's file every five minutes for every subscriber is
 * a nuisance. A file's own wish (REFRESH-INTERVAL) is obeyed up to a week, the standard's own example.
 */
export const SUBSCRIPTION_INTERVAL_MS = 6 * 3_600_000;
export const SUBSCRIPTION_INTERVAL_FLOOR_MS = 3_600_000;
export const SUBSCRIPTION_INTERVAL_CEILING_MS = 7 * 24 * 3_600_000;
