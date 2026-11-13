/**
 * The calendar's root export. A shell mounts it with `import { calendar } from "@ohmail/app/calendar"` and hands it
 * in as `FrameSupplies.calendar`; a shell that does not import it downloads none of the calendar.
 */
export { calendar } from "./entry.js";
