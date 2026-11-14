import type { Browser } from "@playwright/test";

export const SIMULATOR: string;
export const SCREENS: string;
/** The commit a tag of the studio names. */
export function commitOf(studio: string, tag: string): string;
/** The design reference's list of screens at the tag, parsed. */
export function readScreens(studio: string, tag: string): unknown;
/** Unpacks the simulation's folder at the tag into `into` and returns the folder to serve. */
export function extractSimulator(studio: string, tag: string, into: string): string;
/** Serves one folder on loopback, read only, and nothing above it. */
export function serveLoopback(root: string): Promise<{ base: string; close: () => Promise<void> }>;
/** The address a state is drawn at. */
export function addressOf(base: string, key: string): string;
/** Pixels per CSS pixel a device's pictures are taken at. */
export function scaleOf(device: string): number;
/** The window each device is drawn in, read from the reference itself. */
export function windows(served: string, browser: () => Promise<Browser>, base: string): (key: string) => Promise<[number, number]>;
