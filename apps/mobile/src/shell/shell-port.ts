/**
 * What the shell's native module offers the app's native side, as types: the seam the node suite
 * drives with doubles. `shell-native.ts` is the one file that reaches the real module.
 */
import type { ComponentType, Ref } from "react";
import type { ViewProps } from "react-native";

/** Whether this phone's web view can carry the shell, as the native side read it. */
export interface WebViewReading {
  readonly installed: boolean;
  /** The web view package's major version, or null where it could not be read (iOS: the system's). */
  readonly major: number | null;
  /** It names a message's origin and frame. Without it no shell view is made. */
  readonly listener: boolean;
  /**
   * It takes the seals the network block does not give: a proxy that sends nothing anywhere, and a script before the
   * page's own (no peer connection). Without them no shell view is made.
   */
  readonly sealed: boolean;
}

/** One row of the queue as the native keeper holds it. */
export interface NativeKeptRow {
  readonly type: string;
  readonly id: string;
  readonly json: string;
}

export interface ShellNative {
  webViewCheck(): WebViewReading;
  /** The shell's counts, by name. Numbers only. */
  stats(): Record<string, number>;
  setFamilies(prefixes: readonly string[]): Promise<boolean>;
  keeperScopes(): Promise<string[]>;
  prepareCalendarKeeper(): Promise<boolean>;
  fenceCalendarWipe(scope: string): Promise<"empty" | "pending" | "unknown">;
  releaseCalendarWipe(scope: string): Promise<void>;
  /** Removes one scope's keeper; true when a read-back finds none of its files. */
  keeperForget(scope: string): Promise<boolean>;
  keeperErase(scope: string): Promise<boolean>;
  releaseCalendarErasure(scope: string): Promise<void>;
  keeperKeep(scope: string, key: string, value: string | null): Promise<boolean>;
  keeperKeptWords(scope: string): Promise<[string, string][] | null>;
  keeperKeepRows(scope: string, rows: readonly NativeKeptRow[]): Promise<boolean>;
  keeperKeptRows(scope: string): Promise<NativeKeptRow[] | null>;
  /**
   * Every web view's storage and cookies deleted; every live view starts over. Answers what the storage reads of the
   * shell's origin afterwards (`take-back.ts` judges it): polled until it reads empty, or for three seconds.
   */
  clearWebData(): Promise<{ readonly listed: boolean; readonly usage: number | null }>;
  /** Where a scope's keeper and the web view's data live, as paths: what the backup claim measures. */
  storagePaths(scope: string): { readonly keeper: string; readonly webData: string };
}

/** A message the page posted, as the native side received it, with what the platform said of it. */
export interface PageMessage {
  readonly epoch: string;
  readonly origin: string;
  readonly mainFrame: boolean;
  readonly data: string;
}

/** Why the native side made no view, or stopped making one. */
export type ShellRefusal =
  | {
    readonly why: "webview"; readonly installed: boolean; readonly major: number | null; readonly listener: boolean;
    readonly sealed: boolean;
  }
  | { readonly why: "noShell" }
  | { readonly why: "rules" }
  /** The view was asked to be the door's and handed a scope: it shows neither page. */
  | { readonly why: "door" }
  | { readonly why: "ended"; readonly epoch: string };

type NativeEvent<T> = { readonly nativeEvent: T };

interface ShellViewEvents extends ViewProps {
  readonly onMessage: (e: NativeEvent<PageMessage>) => void;
  readonly onEpoch: (e: NativeEvent<{ readonly epoch: string }>) => void;
  readonly onLinkAsk: (e: NativeEvent<{ readonly epoch: string; readonly token: string; readonly url: string }>) => void;
  readonly onMailto: (e: NativeEvent<{ readonly epoch: string; readonly url: string }>) => void;
  readonly onRefused: (e: NativeEvent<ShellRefusal>) => void;
}

/**
 * What a view is asked to be: one scope's page, or the door's page, which stands while no scope is live. Never
 * both: the door's page with a scope does not compile here, and the native view refuses it (`why: "door"`).
 */
export type ShellViewProps = ShellViewEvents & (
  | { readonly scope: string | null; readonly door?: false }
  | { readonly scope: null; readonly door: true }
);

/** What the view itself answers. */
export interface ShellViewHandle {
  post(epoch: string, json: string): Promise<void>;
  openHeld(token: string): Promise<boolean>;
}

export type ShellViewComponent = ComponentType<ShellViewProps & { ref?: Ref<ShellViewHandle> }>;
