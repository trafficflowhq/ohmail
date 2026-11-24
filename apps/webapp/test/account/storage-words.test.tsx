/** @vitest-environment jsdom */
import { cleanup, render, within } from "@testing-library/react";
import { ThemeProvider } from "@ohmail/ui";
import { createTranslator } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FactorSlot, StorageFigures } from "@ohmail/app/account";
import { StoragePane } from "../../../../packages/app/src/account/storage/StoragePane.js";
import { useStorage } from "../../../../packages/app/src/account/storage/use-storage.js";
import { formatStoragePrice, storageFactsOf } from "../../app/shell/storage-state";
import { de, en, published, serve, Words, type Server } from "./storage-harness";
import { BLOCKS, open, ROSTER } from "./storage-fixtures";

/**
 * The visible Storage sentences must match the catalogue and the fixture-derived figures
 * in English and German, with and without plan links. The shipped pane supplies the table
 * comparison. The usage line and plan figures are also checked in their own controls.
 */

let roster: unknown[] | null = ROSTER;
vi.mock("@ohmail/app-logic/mail-state/mail-state-binding", () => ({ useMailboxFacts: () => roster }));

let server: Server;
let access: Record<string, unknown> = {};
beforeEach(() => {
  roster = ROSTER;
  server = serve(() => access);
});
afterEach(() => {
  cleanup();
  server.restore();
});

const still = () => {};
const NO_FACTOR: FactorSlot = () => null;
/** The words of what is drawn, figures and all; what separates them (emphasis, a line break) moves no word. */
const wordsOf = (nodes: readonly string[]) =>
  nodes
    .join(" ")
    .split(/[^\p{L}\p{N}%]+/u)
    .filter(Boolean);
const words = (...parts: string[]) => wordsOf(parts).join(" ");
const visibleText = (parts: readonly string[]) => parts.join(" ").replace(/\s+/g, " ").trim();
function textNodes(root: Node, skip: (el: Element) => boolean): string[] {
  const out: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) out.push(node.textContent ?? "");
    if (node.nodeType === Node.ELEMENT_NODE && skip(node as Element)) return;
    node.childNodes.forEach(walk);
  };
  walk(root);
  return out;
}
const tableOf = (container: HTMLElement) => {
  const table = container.querySelector('[role="table"]');
  return {
    table,
    heads: [...(table?.querySelectorAll('[role="columnheader"]') ?? [])].map((th) => th.textContent ?? ""),
    rows: [...(table?.querySelectorAll('[role="row"]:not([data-head])') ?? [])].map((tr) =>
      [...tr.querySelectorAll('[role="cell"]')].map((td) => td.textContent ?? ""),
    ),
  };
};

/** The shipped shared pane over the block, as the browser (links out) or a store's build (may not) drew it. */
async function shipped(raw: Record<string, unknown>, linksOut: boolean, lang: "en" | "de") {
  const { StoragePane: Shipped } = await import("../../app/shell/StoragePane");
  const facts = storageFactsOf(raw)!;
  const { container } = render(
    <Words lang={lang}>
      <ThemeProvider>
        <Shipped
          facts={facts}
          linksOut={linksOut}
          change={linksOut ? { press: still, busy: false, note: null } : null}
          mail={{ on: facts.mail, busy: false, failed: false, onChange: still }}
        />
      </ThemeProvider>
    </Words>,
  );
  const decorative = (el: Element) => el.matches('[aria-hidden="true"], .oh-scalebar');
  const title = container.querySelector("h2");
  const { table, heads, rows } = tableOf(container);
  const said = {
    outside: wordsOf(textNodes(container, (el) => decorative(el) || el === title || el === table)),
    heads,
    rows,
  };
  cleanup();
  return said;
}

it("plots account-wide expected storage independently of the mailbox total", async () => {
  const { StoragePane: SharedPane } = await import("../../app/shell/StoragePane");
  const facts = storageFactsOf(BLOCKS.keptSome)!;
  const { container } = render(
    <Words lang="en">
      <SharedPane facts={facts} linksOut change={null} mail={null} />
    </Words>,
  );
  const part = container.querySelector<HTMLElement>('.oh-scalebar-part[data-kind="rest"]')!;
  const start = Number.parseFloat(part.style.getPropertyValue("--oh-scalebar-from"));
  const share = Number.parseFloat(part.style.getPropertyValue("--oh-scalebar-share"));
  expect(start).toBeCloseTo(100 * facts.usedBytes / facts.estimate!.expectedBytes);
  expect(start + share).toBeCloseTo(100);
  const mailParts = [...container.querySelectorAll<HTMLElement>(".oh-scalebar-part:not([data-kind=rest])")];
  const rowDots = [...container.querySelectorAll<HTMLElement>(".oh-figuretable .oh-tagdot")];
  expect(mailParts).toHaveLength(facts.mailboxes.length);
  mailParts.forEach((mailPart, i) => {
    const paint = mailPart.style.getPropertyValue("--oh-hue-dot");
    expect(paint).toBeTruthy();
    expect(paint).toBe(rowDots[i]!.style.getPropertyValue("--oh-hue-dot"));
  });
});

const storageText = (locale: "en" | "de") =>
  createTranslator({ locale, messages: locale === "en" ? en : de, namespace: "settings" });
type StorageText = ReturnType<typeof storageText>;

function usageWords(t: StorageText, { used, room, tag }: StorageFigures) {
  const of = room.kind === "held"
    ? t("storageFigureHeld", { date: room.until })
    : t(room.kind === "trial" ? "storageFigureTrial" : "storageFigureOf", { limit: room.limit });
  const tagText = tag?.kind === "percent" ? t("storageTagPercent", { percent: tag.percent })
    : tag?.kind === "full" ? t("storageTagFull") : "";
  return [used, of, tagText];
}

function estimateWords(t: StorageText, needs: NonNullable<StorageFigures["needs"]>) {
  const { letters, size, average } = needs;
  return needs.importing
    ? t("storageImportProgress", { stored: needs.importing.stored, expected: letters, size, average: average.size })
    : t("storageNeedsAverage", { count: letters, size, average: average.size });
}

function planWords(t: StorageText, plan: StorageFigures["plan"]): [string, string][] {
  if (plan.kind === "until") return [
    [t("storageYouKeep"), t("storageLimitUntil", { limit: plan.limit, date: plan.date })],
    [t("storageYourPlanKeeps"), t("storageFromThen", { limit: plan.cap })],
  ];
  const label = plan.kind === "keeps" && plan.plan
    ? t("storageNamedPlanKeeps", { plan: t("storagePlanName", { plan: plan.plan }) })
    : t("storageYourPlanKeeps");
  return [[label, plan.kind === "trial" ? plan.cap : plan.limit]];
}

function offerWords(t: StorageText, { lines, addon }: NonNullable<StorageFigures["plans"]>, linksOut: boolean) {
  return [
    t("storagePlansHead"),
    ...lines.flatMap(({ plan, tag, letters, mailboxes, room, price }) => [
      t("storagePlanName", { plan }),
      tag === "yours" ? t("storageTagYours") : tag === "keepsAll" ? t("storageTagFits") : "",
      t("storagePlanFacts", { count: letters, mailboxes }),
      room,
      linksOut ? price ?? "" : "",
    ]),
    ...(addon ? [
      t("storageAddonName"), t("storageTagAddon"),
      t("storageAddonFacts", { count: addon.letters }), addon.unit,
      linksOut ? addon.price ?? "" : "",
    ] : []),
  ];
}

function expectedProse(t: StorageText, figures: StorageFigures, linksOut: boolean) {
  const { bar, needs, kept, plan, plans } = figures;
  return visibleText([
    ...usageWords(t, figures),
    bar.limit.said,
    bar.plan?.said ?? "",
    t("storageScaleStart"),
    bar.rest ? t(bar.rest.kind === "toCome" ? "storageBarImporting" : "storageBarOut") : "",
    bar.expected ? t("storageBarExpected", { size: bar.expected.said }) : bar.scale,
    ...(needs ? [estimateWords(t, needs), needs.complete ? "" : t("storageIncomplete")] : []),
    ...(kept?.kind === "from" ? [t("storageKeptFromLabel"), kept.month] : []),
    kept?.kind === "some" ? t("storageKeptSome", { count: kept.count }) : "",
    kept?.refills ? t("storageRefill") : "",
    t("storageWhatCountsHead"), t("storageCountsText"),
    t("storageAttachments"), t("storageNeverCounted"),
    ...planWords(t, plan).flat(),
    ...(plans ? offerWords(t, plans, linksOut) : []),
    linksOut ? "" : t("storageManageAtSite"),
    t("storageMail"), t("storageMailSub"),
    linksOut && plans?.mayChange ? t("storageChangePlan") : "",
    linksOut && plans?.mayChange && plans.addon ? t("storageAddStorage") : "",
  ]);
}

function expectProseFigures(container: HTMLElement, prose: string, figures: StorageFigures, t: StorageText) {
  const view = within(container);
  const value = (name: string) =>
    view.getByRole("group", { name }).querySelector(".oh-settingline-text")?.textContent;
  const { used, limit, needs, kept, plan } = figures;
  const figureLine = container.querySelector(".oh-figureline");
  const figureText = figureLine ? words(...textNodes(figureLine, () => false)) : "";
  expect(figureText, "used storage, room and usage tag").toBe(words(...usageWords(t, figures)));
  expect(view.getByRole("img", { name: t("storageOf", { used, limit }) })).toBeTruthy();

  if (needs) {
    expect(words(prose), "message count and estimated size").toContain(words(estimateWords(t, needs)));
  }
  if (kept?.kind === "from") {
    expect(value(t("storageKeptFromLabel"))).toBe(kept.month);
  } else if (kept?.kind === "some") {
    expect(words(prose)).toContain(words(t("storageKeptSome", { count: kept.count })));
  }

  for (const [label, expected] of planWords(t, plan)) expect(value(label)).toBe(expected);
}

/** The new pane over the web's real filling, the block published to the tab's feed as the shell's read would. */
async function anew(raw: Record<string, unknown>, body: "pane" | "facts", lang: "en" | "de") {
  const { storageFiguresOf, useStorageDoor } = await import("../../app/(product)/mailbox/storage-door");
  function Body() {
    return <StoragePane model={useStorage(useStorageDoor(null))} body={body} factor={NO_FACTOR} />;
  }
  access = open(raw);
  await published();
  const { container } = render(
    <Words lang={lang}>
      <Body />
    </Words>,
  );
  const { table, heads, rows } = tableOf(container);
  const prose = visibleText(textNodes(container, (el) => el.matches('[aria-hidden="true"]') || el === table));
  const t = storageText(lang);
  const figures = storageFiguresOf(storageFactsOf(raw)!, {
    locale: lang,
    roster: ROSTER,
    price: (amount, offer) => t(offer.interval === "year" ? "storagePriceYear" : "storagePriceMonth", {
      price: formatStoragePrice(amount, offer.currency, lang),
    }),
  });
  expectProseFigures(container, prose, figures, t);
  expect(prose, "visible prose outside the table").toBe(expectedProse(t, figures, body === "pane"));
  cleanup();
  return { heads, rows };
}

describe("the Storage pane checks figures and pins the rendered wording", () => {
  for (const [name, raw] of Object.entries(BLOCKS)) {
    for (const lang of ["en", "de"] as const) {
      for (const linksOut of [true, false]) {
        it(`${name}, ${lang}, ${linksOut ? "where the build links out" : "where it may not"}`, async () => {
          const old = await shipped(raw, linksOut, lang);
          const now = await anew(raw, linksOut ? "pane" : "facts", lang);
          expect(now.heads).toEqual(old.heads);
          expect(now.rows).toEqual(old.rows);
        });
      }
    }
  }

  it("holds the comparison to something: the fixtures draw a table, the plans and the change", async () => {
    const old = await shipped(BLOCKS.near!, true, "en");
    expect(old.rows.length).toBe(3);
    expect(old.outside.length).toBeGreaterThan(100);
  });
});
