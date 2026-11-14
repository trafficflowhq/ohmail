import { describe, expect, it } from "vitest";
import {
  CONNECT_PURPOSES,
  PROBE_REASONS,
  PROBE_TLS_KINDS,
  SIGN_IN_FAILURES,
  SIGN_IN_PROVIDERS,
  SIGN_IN_REFUSALS,
} from "@ohmail/app-logic/mailboxes/connect/types";
import { NONE, type ConnectWire, type HostWires } from "../../../src/host/index.js";
import type { ConnectFormProps } from "../../../src/mailboxes/connect/contract.js";
import { NO_ENGINE, fakeHost } from "../../support/fake-host.js";

describe("the connect form's contract", () => {
  it("is a key of the host's wires, and a shell that connects nothing answers it `none`", () => {
    const { host } = fakeHost({ engine: NO_ENGINE, service: "ownComputer", scope: "a-scope" });
    const wires: HostWires = host.wires;
    expect(wires.connect).toBe(NONE);
    expect(Object.keys(wires)).toContain("connect");
    expect(Object.values(wires).every((wire) => wire === NONE)).toBe(true);
  });

  it("takes its wire as an input: a page with no frame hands the form what a shell's key would hold", () => {
    const door = {} as ConnectWire;
    const props: ConnectFormProps = {
      ask: { purpose: { kind: "join" }, onDone: () => undefined },
      door,
      factor: NONE,
    };
    expect(props.door).toBe(door);
    expect(props.factor).toBe(NONE);
  });

  it("names its closed lists: five purposes, one provider that signs in, and every reason a refusal may carry", () => {
    expect(CONNECT_PURPOSES).toEqual(["join", "firstRun", "add", "edit", "reconnect"]);
    expect(SIGN_IN_PROVIDERS).toEqual(["microsoft"]);
    expect(PROBE_REASONS).toHaveLength(7);
    expect(PROBE_TLS_KINDS).toHaveLength(7);
    expect(SIGN_IN_REFUSALS).toHaveLength(4);
    expect(SIGN_IN_FAILURES).toHaveLength(8);
  });
});
