import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { emptyDraft, isMailto, parseMailto } from "@trafficflow/core/mailto";
import { MAILTO_SURFACE_CASES } from "./mailto-cases";

/**
 * THE ONE MAILTO PARSER (`@trafficflow/core/mailto`), driven by the strings the OS will actually hand
 * this app. ONE set of cases for the parser every surface reads; each surface's adapter is driven by
 * the table in `mailto-cases.ts`.
 *
 * The suite is organised around the parser's stated contract — plain bounded strings, no control
 * characters in single-line fields, no header a link author invents — because a mailto is the one
 * input in the desktop window that ANY WEBSITE composes. Several cases are RFC 6068's own
 * examples; the rest are the encoding edges and the injection shapes the header comment names.
 */
describe("parseMailto", () => {
  it("reads a bare address", () => {
    expect(parseMailto("mailto:chris@example.com")).toEqual({
      to: ["chris@example.com"],
      cc: [],
      bcc: [],
      subject: "",
      body: "",
    });
  });

  it("reads every field the compose prefill carries", () => {
    expect(
      parseMailto(
        "mailto:a@x.example,b@y.example?cc=c@z.example&bcc=d@w.example" +
          "&subject=Hello%20there&body=Line1%0D%0ALine2",
      ),
    ).toEqual({
      to: ["a@x.example", "b@y.example"],
      cc: ["c@z.example"],
      bcc: ["d@w.example"],
      subject: "Hello there",
      body: "Line1\nLine2",
    });
  });

  it("reads RFC 6068's own examples", () => {
    // §6.1: a subject and a body.
    expect(parseMailto("mailto:infobot@example.com?subject=current-issue&body=send%20current-issue"))
      .toMatchObject({ to: ["infobot@example.com"], subject: "current-issue", body: "send current-issue" });
    // §6.1: %25 is a literal percent in the local part.
    expect(parseMailto("mailto:gorby%25kremvax@example.com")).toMatchObject({
      to: ["gorby%kremvax@example.com"],
    });
    // §6.1: a quoted local part, percent-encoded.
    expect(parseMailto("mailto:%22not%40me%22@example.org")).toMatchObject({
      to: ['"not@me"@example.org'],
    });
    // §6.1: to= in the query appends to the address before the ?.
    expect(parseMailto("mailto:joe@example.com?cc=bob@example.com&body=hello")).toMatchObject({
      to: ["joe@example.com"],
      cc: ["bob@example.com"],
      body: "hello",
    });
  });

  it("never splits a header on an encoded separator — split first, decode second", () => {
    // %26 and %3D are text once decoded; a decode-then-split would read a bcc header out of the subject.
    const d = parseMailto("mailto:a@x.example?subject=fish%26chips%3Dgood%26bcc%3Devil@x.example");
    expect(d?.subject).toBe("fish&chips=good&bcc=evil@x.example");
    expect(d?.bcc).toEqual([]);
  });

  it("keeps + a plus — mailto is percent-encoding only, never form encoding", () => {
    const d = parseMailto("mailto:tom+filter@example.org?subject=a+b&body=1+2");
    expect(d?.to).toEqual(["tom+filter@example.org"]);
    expect(d?.subject).toBe("a+b");
    expect(d?.body).toBe("1+2");
  });

  it("decodes multi-byte UTF-8 as characters, not bytes", () => {
    const d = parseMailto("mailto:a@x.example?subject=caf%C3%A9%20%F0%9F%99%82");
    expect(d?.subject).toBe("café 🙂");
  });

  it("survives a malformed escape instead of dropping the click", () => {
    // decodeURIComponent throws on "%va"; the run stays literal and the rest still decodes.
    const d = parseMailto("mailto:a@x.example?subject=100%valid%20still");
    expect(d?.subject).toBe("100%valid still");
  });

  it("collapses CR and LF out of the subject — the header-injection shape", () => {
    const d = parseMailto("mailto:a@x.example?subject=Hi%0D%0ABcc:evil@x.example%0ASubject:fake");
    expect(d?.subject).toBe("Hi Bcc:evil@x.example Subject:fake");
    expect(d?.subject.includes("\n")).toBe(false);
    expect(d?.subject.includes("\r")).toBe(false);
    expect(d?.bcc).toEqual([]);
  });

  it("keeps newlines and tabs in the body and nothing else below 0x20", () => {
    const d = parseMailto("mailto:a@x.example?body=one%0Atwo%09tab%00nul%07bell%0Dthree");
    expect(d?.body).toBe("one\ntwo\ttabnulbell\nthree");
  });

  it("drops every header it does not name — they are instructions, not text", () => {
    const d = parseMailto(
      "mailto:a@x.example?attach=~/.ssh/id_ed25519&content-type=text/html" +
        "&x-anything=1&in-reply-to=%3Cid%3E&subject=ok",
    );
    expect(d).toEqual({ to: ["a@x.example"], cc: [], bcc: [], subject: "ok", body: "" });
  });

  it("reads scheme and header names case-insensitively", () => {
    const d = parseMailto("MAILTO:a@x.example?SUBJECT=up&To=b@y.example&BODY=text");
    expect(d).toEqual({ to: ["a@x.example", "b@y.example"], cc: [], bcc: [], subject: "up", body: "text" });
  });

  it("lets the first subject and body win and appends repeated recipient headers", () => {
    const d = parseMailto(
      "mailto:?to=a@x.example&to=b@y.example&subject=first&subject=second&body=one&body=two",
    );
    expect(d).toEqual({
      to: ["a@x.example", "b@y.example"],
      cc: [],
      bcc: [],
      subject: "first",
      body: "one",
    });
  });

  it("returns an empty draft for a bare mailto: — the click still means compose", () => {
    const d = parseMailto("mailto:");
    expect(d).toEqual({ to: [], cc: [], bcc: [], subject: "", body: "" });
    expect(d && emptyDraft(d)).toBe(true);
  });

  it("refuses everything that is not a mailto", () => {
    expect(parseMailto("https://example.com")).toBeNull();
    expect(parseMailto("ohmail://signin#code")).toBeNull();
    expect(parseMailto("javascript:alert(1)")).toBeNull();
    expect(parseMailto("")).toBeNull();
    expect(parseMailto(undefined)).toBeNull();
    expect(parseMailto(42)).toBeNull();
    // A scheme hidden behind whitespace still parses; one hidden behind text does not.
    expect(parseMailto("  mailto:a@x.example ")?.to).toEqual(["a@x.example"]);
    expect(parseMailto("see mailto:a@x.example")).toBeNull();
  });

  it("tolerates the mailto:// some launchers produce", () => {
    expect(parseMailto("mailto://a@x.example?subject=s")).toMatchObject({
      to: ["a@x.example"],
      subject: "s",
    });
  });

  it("drops entries that are not addresses and keeps the draft", () => {
    const d = parseMailto("mailto:not-an-address,real@x.example,,another junk");
    expect(d?.to).toEqual(["real@x.example"]);
  });

  it("splits recipients on semicolons exactly as the send path will — no smuggled second recipient", () => {
    // The compose send path splits its To text on /[,;]/ (`parseRecipients`). If this parser
    // admits `a@x;b@y` as ONE entry, the count and every per-entry check here are run against
    // one recipient while the send mails two: `mailto:shown@x.test%3Bevil@y.test` is one entry
    // to the parser and two addresses on the wire. Same separators on both sides, by
    // construction.
    const d = parseMailto("mailto:shown@x.test%3Bevil@y.test");
    expect(d?.to).toEqual(["shown@x.test", "evil@y.test"]);
    // And the recipient CAP counts what the send path will actually mail: 200 semicolon-joined
    // pairs is 200 recipients pre-split — the cap must clamp the post-split count.
    const pairs = Array.from({ length: 100 }, (_, i) => `a${i}@x.example%3Bb${i}@x.example`).join(",");
    expect(parseMailto(`mailto:${pairs}`)?.to).toHaveLength(64);
  });

  it("caps recipients, subject and body instead of carrying a hostile payload", () => {
    const many = Array.from({ length: 200 }, (_, i) => `p${i}@x.example`).join(",");
    const d = parseMailto(`mailto:${many}?subject=${"s".repeat(5_000)}&body=${"b".repeat(150_000)}`);
    expect(d?.to).toHaveLength(64);
    expect(d?.subject).toHaveLength(2_000);
    expect(d?.body).toHaveLength(100_000);
    // An address longer than a server would take is dropped, not truncated into a different one.
    const long = `${"a".repeat(400)}@x.example`;
    expect(parseMailto(`mailto:${long}`)?.to).toEqual([]);
  });

  it("treats empty and valueless query pairs as nothing", () => {
    const d = parseMailto("mailto:a@x.example?&&subject&body=&=orphan");
    expect(d).toEqual({ to: ["a@x.example"], cc: [], bcc: [], subject: "", body: "" });
  });
});

describe("emptyDraft", () => {
  it("is true only when every field is empty", () => {
    expect(emptyDraft({ to: [], cc: [], bcc: [], subject: "", body: "" })).toBe(true);
    expect(emptyDraft({ to: ["a@x.example"], cc: [], bcc: [], subject: "", body: "" })).toBe(false);
    expect(emptyDraft({ to: [], cc: [], bcc: [], subject: "s", body: "" })).toBe(false);
    expect(emptyDraft({ to: [], cc: [], bcc: [], subject: "", body: "b" })).toBe(false);
  });
});

describe("isMailto", () => {
  it("is the parser's own scheme test, case-insensitive, on the bytes as given", () => {
    expect(isMailto("mailto:a@x.example")).toBe(true);
    expect(isMailto("MAILTO:a@x.example")).toBe(true);
    expect(isMailto(" mailto:a@x.example"), "a caller trims first, as `parseMailto` does").toBe(false);
    expect(isMailto("https://x.example/mailto:a")).toBe(false);
  });
});

/**
 * THE DESKTOP'S HALF OF THE ONE MAILTO PARSER. The cases of the parser itself are the ones
 * (above); here the desktop's adapter: the gate parses with the leaf and hands the draft whole to
 * the shell, whose seeder is held to all five fields in the web app's own tests.
 */
describe("the desktop's mailto adapter", () => {
  const gate = readFileSync(resolve(__dirname, "../src/DesktopGate.tsx"), "utf8");
  it("parses with the one leaf, and nothing else", () => {
    expect(gate).toContain('from "@trafficflow/core/mailto"');
    expect(gate).not.toMatch(/from "\.\/mailto(\.js)?"/);
  });
  for (const c of MAILTO_SURFACE_CASES) {
    it(`carries every field: ${c.name}`, () => {
      expect(parseMailto(c.link)).toEqual({ to: c.to, cc: c.cc, bcc: c.bcc, subject: c.subject, body: c.body });
    });
  }
});

/* THE BYTES THE SHELL'S DOOR HANDS OVER. A framed `mailto:` reaches compose as the raw string the
   Rust route table keeps byte-exact (`popup_rows` in `engine_tests.rs`); read from there, so the
   two halves are asked about one string. */
describe("the shell's new-window door", () => {
  it("hands a mailto the parser reads as one subject, never a second header", () => {
    const rust = readFileSync(resolve(__dirname, "../src-tauri/src/engine_tests.rs"), "utf8");
    const raw = /PopupRoute::Compose\("(mailto:[^"]*%26[^"]*)"/.exec(rust)?.[1];
    expect(raw, "the route table lost its encoded-ampersand row").toBe("mailto:x@y.test?subject=A%26B");
    expect(parseMailto(raw!)).toEqual({ to: ["x@y.test"], cc: [], bcc: [], subject: "A&B", body: "" });
  });
});
