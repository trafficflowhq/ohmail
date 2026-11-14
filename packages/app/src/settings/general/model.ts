/**
 * General's model: what the pane draws, as plain data, and the verbs a press calls. The shell builds it from
 * today's sources (the locale's door, the theme, the text size, the picture quality and the after-a-verb choice
 * kept on this device, and the consent row for the two image switches); the pane reaches nothing itself.
 */
import type { ReactNode } from "react";
import type { SubjectDisplay } from "../../reader/subject-display.js";

export type ThemeChoice = "light" | "system" | "dark";
export type LookFace = "paper" | "ohmarchy";

/** Where the look applies: the account's look governs this device, or the device holds its own and can hand it on. */
export type LookScope =
  | { readonly governs: "all" }
  | { readonly governs: "device" | "default"; readonly busy: boolean; applyAll(): void };

/** A switch whose answer is the server's: the press writes, and the line draws what the write answered. */
export interface ServerSwitch {
  readonly blocked: boolean;
  /** The pictures are fetched by this computer, not through the proxy: the sentences say so. */
  readonly fromComputer: boolean;
  set(blocked: boolean): Promise<unknown>;
}

export interface GeneralModel {
  /** Withheld where the shell keeps no language (the demo). */
  readonly language: {
    readonly value: string;
    readonly choices: readonly string[];
    /** Kept on this install alone, not on the account. */
    readonly local: boolean;
    /** The shell is still writing an earlier choice. */
    readonly busy: boolean;
    set(next: string): Promise<unknown>;
  } | null;
  readonly theme: { readonly value: ThemeChoice; set(next: ThemeChoice): void };
  readonly look: {
    readonly face: LookFace;
    /** The scheme the frame resolved: the tiles draw each look in it. */
    readonly scheme: "light" | "dark";
    set(next: LookFace): void;
    /** Withheld where no account can hold a look (the demo, a standalone install). */
    readonly scope: LookScope | null;
  };
  readonly textSize: { readonly value: number; readonly choices: readonly number[]; set(next: number): void };
  readonly imageQuality: {
    readonly value: string;
    readonly choices: readonly string[];
    set(next: string): void;
  };
  readonly afterVerb: {
    readonly value: string;
    readonly choices: readonly string[];
    set(next: string): void;
  };
  readonly subject: { readonly value: SubjectDisplay; set(next: SubjectDisplay): void };
  /**
   * Load images in messages. Withheld until the server's consent row has answered, and where no proxy fetches a
   * picture: it rests on "ask first", and a switch drawn before the answer would show an account the wrong state.
   */
  readonly images: ServerSwitch | null;
  /** Block tracking pixels: under the same gate, for the same reason the other way round (it rests on). */
  readonly pixels: ServerSwitch | null;
  /** The host's own line about which app opens mail links on this computer (`features.defaultMail`). */
  readonly defaultMail: (() => ReactNode) | null;
}
