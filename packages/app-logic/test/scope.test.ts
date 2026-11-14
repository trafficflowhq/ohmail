/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

import {
  DEMO_STORAGE_OWNER,
  scopeMayMount,
  scopeSuffix,
  usePinnedScope,
  type StorageScope,
} from "@ohmail/app-logic/storage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("a place mounts only under a scope that names somebody", () => {
  it("refuses no scope, an empty one, the two words keys spell for nobody and a shape no id has", () => {
    const refused = [null, undefined, "", "local", "anon", "a:b", "has space", "x".repeat(129)];
    expect(refused.filter((s) => scopeMayMount(s as StorageScope))).toEqual([]);
  });

  it("admits an account's or a mailbox's id, and the demo's own word", () => {
    const admitted = ["acc-1", "acct_confirm_1", "mbx-2", "x".repeat(128), DEMO_STORAGE_OWNER];
    expect(admitted.filter((s) => !scopeMayMount(s))).toEqual([]);
  });

  it("admits a dot, as the session's marker's own shape does", () => {
    expect(scopeMayMount("mbx.1")).toBe(true);
  });
});

describe("a stored key's scope is handed in, never looked up", () => {
  it("spells a scope as itself and no scope as local", () => {
    expect(scopeSuffix("acc-1")).toBe("acc-1");
    expect(scopeSuffix(null)).toBe("local");
  });

  it("refuses a scope nobody handed in, and an empty one, rather than reading either as local", () => {
    expect(() => scopeSuffix(undefined as unknown as StorageScope)).toThrow(/no storage scope/);
    expect(() => scopeSuffix("")).toThrow(/empty storage scope/);
  });
});

describe("a mounted hook keeps the scope of its first render", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  const seen: StorageScope[] = [];
  function Probe({ scope }: { scope: StorageScope }): null {
    seen.push(usePinnedScope(scope));
    return null;
  }
  class Catch extends React.Component<
    { children?: React.ReactNode; onError: (e: Error) => void },
    { failed: boolean }
  > {
    state = { failed: false };
    static getDerivedStateFromError(): { failed: boolean } {
      return { failed: true };
    }
    componentDidCatch(e: Error): void {
      this.props.onError(e);
    }
    render(): React.ReactNode {
      return this.state.failed ? null : this.props.children;
    }
  }
  const mount = (scope: StorageScope, onError: (e: Error) => void): void => {
    act(() => root!.render(React.createElement(Catch, { onError }, React.createElement(Probe, { scope }))));
  };

  it("answers the same scope on every render it is handed the same one", () => {
    host = document.createElement("div");
    root = createRoot(host);
    seen.length = 0;
    const errors: Error[] = [];
    mount("acc-1", (e) => errors.push(e));
    mount("acc-1", (e) => errors.push(e));
    expect(errors).toEqual([]);
    expect(seen.every((s) => s === "acc-1")).toBe(true);
  });

  it("throws in render when a later render hands another scope, null included", () => {
    for (const next of ["acc-2", null] as const) {
      host = document.createElement("div");
      root = createRoot(host);
      const errors: Error[] = [];
      const quiet = console.error;
      console.error = () => {};
      try {
        mount("acc-1", (e) => errors.push(e));
        mount(next, (e) => errors.push(e));
      } finally {
        console.error = quiet;
      }
      expect(errors.map((e) => e.message)).toEqual([
        "ohmail: a mounted hook was handed another storage scope",
      ]);
      act(() => root!.unmount());
      root = null;
      host.remove();
      host = null;
    }
  });

  it("throws at the first render when no scope is handed in", () => {
    host = document.createElement("div");
    root = createRoot(host);
    const errors: Error[] = [];
    const quiet = console.error;
    console.error = () => {};
    try {
      mount(undefined as unknown as StorageScope, (e) => errors.push(e));
    } finally {
      console.error = quiet;
    }
    expect(errors.map((e) => e.message)).toEqual([
      "ohmail: a stored key was asked for with no storage scope",
    ]);
  });
});
