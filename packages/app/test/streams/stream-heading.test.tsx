/** @vitest-environment jsdom */
import { cleanup, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { issue, mountStreamFrame } from "./registered-world.js";

afterEach(cleanup);

/** The stream's name stands once, as the studio's News screen names its region: the head's visible title is the
 * place's only heading with its name, so the reading column draws no hidden heading of the same words. */
it("News says its name once: one heading named News over the stream", () => {
  mountStreamFrame({ at: "#/reads", letters: [issue("n1", 11), issue("n2", 12)] });
  screen.getByRole("region", { name: "News stream" });
  expect(screen.getAllByRole("heading", { name: "News" })).toHaveLength(1);
});
