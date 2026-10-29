import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

vi.mock("react-native", () => ({ Keyboard: { addListener: () => ({ remove() {} }) }, Platform: { OS: "android" } }));
import { keyboardLift } from "../src/ui/keyboard-lift";
import { sheetRoom } from "../src/ui/sheet-bounds";

/**
 * THE READER AND ITS SHEETS ON A NARROW WINDOW. The composer's footer wraps rather than starting
 * off-screen; a sheet with a text field rises above the Android keyboard, which the platform's
 * keyboard-avoiding view does not do inside a modal drawn edge to edge; and the from-line gives the
 * address way first. There is no renderer here: the rules are driven and the components read for
 * applying them; the rig's frames are the acceptance.
 */

const read = (rel: string) => withoutComments(readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8"));
const ACTIONS = read("src/ui/MessageActions.tsx");
const SHEET = read("src/ui/Sheet.tsx");
const READER = read("src/ui/MessageReader.tsx");

describe("a sheet rises above the keyboard", () => {
  it("on Android by the keyboard's height; on iOS the keyboard-avoiding view does it", () => {
    expect(keyboardLift("android", 812)).toBe(812);
    expect(keyboardLift("android", -4)).toBe(0);
    expect(keyboardLift("ios", 812)).toBe(0);
    expect(sheetRoom(0, 812), "the room pads its foot by the lift").toMatchObject({ justifyContent: "flex-end", paddingBottom: 812 });
  });
  it("the composer and the keyboard sheets both pad their foot by it", () => {
    for (const [name, src] of [["MessageActions", ACTIONS], ["Sheet", SHEET]] as const) {
      expect(src, `${name} reads no lift`).toContain("const keyboardLift = useKeyboardLift();");
      expect(src, `${name} does not pad by it`).toContain("const room = useSheetRoom(keyboardLift);");
      expect(src, `${name} does not lay its sheet in the room`).toContain("style={room}");
    }
    expect(SHEET, "the shared room drops the lift").toContain("return sheetRoom(insets.top, keyboardLift, ");
  });
});

describe("the composer's footer wraps", () => {
  it("the row wraps, Cancel leads its own line and the send verbs stay right-aligned", () => {
    expect(ACTIONS).toContain('<View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", columnGap: 8, rowGap: 8 }}>');
    expect(ACTIONS).toContain('onPress={closeComposer} style={{ marginRight: "auto" }} />');
  });
});

describe("the from-line keeps the name", () => {
  it("the name does not shrink, the address yields, and below 360 dp the address takes its own line", () => {
    const at = READER.indexOf("{m.from.name}");
    const name = READER.slice(READER.lastIndexOf("<Txt", at), at);
    expect(name).toContain('flexShrink: 0, maxWidth: "60%"');
    const addr = READER.slice(READER.lastIndexOf("<Txt", READER.indexOf("{m.from.address}")), READER.indexOf("{m.from.address}"));
    expect(addr).toContain("flexShrink: 1");
    expect(READER).toContain("export const FROM_LINE_SPLIT_DP = 360;");
    expect(READER).toContain("const narrowFrom = useWindowDimensions().width < FROM_LINE_SPLIT_DP;");
  });
});
