/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, Field, InfoMark, Menu, Seg, Slot } from "../../src/base/index.js";
import {
  RuleLine,
  SettingArea,
  SettingFilter,
  SettingLine,
  SettingNote,
  SettingsHead,
  SettingsSheet,
  TagLine,
} from "../../src/mail/index.js";

afterEach(cleanup);

describe("SettingLine", () => {
  it("is a group named by its label alone, holding its value and its control", () => {
    render(
      <SettingLine label="Build" tag="Web" value="2.0.0 (web build)">
        <Button kind="quiet" size="s" onPress={() => {}}>
          Copy
        </Button>
      </SettingLine>,
    );
    const line = screen.getByRole("group", { name: "Build" });
    expect(line.textContent).toContain("2.0.0 (web build)");
    expect(line.contains(screen.getByRole("button", { name: "Copy" }))).toBe(true);
  });

  it("with a switch is a group of its name holding the one switch of that name", () => {
    render(<SettingLine label="Notify me on this device" toggle={{ on: false }} />);
    const line = screen.getByRole("group", { name: "Notify me on this device" });
    expect(line.contains(screen.getByRole("switch", { name: "Notify me on this device" }))).toBe(true);
  });

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

describe("SettingNote", () => {
  it("is a paragraph of its words, with no sign", () => {
    render(<SettingNote>Only Screen out and Spam, at 90% or more.</SettingNote>);
    const note = screen.getByText("Only Screen out and Spam, at 90% or more.").closest("p");
    expect(note).toBeTruthy();
    expect(note?.querySelector("svg")).toBeNull();
  });

  it("with a warning leads with the sign, which a screen reader does not hear", () => {
    render(<SettingNote warn>You have no unused recovery codes.</SettingNote>);
    const note = screen.getByText("You have no unused recovery codes.").closest("p");
    expect(note?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(note?.textContent).toBe("You have no unused recovery codes.");
  });
});

describe("SettingArea", () => {
  it("is a field of several lines named by the label over it, which writes back what is typed", () => {
    const onChange = vi.fn();
    render(
      <SettingArea
        label="In your words, what belongs in your Ohbox"
        value="Real people"
        onChange={onChange}
      />,
    );
    const field = screen.getByRole("textbox", { name: "In your words, what belongs in your Ohbox" });
    expect(field.tagName).toBe("TEXTAREA");
    expect(field.getAttribute("rows")).toBe("3");
    fireEvent.change(field, { target: { value: "Real people only" } });
    expect(onChange).toHaveBeenCalledWith("Real people only");
  });

  it("says its refusal with the field, which is then invalid", () => {
    render(<SettingArea label="Message" value="" onChange={() => {}} refusal="Add a message first." />);
    const field = screen.getByRole("textbox", { name: "Message" });
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(field.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Add a message first.",
    );
  });
});

describe("RuleLine", () => {
  const goes = (place: string) => (
    <>
      goes to <Slot label={`Goes to ${place}`}>{place}</Slot>
    </>
  );

  it("says its rule as a sentence: who, where their mail goes, where it came from", () => {
    render(
      <RuleLine who="makersfest.example" goes={goes("Ohbox")} origin="Whole domain · Screener decision" />,
    );
    const sentence = screen.getByText("makersfest.example", { exact: false }).closest("p");
    expect(sentence?.textContent).toBe("makersfest.example goes to OhboxWhole domain · Screener decision");
    expect(screen.getByRole("button", { name: "Goes to Ohbox" })).toBeTruthy();
  });

  it("leads a sender's rule with their circle, a button named by them that opens their card at itself", () => {
    const onContact = vi.fn();
    render(
      <RuleLine
        who="giulia@terracotta-milano.example"
        person={{
          name: "Giulia Ferrari",
          address: "giulia@terracotta-milano.example",
          label: "Giulia Ferrari",
          onContact,
        }}
        goes={goes("Ohbox")}
        act={
          <Button kind="quiet" size="s">
            Revoke
          </Button>
        }
      />,
    );
    const circle = screen.getByRole("button", { name: "Giulia Ferrari" });
    fireEvent.click(circle);
    expect(onContact).toHaveBeenCalledWith(circle);
    expect(screen.getByRole("button", { name: "Revoke" })).toBeTruthy();
  });

  it("leads a domain's rule with the at sign, which is no button", () => {
    render(<RuleLine who="lichtgrat.example" goes={goes("Ohbox")} />);
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Goes to Ohbox"]);
  });
});

describe("TagLine", () => {
  it("at rest is a group named by the tag, its colour a button that opens the colours at itself, its two words beside its count", () => {
    const colours = vi.fn();
    render(
      <TagLine
        hue={150}
        name="Pottery Project"
        colour={{ label: "Colour of Pottery Project", onPress: colours, expanded: false }}
        value="4 messages"
        acts={
          <>
            <Button kind="quiet" size="s">
              Rename
            </Button>
            <Button kind="quiet" size="s">
              Delete
            </Button>
          </>
        }
      />,
    );
    const line = screen.getByRole("group", { name: "Pottery Project" });
    expect(line.textContent).toContain("4 messages");
    const colour = screen.getByRole("button", { name: "Colour of Pottery Project" });
    expect(colour.getAttribute("aria-haspopup")).toBe("menu");
    expect(colour.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(colour);
    expect(colours).toHaveBeenCalledWith(colour);
    for (const word of ["Rename", "Delete"])
      expect(line.contains(screen.getByRole("button", { name: word }))).toBe(true);
  });

  it("written is its name's field, one line named by its label, which writes back, goes on at Enter and back at Esc", () => {
    const typed = vi.fn();
    const enter = vi.fn();
    const escape = vi.fn();
    render(
      <TagLine
        hue={150}
        field={{ label: "Name", value: "Pottery Project", onChange: typed, onEnter: enter, onEscape: escape }}
        acts={
          <Button kind="two" size="s">
            Save
          </Button>
        }
      />,
    );
    const field = screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
    expect(field.tagName).toBe("INPUT");
    expect(field.value).toBe("Pottery Project");
    fireEvent.change(field, { target: { value: "Pottery" } });
    expect(typed).toHaveBeenCalledWith("Pottery");
    fireEvent.keyDown(field, { key: "Enter" });
    /* Enter that ends a word being composed is the word's; Enter on the line's own button is the button's. */
    fireEvent.keyDown(field, { key: "Enter", isComposing: true });
    fireEvent.keyDown(screen.getByRole("button", { name: "Save" }), { key: "Enter" });
    fireEvent.keyDown(field, { key: "Escape" });
    expect([enter.mock.calls.length, escape.mock.calls.length]).toEqual([1, 1]);
    /* Written, its dot is not a button: the colour is chosen at rest. */
    expect(screen.queryByRole("button", { name: /Colour/ })).toBeNull();
  });

  it("keeps Esc from what it stands in, hands the app its field, and a colour button told nothing says its colours are shut", () => {
    const heard = vi.fn();
    const node = { current: null as HTMLInputElement | null };
    render(
      <div onKeyDown={heard}>
        <TagLine
          hue={150}
          field={{ label: "Name", value: "Pottery", onChange: () => {}, onEscape: () => {}, ref: node }}
        />
        <TagLine hue={78} name="Paperwork" colour={{ label: "Colour of Paperwork" }} />
      </div>,
    );
    expect(node.current).toBe(screen.getByRole("textbox", { name: "Name" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Name" }), { key: "Escape" });
    expect(heard).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Name" }), { key: "a" });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Colour of Paperwork" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("says its refusal with its field, which is then invalid", () => {
    render(
      <TagLine
        hue={150}
        field={{ label: "New tag", value: "Paperwork", placeholder: "Name a new tag", onChange: () => {} }}
        refusal="You already have “Paperwork”."
        acts={
          <Button kind="two" size="s">
            Add
          </Button>
        }
      />,
    );
    const field = screen.getByRole("textbox", { name: "New tag" });
    expect(field.getAttribute("aria-invalid")).toBe("true");
    const said = document.getElementById(field.getAttribute("aria-describedby")!.split(" ")[0]!);
    expect(said?.textContent).toBe("You already have “Paperwork”.");
    /* Said when it appears: the keys stay in the field, which would say it only when they come to it. */
    expect(said?.closest("[aria-live]")?.getAttribute("aria-live")).toBe("polite");
  });
});

describe("Field, bare with a sign (a list's search)", () => {
  it("is named by its label alone, draws no label, and its sign is not heard", () => {
    render(
      <Field
        label="Search by sender or domain"
        placeholder="Search by sender or domain"
        value=""
        onChange={() => {}}
        bare
        sign="search"
      />,
    );
    const field = screen.getByRole("textbox", { name: "Search by sender or domain" });
    expect(document.querySelector("label")).toBeNull();
    expect(field.parentElement?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("SettingFilter", () => {
  it("holds its control and, at its end, the word that acts on what is left", () => {
    render(
      <SettingFilter
        act={
          <Button kind="quiet" size="s">
            Revoke all 6 matching
          </Button>
        }
      >
        <Seg
          label="Files into"
          options={[
            { value: "all", label: "All" },
            { value: "news", label: "News" },
          ]}
          value="all"
        />
      </SettingFilter>,
    );
    const group = screen.getByRole("group", { name: "Files into" });
    const act = screen.getByRole("button", { name: "Revoke all 6 matching" });
    expect(group.compareDocumentPosition(act) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("says the word before a slot that names what it filters by", () => {
    render(
      <SettingFilter label="Files into">
        <Slot label="Files into">All</Slot>
      </SettingFilter>,
    );
    expect(screen.getByText("Files into")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Files into" })).toBeTruthy();
  });
});
