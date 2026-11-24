/**
 * WHETHER TO MAKE THE SHELL'S VIEW AT ALL. A phone with no web view package, one that cannot name a
 * message's origin and frame, or one that cannot be sealed off the network past its network block,
 * gets one sentence and no view: there is no fallback that lets the page talk to native without the
 * platform saying who is talking, or reach an address of its choosing. Below the oldest major the
 * shell states, the same sentence: that number is a stand-in until phones are read, one constant to change.
 */
import type { WebViewReading } from "./shell-port";

export const OLDEST_WEBVIEW_MAJOR = 120;

export function webViewVerdict(reading: WebViewReading): "usable" | "unusable" {
  if (!reading.installed || !reading.listener || !reading.sealed) return "unusable";
  if (reading.major !== null && reading.major < OLDEST_WEBVIEW_MAJOR) return "unusable";
  return "usable";
}
