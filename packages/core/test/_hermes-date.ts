/**
 * The phone's `Date`, as Hermes answered on an Android emulator (RN 0.86.2, Hermes 250829098.0.16,
 * 2026-10-24): `new Date(s)` and `Date.parse(s)` give these values for these Date header forms, and
 * what Node gives for everything else. NaN is an Invalid Date; the two-digit years read as years 26 and 99.
 */
export const HERMES_MEASURED: Record<string, number> = {
  "24 Oct 2026 06:29:09 +0200": Number.NaN,
  "Sat, 24 Oct 2026 06:29 +0200": Number.NaN,
  "Sat, 24 Oct 2026 04:29:09 UT": Number.NaN,
  "Sat, 24 Oct 26 06:29:09 +0200": -61321087851000,
  "24 Oct 2026 04:29:09 GMT": Number.NaN,
  "4 Oct 2026 06:29:09 +0200": Number.NaN,
  "24 Oct 26 06:29:09 +0200": Number.NaN,
  "Sat, 24 Oct 2026 04:29:09 Z": Number.NaN,
  "Sat, 24 Oct 2026 06:29:09 +02:00": Number.NaN,
  "Sat, 24 oct 2026 06:29:09 +0200": Number.NaN,
  "Sun, 24 Oct 99 06:29:09 +0200": -59017404651000,
  "24-Oct-2026 06:29:09 +0200": Number.NaN,
};

/** Installs the phone's Date on globalThis; the returned function puts Node's back. */
export function usePhoneDate(): () => void {
  const Real = Date;
  class PhoneDate extends Real {
    constructor(...a: unknown[]) {
      if (a.length === 1 && typeof a[0] === "string" && a[0] in HERMES_MEASURED) super(HERMES_MEASURED[a[0]]!);
      else super(...(a as []));
    }
    static override parse(s: string): number {
      return s in HERMES_MEASURED ? HERMES_MEASURED[s]! : Real.parse(s);
    }
  }
  (globalThis as { Date: DateConstructor }).Date = PhoneDate as DateConstructor;
  return () => { (globalThis as { Date: DateConstructor }).Date = Real; };
}
