/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, Field, InfoMark, Menu, Slot } from "../../src/base/index.js";
import { SettingLine, SettingsHead, SettingsSheet } from "../../src/mail/index.js";

afterEach(cleanup);

describe("SettingLine", () => {
  it("with a switch is one switch, named by the line", () => {
    render(<SettingLine label="Load images in messages" toggle={{ on: true }} />);
    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(1);
    expect(switches[0]?.getAttribute("aria-label")).toBe("Load images in messages");
    expect(switches[0]?.getAttribute("aria-checked")).toBe("true");
  });

  it("turns its switch once from a press on its name, and once from a press on the switch", () => {
    const onChange = vi.fn();
    render(<SettingLine label="Block tracking pixels" toggle={{ on: false, onChange }} />);
    fireEvent.click(screen.getByText("Block tracking pixels"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("switch", { name: "Block tracking pixels" }));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(true);
  });

  it("that is off has its switch disabled, and a press beside it does nothing", () => {
    const onChange = vi.fn();
    render(<SettingLine label="Draft reply" toggle={{ on: false, onChange }} off />);
    expect(screen.getByRole("switch", { name: "Draft reply" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByText("Draft reply"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("takes a press beside a slot's control as the control's own", () => {
    const onPress = vi.fn();
    render(
      <SettingLine label="Where the model runs" onPress={onPress}>
        <span>ohmail Cloud</span>
      </SettingLine>,
    );
    fireEvent.click(screen.getByText("Where the model runs"));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("leaves a press on a button of its own to that button", () => {
    const onLine = vi.fn();
    const onButton = vi.fn();
    render(
      <SettingLine label="Default mail app" value="Another app" onPress={onLine}>
        <Button kind="quiet" size="s" onPress={onButton}>
          Make default
        </Button>
      </SettingLine>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Make default" }));
    expect(onButton).toHaveBeenCalledTimes(1);
    expect(onLine).not.toHaveBeenCalled();
    expect(screen.getByText("Another app")).toBeTruthy();
  });

  it("leaves a press inside a card it holds to the card", () => {
    const onChange = vi.fn();
    function Line() {
      const mark = useRef<HTMLButtonElement | null>(null);
      return (
        <SettingLine
          label="Load images in messages"
          toggle={{ on: false, onChange }}
          info={
            <>
              <InfoMark ref={mark} label="About images" expanded onPress={() => undefined} />
              <Menu open onClose={() => undefined} anchor={mark} label="About images" kind="card">
                <p>Images can tell the sender you opened the letter.</p>
              </Menu>
            </>
          }
        />
      );
    }
    render(<Line />);
    fireEvent.click(screen.getByText("Images can tell the sender you opened the letter."));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("switch", { name: "Load images in messages" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("leaves a press on its open menu's title to the menu", () => {
    const onLine = vi.fn();
    function Line() {
      const [open, setOpen] = useState(true);
      const slot = useRef<HTMLButtonElement | null>(null);
      return (
        <SettingLine label="Where the model runs" onPress={onLine}>
          <Slot ref={slot} expanded={open} onPress={() => setOpen(true)}>
            ohmail Cloud
          </Slot>
          <Menu
            open={open}
            onClose={() => setOpen(false)}
            anchor={slot}
            label="Where"
            title="Where the model runs"
          >
            <p>Pick one.</p>
          </Menu>
        </SettingLine>
      );
    }
    render(<Line />);
    fireEvent.click(screen.getByRole("heading", { name: "Where the model runs" }));
    expect(onLine).not.toHaveBeenCalled();
  });

  it("leaves a press on a field's label to the field", () => {
    const onLine = vi.fn();
    render(
      <SettingLine label="Signature" onPress={onLine}>
        <Field label="Name on the signature" value="Mila" onChange={() => undefined} />
      </SettingLine>,
    );
    fireEvent.click(screen.getByText("Name on the signature"));
    expect(onLine).not.toHaveBeenCalled();
  });
});

describe("SettingsSheet", () => {
  it("names itself with a level-2 heading", () => {
    render(
      <SettingsSheet title="Appearance">
        <SettingLine label="Theme" value="Light" />
      </SettingsSheet>,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Appearance" })).toBeTruthy();
  });

  it("says what it wants with its word and its acts", () => {
    const onPlans = vi.fn();
    render(
      <SettingsSheet
        wants={{
          word: "0 credits",
          line: "Suggestions wait for new ones.",
          acts: (
            <Button kind="two" size="s" onPress={onPlans}>
              Plans
            </Button>
          ),
        }}
      >
        <SettingLine label="Use AI for suggestions and drafts" toggle={{ on: true }} />
      </SettingsSheet>,
    );
    expect(document.body.textContent).toContain("0 credits Suggestions wait for new ones.");
    fireEvent.click(screen.getByRole("button", { name: "Plans" }));
    expect(onPlans).toHaveBeenCalledTimes(1);
  });

  it("has no head without a title", () => {
    render(
      <SettingsSheet>
        <SettingLine label="Language" value="English" />
      </SettingsSheet>,
    );
    expect(screen.queryByRole("heading")).toBeNull();
  });
});

describe("SettingsHead", () => {
  it("is the pane's level-1 heading, with its count beside it", () => {
    render(<SettingsHead title="Devices" count="3" />);
    const heading = screen.getByRole("heading", { level: 1, name: "Devices" });
    expect(heading).toBeTruthy();
    expect(heading.closest("header")?.textContent).toContain("3");
  });
});
