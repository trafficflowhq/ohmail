/**
 * THE PANE'S TIMES, in the reader's own language and zone, which the shell hands in: how long ago (with the exact
 * time for a tooltip), the day something became true, and the stamp of when a check last ran. An unparseable instant
 * is said as it came, or as a dash: a sentence with a wrong time would be a claim.
 */
import { appointmentStamp } from "@ohmail/client-engine";

export interface Stamps {
  /** The catalogue's words for an age too young for a unit. */
  readonly justNow: string;
  /** "2 minutes ago", and the exact time beside it. */
  ago(iso: string, now: number): { readonly rel: string; readonly abs: string };
  /** The day, with no clock on it; a dash for none. */
  day(iso: string | null | undefined): string;
  /** "18:40" today, "Mon 18:40" inside the week, "3 Aug, 18:40" past it; empty for an unreadable instant. */
  when(iso: string, now: number): string;
}

/** `justNow` is the catalogue's own words for an age too young for a unit. */
export function stampsOf(locale: string, timeZone: string, justNow: string): Stamps {
  return {
    justNow,
    ago: (iso, now) => {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return { rel: iso, abs: iso };
      const abs = new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone,
      }).format(d);
      const secs = Math.max(0, Math.round((now - d.getTime()) / 1000));
      if (secs < 45) return { rel: justNow, abs };
      const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
      if (secs < 3600) return { rel: rtf.format(-Math.round(secs / 60), "minute"), abs };
      if (secs < 86400) return { rel: rtf.format(-Math.round(secs / 3600), "hour"), abs };
      return { rel: rtf.format(-Math.round(secs / 86400), "day"), abs };
    },
    day: (iso) => {
      if (!iso) return "—";
      const at = new Date(iso);
      if (Number.isNaN(at.getTime())) return "—";
      return at.toLocaleDateString(locale, { dateStyle: "medium", timeZone });
    },
    when: (iso, now) => {
      const at = new Date(iso);
      if (Number.isNaN(at.getTime())) return "";
      return appointmentStamp(at, new Date(now), timeZone, locale);
    },
  };
}
