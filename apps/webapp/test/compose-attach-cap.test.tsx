/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { WriteFilesFixture } from "./fixtures/write-files";
import {
  composeAttachBudgetFor, composeAttachCap, COMPOSE_ATTACH_MAX_TOTAL_BYTES,
  COMPOSE_ATTACH_UNMEASURED_MESSAGE_BYTES,
} from "@ohmail/client-engine";
import { optionsFromFacts, optionsFromMirror, resolveComposeFrom } from "@ohmail/app-logic/writing/compose-from";

/**
 * THE NUMBER ON SCREEN IS THE NUMBER THAT WILL BE ENFORCED.
 *
 * The compose surface stated "Up to 3 MB" as a hard-coded literal. That number came from the hosted
 * API's serverless request-body limit, and it was a claim the product could not keep in either
 * direction: a provider capping submission below it let a user pick a file, press Send, wait, and
 * have their own server bounce the message; and a local install — same code, same process, no
 * request body anywhere in the path — refused files its own mail server would have taken.
 *
 * So the control takes the cap as a PROP and renders the prop, and the prop is
 * `min(this surface's own ceiling, what this mailbox's server announced)`. These guards pin the
 * three joints: the `min`, the strict fallback, and the fact that the sentence is rendered from the
 * same value the picker refuses against.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MIB = 1024 * 1024;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function render(maxTotalBytes: number | undefined, locale: "en" | "de" = "en"): Promise<void> {
  const el = h(WriteFilesFixture, { cap: maxTotalBytes, locale });
  if (!root) { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); }
  await act(async () => { root!.render(el); });
}

const capText = (): string => host!.querySelector<HTMLButtonElement>(".oh-attach button")!.title ?? "";

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove(); root = null; host = null;
});

describe("composeAttachCap — the client mirror of the server's min()", () => {
  it("A STINGY PROVIDER BINDS THE SURFACE — the acceptance check", () => {
    // The announcement's BUDGET FOR RAW BYTES, not its face value: `SIZE` bounds the encoded
    // message, so an announced size carries about three quarters of it in files. `composeAttachBudgetFor`
    // holds the derivation and is pinned against the send's copy by the parity suite.
    expect(composeAttachCap(2 * MIB)).toBe(composeAttachBudgetFor(2 * MIB));
    expect(composeAttachCap(2 * MIB)).toBeLessThan(COMPOSE_ATTACH_MAX_TOTAL_BYTES);
  });

  it("a generous provider does NOT lift the surface past what the request can carry", () => {
    // The browser still has to push these bytes through the hosted API's body limit, so a
    // client that rendered the mailbox's 35 MB raw would promise something it cannot deliver.
    expect(composeAttachCap(35 * MIB)).toBe(COMPOSE_ATTACH_MAX_TOTAL_BYTES);
  });

  it("unknown, null and `SIZE 0` all resolve to the surface's own ceiling", () => {
    expect(composeAttachCap(null)).toBe(COMPOSE_ATTACH_MAX_TOTAL_BYTES);
    expect(composeAttachCap(undefined)).toBe(COMPOSE_ATTACH_MAX_TOTAL_BYTES);
    expect(composeAttachCap(0)).toBe(COMPOSE_ATTACH_MAX_TOTAL_BYTES);
    expect(composeAttachCap(Number.NaN)).toBe(COMPOSE_ATTACH_MAX_TOTAL_BYTES);
  });
});

describe("composeAttachCap — the surface dimension (the local engine's seam)", () => {
  it("an EXPLICITLY UNCAPPED surface lets the mailbox's own announcement govern", () => {
    // The desktop's standalone door: the form, the engine and the SMTP dial are one process,
    // so the only ceiling is the one the user's own submission server announced.
    expect(composeAttachCap(25 * MIB, null)).toBe(composeAttachBudgetFor(25 * MIB));
    expect(composeAttachCap(25 * MIB, null)).toBeGreaterThan(COMPOSE_ATTACH_MAX_TOTAL_BYTES);
    // …and a stingy announcement still binds below the constant, exactly as on the hosted tab.
    expect(composeAttachCap(2 * MIB, null)).toBe(composeAttachBudgetFor(2 * MIB));
  });

  it("both unknown resolves to the assumed provider SIZE — never to 'unbounded', never to 3 MB", () => {
    const assumed = composeAttachBudgetFor(COMPOSE_ATTACH_UNMEASURED_MESSAGE_BYTES);
    expect(composeAttachCap(null, null)).toBe(assumed);
    expect(composeAttachCap(undefined, null)).toBe(assumed);
    // The reported refusal: a 4 MB video on a server that announced nothing.
    expect(assumed).toBeGreaterThan(4 * MIB);
  });

  it("`SIZE 0` and non-finite garbage never become a ceiling, even with the surface uncapped", () => {
    const assumed = composeAttachBudgetFor(COMPOSE_ATTACH_UNMEASURED_MESSAGE_BYTES);
    expect(composeAttachCap(0, null)).toBe(assumed);
    expect(composeAttachCap(Number.NaN, null)).toBe(assumed);
    expect(composeAttachCap(-1, null)).toBe(assumed);
    expect(composeAttachCap(Number.POSITIVE_INFINITY, null)).toBe(assumed);
  });

  it("an UNDECLARED surface is the strict one — identical to the one-argument call", () => {
    // A caller that has not been taught the surface dimension must not acquire a bigger
    // allowance by not passing it. Every existing one-argument call is this case.
    expect(composeAttachCap(25 * MIB, undefined)).toBe(COMPOSE_ATTACH_MAX_TOTAL_BYTES);
    expect(composeAttachCap(25 * MIB, undefined)).toBe(composeAttachCap(25 * MIB));
    expect(composeAttachCap(2 * MIB, undefined)).toBe(composeAttachCap(2 * MIB));
  });

  it("a NUMERIC surface is a bound in both directions", () => {
    expect(composeAttachCap(35 * MIB, 2 * MIB)).toBe(2 * MIB);
    expect(composeAttachCap(1 * MIB, 2 * MIB)).toBe(composeAttachBudgetFor(1 * MIB));
    // A surface declaring a cap of nothing must never become a ceiling no message can clear.
    expect(composeAttachCap(25 * MIB, 0)).toBe(composeAttachBudgetFor(25 * MIB));
  });
});

describe("the resolved From carries the sending mailbox's own ceiling", () => {
  const facts = [
    {
      id: "old", address: "old@lichtgrat.example", status: "connected",
      createdAt: "2026-01-01T00:00:00.000Z", smtpMaxSizeBytes: 2 * MIB,
    },
    {
      id: "new", address: "new@lichtgrat.example", status: "connected",
      createdAt: "2026-02-01T00:00:00.000Z", smtpMaxSizeBytes: 35 * MIB,
    },
  ];

  it("the default sender's number, not the account's first or largest", () => {
    const resolved = resolveComposeFrom(optionsFromFacts(facts), null);
    expect(resolved.mailboxId).toBe("old");
    expect(resolved.maxMessageBytes).toBe(2 * MIB);
    expect(composeAttachCap(resolved.maxMessageBytes)).toBe(composeAttachBudgetFor(2 * MIB));
  });

  it("switching the From selector moves the ceiling with it", () => {
    const resolved = resolveComposeFrom(optionsFromFacts(facts), "new");
    expect(resolved.mailboxId).toBe("new");
    expect(composeAttachCap(resolved.maxMessageBytes)).toBe(COMPOSE_ATTACH_MAX_TOTAL_BYTES);
  });

  it("a surface with no `GET /mailboxes` (the mirror) names no ceiling and falls back", () => {
    const resolved = resolveComposeFrom(optionsFromMirror([{ id: "m1", address: "demo@x.test" }]), null);
    expect(resolved.maxMessageBytes).toBeNull();
    expect(composeAttachCap(resolved.maxMessageBytes)).toBe(COMPOSE_ATTACH_MAX_TOTAL_BYTES);
  });
});

describe("the copy renders the prop's number", () => {
  it("states the SMALLER provider ceiling, not the hard-coded 3 MB", async () => {
    await render(2 * MIB);
    // 2 MiB, said the way every size in the product is said — decimal, like the Finder.
    expect(capText()).toContain("2.1 MB");
    expect(capText()).not.toContain("3.1 MB");
  });

  it("states the surface constant when that is what applies", async () => {
    await render(COMPOSE_ATTACH_MAX_TOTAL_BYTES);
    expect(capText()).toContain("3.1 MB");
  });

  it("defaults to the strict surface ceiling when no prop is given", async () => {
    // A caller that has not been taught to resolve a mailbox must not acquire a bigger allowance
    // by omitting the prop.
    await render(undefined);
    expect(capText()).toContain("3.1 MB");
  });

  it("is translated — the German catalog carries the same parameter", async () => {
    await render(2 * MIB, "de");
    // "Bis zu 2,1 MB insgesamt" — the number is a parameter in both catalogs, so a locale cannot
    // carry a frozen literal the other one has stopped believing, AND the number itself reads in
    // the reader's language: a decimal point in a German pane is a thousands separator.
    expect(capText()).toContain("2,1 MB");
    expect(capText()).not.toContain("2.1 MB");
    expect(capText()).toMatch(/höchstens/);
  });
});
