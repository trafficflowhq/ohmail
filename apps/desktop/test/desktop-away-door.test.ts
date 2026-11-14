import { describe, expect, it } from "vitest";

import { awayDoorFor } from "../src/doors.js";
import { AWAY_PATH } from "../src/local-away.js";
import type { EngineStatus } from "../src/bridge-fetch.js";

/**
 * THE AWAY RESPONDER'S ROUTE AND ITS DOOR RULE, without a window around them.
 *
 * Moved word for word out of `desktop-away.test.tsx` (2026-11-18, the switch to the new shell): these cases assert the
 * desktop's own route and door rule and draw no window, so they no longer stand beside the cases that draw
 * today's `AwayResponderRow` (those wait for the away pane's mount in the new Settings).
 */

describe("the away responder on the hosted door", () => {
  /**
   * THE ROUTE, AS A LITERAL. Everything below addresses `AWAY_PATH`, which makes every one of those
   * assertions true of whatever string this module happens to hold — a wrong path passes them all.
   * (Checked: renaming it to `/account/away` left all nine green.) It is the hosted API's own
   * endpoint, and it is load-bearing twice over: the engine's cloud-mode read table deliberately
   * does NOT list it, which is the whole reason a hosted install's request is FORWARDED to the
   * account rather than answered from the local mirror — and a locally-answered PUT would store
   * an away responder no worker anywhere reads.
   */
  it("is the hosted API's own endpoint, spelled exactly", () => {
    expect(AWAY_PATH).toBe("/away-responder");
  });
});

/** WHICH DOOR MAY CONFIGURE ONE — the decision on its own, without a window around it. */
describe("the door that may configure an away responder", () => {
  const serving = (over: Partial<EngineStatus>): EngineStatus => ({
    state: "serving", mailboxId: "mbx-1", credentialState: "ready", ...over,
  });

  it("is the hosted door, signed in", () => {
    expect(awayDoorFor(serving({ mode: "cloud" }), "live")).toBe("cloud");
  });

  /**
   * AND "SIGNED IN" IS THE ENGINE'S LIVE ANSWER, NOT THE LAUNCH FRAME'S.
   *
   * This block used to drive the door off `credentialState`, which the shell copies out of the
   * engine's one-shot `ready` frame and never rewrites. On the cloud door a sign-in happens IN
   * PLACE against the running engine, so an install that started pre-auth kept reporting `absent`
   * for the life of the process — and this pane, with five others, was missing on a window whose
   * mail was arriving. The field is asserted here in every shape it can take, all with a live
   * session, precisely because none of them may decide any more.
   */
  it("…and the launch frame's credential word no longer decides it", () => {
    for (const credentialState of ["absent", "unreadable", "unknown", undefined] as const) {
      expect(
        awayDoorFor(serving({ mode: "cloud", credentialState }), "live"),
        `a live session with credentialState=${String(credentialState)} lost the responder`,
      ).toBe("cloud");
    }
  });

  /**
   * THE STANDALONE ARM, which this block used to assert was permanently `null`.
   *
   * It said: *"is NEVER the standalone door — the sender lives in the hosted worker… Nothing on
   * this door sends the reply, so a control here would store a configuration that answers
   * nobody."* True when written, and false since the pass moved into `@trafficflow/services` —
   * which the desktop engine bundles — and began running in the sidecar's drain with this
   * machine's own SMTP dial.
   *
   * The promise on that door is genuinely smaller (replies go out while the app is open) and the
   * pane says so; that is a sentence, not a reason to withhold the control. It is asserted for
   * BOTH credential states because the credential is not what gates it: the responder is
   * configuration, and hiding the setting on the launch where somebody is mid-setup is the
   * failure `profileImportDoorFor` already argues against.
   */
  it("is ALSO the standalone door — the engine on this machine sends while the window is open", () => {
    // The hosted session's state is irrelevant on this door and is asserted so: a standalone
    // install has no session to be in any of them, and reading one would be a hosted fact
    // deciding a local pane.
    expect(awayDoorFor(serving({ mode: "local" }), "unknown")).toBe("local");
    expect(awayDoorFor(serving({ mode: "local", credentialState: "ready" }), "out")).toBe("local");
    expect(awayDoorFor(serving({ mode: "local", credentialState: "absent" }), "live")).toBe("local");
  });

  it("distinguishes the two live doors rather than answering a boolean", () => {
    // The caller needs WHICH door: `"local"` also selects the "while ohmail is open on this
    // computer" note, and a boolean would put that sentence on the hosted pane where it is false.
    expect(awayDoorFor(serving({ mode: "local" }), "live"))
      .not.toBe(awayDoorFor(serving({ mode: "cloud" }), "live"));
  });

  it("is nothing while there is no hosted session, no door, or no answer from the shell", () => {
    // `out` is signed out or expired; `unknown` is "the engine has not been asked yet, or there is
    // no bridge to ask over" — and a settings pane whose only state is an error it cannot fix
    // from inside itself is worse than no pane.
    expect(awayDoorFor(serving({ mode: "cloud" }), "out")).toBeNull();
    expect(awayDoorFor(serving({ mode: "cloud" }), "unknown")).toBeNull();
    expect(awayDoorFor(serving({ mode: "cloud", credentialState: "ready" }), "out")).toBeNull();
    expect(awayDoorFor(serving({ mode: null }), "live")).toBeNull();
    expect(awayDoorFor(null, "live")).toBeNull();
  });
});
