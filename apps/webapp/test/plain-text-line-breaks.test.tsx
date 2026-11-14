/** @vitest-environment jsdom */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ReadingPane, StreamCard } from "@ohmail/ui";
import messages from "../messages/en.json";
import { settleEditor } from "./_first-paint.js";

/**
 * A PLAIN-TEXT LETTER KEEPS ITS OWN LINE BREAKS IN EVERY PANEL THAT SHOWS IT. The rule sat on the
 * FOCUSED panel's container, so a conversation's sibling panels (`.pm-body`) ran a two-line
 * signature into one line. Now one class on the element holding the text, `.msg-plain`, declared
 * once. The real stylesheets are loaded and the reading walks the ancestors, which is how an
 * inherited property resolves.
 * MUTATIONS WATCHED RED (parked and restored by `kit/mutate/mutation-control.sh`):
 *   · `msg-plain` dropped from BodyText's plain paragraph → the conversation and container cases;
 *   · the `.msg-plain` declaration deleted from message.css → every rendered case and the census.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SHEETS = [
  "packages/ui/src/composites/message.css",
  "packages/ui/src/composites/stream.css",
  "packages/ui/src/composites/reader.css",
  "apps/webapp/app/app.css",
  "apps/webapp/app/letter-body/message-body.css",
];

/** The sender's own line break, inside one paragraph — what the finding's reply carried. */
const SIGNED = "Thanks, that works for me.\n\nCasey Reeve\nohmail — sent from my phone";
const SIGNATURE = "Casey Reeve\nohmail — sent from my phone";

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let styles: HTMLStyleElement[] = [];

function loadSheets(): void {
  styles = SHEETS.map((rel) => {
    const el = document.createElement("style");
    el.textContent = readFileSync(resolve(process.cwd(), rel), "utf8");
    document.head.appendChild(el);
    return el;
  });
  // Every sheet parsed — a sheet jsdom dropped would make every reading below a reading of nothing.
  for (const el of styles) expect((el.sheet as CSSStyleSheet).cssRules.length).toBeGreaterThan(5);
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  for (const el of styles) el.remove();
  root = null; host = null; styles = [];
});

/** `white-space` is inherited and jsdom resolves only the element's own rules: walk up. */
function whiteSpaceOf(el: Element): string {
  for (let e: Element | null = el; e; e = e.parentElement) {
    const v = getComputedStyle(e).whiteSpace;
    if (v) return v;
  }
  return "normal";
}

/** The element whose own text is the signature — the node a reader sees run together or not. */
function signatureIn(scope: Element): Element {
  const found = [...scope.querySelectorAll("p, div")].filter((e) =>
    [...e.childNodes].some((n) => n.nodeType === 3 && (n.nodeValue ?? "").includes(SIGNATURE)));
  expect(found, "the signature is not on screen as one text node").toHaveLength(1);
  return found[0]!;
}

async function render(tree: React.ReactElement): Promise<HTMLDivElement> {
  host = document.createElement("div");
  host.className = "read-col";
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T12:00:00.000Z"), children: tree,
    }));
  });
  return host;
}

function mail(id: string, date: string): Record<string, unknown> {
  return {
    id, accountId: "a", mailboxId: "mb", threadId: "t1", messageIdHeader: null,
    subject: "Re: the north elevation", from: { name: `Sender ${id}`, address: `${id}@example.invalid` },
    to: [], cc: [], date, folder: "INBOX", snippet: `snippet-${id}`, body: SIGNED,
    unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date,
  };
}

describe("a conversation keeps every letter's line breaks, not only the focused one's", () => {
  it("the focused panel AND both siblings render the two-line signature on two lines", async () => {
    loadSheets();
    const { MessagePane } = await import("../app/shell/MessagePane.js");
    const { MessageChromeProvider } = await import("../app/shell/message-chrome.js");
    const thread = [
      mail("a", "2026-07-30T09:00:00.000Z"), mail("b", "2026-07-31T09:00:00.000Z"), mail("c", "2026-08-01T09:00:00.000Z"),
    ];
    const el = await render(h(MessageChromeProvider as never, {
      value: {
        ownAddresses: [], replyTo: null, replyBody: { text: "", html: "" },
        onReplyBody: () => {}, closeReply: () => {}, sendReply: () => {}, replySendState: () => ({ phase: "idle" }),
        openSenderMenu: () => {}, conversationOf: () => thread,
        bodyOf: (m: Record<string, unknown>) => ({
          text: m.body as string, state: "full", withheld: null, html: null,
          loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
        }),
        hydrateBody: () => {}, hydrateThread: () => {}, openSubjectRule: () => {}, openAttachmentPreview: () => {},
      },
      children: h(MessagePane as never, {
        message: thread[1], tags: [], now: new Date("2026-08-02T12:00:00.000Z"),
        onAction: () => {}, onAddTag: () => {}, onAttachment: () => {},
      } as never),
    } as never));
    await settleEditor();

    // The shape the finding was read on: the opened letter plus two sibling panels.
    expect(el.querySelectorAll(".conv .pm .pm-body"), "no sibling panels — this would measure nothing").toHaveLength(2);
    for (const id of ["a", "b", "c"]) {
      const panel = el.querySelector(`.conv [data-conv-id="${id}"]`);
      expect(panel, `panel ${id} missing`).not.toBeNull();
      expect(whiteSpaceOf(signatureIn(panel!)), `panel ${id} runs the signature together`).toBe("pre-line");
    }
  });
});

describe("no container takes the line breaks away", () => {
  /* Every container a plain body is rendered in, on the web and in the desktop's shared shell:
     the focused pane, a sibling panel, the Screener preview, the Trash read, and the html
     viewer's own `.mb` (whose `white-space: normal` the text fallback renders inside). */
  const CONTAINERS: Array<[string, string]> = [
    ["the focused message", "msg-body"],
    ["a conversation sibling", "pm-body"],
    ["the Screener preview", "hm-body"],
    ["the Trash read", "trash-live-read"],
    ["the html viewer's text fallback", "mb"],
  ];
  for (const [what, cls] of CONTAINERS) {
    it(`${what} (.${cls})`, async () => {
      loadSheets();
      const { MessageBody } = await import("../app/letter-body/MessageBody.js");
      const el = await render(h("div", { className: cls }, h(MessageBody as never, { text: SIGNED, html: null } as never)));
      expect(whiteSpaceOf(signatureIn(el))).toBe("pre-line");
    });
  }

  it("the ui kit's raw body and a stream card's preview wear the same class", async () => {
    loadSheets();
    const el = await render(h("div", null,
      h(ReadingPane as never, { body: SIGNED } as never),
      h(StreamCard as never, {
        id: "s1", from: "Sender", time: "now", subject: "Hello", body: SIGNED,
        expandLabel: "Expand", collapseLabel: "Collapse",
      } as never),
    ));
    const raw = el.querySelector(".msg-body");
    const card = el.querySelector(".sc-body");
    expect(raw?.textContent).toContain(SIGNATURE);
    expect(card?.textContent).toContain(SIGNATURE);
    expect(whiteSpaceOf(raw!)).toBe("pre-line");
    expect(whiteSpaceOf(card!)).toBe("pre-line");
  });
});

describe("one rule, declared once", () => {
  /* Every stylesheet the product ships (the web app, the desktop's shell, the ui kit, the tokens).
     A second `pre-line` is a second copy of the rule some other container will lack. */
  const ROOTS = ["apps/webapp/app", "apps/desktop/src", "packages/ui/src", "packages/tokens/src"];
  const sheets = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === "node_modules" || name === "dist") return [];
    if (statSync(p).isDirectory()) return sheets(p);
    return name.endsWith(".css") ? [p] : [];
  });

  it("`white-space: pre-line` appears in exactly one rule, `.msg-plain`", () => {
    const found: string[] = [];
    let scanned = 0;
    for (const r of ROOTS) {
      for (const file of sheets(resolve(process.cwd(), r))) {
        scanned++;
        const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
        for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
          if (/white-space\s*:\s*pre-line/.test(m[2]!)) found.push(`${file.slice(process.cwd().length + 1)} ${m[1]!.trim()}`);
        }
      }
    }
    // Positive control: the walk read the sheets it claims to, the one holding the rule among them.
    expect(scanned).toBeGreaterThan(30);
    expect(found).toEqual(["packages/ui/src/composites/message.css .msg-plain"]);
  });
});
