/**
 * The places and stages of the app this page is built for. The shell build supplies the app-specific module.
 */
import type { Mounted } from "./frame-supplies";
import type { Bridge } from "./bridge";
import type { ShellConfig } from "../../src/shell/bridge-kinds";

declare function mounted(bridge: Bridge, config: Pick<ShellConfig, "scope" | "setting" | "os" | "build">): Mounted;
export default mounted;
