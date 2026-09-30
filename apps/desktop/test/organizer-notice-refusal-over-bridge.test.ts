/**
 * THE DESKTOP'S MARK READ CARRIES ITS REFUSAL'S STATUS (NOTICE-DISMISS-REFUSAL-IS-SILENT). The
 * shared notice says why a press did not land from the rejection's `status`; the bridge used to
 * reject with the status only in the message, so a 503 from an offline engine read as "try again".
 */
import { describe, expect, it, vi } from "vitest";

let answer = 200;
let code: string | null = null;
vi.mock("../src/bridge-fetch.js", async () => {
  const real = await vi.importActual<typeof import("../src/bridge-fetch.js")>("../src/bridge-fetch.js");
  return {
    ...real,
    bridgeFetch: async () => new Response(JSON.stringify(code ? { error: { code } } : {}), { status: answer }),
  };
});

const { organizerNoticeOverBridge } = await import("../src/local-organizer-notice.js");
const { refusalOf } = await import("../../webapp/app/shell/OrganizerNotice");

describe("the bridge's Mark read, answered", () => {
  /* 503 `offline_read_only` is the proxy's own answer while the install is offline (`cloud-auth.ts`). */
  const table: ReadonlyArray<[number, string | null, string]> = [
    [503, "offline_read_only", "noticeDismissOffline"],
    [402, "subscription_required", "noticeDismissInactive"],
    [503, null, "noticeDismissFailed"],
    [500, null, "noticeDismissFailed"],
  ];
  for (const [status, said, key] of table) {
    it(`${status} ${said ?? "(no code)"} rejects and the notice reads it as ${key}`, async () => {
      answer = status;
      code = said;
      const err = await organizerNoticeOverBridge("mb1").then(() => null, (e: unknown) => e);
      expect(err, "a refused stamp resolved as written").not.toBeNull();
      expect(refusalOf(err)).toBe(key);
    });
  }
  it("200 resolves", async () => {
    answer = 200;
    await expect(organizerNoticeOverBridge("mb1")).resolves.toBeUndefined();
  });
});
