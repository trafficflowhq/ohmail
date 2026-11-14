import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

/**
 * THE PAGE'S WORD FOR ITS FIRST FRAME. `middleware.ts` writes `x-ohmail-first-page` on the rewrite to the app: `now`
 * after a probe that named a full session, `wait` when it skipped the probe. The page hands the shell `now` only for
 * that exact word; a missing, forged-looking or unknown one is `wait`, so a request that reached the page around the
 * middleware draws nothing of a mailbox before the browser's own check.
 */

let sent: Headers = new Headers();
vi.mock("next/headers", () => ({ headers: async () => sent }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));

type Page = (props: { searchParams?: Promise<Record<string, string>> }) => Promise<ReactElement<{ drawMail?: string }>>;

async function wordFor(value: string | null): Promise<string | undefined> {
  sent = new Headers(value === null ? {} : { "x-ohmail-first-page": value });
  const { default: page } = (await import("../app/(product)/mailbox/page")) as unknown as { default: Page };
  return (await page({ searchParams: Promise.resolve({}) })).props.drawMail;
}

describe("the mailbox page's word", () => {
  const base = process.env.NEXT_PUBLIC_API_BASE;
  beforeEach(() => { process.env.NEXT_PUBLIC_API_BASE = "/api"; });
  afterEach(() => {
    if (base === undefined) delete process.env.NEXT_PUBLIC_API_BASE;
    else process.env.NEXT_PUBLIC_API_BASE = base;
  });

  it("is now only for the exact word now", async () => {
    expect(await wordFor("now")).toBe("now");
  });

  it("is wait for wait, for no word, and for any other spelling", async () => {
    for (const value of ["wait", null, "", "NOW", "now,now", "yes", "1"]) {
      expect(await wordFor(value), String(value)).toBe("wait");
    }
  });
});
