/**
 * What the ohcal app mounts: the calendar's places, registered here when they exist. None is yet, so the frame stands
 * with its dock and nothing in it; the calendar app never mounts a mail place.
 */
import type { ShellConfig } from "../../src/shell/bridge-kinds";
import type { Bridge } from "./bridge";
import { nothingMounted, type Mounted } from "./frame-supplies";

export default function mounted(_bridge: Bridge, _config: Pick<ShellConfig, "scope" | "setting">): Mounted {
  return nothingMounted();
}
