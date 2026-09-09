/** @vitest-environment jsdom */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it } from "vitest";

import en from "../../webapp/messages/en.json";
import { EMPTY_LOCAL, enterLocalDoor } from "../src/doors.js";
import { configureSelfHostDoor } from "../src/self-host.js";
import { providerById } from "../../webapp/app/shell/providers.js";

/**
 * BOTH DOORS, ONE READING OF THE PROBE'S OWN ANSWER.
 *
 * ── WHAT THE ENGINE ACTUALLY SENDS, MEASURED ──────────────────────────────────────────────────
 *
 * A real TLS listener whose certificate CHAIN validates and whose NAME is `mail.doors016.example`,
 * dialled at `127.0.0.1`, put through the shipped classifier (`tlsDetailOf`, the same call the
 * mailbox probe makes) answered:
 *
 *     {"kind":"hostname_mismatch","expectedHost":"127.0.0.1","certHost":"mail.doors016.example"}
 *
 * `suggestedHost` sits beside those when the vanity-CNAME shape resolves — a lane rig cannot
 * produce one, so the bodies below carry the field as it was measured live against a real mailbox
 * during the onboarding drill and recorded on the row.
 *
 * (A GreenMail rig CANNOT produce this detail at all, and that is worth writing down: its bundled
 * certificate is self-signed, so the chain never validates and the classifier answers
 * `{"kind":"self_signed"}` before a name is ever compared. `hostname_mismatch` is by construction
 * the one TLS kind whose chain DID validate.)
 *
 * ── THE CENSUS ────────────────────────────────────────────────────────────────────────────────
 *
 * The standalone door and the self-hosted door are two screens over one product, and both are
 * shown the same `error.details` by the same engine. Reading it in two places is how they came to
 * describe one refusal in two ways: the standalone door sharpened the sentence, and the self-hosted
 * door returned `error.message` and discarded the details it was holding.
 */

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
interface Host {
  __TAURI_INTERNALS__?: { invoke: Invoke; transformCallback?: unknown };
}
const host = globalThis as unknown as Host;

function encode(status: number, body = "", statusText = "OK"): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText, h: [] }));
  const payload = new TextEncoder().encode(body);
  const out = new Uint8Array(4 + meta.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(payload, 4 + meta.byteLength);
  return out;
}

const ADDRESS = "mila@example.com";
const ORIGIN = "https://ohmail.example.com";

/** The refusal bodies the engine sends, as the field set each one carries. */
const REFUSALS: Array<{ what: string; body: string }> = [
  {
    what: "a hostname mismatch with a host to suggest",
    body: JSON.stringify({
      error: {
        code: "mailbox_probe_failed",
        message:
          "That mail server's certificate does not match the host you entered, so we stopped " +
          "before sending the password. Check the IMAP host with your provider.",
        details: {
          reason: "tls",
          transport: "imap",
          tls: {
            kind: "hostname_mismatch",
            expectedHost: "mail.trafficflow.ch",
            certHost: "trafficflow.ch",
            suggestedHost: "trafficflow.ch",
          },
        },
      },
    }),
  },
  {
    what: "a hostname mismatch with nothing to suggest",
    body: JSON.stringify({
      error: {
        code: "mailbox_probe_failed",
        message: "That mail server's certificate does not match the host you entered.",
        details: {
          reason: "tls",
          transport: "smtp",
          tls: { kind: "hostname_mismatch", expectedHost: "mail.example.org", certHost: "*.hosting.example" },
        },
      },
    }),
  },
  {
    what: "a self-signed certificate — a TLS refusal this reading does not rewrite",
    body: JSON.stringify({
      error: {
        code: "mailbox_probe_failed",
        message: "That mail server's certificate is signed by an authority this computer does not trust.",
        details: { reason: "tls", transport: "imap", tls: { kind: "self_signed" } },
      },
    }),
  },
  {
    what: "a refusal with no details at all",
    body: JSON.stringify({
      error: { code: "mailbox_probe_failed", message: "The password was refused." },
    }),
  },
];

/** The standalone door's shell: the row read succeeds, the credential PATCH is refused. */
function standaloneShell(body: string): void {
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, payload) => {
      if (command === "engine_configure") return { state: "starting", mode: "local" };
      if (command === "engine_status") {
        return {
          state: "serving", mode: "local", address: ADDRESS, mailboxId: "mbx-1", credentialState: "absent",
        };
      }
      if (command === "engine_request") {
        const req = payload as { method?: string; url?: string } | undefined;
        if ((req?.method ?? "GET") === "GET") {
          return encode(200, JSON.stringify({ id: "mbx-1", address: ADDRESS }));
        }
        return encode(400, body, "Bad Request");
      }
      throw new Error(`unexpected command ${command}`);
    },
  };
}

/** The self-hosted door's shell: an engine is up, and the candidate probe is refused. */
function selfHostShell(body: string): void {
  let base = "https://api.ohmail.app";
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    invoke: async (command, payload) => {
      if (command === "engine_configure") {
        base = (payload!.config as { cloudUrl?: string }).cloudUrl ?? "";
        return { state: "starting", mode: "cloud" };
      }
      if (command === "engine_status") {
        return {
          state: "serving", mode: "cloud", flavor: "managed", address: ADDRESS,
          mailboxId: "mbx-1", credentialState: "ready", baseUrl: base,
        };
      }
      if (command === "engine_request") {
        const url = String(payload!.url ?? "");
        if (url === "/cloud/probe") return encode(400, body, "Bad Request");
        return encode(404, '{"error":{"code":"not_found","message":"no such route"}}', "Not Found");
      }
      throw new Error(`unexpected command ${command}`);
    },
  };
}

const FILLED = {
  ...EMPTY_LOCAL,
  providerId: "imap",
  address: ADDRESS,
  password: "hunter2-not-a-real-secret",
  imapHost: "mail.example.org",
  smtpHost: "smtp.example.org",
  user: ADDRESS,
};

afterEach(() => {
  delete host.__TAURI_INTERNALS__;
});

describe("the two doors read one probe answer the same way", () => {
  for (const refusal of REFUSALS) {
    it(`says the same thing about ${refusal.what}`, async () => {
      standaloneShell(refusal.body);
      const standalone = await enterLocalDoor(FILLED, providerById("imap"));

      selfHostShell(refusal.body);
      const selfHosted = await configureSelfHostDoor(ORIGIN, ADDRESS);

      expect(selfHosted.problem).toBe(standalone.problem);
      expect(selfHosted.suggestion ?? null).toEqual(standalone.suggestion ?? null);
    });
  }

  /**
   * AND THE SUGGESTION IS A FACT ABOUT ONE FIELD. A mismatch on the outgoing transport names the
   * SMTP host; naming the incoming one would put the wrong server in the wrong box.
   */
  it("carries the transport the mismatch was on", async () => {
    standaloneShell(REFUSALS[0]!.body);
    const imap = await enterLocalDoor(FILLED, providerById("imap"));
    expect(imap.suggestion).toEqual({ host: "trafficflow.ch", transport: "imap" });

    standaloneShell(REFUSALS[1]!.body);
    const smtp = await enterLocalDoor(FILLED, providerById("imap"));
    // Nothing to suggest on this one — the certificate named a host, but not one to stand behind.
    expect(smtp.suggestion ?? null).toBeNull();
  });
});

/* ── THE SUGGESTION ON SCREEN ────────────────────────────────────────────────────────────────── */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

describe("the standalone door offers the host the probe named", () => {
  let root: Root | null = null;
  let mount: HTMLElement | null = null;

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    mount?.remove();
    root = null;
    mount = null;
  });

  const set = async (el: HTMLElement, id: string, value: string): Promise<void> => {
    const input = el.querySelector<HTMLInputElement>(`#${id}`);
    if (!input) throw new Error(`no field #${id} on screen`);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  const press = async (el: HTMLElement, label: string): Promise<void> => {
    const found = [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(label));
    if (!found) {
      throw new Error(
        `no control saying "${label}" — found: ${
          [...el.querySelectorAll("button")].map((b) => b.textContent).join(" | ")
        }`,
      );
    }
    await act(async () => {
      found.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };

  it("names it in a control, and pressing that control fills the field", async () => {
    standaloneShell(REFUSALS[0]!.body);
    const { DoorChooser } = await import("../src/DoorChooser.js");
    mount = document.createElement("div");
    document.body.append(mount);
    root = createRoot(mount);
    await act(async () => {
      root!.render(
        h(
          NextIntlClientProvider,
          { locale: "en", messages: en as never, timeZone: "Europe/Zurich" },
          h(DoorChooser, { start: "local", onEntered: () => {} }),
        ),
      );
    });

    /* The generic entry, which is the one with host fields on screen — and the one a person on
       their own mail server uses. A named preset's host is this app's own fact and there is no
       field to write a suggestion into. */
    await press(mount, "Any other IMAP mailbox");

    await set(mount, "door-address", ADDRESS);
    await set(mount, "door-password", "hunter2-not-a-real-secret");
    await set(mount, "door-imap-host", "mail.trafficflow.ch");
    await press(mount, "Open this mailbox");

    // THE SENTENCE, which already named the host.
    expect(mount.querySelector(".join-error")?.textContent ?? "").toContain(
      "It answers to trafficflow.ch — use that as the IMAP host.",
    );

    /* AND THE CONTROL. Its accessible name names the host, so a screen reader hears which server
       is being offered rather than "use this". */
    const offer = [...mount.querySelectorAll("button")].find((b) =>
      (b.getAttribute("aria-label") ?? b.textContent ?? "").includes("trafficflow.ch"),
    );
    expect(offer, "no control offered the host the probe named").toBeTruthy();
    expect(offer!.getAttribute("aria-label") ?? offer!.textContent ?? "").toContain("trafficflow.ch");

    await act(async () => {
      offer!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // The field now holds it, so the next attempt dials the host the certificate covers.
    expect(mount.querySelector<HTMLInputElement>("#door-imap-host")!.value).toBe("trafficflow.ch");
  });

  /**
   * AND NOT WHERE THERE IS NOTHING TO FILL. Behind a named provider the host is this app's own
   * fact and the field is not on screen, so the offer would press into nothing. The sentence still
   * names the host — which is what it did before the control existed.
   */
  it("offers no control behind a named provider, and still names the host", async () => {
    standaloneShell(REFUSALS[0]!.body);
    const { DoorChooser } = await import("../src/DoorChooser.js");
    mount = document.createElement("div");
    document.body.append(mount);
    root = createRoot(mount);
    await act(async () => {
      root!.render(
        h(
          NextIntlClientProvider,
          { locale: "en", messages: en as never, timeZone: "Europe/Zurich" },
          h(DoorChooser, { start: "local", onEntered: () => {} }),
        ),
      );
    });

    await press(mount, "Fastmail");
    // The proof there is no field: a named preset draws none.
    expect(mount.querySelector("#door-imap-host")).toBeNull();

    await set(mount, "door-address", ADDRESS);
    await set(mount, "door-password", "hunter2-not-a-real-secret");
    await press(mount, "Open this mailbox");

    expect(mount.querySelector(".join-error")?.textContent ?? "").toContain(
      "It answers to trafficflow.ch — use that as the IMAP host.",
    );
    const offer = [...mount.querySelectorAll("button")].find((b) =>
      (b.getAttribute("aria-label") ?? b.textContent ?? "").includes("Use trafficflow.ch"),
    );
    expect(offer, "a control was offered with no field to fill").toBeUndefined();
  });
});
