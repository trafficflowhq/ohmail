import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => fs.readFileSync(path.join(APP, rel), "utf8");

/**
 * THE WIRING BETWEEN TWO APPLICATIONS, PINNED BY SOURCE.
 *
 * Same argument as the suggest control's in `desktop-shell.test.ts`: the behaviour is driven where
 * it can be driven — above, and in the shared client's own suite over the pane — but the edge
 * between `DesktopGate` and the shared shell has no single place to render, and deleting it leaves
 * every suite in both applications green.
 */
describe("the wiring, pinned by source", () => {
  const frame = read("src/DesktopFrame.tsx");
  const shell = read("../webapp/app/(product)/mailbox/web-supplies.tsx");
  const mounted = (rel: string) => read(`../../packages/app/src/${rel}`);

  it("the shared shell admits a host transport as a second way to be supported", () => {
    const host = read("src/host-contract.ts");
    expect(read("src/doors.ts")).toContain('status?.mode === "cloud" && session === "live" ? "cloud" : null');
    expect(host).toContain('away === "cloud" ? "service"');
    expect(frame).toContain("awayDoor === null ? null : awayFeedOver(awayOverBridge)");
    expect(frame).toContain("away: awayFeed?.wire ?? awayOverBridge");
    expect(frame).toContain("away: AwaySettings");
    expect(mounted("host/panes.ts")).toContain("away: wires.away !== NONE && capabilities.awayRunsOn !== NONE");
    const settings = mounted("settings/away/AwaySettings.tsx");
    expect(settings).toContain("const wire = host.wires.away");
    expect(settings).toContain("const runsOn = host.capabilities.awayRunsOn");
    expect(settings).toContain("wire.save(");
  });

  it("the shared files name none of the transport — no bridge, no Tauri, no engine", () => {
    expect(shell).not.toMatch(/bridgeFetch|__TAURI/);
    for (const file of ["AwayPane.tsx", "AwaySettings.tsx", "notice.ts", "model.ts"]) {
      expect(mounted(`settings/away/${file}`), file).not.toMatch(/bridgeFetch|bridge-fetch|__TAURI|@tauri-apps|@ohmail\/client-engine/);
    }
    expect(frame).toMatch(/import \{ AwaySettings, awayFeedOver, useAwayNotice \} from "@ohmail\/app\/settings\/away"/);
    expect(fs.existsSync(path.join(APP, "src", "DesktopAway.tsx"))).toBe(false);
    expect(read("src/local-away.ts")).toMatch(/from "\.\/bridge-fetch\.js"/);
  });
});
