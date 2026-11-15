/**
 * Where a password typed for one CalDAV server may travel: to that host, and to its siblings under
 * the same parent name when that parent has two labels or more. A server's answer or a redirect that
 * names any other host gets no credential.
 */
import { describe, expect, it } from "vitest";
import { credentialHostsFor } from "../src/caldav/hosts.js";

const admitted = (typed: string, hosts: readonly string[]): boolean[] => hosts.map(credentialHostsFor(typed));

describe("the hosts a typed server's password may travel to", () => {
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
