/**
 * THE PHONE FRAME IS MOUNTED ONLY OVER A DOCUMENT WHOSE OWN TREE FITS (`src/mail/frame-tree.ts`). The
 * shapes are the ones this app's WebView amplified on a phone (each of them hundreds of thousands of elements on the
 * AVD, equal to parse5), and the review's two counterexamples to counting any other document than the
 * mounted one. Every reading here is taken over the document the frame mounts, built the way the frame
 * builds it, in each consent state, and the count runs a step per macrotask through a driven scheduler.
 */
import { describe, expect, it } from "vitest";
import { defaultTreeAdapter, parse } from "parse5";
import { sanitizeMailHtmlPhone, type PhoneSanitizeOptions } from "../src/mail/sanitize";
import { buildPhoneMailDocument } from "../src/mail/mail-document";
import { treeStepper, treeWithin } from "@ohmail/client-engine/html-tree-budget";
import { MAIL_MAX_HTML_CHARS } from "@ohmail/client-engine";
import { FRAME_BUDGET, FRAME_STEP_CHARS, FRAME_STEP_WORK, PHONE_FRAME_MAX_CHARS } from "../src/mail/frame-budget";
import {
  FRAME_CACHE_MAX_CHARS,
  FRAME_CACHE_SIZE,
  frameReadingOf,
  frameTreeLine,
  planFrameCount,
  startFrameCount,
  type FrameCount,
  type FramePlan,
  type FrameSchedule,
} from "../src/mail/frame-tree";

const THEME = { bg: "#fbfaf9", ink: "#251f1b", ink2: "#625952", accent: "#a3461c", fontScale: 1 };

const bs = (n: number): string => Array.from({ length: n }, (_, i) => `<b class="c${i}">`).join("");
const nestedP = (l: number, r: number): string => `<p>${bs(l)}${"<p>t</p>".repeat(r)}${"</b>".repeat(l)}</p>`;
const words = (n: number, k: number): string => Array.from({ length: k }, (_, i) => `w${(n * 31 + i).toString(36)}q`).join(" ");
/** The web's 200 KiB ordinary control (`html-body-bounded.test.tsx`, `newsletter(400, true)`). */
function newsletter(rows: number): string {
  const pad = "font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:15px;line-height:150%;mso-line-height-rule:exactly;"
    + "text-align:left;color:#333333;word-break:break-word;padding:12px 24px 12px 24px;border-bottom:1px solid #eeeeee;";
  const r = Array.from({ length: rows }, (_, n) => `<tr><td valign="top" style="${pad}"><a href="https://example.com/item/${n}" style="color:#0a66c2">`
    + `Item ${n} ${words(n, 4)}</a><br>${words(n + 7, 18)}</td><td width="120" style="padding:12px;color:#999999">Oct ${1 + (n % 28)}</td></tr>`);
  return `<!doctype html><html><head><style>body{margin:0}</style></head><body><table width="600" align="center" cellpadding="0" cellspacing="0" style="width:600px">${r.join("")}</table></body></html>`;
}
const CONTROL = `<table width="600" style="width:600px">${Array.from({ length: 100 }, (_, n) =>
  `<tr><td style="padding:12px;font-family:Arial"><a href="https://example.com/${n}">Item ${n}</a><br>words of row ${n}</td><td width="120">Oct ${n % 28}</td></tr>`).join("")}</table>`;
const AMP_FRAME = `<table width="600" style="width:600px"><tr><td><p>${bs(400)}<button>${"<p>t</p>".repeat(1500)}</button></p></td></tr></table>`;
const AMP_PARSE = `<table width="600"><tr><td><p>${bs(400)}</p>${"<p>t</p>".repeat(1600)}</td></tr></table>`;

/** The review's counterexample: `n` td-isolated strike units, each formatting element styled with its own picture. */
function strikes(n: number): string {
  let id = 0;
  const u = () => `https://sender.invalid/${id++}.png`;
  const unit = () => `<strike class="c0"><div><p><strike style="background:url(${u()})"><strike style="background:url(${u()})"><div>`
    + `<strike style="background:url(${u()})"><strike style="background:url(${u()})"></strike></strike></div></strike></strike></p></div></strike>`;
  return `<table><tr>${Array.from({ length: n }, () => `<td>${unit()}</td>`).join("")}</tr></table>`;
}
/** The review's minimal trigger: equal formatting elements re-opened across two block boundaries. */
const TRIGGER = '<code><div><p><code style="background:url(https://k.invalid/0)"><code style="background:url(https://k.invalid/0)"><div>'
  + '<code style="background:url(https://k.invalid/0)"><code style="background:url(https://k.invalid/1)"></code></code></div></code></code></p></div></code>';

/** Every element parse5 builds from `doc` as a document, scripting off, with no budget. */
function elementsOf(doc: string): number {
  let n = 0;
  parse(doc, {
    scriptingEnabled: false,
    treeAdapter: { ...defaultTreeAdapter, createElement: (t, ns, a) => (n++, defaultTreeAdapter.createElement(t, ns, a)) },
  });
  return n;
}

type State = "none" | "same" | "distinct" | Set<number>;
const gif = (k: number): string => `data:image/gif;base64,R0lGODlh${Buffer.from(`picture-${k}`).toString("base64").replace(/=/g, "")}`;
/**
 * The frame's sanitize options in one consent state: nothing resolved; the first 12 picture keys
 * resolved to one shared picture, or to a picture each (the fetch and the engine mint at most 12); or a set.
 */
function optsIn(html: string, state: State): PhoneSanitizeOptions {
  if (state === "none") return {};
  const bare = sanitizeMailHtmlPhone(html, {});
  const keys = [...new Set(bare.blocked.map((b) => b.url))];
  const pick = (k: number) => (state === "same" ? gif(0) : gif(k));
  const chosen = (k: number) => (state instanceof Set ? state.has(k) : k < 12);
  return {
    resolvedRemote: new Map(keys.flatMap((u, k) => (chosen(k) ? [[u, pick(k)] as [string, string]] : []))),
    inlineImages: new Map(bare.cids.flatMap((c, k) => (chosen(k + keys.length) ? [[c, pick(k + keys.length)] as [string, string]] : []))),
  };
}
/** What the frame does: sanitize in this consent state, build the shell, plan the count of exactly that. */
function frameFor(html: string, state: State = "none"): { mounted: string; plan: FramePlan } {
  const sanitized = sanitizeMailHtmlPhone(html, optsIn(html, state));
  const mounted = buildPhoneMailDocument(sanitized.html, THEME);
  return { mounted, plan: planFrameCount(mounted, sanitized.oversize === true, PHONE_FRAME_MAX_CHARS) };
}

/** A scheduler the case drives: tasks queue until `drain`, and a cancel can be honoured or ignored. */
function fakeScheduler(honourCancel = true) {
  const queue: Array<{ run: () => void; live: boolean }> = [];
  const schedule: FrameSchedule = (run) => {
    const task = { run, live: true };
    queue.push(task);
    return () => {
      if (honourCancel) task.live = false;
    };
  };
  const runOne = (): void => {
    const task = queue.shift();
    if (task?.live) task.run();
  };
  const drain = (): void => {
    while (queue.length > 0) runOne();
  };
  return { schedule, runOne, drain, queue };
}

function countNow(plan: FramePlan): FrameCount {
  const f = fakeScheduler();
  let got: FrameCount | null = null;
  startFrameCount(plan, (c) => {
    got = c;
  }, f.schedule);
  f.drain();
  if (got === null) throw new Error("the count never answered");
  return got;
}

let unique = 0;
/** `html` made distinct from every earlier document in this file (inside its body, where the sanitizer keeps it). */
const fresh = (html: string): string => {
  const mark = `<p>case ${(unique += 1)}</p>`;
  return html.includes("</body>") ? html.replace("</body>", `${mark}</body>`) : `${html}${mark}`;
};
/** The reading of `html` in one state (a cached answer is the same reading). */
const readingOf = (html: string, state: State = "none") => countNow(frameFor(html, state).plan).reading;

describe("the frame's reading: the amplifiers past, ordinary mail framed", () => {
  it("the three shapes the phone's WebView amplified read past on elements", () => {
    for (const html of [AMP_FRAME, nestedP(400, 1500), nestedP(200, 1000)]) {
      expect(readingOf(html)).toEqual({ fits: false, past: "elements" });
    }
  });

  it("8 M elements out of 72 KB reaches the count now that the sanitizer's walk is a loop, and is refused", () => {
    expect(readingOf(nestedP(2000, 4000))).toEqual({ fits: false, past: "work" });
  });

  it("an li re-opening the formatting after the sanitizer unwraps its form reads past", () => {
    expect(readingOf(`<ul><li>${bs(400)}<form>${"<li>t</li>".repeat(1500)}</form></li></ul>`)).toEqual({ fits: false, past: "elements" });
    expect(readingOf(`<li>${bs(400)}<form>${"<li>t</li>".repeat(1500)}`)).toEqual({ fits: false, past: "elements" });
  });

  it("the reviewer's first-parse shape fits on the phone at 2,012: the sanitizer closes what it opened", () => {
    expect(readingOf(AMP_PARSE)).toMatchObject({ fits: true, elements: 2_012 });
  });

  it("the ordinary control and the web's 200 KiB newsletter fit with their own counts", () => {
    expect(readingOf(CONTROL)).toMatchObject({ fits: true, elements: 509 });
    expect(readingOf(newsletter(400))).toMatchObject({ fits: true, elements: 2_010 });
  });
});

describe("the count is over the document the frame mounts, the shell included", () => {
  it("2,042 body paragraphs fit over the body alone (2,045) and are past over the document (2,049); 2,041 fits at 2,048", () => {
    const at = "<p>x</p>".repeat(2_041);
    const past = "<p>x</p>".repeat(2_042);
    expect(treeWithin(sanitizeMailHtmlPhone(past).html, FRAME_BUDGET)).toMatchObject({ fits: true, elements: 2_045 });
    expect(readingOf(past)).toEqual({ fits: false, past: "elements" });
    expect(readingOf(at)).toMatchObject({ fits: true, elements: 2_048 });
  });

  it("131,073 characters of text are past the text bound; 131,072 fit, the shell's style not counted", () => {
    expect(readingOf(`<p>${"a".repeat(131_073)}</p>`)).toEqual({ fits: false, past: "text" });
    expect(readingOf(`<p>${"a".repeat(131_072)}</p>`)).toMatchObject({ fits: true, textChars: 131_072 });
  });

  it("the work bound: a deep stack amplifying text is past; 40,000 attributes are already gone by the sanitizer", () => {
    expect(readingOf(`<i title="WORKDEEP"><b>${"<span>".repeat(500)}${"a ".repeat(60_000)}`)).toEqual({ fits: false, past: "work" });
    const attrs = Array.from({ length: 40_000 }, (_, i) => `a${i.toString(36)}`).join(" ");
    expect(readingOf(`<b data-needle="WORKATTR" ${attrs}>x</b>`)).toMatchObject({ fits: true });
  });

  it("the copied module reads a noscript wrap as the frame does, with scripting off", () => {
    const amp = `<p>${bs(400)}</p>${"<p>t</p>".repeat(1600)}`;
    expect(treeWithin(`<noscript>${amp}</noscript>`, FRAME_BUDGET)).toEqual({ fits: false, past: "elements" });
  });

  // The sanitizer's htmlparser2 kept its open-element stack with unshift and indexOf (`patches/htmlparser2@12.0.0.patch`).
  it("sanitizes closes that match nothing and a deep math nest at the html cap in under a second", () => {
    const fill = (head: string, unit: string, tail = "") => {
      const n = Math.floor((MAIL_MAX_HTML_CHARS - head.length) / (unit.length + tail.length));
      return head + unit.repeat(n) + tail.repeat(n);
    };
    for (const html of [fill("", "<b>", "</i>"), fill("<math>", "<mi>")]) {
      expect(html.length).toBeLessThanOrEqual(MAIL_MAX_HTML_CHARS);
      const t0 = performance.now();
      const out = sanitizeMailHtmlPhone(html);
      expect(out.oversize ?? false, html.slice(0, 12)).toBe(false);
      expect(performance.now() - t0, html.slice(0, 12)).toBeLessThan(1_000);
    }
  }, 60_000);

  it("past the html cap the plan refuses without a step", () => {
    expect(frameFor(`<p>${"a".repeat(513 * 1024)}</p>`).plan.known).toEqual({ fits: false, past: "oversize" });
  });
});

describe("the counted document is the mounted one, in every consent state", () => {
  it("the review's 160 strike units: the document mounted before consent builds 2,090 and is refused; after, its own count decides", () => {
    const html = strikes(160);
    expect(html.length).toBeGreaterThan(36_000);
    for (const state of ["none", "same", "distinct"] as const) {
      const { mounted, plan } = frameFor(html, state);
      expect(plan.key, state).toBe(mounted);
      const real = elementsOf(mounted);
      const r = countNow(plan).reading;
      if (real > FRAME_BUDGET.elements) expect(r, `${state}: ${real}`).toEqual({ fits: false, past: "elements" });
      else expect(r, `${state}: ${real}`).toMatchObject({ fits: true, elements: real });
    }
    expect(elementsOf(frameFor(html, "none").mounted)).toBe(2_090);
    expect(readingOf(html, "none")).toEqual({ fits: false, past: "elements" });
  });

  it("the review's minimal trigger: the reading is the mounted document's own count in every state", () => {
    const counts = (["none", "same", "distinct"] as const).map((state) => {
      const { mounted, plan } = frameFor(TRIGGER, state);
      expect(plan.key).toBe(mounted);
      const r = countNow(plan).reading;
      expect(r, state).toMatchObject({ fits: true, elements: elementsOf(mounted) });
      return elementsOf(mounted);
    });
    // Equal formatting elements build one more: before consent and with one shared picture, 19; with two, 18.
    expect(counts).toEqual([19, 19, 18]);
  });

  it("a consent state that changes the document is a new key, counted afresh", () => {
    const html = fresh(`${CONTROL}${TRIGGER}`);
    const before = frameFor(html, "none");
    expect(countNow(before.plan).reading).toMatchObject({ fits: true });
    const after = frameFor(html, "distinct");
    expect(after.mounted).not.toBe(before.mounted);
    expect(after.plan.known).toBeNull();
    expect(countNow(after.plan).reading).toMatchObject({ fits: true, elements: elementsOf(after.mounted) });
    expect(frameFor(html, "none").plan.cached).toBe(true);
  });

  it("500 random documents, the review's block-within-formatting shapes among them: the counted document is the mounted one", () => {
    let seed = 0x0f12;
    const r = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const FORMATTING = ["b", "i", "code", "strike", "font", "em", "a", "s", "u", "nobr", "strong", "tt", "big", "small"];
    const styled = (tag: string, keys: number) => `<${tag} style="background:url(https://p.invalid/${Math.floor(r() * keys)})">`;
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
    let moved = 0;
    let equalBuildsMore = 0;
    for (let k = 0; k < 500; k++) {
      const keys = 1 + Math.floor(r() * 4);
      const tag = pick(FORMATTING.slice(0, 4));
      let html = "";
      const family = k % 3;
      if (family === 0) {
        // The review's chain: one formatting run re-opened across block boundaries, nested `depth` deep.
        const depth = 1 + Math.floor(r() * 6);
        html = `<p>${`${styled(tag, keys)}<${pick(["div", "p", "li", "ul"])}>`.repeat(depth)}${styled(tag, keys)}${styled(tag, keys)}x`
          + `</${tag}></${tag}>${`</div></${tag}>`.repeat(depth)}</p>`;
      } else if (family === 1) {
        // The review's unit, repeated: equal formatting elements on both sides of a block, siblings.
        const unit = () => `<${tag}><div><p>${styled(tag, keys)}${styled(tag, keys)}<div>${styled(tag, keys)}${styled(tag, keys)}`
          + `</${tag}></${tag}></div></${tag}></${tag}></p></div></${tag}>`;
        html = Array.from({ length: 1 + Math.floor(r() * 8) }, unit).join("");
      } else {
        // A run of formatting elements over a few keys, then blocks with stray opens and closes among them.
        html = "<p>";
        for (let i = 0, n = 4 + Math.floor(r() * 12); i < n; i++) html += r() < 0.85 ? styled(pick(FORMATTING.slice(0, 5)), keys) : `<${tag}>`;
        for (let i = 0, n = 1 + Math.floor(r() * 20); i < n; i++) {
          const roll = r();
          if (roll < 0.5) html += "<p>t</p>";
          else if (roll < 0.62) html += styled(pick(FORMATTING), keys);
          else if (roll < 0.72) html += `</${pick(FORMATTING)}>`;
          else if (roll < 0.82) html += `<img src="https://p.invalid/${Math.floor(r() * keys)}">`;
          else html += `<${pick(["div", "ul", "li", "table", "td"])}>x`;
        }
      }
      const subset = new Set(Array.from({ length: 12 }, (_, i) => i).filter(() => r() < 0.5));
      const counts = (["none", "same", "distinct", subset] as const).map((state) => {
        const { mounted, plan } = frameFor(html, state);
        expect(plan.key, html).toBe(mounted);
        const reading = treeWithin(mounted, FRAME_BUDGET);
        expect(reading, html).toEqual(treeWithin(plan.key, FRAME_BUDGET));
        if (reading.fits) expect(reading.elements, html).toBe(elementsOf(mounted));
        return elementsOf(mounted);
      });
      if (new Set(counts).size > 1) moved += 1;
      if (counts[0]! > counts[2]!) equalBuildsMore += 1;
    }
    // The control: pictures moved the mounted tree in many of these documents (162), and in the review's
    // direction in many (106): before consent, its pictures all equal, the document built more than with them distinct.
    expect(moved).toBeGreaterThan(100);
    expect(equalBuildsMore).toBeGreaterThan(50);
  });
});

describe("the count runs a step at a time and equals the one-shot reading", () => {
  const shapes = [CONTROL, AMP_FRAME, AMP_PARSE, nestedP(200, 1000), strikes(40), TRIGGER, `<p>${"\u{1F600}\r\nx&amp;y".repeat(300)}</p>`];
  it("over every shape's mounted document at 1, 7, 1,024 and 32,768 characters a step, with and without a work share", () => {
    for (const html of [...shapes, newsletter(400)]) {
      const doc = frameFor(html).mounted;
      const once = treeWithin(doc, FRAME_BUDGET);
      for (const size of doc.length > 60_000 ? [7, 1_024, 32_768] : [1, 7, 1_024, 32_768]) {
        for (const work of [Infinity, FRAME_STEP_WORK, 997]) {
          const step = treeStepper(doc, FRAME_BUDGET, size, work);
          let r = step();
          while (r === null) r = step();
          expect(r, `${doc.length} chars at ${size} / ${work}`).toEqual(once);
        }
      }
    }
  });

  it("the 200 KiB newsletter takes at least 6 steps and the control one", () => {
    expect(countNow(frameFor(fresh(newsletter(400))).plan).steps).toBeGreaterThanOrEqual(6);
    expect(countNow(frameFor(fresh(CONTROL)).plan).steps).toBeLessThanOrEqual(1);
  });

  it("the crafted part that held one step about a second on a phone is spread over many steps of the work share", () => {
    // Thousands of distinct formatting elements in a few kilobytes: one slice of them is nearly all of MAX_PARSE_WORK.
    const doc = frameFor(fresh(`<p>${bs(2000)}${"<p>t</p>".repeat(10)}`)).mounted;
    const steps = (chars: number, work: number) => {
      const step = treeStepper(doc, FRAME_BUDGET, chars, work);
      let n = 1;
      let r = step();
      while (r === null) {
        n += 1;
        r = step();
      }
      return { r, n };
    };
    expect(steps(32_768, Infinity)).toEqual({ r: { fits: false, past: "work" }, n: 1 });
    expect(steps(FRAME_STEP_CHARS, FRAME_STEP_WORK).r).toEqual({ fits: false, past: "work" });
    const count = countNow(frameFor(fresh(`<p>${bs(2000)}${"<p>t</p>".repeat(10)}`)).plan);
    expect(count.reading).toEqual({ fits: false, past: "work" });
    // Spread over many steps where one slice held it whole (far more steps at the work share; a step can overshoot
    // its share by one token's work, so the floor is far below that).
    expect(count.steps).toBeGreaterThanOrEqual(10);
  });
});

describe("the cache: the counted string is the key, never a message", () => {
  it("a reopen is answered without a step; a different document is not", () => {
    const html = fresh(CONTROL);
    expect(frameFor(html).plan.known).toBeNull();
    const first = countNow(frameFor(html).plan);
    const again = frameFor(html).plan;
    expect(again.cached).toBe(true);
    expect(again.known).toEqual(first.reading);
    expect(countNow(again)).toMatchObject({ steps: 0, cached: true });
    expect(frameFor(fresh(CONTROL)).plan.known).toBeNull();
  });

  it("two bodies under one message: the second is counted, and the amplifier is refused", () => {
    expect(countNow(frameFor(fresh(CONTROL)).plan).reading).toMatchObject({ fits: true });
    const amplifier = frameFor(fresh(AMP_FRAME)).plan;
    expect(amplifier.known).toBeNull();
    expect(countNow(amplifier).reading).toEqual({ fits: false, past: "elements" });
  });

  it("holds the last eight: the ninth document evicts the least recently read", () => {
    const docs = Array.from({ length: FRAME_CACHE_SIZE + 1 }, () => fresh(CONTROL));
    for (const d of docs.slice(0, FRAME_CACHE_SIZE)) countNow(frameFor(d).plan);
    expect(frameFor(docs[0]!).plan.cached).toBe(true); // read again: now the most recent
    countNow(frameFor(docs[FRAME_CACHE_SIZE]!).plan);
    expect(frameFor(docs[0]!).plan.cached).toBe(true);
    expect(frameFor(docs[1]!).plan.cached).toBe(false);
  });

  it("a document longer than the cache's limit is counted again rather than held", () => {
    // Only a resolved picture makes a mounted document that long from a part under the html cap.
    const url = "https://img.invalid/big.png";
    const html = fresh(`<img src="${url}" width="600" height="400">`);
    const big = { resolvedRemote: new Map([[url, `data:image/png;base64,${"A".repeat(FRAME_CACHE_MAX_CHARS)}`]]) };
    const doc = buildPhoneMailDocument(sanitizeMailHtmlPhone(html, big).html, THEME);
    expect(doc.length).toBeGreaterThan(FRAME_CACHE_MAX_CHARS);
    expect(countNow(planFrameCount(doc, false, PHONE_FRAME_MAX_CHARS)).reading).toMatchObject({ fits: true });
    expect(planFrameCount(doc, false, PHONE_FRAME_MAX_CHARS).known).toBeNull();
  });
});

describe("a count belongs to its document: cancel, switch, and the default scheduler", () => {
  it("a count cancelled mid-way never answers, whatever its scheduler still holds", () => {
    for (const honour of [true, false]) {
      const f = fakeScheduler(honour);
      let calls = 0;
      const cancel = startFrameCount(frameFor(fresh(newsletter(400))).plan, () => {
        calls += 1;
      }, f.schedule);
      f.runOne();
      cancel();
      f.drain();
      expect(calls, honour ? "cancel honoured" : "cancel ignored by the scheduler").toBe(0);
    }
  });

  it("start A, start B, run A's step: A never answers and B answers once", () => {
    const f = fakeScheduler(false);
    const answers: string[] = [];
    const cancelA = startFrameCount(frameFor(fresh(newsletter(400))).plan, () => answers.push("A"), f.schedule);
    cancelA();
    startFrameCount(frameFor(fresh(CONTROL)).plan, () => answers.push("B"), f.schedule);
    f.drain();
    expect(answers).toEqual(["B"]);
  });

  it("a reading is used only for the document it was made for", () => {
    const a = frameFor(fresh(CONTROL)).plan;
    const counted = { key: a.key, reading: countNow(a).reading };
    const b = frameFor(fresh(AMP_FRAME)).plan;
    expect(frameReadingOf(a, counted)).toEqual(counted.reading);
    expect(frameReadingOf(b, counted)).toBeNull();
    expect(frameReadingOf(b, null)).toBeNull();
  });

  it("the default scheduler: real macrotasks, the same reading", async () => {
    const plan = frameFor(fresh(newsletter(400))).plan;
    const got = await new Promise<FrameCount>((res) => {
      startFrameCount(plan, res);
    });
    expect(got.reading).toEqual(treeWithin(plan.key, FRAME_BUDGET));
    expect(got.steps).toBeGreaterThanOrEqual(6);
  });
});

describe("the log line says numbers and the closed vocabulary only", () => {
  it("a fitting and a refused count, and nothing of the mail", () => {
    const fits = JSON.parse(frameTreeLine(countNow(frameFor(fresh(CONTROL)).plan)));
    expect(Object.keys(fits).sort()).toEqual(["cached", "ceiling", "chars", "elements", "event", "fits", "level", "maxStepMs", "service", "steps", "textChars", "totalMs", "ts", "wallMs", "work"]);
    expect(fits).toMatchObject({ service: "phone", event: "mail_frame_tree", fits: true, cached: false });
    const past = frameTreeLine(countNow(frameFor(fresh(AMP_FRAME)).plan));
    expect(JSON.parse(past)).toMatchObject({ fits: false, past: "elements" });
    expect(past).not.toContain("<");
  });
});
