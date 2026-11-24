/**
 * Where a password typed for one CalDAV server may travel. To that server's own origin, and to an
 * origin the server itself named in the same turn; and a server can only name a host beside its
 * own: its own host, and its siblings under the same parent name when that parent has two labels
 * or more. A server's answer or a redirect that names any other host gets no credential, and an
 * address nobody but a caller names gets none either.
 */
import { describe, expect, it } from "vitest";
import { typedAddress } from "../src/address.js";
import { hostsBeside, turnHostsOf, type TurnHosts } from "../src/caldav/hosts.js";
import { hopOf, originOf } from "../src/request/shape.js";

const admitted = (typed: string, hosts: readonly string[]): boolean[] => hosts.map(hostsBeside(typed));

/** A turn of its own for a server typed as `typed`. */
const turn = (typed: string): TurnHosts => turnHostsOf({}, typedAddress(typed)!);
/** The port's question about an address the caller asked for, or about one the answer of `from` sent the request on to. */
const hop = (address: string, from: string | null = null) => hopOf(new URL(address), from === null ? null : originOf(new URL(from)));
const TYPED = "https://caldav.example.com/";
const BESIDE = "https://p12-caldav.example.com/123/calendars/";

describe("the origins one turn's sign-in travels to", () => {
  it("begins with the sealed server's own origin alone: its scheme, its host and its port", () => {
    const t = turn(TYPED);
    expect([
      "https://caldav.example.com/any/path", "https://CALDAV.example.com./", "https://caldav.example.com:443/",
      "https://caldav.example.com:8443/", "http://caldav.example.com/", BESIDE, "https://example.com/", "https://caldav.example.com.attacker.example/",
    ].map((address) => t.admits(hop(address)))).toEqual([true, true, true, false, false, false, false, false]);
    // A port that was typed is the server's own, and the scheme's own port is then another server.
    const ported = turn("https://dav.example.com:8443/dav/");
    expect(["https://dav.example.com:8443/", "https://dav.example.com/", "https://dav.example.com:8444/"].map((address) => ported.admits(hop(address)))).toEqual([true, false, false]);
  });

  it("an address typed without TLS is also its own over TLS, on the same port, and nothing else", () => {
    const t = turn("http://nas.example.org:5232/mila/");
    expect(["http://nas.example.org:5232/", "https://nas.example.org:5232/", "https://nas.example.org/", "http://nas.example.org/"].map((address) => t.admits(hop(address))))
      .toEqual([true, true, false, false]);
  });

  it("admits an origin the server named: in an answer that came from an origin admitted before it", () => {
    const t = turn(TYPED);
    t.names(BESIDE, "https://caldav.example.com/principals/mila/");
    expect([BESIDE, "https://p12-caldav.example.com:8443/", "https://p13-caldav.example.com/"].map((address) => t.admits(hop(address)))).toEqual([true, false, false]);
    // And what a named origin names in its turn.
    t.names("https://p13-caldav.example.com/home/", BESIDE);
    expect(t.admits(hop("https://p13-caldav.example.com/"))).toBe(true);
  });

  it("takes no name from an answer of an origin that is not admitted, none for a host that does not stand beside the typed one, and none that is no address", () => {
    const t = turn(TYPED);
    t.names(BESIDE, "https://elsewhere.example.net/");
    t.names(BESIDE, "https://caldav.example.com:8443/");
    t.names("https://elsewhere.example.net/home/", TYPED);
    t.names("https://caldav.example.com.attacker.example/home/", TYPED);
    t.names("not an address", TYPED);
    t.names(BESIDE, "not an address");
    expect([BESIDE, "https://elsewhere.example.net/", "https://caldav.example.com.attacker.example/"].map((address) => t.admits(hop(address)))).toEqual([false, false, false]);
  });

  it("in the discovery, a redirect names the origin it sends the request on to; the address a caller asks for is never named by being asked", () => {
    const t = turn(TYPED);
    expect(t.admitsFound(hop(BESIDE))).toBe(false);
    expect(t.admitsFound(hop(BESIDE, TYPED))).toBe(true);
    // From then on it is admitted for every request of the turn, and it can send the discovery on once more.
    expect([t.admits(hop(BESIDE)), t.admitsFound(hop("https://p13-caldav.example.com/dav/", BESIDE))]).toEqual([true, true]);
    // Sent on by an origin that is not admitted, or to a host that does not stand beside the typed one: not named.
    const other = turn(TYPED);
    expect([other.admitsFound(hop(BESIDE, "https://elsewhere.example.net/")), other.admitsFound(hop("https://elsewhere.example.net/", TYPED)), other.admits(hop(BESIDE))])
      .toEqual([false, false, false]);
  });

  it("outside the discovery a redirect names nothing", () => {
    const t = turn(TYPED);
    expect([t.admits(hop(BESIDE, TYPED)), t.admits(hop(BESIDE))]).toEqual([false, false]);
  });

  it("has nothing to ask its server about a host the server could never name", () => {
    const t = turn(TYPED);
    expect([BESIDE, "https://caldav.example.com:8443/", "https://elsewhere.example.net/", "not an address"].map((address) => t.couldName(address))).toEqual([true, true, false, false]);
  });

  it("is kept with the object a caller made for the turn: the same object finds what was named, another begins from the sealed origin alone", () => {
    const typed = typedAddress(TYPED)!;
    const one = {};
    turnHostsOf(one, typed).names(BESIDE, TYPED);
    expect([turnHostsOf(one, typed).admits(hop(BESIDE)), turnHostsOf({}, typed).admits(hop(BESIDE))]).toEqual([true, false]);
  });

  it("asks its server once: the first caller's asking is every caller's answer, a failed one too", async () => {
    const t = turn(TYPED);
    let asked = 0;
    const ask = async () => {
      asked += 1;
      return "unavailable" as const;
    };
    expect([await t.once(ask), await t.once(ask), await t.once(async () => null), asked]).toEqual(["unavailable", "unavailable", "unavailable", 1]);
  });
});

describe("the hosts a typed server's answers may name", () => {
  it("the typed host and its siblings: a server that names its home on a numbered host of its own is followed", () => {
    expect(admitted("caldav.example.com", ["caldav.example.com", "p01-caldav.example.com", "p118-caldav.example.com", "a.b.example.com"])).toEqual([true, true, true, true]);
  });

  it("a host is one host however it is written", () => {
    expect(admitted("CalDAV.Example.com.", ["caldav.example.com", "p01-caldav.example.com".toUpperCase(), "p01-caldav.example.com."])).toEqual([true, true, true]);
  });

  it("no other name, however alike", () => {
    expect(
      admitted("caldav.example.com", [
        "example.com", // the parent itself is not a sibling
        "evil.example.test",
        "caldav.example.com.attacker.example",
        "example.com.attacker.example",
        "xexample.com",
        "caldav-example.com",
        "com",
        "",
        "caldav.example.com@evil.example.test",
        "caldav.example.com/evil",
      ]),
    ).toEqual([false, false, false, false, false, false, false, false, false, false]);
  });

  it("a parent of three labels admits its own members only", () => {
    expect(admitted("cloud.example.co.uk", ["cloud.example.co.uk", "files.example.co.uk", "other.co.uk", "example.co.uk"])).toEqual([true, true, false, false]);
  });

  it("a typed host of two labels, or of one, admits itself only", () => {
    expect(admitted("example.org", ["example.org", "dav.example.org", "other.org"])).toEqual([true, false, false]);
    expect(admitted("nas", ["nas", "nas.home", "other"])).toEqual([true, false, false]);
  });

  it("a numbered address admits itself only: its last numbers are no parent name", () => {
    expect(admitted("192.168.1.10", ["192.168.1.10", "10.168.1.10", "evil.168.1.10", "192.168.1.11"])).toEqual([true, false, false, false]);
    expect(admitted("127.0.0.1", ["127.0.0.1", "localhost"])).toEqual([true, false]);
    expect(admitted("[fd00::10]", ["[fd00::10]", "fd00::10", "[fd00::11]"])).toEqual([true, true, false]);
    // A name whose last label is a number is no name with a parent either.
    expect(admitted("a.b.c.7", ["a.b.c.7", "x.b.c.7"])).toEqual([true, false]);
  });

  it("nothing typed admits nothing", () => {
    expect(admitted("", ["", "example.com"])).toEqual([false, false]);
    expect(admitted(".", [".", ""])).toEqual([false, false]);
  });
});
