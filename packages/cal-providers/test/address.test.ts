/**
 * A typed address read by its shape, for a door that takes it and dials nothing; and the rule that
 * holds the door and the dial together: for every address the request port decides without a lookup,
 * the door's reading says the same word, and what the door admits the port goes on to look up or ask.
 */
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import type { HostResolver, PinnedRequestOptions, PinnedResponse } from "@trafficflow/core/net";
import { describe, expect, it } from "vitest";
import {
  ICLOUD_CALDAV_START,
  readTypedAddress,
  subscriptionAddresses,
  typedAddress,
} from "../src/address.js";
import { guardedRequest } from "../src/request/guarded.js";
import type { HttpRequest } from "../src/request/index.js";
import { shapeRefusal, type AddressPolicy } from "../src/request/shape.js";

const CLOUD: AddressPolicy = { kind: "cloud" };
const OWN: AddressPolicy = { kind: "own-network" };
// Put together here, so that no line of this file is shaped like an address with a sign-in inside it.
const WITH_SIGN_IN = ["https://", "u", ":", "p", "@", "dav.example.test/"].join("");

describe("a CalDAV server's address, as typed", () => {
  it("is kept as its origin and path, over TLS unless it was typed without", () => {
    const kept = (typed: string, policy: AddressPolicy = CLOUD) => readTypedAddress("caldav", typed, policy);
    expect(kept("dav.example.test")).toEqual({
      ok: true,
      host: "dav.example.test",
      start: "https://dav.example.test/",
    });
    expect(kept("  https://DAV.example.test/remote.php/dav  ")).toEqual({
      ok: true,
      host: "dav.example.test",
      start: "https://dav.example.test/remote.php/dav",
    });
    expect(kept("mila@example.test")).toEqual({
      ok: true,
      host: "example.test",
      start: "https://example.test/",
    });
    expect(kept("https://dav.example.test:8443/dav/")).toEqual({
      ok: true,
      host: "dav.example.test",
      start: "https://dav.example.test:8443/dav/",
    });
    expect(kept(ICLOUD_CALDAV_START)).toEqual({
      ok: true,
      host: "caldav.icloud.com",
      start: ICLOUD_CALDAV_START,
    });
    expect(kept("http://nas.local:5232/", OWN)).toEqual({
      ok: true,
      host: "nas.local",
      start: "http://nas.local:5232/",
    });
    expect(kept("http://192.168.1.20/dav", OWN)).toEqual({
      ok: true,
      host: "192.168.1.20",
      start: "http://192.168.1.20/dav",
    });
  });

  it("reads again to the same starts: what a pass asks is what the door kept", () => {
    for (const typed of [
      "dav.example.test",
      "https://dav.example.test/remote.php/dav",
      "mila@example.test",
    ]) {
      const kept = readTypedAddress("caldav", typed, CLOUD);
      expect(kept.ok && typedAddress(kept.start!)).toEqual(typedAddress(typed));
    }
  });

  it("is refused by its shape, with the word of the closed list", () => {
    const word = (typed: string, policy: AddressPolicy = CLOUD) => {
      const read = readTypedAddress("caldav", typed, policy);
      return read.ok ? "taken" : read.reason;
    };
    expect(word("")).toBe("address_invalid");
    expect(word(WITH_SIGN_IN)).toBe("address_invalid");
    expect(word("ftp://dav.example.test/")).toBe("address_invalid");
    expect(word("https://dav.example.test/dav?token=abc")).toBe("address_invalid");
    expect(word("https://dav.example.test/dav#home")).toBe("address_invalid");
    expect(word("http://dav.example.test/")).toBe("address_not_allowed");
    expect(word("https://127.0.0.1/")).toBe("address_not_allowed");
    expect(word("https://nas.local/")).toBe("address_not_allowed");
    expect(word("https://dav.example.test:993/")).toBe("port_not_allowed");
    expect(word("http://203.0.114.1/dav", OWN)).toBe("address_not_allowed");
    expect(word("https://169.254.169.254/", OWN)).toBe("address_not_allowed");
  });
});

describe("a subscription's address, as typed", () => {
  it("hands back its host and nothing else of it", () => {
    const read = readTypedAddress("ics", "webcal://Feeds.example.test/team/key-abc/basic.ics?t=1", CLOUD);
    expect(read).toEqual({ ok: true, host: "feeds.example.test", start: null });
    expect(JSON.stringify(read)).not.toContain("key-abc");
  });

  it("is read as typed: plain is refused on a hosted server, and taken for a person's own network on their own", () => {
    const word = (typed: string, policy: AddressPolicy) => {
      const read = readTypedAddress("ics", typed, policy);
      return read.ok ? read.host : read.reason;
    };
    expect(word("http://feeds.example.test/a.ics", CLOUD)).toBe("address_not_allowed");
    expect(word("https://feeds.example.test/a.ics", CLOUD)).toBe("feeds.example.test");
    expect(word("webcals://feeds.example.test/a.ics", CLOUD)).toBe("feeds.example.test");
    expect(word("http://192.168.1.20/a.ics", CLOUD)).toBe("address_not_allowed");
    expect(word("http://192.168.1.20/a.ics", OWN)).toBe("192.168.1.20");
    expect(word("http://localhost:8080/a.ics", OWN)).toBe("localhost");
    expect(word("feeds.example.test/a.ics", CLOUD)).toBe("address_invalid");
    expect(word(`https://feeds.example.test/${"a".repeat(9000)}`, CLOUD)).toBe("address_invalid");
    // The reader's own order is unchanged by the move: as typed first, then over TLS, never the other way round.
    expect(subscriptionAddresses("http://feeds.example.test/a.ics")).toEqual([
      "http://feeds.example.test/a.ics",
      "https://feeds.example.test/a.ics",
    ]);
  });
});

describe("the door's reading and the request port's", () => {
  const ADDRESSES = [
    "https://feeds.example.test/a.ics",
    "http://feeds.example.test/a.ics",
    "https://feeds.example.test:25/a.ics",
    "https://feeds.example.test:8443/a.ics",
    "https://169.254.169.254/a.ics",
    "https://100.100.100.200/a.ics",
    "https://10.0.0.5/a.ics",
    "http://10.0.0.5/a.ics",
    "https://127.0.0.1/a.ics",
    "http://127.0.0.1:8080/a.ics",
    "https://localhost/a.ics",
    "http://nas.local/a.ics",
    "https://x.home.arpa/a.ics",
    "https://metadata.google.internal/a.ics",
    "https://hidden.onion/a.ics",
    "https://203.0.114.1/a.ics",
    "http://203.0.114.1/a.ics",
    "https://[::1]/a.ics",
    "https://[2001:db8::1]/a.ics",
    "https://2130706433/a.ics",
    "https://feeds..example.test/a.ics",
    ["https://", "u", ":", "p", "@", "feeds.example.test/a.ics"].join(""),
  ];
  const get: HttpRequest = {
    method: "GET",
    headers: {},
    body: null,
    auth: null,
    validators: null,
    signal: new AbortController().signal,
  };

  /** The request port over stand-ins that count: a resolver that knows no name, and a request that dials nothing. */
  function port(policy: AddressPolicy) {
    const seen = { looked: 0, asked: 0 };
    const resolver: HostResolver = {
      async resolve() {
        seen.looked += 1;
        return ["203.0.114.1"];
      },
    };
    const request = async (_url: string, _opts: PinnedRequestOptions): Promise<PinnedResponse> => {
      seen.asked += 1;
      const stream = Readable.from([Buffer.from("BEGIN:VCALENDAR")]) as unknown as IncomingMessage;
      return { status: 200, headers: {}, stream };
    };
    const limits = { connectMs: 2_000, totalMs: 4_000, maxRedirects: 0, maxBodyBytes: 1024 };
    return { seen, port: guardedRequest({ resolver, request, policy, limits, hosts: null, writes: false }) };
  }

  it("agree on every address neither needs a lookup for, on both policies", async () => {
    const rows: string[] = [];
    for (const policy of [CLOUD, OWN]) {
      for (const address of ADDRESSES) {
        const { seen, port: p } = port(policy);
        const answer = await p.request(address, get);
        const door = shapeRefusal(new URL(address), policy, null);
        const dial = answer.arrived ? null : answer.reason;
        // Refused at sight by the port: the door says the same word. Admitted by the door: the port went on to look up or ask.
        if (seen.looked === 0 && seen.asked === 0)
          rows.push(`${policy.kind} ${door === dial ? "same" : `door ${door} dial ${dial}`}`);
        else rows.push(`${policy.kind} ${door === null ? "same" : `door ${door} but the port went on`}`);
        if (door !== null) expect([seen.looked, seen.asked], address).toEqual([0, 0]);
      }
    }
    expect(rows.filter((r) => !r.endsWith("same"))).toEqual([]);
    expect(rows.length).toBe(2 * ADDRESSES.length);
  });

  /** Forbidden on BOTH policies: this machine's unspecified address, link-local and metadata, in every spelling. */
  const EVERYWHERE = [
    "https://169.254.169.254./a.ics",
    "https://0xa9.0xfe.0xa9.0xfe/a.ics",
    "https://2852039166/a.ics",
    "https://0251.0376.0251.0376/a.ics",
    "https://%31%36%39.254.169.254/a.ics",
    "https://①⑥⑨.②⑤④.①⑥⑨.②⑤④/a.ics",
    "https://[::ffff:a9fe:a9fe]/a.ics",
    "https://[::ffff:169.254.169.254]/a.ics",
    "https://[64:ff9b::a9fe:a9fe]/a.ics",
    "https://[2002:a9fe:a9fe::1]/a.ics",
    "https://[fe80::1]/a.ics",
    "https://0/a.ics",
    "https://0.0.0.0/a.ics",
    "https://[::]/a.ics",
    "https://[::ffff:0.0.0.0]/a.ics",
    "https://100.100.100.200/a.ics",
    "https://metadata.google.internal./a.ics",
    "https://169.254.\n169.254/a.ics",
    "webcal://[::ffff:a9fe:a9fe]/a.ics",
  ];
  /** Forbidden on the cloud policy only: this machine and private networks, in every spelling. */
  const CLOUD_ONLY = [
    "https://0x7f.0.0.1/a.ics",
    "https://0177.0.0.1/a.ics",
    "https://127.1/a.ics",
    "https://2130706433/a.ics",
    "https://[::ffff:127.0.0.1]/a.ics",
    "https://[::1]/a.ics",
    "https://localhost./a.ics",
    "https://LOCALHOST/a.ics",
    "https://%6c%6fcalhost/a.ics",
    "https://x.localhost/a.ics",
    "https://10.1/a.ics",
    "https://[fd00::1]/a.ics",
    "webcals://192.168.0.1/a.ics",
  ];

  it("a host written to slip past the shape is refused by the door's own reader and at the dial, with no lookup and no request", async () => {
    const rows: string[] = [];
    const cases: [string, AddressPolicy][] = [
      ...EVERYWHERE.flatMap((a): [string, AddressPolicy][] => [
        [a, CLOUD],
        [a, OWN],
      ]),
      ...CLOUD_ONLY.map((a): [string, AddressPolicy] => [a, CLOUD]),
    ];
    for (const [typed, policy] of cases) {
      const door = readTypedAddress("ics", typed, policy);
      const { seen, port: p } = port(policy);
      const asked = typed.startsWith("webcal") ? typed.replace(/^webcals?:/, "https:") : typed;
      const dial = await p.request(asked, get);
      const said = `${policy.kind} ${JSON.stringify(typed)}: door ${door.ok ? "TAKEN" : door.reason} dial ${dial.arrived ? "ARRIVED" : dial.reason} looked ${seen.looked} asked ${seen.asked}`;
      if (door.ok || dial.arrived || seen.looked !== 0 || seen.asked !== 0) rows.push(said);
    }
    expect(rows).toEqual([]);
    expect(cases.length).toBe(51);
    // The control: the same two readers take a public address and the port dials it.
    const { seen, port: p } = port(CLOUD);
    expect(readTypedAddress("ics", "https://feeds.example.test/a.ics", CLOUD).ok).toBe(true);
    expect((await p.request("https://feeds.example.test/a.ics", get)).arrived).toBe(true);
    expect([seen.looked, seen.asked]).toEqual([1, 1]);
    // And a CalDAV server typed as a host alone or a mail address is read the same way.
    for (const typed of ["0x7f.1", "mila@127.0.0.1", "mila@169.254.169.254", "169.254.169.254:8443"]) {
      expect(readTypedAddress("caldav", typed, CLOUD).ok, typed).toBe(false);
    }
    expect(readTypedAddress("caldav", "mila@169.254.169.254", OWN).ok).toBe(false);
    expect(shapeRefusal(new URL("https://feeds.example.test:1023/"), CLOUD, null)).toBe("port_not_allowed");
  });

  it("the port refuses at the dial what a shape cannot show: a name that resolves to a private address", async () => {
    const seen = { asked: 0 };
    const request = async (): Promise<PinnedResponse> => {
      seen.asked += 1;
      return { status: 200, headers: {}, stream: Readable.from([]) as unknown as IncomingMessage };
    };
    const limits = { connectMs: 2_000, totalMs: 4_000, maxRedirects: 0, maxBodyBytes: 1024 };
    const inside: HostResolver = { resolve: async () => ["203.0.114.1", "10.0.0.5"] };
    const p = guardedRequest({
      resolver: inside,
      request,
      policy: CLOUD,
      limits,
      hosts: null,
      writes: false,
    });
    expect(readTypedAddress("ics", "https://rebound.example.test/a.ics", CLOUD).ok).toBe(true);
    expect(await p.request("https://rebound.example.test/a.ics", get)).toEqual({
      arrived: false,
      reason: "address_not_allowed",
    });
    expect(seen.asked).toBe(0);
  });
});
