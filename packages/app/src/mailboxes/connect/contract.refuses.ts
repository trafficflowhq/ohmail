/**
 * WHAT THE COMPILER REFUSES of the connect form's contract. This file builds to nothing; it exists to fail.
 * Each marked line is an error the compiler must report; where it stops being one, the mark itself is the error.
 */
import type { Secret } from "@ohmail/app-logic/mailboxes/connect/secret";
import type { ConnectInput, MailboxId } from "@ohmail/app-logic/mailboxes/connect/types";
import type { ConnectWire } from "../../host/index.js";
import type { ConnectPurpose, ConnectSubject } from "./contract.js";

declare const wire: ConnectWire;
declare const input: ConnectInput;
declare const subject: ConnectSubject;

// @ts-expect-error a route's word is not a mailbox id
export const aWord: MailboxId = "a-word-from-the-address";
// @ts-expect-error a typed password is not handed to a wire as a string
export const aString: Secret = "typed";
// @ts-expect-error nor as an object of a secret's shape
export const aLookalike: Secret = { toString: () => "", toJSON: () => "" };
// @ts-expect-error a purpose says what the form is opened for
export const noKind: ConnectPurpose = {};
// @ts-expect-error an edit names its mailbox
export const noSubject: ConnectPurpose = { kind: "edit" };
// @ts-expect-error a subject's id is the account's own
export const wordAsSubject: ConnectSubject = { ...subject, id: "a-word" };

// @ts-expect-error the mode is stated, never defaulted
export const noMode = wire.connect(input);
// @ts-expect-error a body's password is sealed
export const openBody = wire.connect({ ...input, imap: { ...input.imap, pass: "typed" } }, "seed");
