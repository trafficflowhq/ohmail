// @services: none — the port resolver's answers, no dial
import { afterEach, describe, expect, it } from "vitest";
import { greenmailPorts } from "../apps/worker/test/_greenmail-ports.js";

/**
 * A LANE'S OWN GREENMAIL ISOLATES ALL OF ITS TRAFFIC, OR THE LANE IS TOLD.
 *
 * `_workerenv.ts` read IMAP's port from the environment and carried SMTP's as the literal 3025, so
 * a lane that started its own container isolated every READ and delivered every SEND into the
 * shared box. Two send cases did, on fresh random users. A half-applied override is worse than
 * none: it looks isolated and is not, and the only visible trace is mail arriving somewhere else.
 */
describe("the GreenMail ports come from the environment together", () => {
  const saved = { imap: process.env.IMAP_PORT, smtp: process.env.SMTP_PORT, ih: process.env.IMAP_HOST, sh: process.env.SMTP_HOST };
  const set = (k: "IMAP_PORT" | "SMTP_PORT" | "IMAP_HOST" | "SMTP_HOST", v: string | undefined) => {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };
  afterEach(() => {
    set("IMAP_PORT", saved.imap); set("SMTP_PORT", saved.smtp);
    set("IMAP_HOST", saved.ih); set("SMTP_HOST", saved.sh);
  });

  it("defaults to the shared box when nothing is set", () => {
    set("IMAP_PORT", undefined); set("SMTP_PORT", undefined);
    set("IMAP_HOST", undefined); set("SMTP_HOST", undefined);
    expect(greenmailPorts()).toEqual({ imapHost: "127.0.0.1", imapPort: 3143, smtpHost: "127.0.0.1", smtpPort: 3025 });
  });

  it("refuses an IMAP port with no SMTP port beside it, and says where the mail would go", () => {
    set("IMAP_PORT", "4143"); set("SMTP_PORT", undefined);
    expect(() => greenmailPorts()).toThrow(/SMTP_PORT is unset/);
    expect(() => greenmailPorts()).toThrow(/DELIVER into the shared box on 3025/);
    /* The remedy is named, because a refusal a reader cannot act on gets worked around. */
    expect(() => greenmailPorts()).toThrow(/GreenMail container of this checkout's own/);
  });

  it("takes both when both are given, and lets the SMTP host fall back to the IMAP host", () => {
    set("IMAP_PORT", "4143"); set("SMTP_PORT", "4025");
    set("IMAP_HOST", "10.0.0.9"); set("SMTP_HOST", undefined);
    expect(greenmailPorts()).toEqual({ imapHost: "10.0.0.9", imapPort: 4143, smtpHost: "10.0.0.9", smtpPort: 4025 });
    set("SMTP_HOST", "10.0.0.10");
    expect(greenmailPorts().smtpHost).toBe("10.0.0.10");
  });

  it("an SMTP port alone is not refused — that override is whole on its own", () => {
    set("IMAP_PORT", undefined); set("SMTP_PORT", "4025");
    expect(greenmailPorts()).toMatchObject({ imapPort: 3143, smtpPort: 4025 });
  });
});
