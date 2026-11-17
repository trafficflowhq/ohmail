/**
 * THE FORM'S WORDS, BY WHAT IT IS OPENED FOR. One form stands where five stood, and each mount keeps the sentences
 * its form said: a total table of catalogue keys, never a sentence written here and never a branch on a shell's name.
 */
import type { ConnectPurposeKind } from "@ohmail/app-logic/mailboxes/connect/types";
import type { ConnectNamespace } from "./namespace.js";

export interface Word {
  readonly ns: ConnectNamespace;
  readonly key: string;
}
const word = (ns: ConnectNamespace, key: string): Word => ({ ns, key });

export interface FormWords {
  /** What stands over the form, and the note under it. */
  readonly lead: Word | null;
  readonly note: Word | null;
  readonly address: Word;
  readonly user: Word;
  readonly userPlaceholder: Word | null;
  readonly password: Word;
  readonly passwordHint: Word | null;
  readonly imapHost: Word;
  readonly smtpHost: Word;
  readonly submit: Word;
  readonly working: Word;
  /** What the provider's sign-in press says while its start runs. */
  readonly signInWorking: Word;
  /** The line the second factor's dialog is handed for a parked connect or edit. */
  readonly factorLine: Word;
  /** The provider's sign-in by code is run elsewhere, after setup. */
  readonly codeElsewhere: Word | null;
  /** The provider's own sign-in, offered beside a password it refused. `null`: this mount offers none there. */
  readonly signInInstead: Word | null;
  /** The test: its press, its wait, its press again, and the line a parked test hands the dialog. `null`: this mount has no test. */
  readonly test: {
    readonly press: Word;
    readonly waiting: Word;
    readonly waitingLong: Word;
    readonly again: Word;
    readonly factorLine: Word;
  } | null;
}

const JOIN: FormWords = {
  lead: word("join", "step_mailbox_lead"),
  note: word("join", "appPasswordReady"),
  address: word("join", "mailboxAddress"),
  user: word("join", "mailboxUser"),
  userPlaceholder: word("join", "mailboxUserPlaceholder"),
  password: word("join", "appPasswordLabel"),
  passwordHint: word("join", "appPasswordHint"),
  imapHost: word("join", "imapHost"),
  smtpHost: word("join", "smtpHost"),
  submit: word("join", "connectMailbox"),
  working: word("join", "working"),
  signInWorking: word("join", "working"),
  factorLine: word("mailboxes", "factorBody"),
  codeElsewhere: word("join", "mailboxMicrosoftAfterSetup"),
  signInInstead: word("mailboxes", "oauthContinue"),
  test: null,
};

/* The password's own hint differs by whose service this is; the stage that mounts the form says it. */
const RUN: FormWords = {
  lead: null,
  note: null,
  address: word("onboarding", "address"),
  user: word("onboarding", "user"),
  userPlaceholder: null,
  password: word("onboarding", "password"),
  passwordHint: null,
  imapHost: word("onboarding", "imapHost"),
  smtpHost: word("onboarding", "smtpHost"),
  submit: word("onboarding", "connect"),
  working: word("onboarding", "connecting"),
  signInWorking: word("mailboxes", "working"),
  factorLine: word("mailboxes", "factorBody"),
  codeElsewhere: null,
  signInInstead: null,
  test: {
    press: word("onboarding", "test"),
    waiting: word("onboarding", "testing"),
    waitingLong: word("onboarding", "testingLocal"),
    again: word("onboarding", "testAgain"),
    factorLine: word("onboarding", "mailboxStepUp"),
  },
};

const EDIT: FormWords = {
  lead: word("mailboxes", "editIntro"),
  note: null,
  address: word("mailboxes", "editTitle"),
  user: word("mailboxes", "imapUserLabel"),
  userPlaceholder: word("mailboxes", "keepCurrent"),
  password: word("mailboxes", "passwordLabel"),
  passwordHint: null,
  imapHost: word("mailboxes", "imapLabel"),
  smtpHost: word("mailboxes", "smtpLabel"),
  submit: word("mailboxes", "continue"),
  working: word("mailboxes", "savingEdit"),
  signInWorking: word("mailboxes", "working"),
  factorLine: word("mailboxes", "factorBodyEdit"),
  codeElsewhere: null,
  signInInstead: null,
  test: null,
};

export const FORM_WORDS: Readonly<Record<ConnectPurposeKind, FormWords>> = {
  join: JOIN,
  firstRun: RUN,
  add: RUN,
  edit: EDIT,
  reconnect: EDIT,
};

/** The edit's own words beside the table's: its ports, what a blank keeps, its way back, and its lead on a mailbox that takes an app password. */
export const EDIT_WORDS = {
  imapPort: word("mailboxes", "imapPortLabel"),
  smtpPort: word("mailboxes", "smtpPortLabel"),
  keep: word("mailboxes", "keepCurrent"),
  cancel: word("mailboxes", "cancel"),
  leadAppPassword: word("mailboxes", "editIntro_gmail"),
} as const;
