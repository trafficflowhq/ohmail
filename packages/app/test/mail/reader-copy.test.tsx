/** @vitest-environment jsdom */
/**
 * THE HOST's CLIPBOARD REACHES THE READER (`useMailReaderParts`): the very function a host hands with its reader, and
 * `none` where it hands none, so that a person's card offers Copy only where a copy can be made (the switch's point 65).
 */
import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { DoorsContext, type Doors } from "@ohmail/app-logic/reader/doors";
import { NONE } from "../../src/host/index.js";
import { useMailReaderParts } from "../../src/mail/index.js";
import { bodyDouble } from "../reader/support/mail.js";

afterEach(cleanup);

const wrapper = ({ children }: { children: ReactNode }) => (
  <DoorsContext.Provider value={{ files: undefined, pictures: undefined } as unknown as Doors}>
    {children}
  </DoorsContext.Provider>
);

describe("the host's clipboard in the reader's parts", () => {
  it("is the function the host handed, by identity", () => {
    const copy = async (): Promise<boolean> => true;
    const { result } = renderHook(() => useMailReaderParts({ body: bodyDouble().body, look: NONE, copy }), {
      wrapper,
    });
    expect(result.current.copy).toBe(copy);
  });

  it("is none where the host hands none", () => {
    const { result } = renderHook(() => useMailReaderParts({ body: bodyDouble().body, look: NONE }), {
      wrapper,
    });
    expect(result.current.copy).toBe("none");
  });
});
