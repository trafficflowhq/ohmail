import { DEFAULT_LIMITS, readCalendar } from "@ohmail/cal-core";
import { isRecord } from "./json-answers.js";

const CORE = new Set([
  "UID",
  "DTSTAMP",
  "CREATED",
  "LAST-MODIFIED",
  "SEQUENCE",
  "DTSTART",
  "DTEND",
  "SUMMARY",
  "DESCRIPTION",
  "LOCATION",
  "STATUS",
  "TRANSP",
  "CLASS",
  "ORGANIZER",
  "ATTENDEE",
  "RRULE",
  "URL",
]);
const HEADER = new Set(["VERSION", "PRODID", "CALSCALE"]);

/** The CalDAV member must fit in a single event draft. */
export function portableCalendarText(text: string) {
  const parsed = readCalendar(text, DEFAULT_LIMITS);
  if (!parsed.ok || parsed.dropped.length) return false;
  const { tree, events, timezones, other } = parsed.calendar;
  const event = events[0];
  return (
    events.length === 1 &&
    !!event &&
    !timezones.length &&
    !other.length &&
    tree.properties.every(({ name, params }) => HEADER.has(name) && !params.length) &&
    !event.component.components.length &&
    event.component.properties.every(
      ({ name, params }) =>
        CORE.has(name) &&
        params.every(({ name: param }) =>
          name === "ORGANIZER"
            ? param === "CN"
            : (name === "DTSTART" || name === "DTEND") && (param === "TZID" || param === "VALUE"),
        ),
    ) &&
    new Set(event.component.properties.map(({ name }) => name)).size === event.component.properties.length
  );
}

const GOOGLE = new Set([
  "kind",
  "etag",
  "id",
  "iCalUID",
  "created",
  "updated",
  "sequence",
  "htmlLink",
  "creator",
  "organizer",
  "status",
  "summary",
  "description",
  "location",
  "start",
  "end",
  "transparency",
  "visibility",
  "recurrence",
  "eventType",
  "attachments",
  "extendedProperties",
  "reminders",
  "conferenceData",
  "hangoutLink",
  "colorId",
  "guestsCanInviteOthers",
  "guestsCanSeeOtherGuests",
  "guestsCanModify",
  "attendees",
  "attendeesOmitted",
]);
const GRAPH = new Set([
  "@odata.context",
  "@odata.etag",
  "@odata.type",
  "id",
  "uid",
  "iCalUId",
  "changeKey",
  "createdDateTime",
  "lastModifiedDateTime",
  "originalStartTimeZone",
  "originalEndTimeZone",
  "isAllDay",
  "isCancelled",
  "isDraft",
  "isOrganizer",
  "responseRequested",
  "responseStatus",
  "webLink",
  "subject",
  "body",
  "bodyPreview",
  "location",
  "locations",
  "start",
  "end",
  "type",
  "recurrence",
  "seriesMasterId",
  "showAs",
  "sensitivity",
  "organizer",
  "attendees",
  "categories",
  "importance",
  "hasAttachments",
  "isReminderOn",
  "reminderMinutesBeforeStart",
  "isOnlineMeeting",
  "onlineMeeting",
  "onlineMeetingUrl",
  "onlineMeetingProvider",
  "allowNewTimeProposals",
  "hideAttendees",
  "transactionId",
  "attachments",
  "extensions",
  "singleValueExtendedProperties",
  "multiValueExtendedProperties",
]);

const empty = (value: unknown) => value == null || (Array.isArray(value) && value.length === 0);
const optional = (value: unknown, standard: unknown) => value == null || value === standard;
const within = (raw: Readonly<Record<string, unknown>>, fields: ReadonlySet<string>) =>
  Object.keys(raw).every((key) => fields.has(key));

function googleTime(value: unknown) {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => key === "date" || key === "dateTime" || key === "timeZone") &&
    (typeof value.date === "string"
      ? value.dateTime == null && value.timeZone == null
      : typeof value.dateTime === "string")
  );
}

export function portableGoogle(raw: Readonly<Record<string, unknown>>) {
  const r = raw.reminders;
  return (
    within(raw, GOOGLE) &&
    optional(raw.eventType, "default") &&
    empty(raw.attachments) &&
    raw.colorId == null &&
    raw.extendedProperties == null &&
    raw.conferenceData == null &&
    optional(raw.status, "confirmed") &&
    optional(raw.attendeesOmitted, false) &&
    optional(raw.guestsCanInviteOthers, true) &&
    optional(raw.guestsCanSeeOtherGuests, true) &&
    optional(raw.guestsCanModify, false) &&
    (raw.visibility == null || ["default", "private"].includes(String(raw.visibility))) &&
    googleTime(raw.start) &&
    googleTime(raw.end) &&
    isRecord(r) &&
    r.useDefault === false &&
    empty(r.overrides) &&
    Object.keys(r).every((key) => key === "useDefault" || key === "overrides")
  );
}

function simpleLocation(value: unknown) {
  return (
    value == null ||
    (isRecord(value) &&
      Object.keys(value).every((key) =>
        ["displayName", "locationType", "uniqueIdType", "address", "coordinates", "uniqueId"].includes(key),
      ) &&
      optional(value.locationType, "default") &&
      optional(value.uniqueIdType, "unknown") &&
      [value.address, value.coordinates].every(
        (entry) =>
          entry == null ||
          (isRecord(entry) && Object.values(entry).every((part) => part == null || part === "")),
      ) &&
      (value.uniqueId == null || value.uniqueId === value.displayName || value.uniqueId === ""))
  );
}

export function portableMicrosoft(raw: Readonly<Record<string, unknown>>) {
  return (
    within(raw, GRAPH) &&
    [
      raw.categories,
      raw.attachments,
      raw.extensions,
      raw.singleValueExtendedProperties,
      raw.multiValueExtendedProperties,
    ].every(empty) &&
    [
      raw.hasAttachments,
      raw.isOnlineMeeting,
      raw.isReminderOn,
      raw.isDraft,
      raw.isCancelled,
      raw.hideAttendees,
    ].every((v) => optional(v, false)) &&
    [raw.allowNewTimeProposals, raw.responseRequested, raw.isOrganizer].every((v) => optional(v, true)) &&
    optional(raw.importance, "normal") &&
    optional(raw.onlineMeetingProvider, "unknown") &&
    raw.onlineMeeting == null &&
    raw.onlineMeetingUrl == null &&
    (raw.sensitivity == null || raw.sensitivity === "normal" || raw.sensitivity === "private") &&
    (raw.showAs == null || raw.showAs === "busy" || raw.showAs === "free") &&
    (raw.body == null
      ? !raw.bodyPreview
      : isRecord(raw.body) && (raw.body.contentType === "text" || !raw.body.content)) &&
    simpleLocation(raw.location) &&
    (empty(raw.locations) ||
      (Array.isArray(raw.locations) &&
        raw.locations.length === 1 &&
        simpleLocation(raw.locations[0]) &&
        isRecord(raw.location) &&
        isRecord(raw.locations[0]) &&
        raw.locations[0].displayName === raw.location.displayName))
  );
}
