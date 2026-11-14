import { describe, expect, it } from "vitest";
import { ALLOWED_TOOLS, validateSteps } from "../src/workflow-shapes.js";

/**
 * A workflow runs without the person pressing anything, so it may only do what can be undone and
 * sends nothing: file a letter, store a draft, add a knowledge entry. The storage gate refuses
 * any other step, so a workflow that would send or forward mail is never stored.
 */
describe("a workflow never sends mail", () => {
  it("a step that sends or forwards is refused, alone or among allowed steps", () => {
    for (const tool of ["send", "forward"]) {
      const alone = validateSteps([{ tool, args: { to: "someone@example.invalid" } }]);
      expect(alone.ok).toBe(false);
      if (!alone.ok) expect(alone.error).toContain(tool);

      const among = validateSteps([{ tool: "file_message", args: { folder: "Receipts" } }, { tool }]);
      expect(among.ok).toBe(false);
      if (!among.ok) expect(among.error).toContain(`step 1`);
    }
  });

  it("one step of each allowed tool is stored", () => {
    expect(validateSteps([{ tool: "file_message", args: { folder: "Receipts" } }])).toEqual({ ok: true });
    expect(validateSteps([{ tool: "draft_reply", args: {} }])).toEqual({ ok: true });
    expect(validateSteps([{ tool: "add_kb_entry" }])).toEqual({ ok: true });
  });

  it("the allowed tools are exactly the three that can be undone", () => {
    expect([...ALLOWED_TOOLS].sort()).toEqual(["add_kb_entry", "draft_reply", "file_message"]);
  });
});
