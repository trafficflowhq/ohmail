import { expect, it } from "vitest";
import { folderCommandProblem } from "../src/folder/index.js";

it("validates before dispatch and keeps a failed create's name taken until dismissed", () => {
  const failed = {
    id: "pending",
    mailboxId: "work",
    name: "Projects",
    op: { kind: "create", error: "exists" },
  };
  expect(folderCommandProblem([], "work", "Projects/%")).toBe("folderNameChars");
  expect(folderCommandProblem([], "work", "Projects/ Planning")).toBe("folderNameSpaces");
  expect(folderCommandProblem([failed], "work", "Projects")).toBe("folderNameTaken");
  expect(folderCommandProblem([failed], "home", "Projects")).toBeNull();
  expect(folderCommandProblem([], "work", "Projects")).toBeNull();
});
