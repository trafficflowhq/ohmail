import { MIRROR_ENTITY_TYPES } from "@ohmail/client-engine";
import { describe, expect, it, vi } from "vitest";
import { nativePhoneDiagnosticDeps } from "../src/engine/diagnostics-native";
import { PHONE_DIAGNOSTIC_FILE_NAME } from "../src/engine/diagnostics";
import { phoneDiagnosticsOf } from "../src/shell/phone-diagnostics-native";
import { createPhoneDiagnosticsDoor } from "../src/shell/phone-diagnostics";

vi.mock("../src/engine/diagnostics-native", () => ({
  nativePhoneDiagnosticDeps: vi.fn(),
  shareDiagnosticFile: vi.fn(),
}));

const where = "file:///fixture/diagnostics.json";
const fileName = "diagnostics.json";
const signal = () => new AbortController().signal;

function fixture() {
  let live = true;
  const write = vi.fn(async (_counts: readonly number[], allowed: () => boolean): Promise<string | null> => allowed() ? where : null);
  const share = vi.fn(async (_uri: string, allowed: () => boolean) => allowed());
  const door = createPhoneDiagnosticsDoor({ live: () => live, fileName, write, share });
  return { ...door, write, share, leave: () => { live = false; } };
}

describe("the phone's diagnostic file door", () => {
  it("only shares a confirmed native write and answers with the file name", async () => {
    const { answer, beginPage, write, share } = fixture();
    await expect(answer({ do: "share" }, signal())).resolves.toEqual({ refused: "notReady" });
    expect(share).not.toHaveBeenCalled();

    await expect(answer({ do: "write", counts: [2, 3] }, signal())).resolves.toEqual({ fileName });
    expect(write.mock.calls[0]?.[0]).toEqual([2, 3]);
    expect(share).not.toHaveBeenCalled();

    await expect(answer({ do: "share" }, signal())).resolves.toEqual({ shared: true });
    expect(share.mock.calls[0]?.[0]).toBe(where);
    beginPage();
    await expect(answer({ do: "share" }, signal())).resolves.toEqual({ refused: "notReady" });
    expect(share).toHaveBeenCalledTimes(1);
  });

  it("keeps the file for a retry when native cancels or cannot open the share sheet", async () => {
    const { answer, write, share } = fixture();
    share.mockResolvedValueOnce(false);
    await answer({ do: "write", counts: [1] }, signal());
    await expect(answer({ do: "share" }, signal())).resolves.toEqual({ shared: false });
    await expect(answer({ do: "share" }, signal())).resolves.toEqual({ shared: true });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("does not start or finish acting for an old page during a scope change", async () => {
    const { answer, beginPage, write, share, leave } = fixture();
    let commit!: () => void;
    write.mockImplementationOnce((_counts, allowed) => new Promise((resolve) => {
      commit = () => resolve(allowed() ? where : null);
    }));

    const pending = answer({ do: "write", counts: [3] }, signal());
    beginPage();
    commit();
    await expect(pending).resolves.toEqual({ refused: "cancelled" });
    await expect(answer({ do: "share" }, signal())).resolves.toEqual({ refused: "notReady" });

    await answer({ do: "write", counts: [4] }, signal());
    leave();
    await expect(answer({ do: "share" }, signal())).resolves.toEqual({ refused: "cancelled" });
    expect(share).not.toHaveBeenCalled();
  });

  it("serializes native writes and sharing", async () => {
    const { answer, write } = fixture();
    let confirm!: () => void;
    write.mockImplementationOnce((_counts, allowed) => new Promise((resolve) => {
      confirm = () => resolve(allowed() ? where : null);
    }));

    const pending = answer({ do: "write", counts: [3] }, signal());
    await expect(answer({ do: "write", counts: [9] }, signal())).resolves.toEqual({ refused: "notReady" });
    await expect(answer({ do: "share" }, signal())).resolves.toEqual({ refused: "notReady" });
    confirm();
    await expect(pending).resolves.toEqual({ fileName });
    expect(write).toHaveBeenCalledTimes(1);
  });
});

it("Write withholds private-looking event fields and raw crash frames from the file bytes", async () => {
  const write = vi.fn(async (_text: string) => where);
  const outside = [
    "PrivatePhase", "PrivateCode", "PrivateClass", "PrivateFrame", "PrivateCause",
    "private_event", "private_service", "PrivateAccount", "PrivateMailbox", "PrivateCrashError",
  ];
  vi.mocked(nativePhoneDiagnosticDeps).mockReturnValue({
    kv: undefined,
    now: () => new Date("2026-11-21T12:00:00Z"),
    random16: () => new Uint8Array(16),
    platform: { os: "android", osVersion: 35 },
    build: { version: "2.0.0", commit: "dev" },
    lines: () => [
      JSON.stringify({
        service: "engine", event: "imap_connect_failed", attempt: 4, phase: outside[0],
        errorCode: outside[1], causeClass: outside[2], causeCode: "ETIMEDOUT", count: 12,
        mailboxId: outside[8], accountId: outside[7],
      }),
      JSON.stringify({
        service: "phone", event: "render_error_caught", surface: "reader",
        errorClass: "TypeError", frame: outside[3], causeCode: outside[4], phase: "reader",
      }),
      JSON.stringify({ service: outside[6], event: outside[5], attempt: 9 }),
      `${outside[9]}: private error`,
      `    at ${outside[3]} (private/file.js:1:2)`,
    ],
    write,
  });
  const door = phoneDiagnosticsOf(() => true, async () => null);
  const result = await door.answer({ do: "write", counts: MIRROR_ENTITY_TYPES.map(() => 0) }, signal());
  expect(result).toEqual({ fileName: PHONE_DIAGNOSTIC_FILE_NAME });
  expect(write).toHaveBeenCalledOnce();
  const bytes = write.mock.calls[0]![0];
  expect(outside.filter((value) => bytes.includes(value))).toEqual([]);
  const sections = JSON.parse(bytes).sections;
  expect(sections.find((s: { k: string }) => s.k === "log").lines).toContainEqual(expect.objectContaining({
    event: "imap_connect_failed", values: { attempt: 4 }, causeCode: "timeout", labels: {},
    mailbox: expect.stringMatching(/^[0-9a-f]{16}$/), account: expect.stringMatching(/^[0-9a-f]{16}$/),
  }));
  expect(sections.find((s: { k: string }) => s.k === "log").lines).toContainEqual(expect.objectContaining({
    event: "render_error_caught", labels: { surface: "reader" },
  }));
  expect(sections.find((s: { k: string }) => s.k === "crash").records).toContainEqual(expect.objectContaining({
    event: "render_error_caught", errorClass: "TypeError", surface: "reader", frame: null,
  }));
});
