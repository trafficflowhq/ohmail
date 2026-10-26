import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_HTML_TO_TEXT_CHARS, MimeParseError, normalizeMime } from "../src/mime.js";
import { MIME_PARSE_CEILING_MS, ParseDeadlineExceeded, parseBounded, startParseBudget } from "../src/mime-parse.js";

/**
 * normalizeMime ALWAYS SETTLES. A throw inside mailparser's header processing used to escape as
 * an uncaught exception whenever the head spanned more than one chunk, and the parse stayed
 * pending for ever: the worker and the desktop engine exit on that exception, and the drain behind
 * the message stops. The throw is injected through the parser's prototype (a seam in this
 * process, no dependency file touched), only for a message carrying `X-Fault`; the clock is fake
 * for `setTimeout` alone, because mailparser's own work runs on real `setImmediate` ticks.
 */
const require_ = createRequire(import.meta.url);
const { MailParser } = require_("mailparser") as { MailParser: { prototype: Record<string, unknown> } };
const proto = MailParser.prototype as Record<string, (...a: unknown[]) => unknown>;
const DEADLINE_MS = 30_000;

const msg = (opts: { pad?: number; fault?: boolean; html?: string } = {}): Buffer => Buffer.from([
  "From: Alice <alice@example.com>", "To: bob@example.org", "Subject: settles",
  "Message-ID: <settles@example.com>", ...(opts.fault ? ["X-Fault: 1"] : []),
  ...(opts.pad ? [`X-Pad: ${"p".repeat(opts.pad)}`] : []),
  `Content-Type: ${opts.html !== undefined ? "text/html" : "text/plain"}; charset=utf-8`, "",
  opts.html ?? "hi", "",
].join("\r\n"));

const originals = { processHeaders: proto.processHeaders!, processChunk: proto.processChunk! };
afterEach(() => {
  proto.processHeaders = originals.processHeaders;
  proto.processChunk = originals.processChunk;
  vi.useRealTimers();
});

function injectHeaderThrow(): void {
  proto.processHeaders = function (this: unknown, ...args: unknown[]) {
    const lines = args[0] as Array<{ key: string }>;
    if (lines.some((l) => l.key === "x-fault")) throw new TypeError("injected: the header callback threw");
    return originals.processHeaders.apply(this, args);
  };
}

function track<T>(p: Promise<T>): { state: () => string; error: () => unknown } {
  let state = "pending";
  let error: unknown;
  p.then(() => { state = "resolved"; }, (e: unknown) => { state = "rejected"; error = e; });
  return { state: () => state, error: () => error };
}

const realTicks = async (n = 200): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};

describe("normalizeMime settles on a throw inside mailparser's header processing", () => {
  for (const [label, pad] of [["a 64 KiB head", 64 * 1024], ["a 256 KiB head", 256 * 1024], ["a one-chunk head", 0]] as const) {
    it(`${label}: rejects MimeParseError (refused), and nothing escapes`, async () => {
      const escaped: unknown[] = [];
      const onUncaught = (e: unknown): void => { escaped.push(e); };
      process.on("uncaughtException", onUncaught);
      try {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        injectHeaderThrow();
        const t = track(normalizeMime(msg({ fault: true, pad })));
        await realTicks();
        await vi.advanceTimersByTimeAsync(DEADLINE_MS * 2);
        await realTicks(20);
        expect(t.state(), "the parse never settled — the throw escaped the parse").toBe("rejected");
        const err = t.error();
        expect(err).toBeInstanceOf(MimeParseError);
        expect((err as MimeParseError).reason).toBe("refused");
        expect(((err as Error).cause as Error).message).toBe("injected: the header callback threw");
        expect(escaped, "the throw reached uncaughtException").toEqual([]);
      } finally {
        process.off("uncaughtException", onUncaught);
      }
    });
  }

  it("the control: the same message without the fault parses", async () => {
    injectHeaderThrow();
    const m = await normalizeMime(msg({ pad: 64 * 1024 }));
    expect(m.from.address).toBe("alice@example.com");
    expect(m.to.map((a) => a.address)).toEqual(["bob@example.org"]);
  });
});

describe("an attachment stream's error settles the parse", () => {
  it("a fault in an attachment's stream rejects MimeParseError, and nothing escapes", async () => {
    const escaped: unknown[] = [];
    const onUncaught = (e: unknown): void => { escaped.push(e); };
    process.on("uncaughtException", onUncaught);
    try {
      // The attachment's hashing stream fails its first chunk, the way a Transform reports a fault.
      type Hasher = { _transform(c: unknown, e: unknown, done: (err?: Error) => void): void };
      proto.processChunk = function (this: { attachmentList: Array<{ content: Hasher }> }, ...args: unknown[]) {
        const before = this.attachmentList.length;
        const out = originals.processChunk.apply(this, args);
        const added = this.attachmentList[before];
        if (added) added.content._transform = (_c, _e, done) => done(new Error("injected: the attachment stream failed"));
        return out;
      };
      const raw = Buffer.from([
        "From: Alice <alice@example.com>", "To: bob@example.org", "Subject: file",
        'Content-Type: multipart/mixed; boundary="B"', "", "--B", "Content-Type: text/plain", "", "hi",
        "--B", "Content-Type: application/pdf", "Content-Transfer-Encoding: base64",
        'Content-Disposition: attachment; filename="a.pdf"', "", "JVBERi0xLjQK".repeat(2000), "--B--", "",
      ].join("\r\n"));
      const t = track(normalizeMime(raw));
      await realTicks(400);
      expect(t.state()).toBe("rejected");
      expect(t.error()).toBeInstanceOf(MimeParseError);
      expect(escaped, "the stream's error reached uncaughtException").toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });
});

describe("a parse that stops is a parse_timeout at the deadline, not before", () => {
  it("rejects MimeParseError (parse_timeout) at 30 s and is pending at 30 s less 1 ms", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    proto.processChunk = function () { /* never calls back: the parse stops */ };
    const t = track(normalizeMime(msg()));
    await realTicks();
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
    expect(t.state()).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(t.state()).toBe("rejected");
    expect(t.error()).toBeInstanceOf(MimeParseError);
    expect((t.error() as MimeParseError).reason).toBe("parse_timeout");
  });

  /** Fake time one second at a time, with real ticks between, until `t` settles: the fake ms it took. */
  async function settledAfter(t: { state: () => string }, maxMs: number): Promise<number> {
    for (let ms = 0; ms <= maxMs; ms += 1_000) {
      if (t.state() !== "pending") return ms;
      await vi.advanceTimersByTimeAsync(1_000);
      await realTicks(10);
    }
    return Number.POSITIVE_INFINITY;
  }

  // The first parse waits 20 s on its first chunk, then meets the html-to-text refusal.
  function delayFirstThen(fallback: (self: unknown, args: unknown[]) => unknown): () => boolean {
    let firstDelayed = false;
    let fallbackStarted = false;
    proto.processChunk = function (this: { options: { skipHtmlToText?: boolean } }, ...args: unknown[]) {
      if (this.options.skipHtmlToText) { fallbackStarted = true; return fallback(this, args); }
      if (!firstDelayed) {
        firstDelayed = true;
        setTimeout(() => { originals.processChunk.apply(this, args); }, 20_000);
        return;
      }
      return originals.processChunk.apply(this, args);
    };
    return () => fallbackStarted;
  }

  it("one budget covers the fallback re-parse: a stopped fallback is refused 30 s after the last progress", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fallbackStarted = delayFirstThen(() => undefined);   // the fallback stops
    const t = track(normalizeMime(msg({ html: `<p>${"x".repeat(MAX_HTML_TO_TEXT_CHARS + 16)}</p>` })));
    await realTicks();
    expect(await settledAfter(t, 120_000), "the first parse's last progress was at 20 s").toBe(50_000);
    expect(fallbackStarted(), "the html-to-text refusal never sent the message to the fallback").toBe(true);
    expect((t.error() as MimeParseError).reason).toBe("parse_timeout");
  });

  it("one budget covers the fallback re-parse: its ceiling counts from the FIRST parse's start", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // A fallback that keeps progressing, one chunk every 20 s, never meets the 30 s bound.
    const fallbackStarted = delayFirstThen((self, args) => {
      setTimeout(() => { originals.processChunk.apply(self, args); }, 20_000);
    });
    const parts = Array.from({ length: 40 }, (_, i) => ["--B", "Content-Type: text/plain", "", `part ${i}`]);
    const t = track(normalizeMime(Buffer.from([
      "From: Alice <alice@example.com>", "Subject: parts", 'Content-Type: multipart/mixed; boundary="B"', "",
      "--B", "Content-Type: text/html", "", `<p>${"x".repeat(MAX_HTML_TO_TEXT_CHARS + 16)}</p>`, ...parts.flat(), "--B--", "",
    ].join("\r\n"))));
    await realTicks();
    expect(await settledAfter(t, MIME_PARSE_CEILING_MS + 60_000), "the fallback ran on a clock of its own")
      .toBe(MIME_PARSE_CEILING_MS);
    expect(fallbackStarted()).toBe(true);
    expect((t.error() as MimeParseError).reason).toBe("parse_timeout");
    expect(((t.error() as Error).cause as ParseDeadlineExceeded).ms).toBe(MIME_PARSE_CEILING_MS);
  });

  it("the deadline is 30 s", async () => {
    const { MIME_PARSE_DEADLINE_MS } = await import("../src/mime-parse.js");
    expect(MIME_PARSE_DEADLINE_MS).toBe(DEADLINE_MS);
    expect(MIME_PARSE_CEILING_MS).toBe(10 * 60_000);
  });
});

describe("the deadline counts turns without progress, not wall time", () => {
  // Synthetic inline images: `sizes` raw bytes each, base64 in 76-column lines or one unbroken line.
  const heavy = (sizes: number[], wrapped: boolean): Buffer => Buffer.from([
    "From: Letter <news@example.com>", "To: reader@example.com", "Subject: heavy", "Message-ID: <heavy@example.com>",
    'Content-Type: multipart/related; boundary="B"', "", "--B", "Content-Type: text/html; charset=utf-8", "",
    `<html><body>${sizes.map((_, i) => `<img src="cid:p${i}@example.com">`).join("")}</body></html>`, "",
    ...sizes.flatMap((n, i) => {
      const b64 = randomBytes(n).toString("base64");
      return ["--B", "Content-Type: image/png", "Content-Transfer-Encoding: base64", `Content-ID: <p${i}@example.com>`,
        "Content-Disposition: inline", "", wrapped ? b64.replace(/.{76}/g, "$&\r\n") : b64, ""];
    }),
    "--B--", "",
  ].join("\r\n"));

  // A busy engine: every turn of the loop also spends a second of somebody else's work.
  async function onBusyLoop<T>(run: () => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let on = true;
    const spin = (): void => { if (!on) return; vi.advanceTimersByTime(1_000); setImmediate(spin); };
    setImmediate(spin);
    try { return await run(); } finally { on = false; }
  }

  for (const [label, sizes, wrapped] of [
    ["three ~540 KB inline images", [400_000, 400_000, 400_000], true],
    ["one ~1.2 MB inline image in a 1.6 MB letter", [900_000, 280_000], true],
    ["six unbroken ~540 KB inline images", Array<number>(6).fill(405_000), false],
  ] as const) {
    it(`a heavy letter (${label}) on a busy loop is read whole`, async () => {
      const m = await onBusyLoop(() => normalizeMime(heavy([...sizes], wrapped)));
      expect(m.attachments.filter((a) => a.inline).map((a) => a.sizeBytes)).toEqual(sizes);
    }, 60_000);
  }

  it("a loop held for longer than the deadline is one late look, not an expiry", async () => {
    const budget = startParseBudget(200, 30_000);
    let held = false;
    proto.processChunk = function (...args: unknown[]) {
      if (!held) { held = true; const until = Date.now() + 600; while (Date.now() < until) { /* the loop is held */ } }
      return originals.processChunk.apply(this, args);
    };
    try {
      const m = await parseBounded(msg(), { keepCidLinks: true, maxHtmlLengthToParse: MAX_HTML_TO_TEXT_CHARS }, budget);
      expect(held).toBe(true);
      expect(m.text).toBe("hi\n");
    } finally {
      budget.clear();
    }
  });

  it("a parse that keeps progressing still ends at the ceiling, and the error names the bound that fired", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const busy = startParseBudget(120, 600);
    const idle = startParseBudget(120, 600);
    const fired: Array<[string, number]> = [];
    busy.onExpire((ms) => fired.push(["busy", ms]));
    idle.onExpire((ms) => fired.push(["idle", ms]));
    const beat = setInterval(() => busy.progress(), 20);
    try {
      vi.advanceTimersByTime(119);
      expect(fired).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(fired).toEqual([["idle", 120]]);
      vi.advanceTimersByTime(479);
      expect(fired).toEqual([["idle", 120]]);
      vi.advanceTimersByTime(1);
      expect(fired).toEqual([["idle", 120], ["busy", 600]]);
      expect(new ParseDeadlineExceeded(600).ms).toBe(600);
    } finally {
      clearInterval(beat);
      busy.clear();
      idle.clear();
    }
  });
});

describe("a throw in a text part's stream callback settles the parse", () => {
  // A text part's content stream, and the charset and flowed decoders piped into it, call back on
  // later ticks with no caller: at the base a throw there escaped and exited the process.
  type TextNode = { contentStream?: { read: (n?: number) => unknown }; isAttachment?: boolean };
  const textMsg = (ct: string, body: string, fault: boolean): Buffer => Buffer.from([
    "From: Alice <alice@example.com>", "To: bob@example.org", "Subject: text",
    ...(fault ? ["X-Fault: 1"] : []), `Content-Type: ${ct}`, "", body, "",
  ].join("\r\n"));
  const SHAPES = [
    ["a utf-8 part", "text/plain; charset=utf-8", "hi", "hi\n"],
    ["a 64 KiB utf-8 part", "text/plain; charset=utf-8", "x".repeat(64 * 1024), `${"x".repeat(64 * 1024)}\n`],
    ["a charset-decoded part", "text/plain; charset=iso-8859-1", "caf=E9", "caf=E9\n"],
    ["a flowed, charset-decoded part", "text/plain; charset=iso-8859-1; format=flowed", "a \r\nb", "a b"],
  ] as const;

  function injectTextStreamThrow(): void {
    proto.processChunk = function (this: { curnode?: TextNode; headers?: unknown }, ...args: unknown[]) {
      const out = originals.processChunk.apply(this, args);
      const node = this.curnode;
      if ((args[0] as { type: string }).type === "node" && node?.contentStream && !node.isAttachment
        && (this.headers instanceof Map && this.headers.has("x-fault"))) {
        // Only the listener's own call (no size): the stream's internals read(0), and must not throw.
        const read = node.contentStream.read.bind(node.contentStream);
        node.contentStream.read = (n?: number) => {
          if (n === undefined) throw new TypeError("injected: the text stream callback threw");
          return read(n);
        };
      }
      return out;
    };
  }

  for (const [label, ct, body] of SHAPES) {
    it(`${label}, a throw in its stream's readable listener: rejects MimeParseError (refused), and nothing escapes`, async () => {
      const escaped: unknown[] = [];
      const onUncaught = (e: unknown): void => { escaped.push(e); };
      process.on("uncaughtException", onUncaught);
      try {
        injectTextStreamThrow();
        const t = track(normalizeMime(textMsg(ct, body, true)));
        await realTicks(400);
        expect(t.state(), "the parse never settled — the throw escaped the parse").toBe("rejected");
        expect(t.error()).toBeInstanceOf(MimeParseError);
        expect((t.error() as MimeParseError).reason).toBe("refused");
        expect(((t.error() as Error).cause as Error).message).toBe("injected: the text stream callback threw");
        expect(escaped, "the throw reached uncaughtException").toEqual([]);
      } finally {
        process.off("uncaughtException", onUncaught);
      }
    });
  }

  it("the control: the same parts without the fault parse to their text", async () => {
    injectTextStreamThrow();
    for (const [, ct, body, text] of SHAPES) {
      expect((await normalizeMime(textMsg(ct, body, false))).textBody).toBe(text);
    }
  });
});

describe("every other callback the parser runs settles the parse", () => {
  // Each reached only from a later tick: the parse's reader (it calls `read()` when the text part's
  // decoder ends), and an attachment's `end` (its listener releases the attachment).
  const readableRead = proto.read!;
  afterEach(() => { delete (proto as Record<string, unknown>).read; });
  const BOOM = "injected: a parser callback threw";
  const faulty = (): Buffer => Buffer.from(["From: Alice <alice@example.com>", "To: bob@example.org",
    "Subject: cb", "X-Fault: 1", "Content-Type: text/plain; charset=utf-8", "", "hi", ""].join("\r\n"));
  const attachmentMsg = Buffer.from([
    "From: Alice <alice@example.com>", "X-Fault: 1", "Subject: file", 'Content-Type: multipart/mixed; boundary="B"', "",
    "--B", "Content-Type: text/plain", "", "hi", "--B", "Content-Type: application/pdf",
    "Content-Transfer-Encoding: base64", 'Content-Disposition: attachment; filename="a.pdf"', "", "JVBERi0xLjQK", "--B--", "",
  ].join("\r\n"));
  type Self = { headers?: unknown; attachmentList: Array<{ release: () => void }> };
  const SEAMS: Array<[string, () => void, Buffer]> = [
    ["the parse's own reader", () => {
      proto.read = function (this: Self, ...a: unknown[]) {
        if (a[0] === undefined && (this.headers instanceof Map && this.headers.has("x-fault"))) throw new TypeError(BOOM);
        return readableRead.apply(this, a);
      };
    }, faulty()],
    ["an attachment's end", () => {
      proto.processChunk = function (this: Self, ...args: unknown[]) {
        const before = this.attachmentList.length;
        const out = originals.processChunk.apply(this, args);
        const added = this.attachmentList[before];
        if (added) added.release = () => { throw new TypeError(BOOM); };
        return out;
      };
    }, attachmentMsg],
  ];

  for (const [label, inject, raw] of SEAMS) {
    it(`${label}: a throw there rejects MimeParseError (refused), and nothing escapes`, async () => {
      const escaped: unknown[] = [];
      const onUncaught = (e: unknown): void => { escaped.push(e); };
      process.on("uncaughtException", onUncaught);
      try {
        inject();
        const t = track(normalizeMime(raw));
        await realTicks(400);
        expect(t.state(), "the parse never settled — the throw escaped the parse").toBe("rejected");
        expect((t.error() as MimeParseError).reason).toBe("refused");
        expect(((t.error() as Error).cause as Error).message).toBe(BOOM);
        expect(escaped, "the throw reached uncaughtException").toEqual([]);
      } finally {
        process.off("uncaughtException", onUncaught);
      }
    });
  }
});
