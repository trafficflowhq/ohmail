import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mounted = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
const read = (file: string) => mounted(`apps/webapp/app/${file}`);

describe("the shell wiring, pinned by source", () => {
  const frame = read("(product)/mailbox/CloudShell.tsx");
  const supplies = read("(product)/mailbox/web-supplies.tsx");
  const browserHost = read("(product)/mailbox/host.ts");
  const awayNotice = mounted("packages/app/src/settings/away/notice.ts");
  const awaySettings = mounted("packages/app/src/settings/away/AwaySettings.tsx");

  it("the shell's ONE away read is gated on the RESOLVED demo answer, not the hydration one", () => {
    expect(frame).toMatch(/const demoNow = useResolvedDemoMode\(\);[\s\S]*?if \(demoNow\) return <DemoFrame[\s\S]*?<SignedInFrame/);
    expect(frame).not.toContain("away.state(");
    expect(supplies).toContain("useEffect(() => awayFeed?.start(), [awayFeed])");
    expect(awayNotice).toMatch(/if \(started\) return;\s+started = true;\s+void wire.state\(\)/);
  });

  it("support is the hosted client OR a host's own wire — never a bare `apiConfigured()`", () => {
    expect(supplies).toMatch(/apiConfigured\(\) && scope !== null && scope === confirmed\s*\? awayFeedOver/);
    expect(browserHost).toContain('awayRunsOn: has.wires.away === NONE ? CANNOT.awayRunsOn : "service"');
    const desktop = mounted("apps/desktop/src/DesktopFrame.tsx");
    expect(desktop).toContain("awayDoor === null ? null : awayFeedOver(awayOverBridge)");
  });

  it("the Ohbox notice is gated on demo, support, and the responder actually being on", () => {
    expect(awayNotice).toContain("!demo && host.capabilities.awayRunsOn !== NONE");
    expect(awayNotice).toContain("if (!active || !row?.enabled) return [];");
    expect(awayNotice).toContain("awayEffectivePiles(row.piles");
    expect(awayNotice).toContain("audience: row.audience");
    expect(awayNotice).toContain("throttle: row.throttle");
  });

  it("the standingNotice block itself passes the scope to <AwayNotice>", () => {
    expect(supplies).toContain("...useAwayNotice(awayFeed)");
    const frameParts = mounted("packages/app/src/frame/FrameParts.tsx");
    expect(frameParts).toContain("<FeatureNotices features={host.features} notices={inner.notices}");
    expect(frameParts).toContain("<NoticeHost store={inner.notices}");
    expect(awayNotice).toMatch(/kind: "away",\s+title,/);
    expect(awayNotice).toMatch(/piles: new Intl.ListFormat[^\n]*\.format\(piles\)/);
  });

  it("`ohx-standing` names nothing any more — no element, no rule", () => {
    expect(awayNotice).not.toContain("ohx-standing");
    expect(mounted("packages/app/src/frame/NoticeHost.tsx")).not.toContain("ohx-standing");
    const css = read("app.css").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css, "a rule still styles the retired pane class").not.toMatch(/\.ohx-standing\s*[{,>:.\s]/);
  });

  it("the settings row reports its echo into the same held state, down the same wire", () => {
    const pane = read("(product)/mailbox/pane-parts.tsx");
    expect(pane.match(/away: AwaySettings\b/g)).toHaveLength(1);
    expect(supplies).toContain("away: awayFeed?.wire ?? NONE");
    expect(awaySettings).toContain("const wire = host.wires.away");
    expect(awaySettings).toContain("const runsOn = host.capabilities.awayRunsOn");
    expect(awaySettings).toContain("wire.save(");
    expect(awayNotice).toMatch(/const row = await transport.save\(next\);\s+remember\(row, \+\+serial\);/);
    expect(awayNotice).toContain("feed?.subscribe");
    expect(awayNotice).toContain("feed?.read");
  });

  it("the responder's pane is the injected node itself — absent ⇒ no pane and no nav entry", () => {
    const registration = mounted("packages/app/src/mail/panes.ts");
    const available = mounted("packages/app/src/host/panes.ts");
    const facts = mounted("packages/app/src/settings/facts.ts");
    expect(registration).toContain('away: parts.away === NONE ? NONE : paneOf("away", { Body: parts.away })');
    expect(available).toContain("away: wires.away !== NONE && capabilities.awayRunsOn !== NONE");
    expect(facts).toContain('away: fact("mail", "reply", said("away"), byHost("away"))');
    const pane = read("(product)/mailbox/pane-parts.tsx");
    expect(pane.match(/\baway: AwaySettings\b/g)).toHaveLength(1);
    expect(pane).not.toMatch(/screener:[^,}]*AwaySettings/);
  });
});
