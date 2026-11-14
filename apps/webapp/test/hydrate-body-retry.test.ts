/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { letter, mountReader } from "../../../packages/app/test/reader/support/mail.js";

/**
 * SCREENER-HYDRATE — the body-hydration ask must FORWARD the person's `{ retry }`.
 *
 * Today's shell built one `hydrateBody` and handed it to every pile; it used to drop the second
 * argument, so every "try again" was inert: `OhmailEngine.hydrateBody` re-asks a FAILED body only
 * under that flag, and a held message whose body 500'd could not be recovered short of reloading
 * the tab. The new reader asks the engine itself: its Try again must ask with `{ retry: true }`,
 * and its own ask at the open must not, so a refused body is not re-polled by itself.
 *
 * Over the new reader's column and the reader's fake engine, which records every body ask
 * (`"<id> retry"` for a retry), so this asserts the FORWARD and not the engine's own retry logic
 * (which `packages/client-engine/test/body-hydration.test.ts` already owns).
 */
afterEach(() => cleanup());

const failed = () =>
  mountReader({
    letters: [letter("m-1", { body: undefined } as never)],
    open: "m-1",
    bodies: { "m-1": { state: "failed" } },
  });

describe("the reader's body ask", () => {
  it("forwards { retry: true } to the engine — the human 'try again' path", () => {
    const { mail } = failed();
    const before = mail.bodyAsks.length;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(mail.bodyAsks.slice(before)).toEqual(["m-1 retry"]);
  });

  it("asks without retry on the automatic trigger, so a refused body is not re-polled", () => {
    const { mail } = failed();
    expect(mail.bodyAsks.length).toBeGreaterThan(0);
    expect(mail.bodyAsks.filter((a) => a.endsWith(" retry"))).toEqual([]);
  });
});
