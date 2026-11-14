/** @vitest-environment jsdom */
/**
 * THE PICTURE DOOR ASKS FOR NOTHING A HOST NAMED NO WIRE FOR. A letter's remote pictures reach a window through the
 * host's picture wire and through nothing else. Over a host that names none, no door stands at all: no address is
 * minted for a picture, no press is recorded anywhere and no request leaves, whatever the account's own answer on
 * pictures is, and also on a page whose server client is configured and would answer.
 *
 * The page here HAS a server client that answers (the mock below says so and counts what it is asked): a door that
 * fell back to it would be seen.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WEB_IMAGES } from "../app/(product)/mailbox/image-wire";
import { useRemoteImages, type ImageDoor } from "../app/shell/remote-images";

/** What the page's own server client was asked to record, and the sentence it refuses with when it does. */
const client = vi.hoisted(() => ({ recorded: [] as string[], refuses: null as string | null }));
vi.mock("../app/api-client", async (load) => {
  const real = await load<typeof import("../app/api-client")>();
  return {
    ...real,
    API_BASE: "/api",
    apiConfigured: () => true,
    messageOf: (e: unknown) => (e as { message?: string }).message ?? String(e),
    privacy: {
      loadRemote: async (id: string) => {
        client.recorded.push(id);
        if (client.refuses !== null) throw new Error(client.refuses);
        return { remoteContent: "loaded" };
      },
    },
  };
});

const PICTURE = "https://images.newsletter.example/hero.png";
type Options = Parameters<typeof useRemoteImages>[0];
type Door = ReturnType<typeof useRemoteImages>;

/** What the door said when a press could not be recorded. */
const failed: string[] = [];
/** The door as a mount calls it, over the wire a host named and the account's answer on pictures. */
const over = (wire: ImageDoor | "none", mode: "auto" | "manual"): Options => ({
  wire, mode, loadPixels: true, onFailed: (sentence) => void failed.push(sentence),
});

let door: Door;
function Mounted({ options }: { options: Options }) {
  door = useRemoteImages(options);
  return null;
}

/** Everything a letter's body does with a door: name a picture's address, press Show images, ask for the bytes. */
async function pressedAsABodyPresses(messageId: string): Promise<string[]> {
  const minted: string[] = [];
  await act(async () => {
    const address = door?.proxyFor(messageId)(PICTURE);
    if (address !== undefined && address !== "") minted.push(address);
    door?.consent(messageId);
    door?.needRemote(messageId, [PICTURE]);
  });
  await act(async () => {});
  return minted;
}

const fetched = vi.fn(async () => new Response(null, { status: 204 }));
beforeEach(() => {
  client.recorded.length = 0;
  client.refuses = null;
  failed.length = 0;
  fetched.mockClear();
  vi.stubGlobal("fetch", fetched);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each(["auto", "manual"] as const)(
  "over a host that names no picture wire, the account's answer on pictures being %s",
  (mode) => {
    it("no door stands: the reader is handed no pictures, and no control over a wire nothing can serve", () => {
      render(<Mounted options={over("none", mode)} />);
      expect(door, "a picture door stood over a host that named no wire").toBeUndefined();
    });

    it("nothing of a letter is asked for: no address is minted, no press is recorded, no request leaves", async () => {
      render(<Mounted options={over("none", mode)} />);
      const minted = await pressedAsABodyPresses("m1");
      expect(minted, "an address was minted for a picture").toEqual([]);
      expect(client.recorded, "the page's own server client was asked to record a press").toEqual([]);
      expect(fetched, "a request left").not.toHaveBeenCalled();
    });
  },
);

describe("a caller that hands the door nothing at all", () => {
  it("has no door: what is not a wire reads as none, never as a wire of the door's own", async () => {
    render(<Mounted options={{ ...over("none", "auto"), wire: undefined as unknown as "none" }} />);
    expect(door).toBeUndefined();
    expect(await pressedAsABodyPresses("m1")).toEqual([]);
    expect(client.recorded).toEqual([]);
  });
});

describe("over the web's own wire, on a page with a server client", () => {
  it("a picture's address is this origin's proxy, with the letter's id and the sender's address in its query alone", () => {
    render(<Mounted options={over(WEB_IMAGES, "auto")} />);
    const address = new URL(door!.proxyFor("m1")(PICTURE));
    expect(address.origin).toBe(window.location.origin);
    expect(address.pathname).toBe("/api/img");
    expect([address.searchParams.get("mid"), address.searchParams.get("u")]).toEqual(["m1", PICTURE]);
  });

  it("a press is recorded through the page's server client, once, and then the letter's pictures are admitted", async () => {
    render(<Mounted options={over(WEB_IMAGES, "manual")} />);
    expect(door!.auto, "pictures load by themselves under the account's manual answer").toBe(false);
    expect(door!.consented("m1")).toBe(false);
    await pressedAsABodyPresses("m1");
    expect(client.recorded).toEqual(["m1"]);
    expect(door!.consented("m1")).toBe(true);
    expect(fetched, "the door fetched a picture's bytes itself").not.toHaveBeenCalled();
  });

  it("a refused press admits nothing and says the server's own sentence", async () => {
    client.refuses = "Remote images are switched off for this mailbox.";
    render(<Mounted options={over(WEB_IMAGES, "manual")} />);
    await pressedAsABodyPresses("m1");
    expect(door!.consented("m1")).toBe(false);
    expect(failed).toEqual(["Remote images are switched off for this mailbox."]);
  });
});

describe("over a pipe, on a page whose server client would answer", () => {
  it("the bytes and the press go down the pipe, and the page's server client is asked nothing", async () => {
    const pipe = {
      fetch: vi.fn(async () => "data:image/png;base64,AAAA"),
      record: vi.fn(async () => undefined),
    };
    render(<Mounted options={over(pipe, "manual")} />);
    await pressedAsABodyPresses("m1");
    expect(pipe.record.mock.calls).toEqual([["m1"]]);
    expect(pipe.fetch.mock.calls).toEqual([["m1", PICTURE]]);
    expect(door!.resolvedFor("m1").get(PICTURE)).toBe("data:image/png;base64,AAAA");
    expect(client.recorded, "the page's own server client was asked beside the pipe").toEqual([]);
    expect(fetched).not.toHaveBeenCalled();
  });
});
