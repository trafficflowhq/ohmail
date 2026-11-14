import nodemailer, { type Transporter } from "nodemailer";
import { vi } from "vitest";

/**
 * The SMTP transporter an adapter builds, taken where the adapter takes it: from
 * `nodemailer.createTransport`. Call before `connect()`; `last()` is the newest one built.
 */
export function watchTransporters(): { last(): Transporter; restore(): void } {
  const spy = vi.spyOn(nodemailer, "createTransport");
  return {
    last(): Transporter {
      const results = spy.mock.results;
      const newest = results[results.length - 1];
      if (newest === undefined || newest.type !== "return") throw new Error("the adapter built no transporter");
      return newest.value as Transporter;
    },
    restore(): void { spy.mockRestore(); },
  };
}
