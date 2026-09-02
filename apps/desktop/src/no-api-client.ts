/**
 * The ohmail Cloud API client, absent.
 *
 * This module mirrors `apps/webapp/app/api-client.ts`'s exported TYPE surface — signatures,
 * generics and class shapes included, because a signature is a shape and not a secret — and
 * every value export is a refusal: the endpoint paths, the header and token handling and the
 * call construction all live in the bodies, and no body is here. `vite.config.ts` aliases the
 * real module to this one in BOTH desktop artifacts, so no released binary carries a Cloud
 * client. It was generated from the real module's emitted declarations while that module was
 * not published; it is an ordinary hand-kept source now, and the desktop suite pins the alias
 * and the exports that must answer instead of refuse. When the real module's surface changes,
 * change this one in the same commit — the desktop typecheck is what notices a drift.
 *
 * The desktop tier has no Cloud account and no server: it talks to a local engine over a pipe.
 * Reaching for anything here throws rather than quietly opening a socket.
 */

const UNAVAILABLE = "the ohmail Cloud API is not part of this build — the desktop tier talks to its own local engine";

const refuse = (): never => {
  throw new Error(UNAVAILABLE);
};

/* One stand-in behind every value export. Calling it, constructing it, or reading any property
 * off it refuses. It is typed `any` so it can be assigned to each export's real declared type;
 * the EXPORTS are typed, which is what consumers check against. */
const absent: any = new Proxy(function () { refuse(); } as any, {
  get: (_t, key) => (key === "then" ? undefined : absent),
  apply: () => refuse(),
  construct: () => refuse(),
});

/* The two exports that ANSWER rather than refuse. Everything else here is a way to reach a
 * server; these two exist to report whether there is one, and the shared client asks before it
 * acts — it skips its Cloud path whenever the answer is no. Refusing the question instead of
 * answering it turns that guard into a crash on first render, so these say what is true of this
 * build: there is no Cloud behind it. */
const noCloudBase = null;
const noCloudConfigured = () => false;

export const API_BASE: string | null = noCloudBase;

export const apiConfigured: () => boolean = noCloudConfigured;

export class ApiError extends Error {
  declare readonly status: number;
  declare readonly code: string;
  declare readonly details?: unknown | undefined;
  constructor(..._args: any[]) {
    super();
    refuse();
  }
}

export const OFFLINE_CODE = "network_unreachable";

interface RequestOptions {
    method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    body?: unknown;
    headers?: Record<string, string>;
    signal?: AbortSignal;
}

export const csrfToken: () => string | null = absent;

export const api: <T>(path: string, opts?: RequestOptions) => Promise<T> = absent;

export interface SessionUser {
    userId: string;
    accountId: string;
    email: string;
    displayName: string;
    twofaEnrolled: {
        webauthn: boolean;
        totp: boolean;
        recoveryCodes: boolean;
    };
    emailVerified: boolean;
}

export interface EnrollmentSession {
    status: "enrollment";
    user: SessionUser;
    next: "enroll_2fa";
    enrollmentToken: string;
    expiresIn: number;
}

export interface RegistrationPending {
    status: "ok";
}

export interface TwofaChallenge {
    status: "twofa_required";
    loginToken: string;
    methods: Array<"webauthn" | "totp" | "recovery_code">;
}

export type LoginResult = EnrollmentSession | TwofaChallenge;

export interface AuthenticatedSession {
    status: "authenticated";
    user: SessionUser;
}

export interface MailboxDTO {
    id: string;
    provider: string;
    address: string;
    displayName: string | null;
    status: string;
    lastSyncAt: string | null;
    authKind?: "password" | "oauth";
    organizerRole?: "organizer" | "reader";
    organizedBy?: { kind: string | null; name: string | null; since: string | null } | null;
    organizerState?: "held" | "stopped" | null;
    organizeConsentedAt?: string | null;
    errorCode?: "auth" | "connect" | "tls" | "timeout" | "storage" | "sync" | "unknown" | null;
    errorDetail?: string | null;
    failedAt?: string | null;
    retryCount?: number;
    syncBlockedReason?: string | null;
    syncBlockedSince?: string | null;
    pendingMoves?: number;
    disabledReason?: string | null;
    createdAt?: string;
    initialImportCompletedAt?: string | null;
    inboundQuietSince?: string | null;
    inboundQuietDismissedAt?: string | null;
    smtpMaxSizeBytes?: number | null;
    messageCount?: number;
    serverMessageCount?: number;
}

export interface SubscriptionStatus {
    subscription: {
        plan: "solo" | "plus" | "pro";
        status: string;
        mailboxLimit: number;
        monthlyCredits: number;
        currentPeriodEnd: string | null;
        cancelAtPeriodEnd: boolean;
        graceUntil: string | null;
    } | null;
    balance: number;
    entitlements: {
        mailboxLimit: number;
        canAddMailbox: boolean;
        aiEnabled: boolean;
        syncEnabled: boolean;
        reason: string;
    };
    plans: Record<string, {
        priceUsd: number;
        mailboxes: number;
        monthlyCredits: number;
    }>;
    trialCredits?: number;
    invoiceGranted?: boolean;
}

export const auth: {
    register: (b: {
        email: string;
        password: string;
        displayName: string;
        inviteCode?: string;
    }) => Promise<EnrollmentSession | RegistrationPending>;
    verifyEmail: (b: {
        token: string;
        password: string;
    }) => Promise<EnrollmentSession | {
        status: "verified";
    }>;
    resendVerification: () => Promise<{
        ok: true;
    }>;
    login: (b: {
        email: string;
        password: string;
    }) => Promise<LoginResult>;
    session: () => Promise<{
        user: SessionUser;
        scope: "full" | "enrollment";
    }>;
    logout: () => Promise<void>;
    webauthnRegisterOptions: () => Promise<{
        options: PublicKeyCredentialCreationOptionsJSON;
    }>;
    webauthnRegisterVerify: (b: {
        credential: unknown;
        label: string;
    }) => Promise<{
        credentialId: string;
        twofaEnrolled: SessionUser["twofaEnrolled"];
        session?: AuthenticatedSession;
    }>;
    totpEnroll: () => Promise<{
        secret: string;
        otpauthUrl: string;
    }>;
    totpActivate: (b: {
        code: string;
    }) => Promise<{
        twofaEnrolled: SessionUser["twofaEnrolled"];
        session?: AuthenticatedSession;
    }>;
    recoveryCodes: () => Promise<{
        codes: string[];
    }>;
    totpRemove: () => Promise<void>;
    webauthnAssertOptions: (b: {
        loginToken: string;
    }) => Promise<{
        options: PublicKeyCredentialRequestOptionsJSON;
    }>;
    webauthnAssertVerify: (b: {
        loginToken: string;
        credential: unknown;
    }) => Promise<AuthenticatedSession>;
    totpVerify: (b: {
        loginToken: string;
        code: string;
    }) => Promise<AuthenticatedSession>;
    desktopLink: (b?: {
        challenge?: string;
    }) => Promise<{
        code: string;
        expiresIn: number;
    }>;
    recoveryVerify: (b: {
        loginToken: string;
        code: string;
    }) => Promise<AuthenticatedSession & {
        remainingCodes: number;
    }>;
} = absent;

export interface CreateMailboxBody {
    provider: string;
    address: string;
    displayName?: string;
    imap: {
        host: string;
        port?: number;
        secure?: boolean;
        user: string;
        pass: string;
        allowInsecure?: boolean;
    };
    smtp?: {
        host: string;
        port?: number;
        secure?: boolean;
        user?: string;
        pass?: string;
    };
}

export interface UpdateMailboxBody {
    displayName?: string | null;
    status?: "connected" | "disabled";
    imap?: {
        host?: string;
        port?: number;
        secure?: boolean;
        user?: string;
        pass: string;
        allowInsecure?: boolean;
    };
    smtp?: {
        host?: string;
        port?: number;
        secure?: boolean;
        user?: string;
        pass: string;
    };
}

export const mailboxes: {
    list: (opts?: {
        counts?: boolean;
    }) => Promise<{
        items: MailboxDTO[];
    }>;
    resync: (id: string) => Promise<{
        status: string;
    }>;
    create: (b: CreateMailboxBody) => Promise<MailboxDTO>;
    update: (id: string, b: UpdateMailboxBody) => Promise<MailboxDTO>;
    organizer: (id: string) => Promise<OrganizerPeek>;
    takeover: (id: string) => Promise<MailboxTakeover>;
    oauthStart: (b?: {
        mailboxId?: string;
        returnTo?: string;
    }) => Promise<{
        authorizeUrl: string;
        state: string;
    }>;
    oauthAvailability: () => Promise<{
        available: boolean;
    }>;
    oauthComplete: (b: {
        state: string;
        code: string;
    }) => Promise<{
        mailbox: MailboxDTO;
        created: boolean;
        returnTo: string | null;
    }>;
} = absent;

export interface OrganizerHolder {
    kind: "local" | "cloud" | "unknown";
    displayName: string | null;
    heartbeatAt: string;
    active: boolean;
}

export interface OrganizerPeek {
    state: "none" | "held" | "stopped";
    holders: OrganizerHolder[];
    unreadable: number;
}

export type MailboxTakeover = {
    outcome: "authorized";
    previousReason: string;
} | {
    outcome: "already_organizing";
} | {
    outcome: "disconnected";
};

export interface ProfileImportCountsWire {
    screener: number;
    rules: number;
    notifyRules: number;
    tags: number;
    awayResponder: boolean;
}

export type ProfileImportCandidateWire = {
    state: "none";
} | {
    state: "found";
    fingerprint: string;
    updatedAt: string;
    producer: {
        kind: string;
        version: string;
    };
    counts: ProfileImportCountsWire;
} | {
    state: "newer";
    v: number;
};

export interface ProfileImportAppliedWire {
    imported: ProfileImportCountsWire;
    skippedRules: number;
    seq: number | null;
}

export const profileImport: {
    candidate: (mailboxId: string) => Promise<ProfileImportCandidateWire>;
    apply: (mailboxId: string, fingerprint: string) => Promise<ProfileImportAppliedWire>;
    decline: (mailboxId: string, subject: {
        fingerprint?: string;
        v?: number;
    }) => Promise<{
        dismissed: boolean;
    }>;
} = absent;

export const billing: {
    subscription: () => Promise<SubscriptionStatus>;
    portal: () => Promise<{
        url: string;
    }>;
    checkout: (plan: "solo" | "plus" | "pro") => Promise<{
        url: string;
    }>;
} = absent;

export interface ErasureResult {
    erased: true;
    usersErased: number;
    tables: Record<string, number>;
    retained: string;
    subscription: "none" | "cancelled" | "cancel_failed";
}

export const aiSettings: {
    get: () => Promise<{
        aiEnabled: boolean;
    }>;
    set: (aiEnabled: boolean) => Promise<{
        aiEnabled: boolean;
    }>;
} = absent;

export interface ScreeningPreferenceWire {
    ohboxPolicy: "people_only" | "people_and_replied" | null;
    ohboxBar: string | null;
    defaultBar: string;
    screenerAutoApply: boolean;
}

export const screeningSettings: {
    get: () => Promise<ScreeningPreferenceWire>;
    set: (body: {
        ohboxPolicy?: ScreeningPreferenceWire["ohboxPolicy"];
        ohboxBar?: string | null;
        screenerAutoApply?: boolean;
    }) => Promise<ScreeningPreferenceWire>;
} = absent;

export interface ConsentStateWire {
    seedConfirmedAt: string | null;
    screeningResetAt: string | null;
    dormancyDays: number;
    screeningBaselineAt?: string | null;
    autoSuggestAt?: string | null;
    blockRemoteImagesAt?: string | null;
    blockAutoUnsubscribeAt?: string | null;
    locale?: string | null;
    counts: {
        decidedSenders: number;
        activeUndecidedSenders: number;
        dormantUndecidedSenders: number;
    };
}

export interface SeedCandidateWire {
    address: string;
    name: string | null;
    messages: number;
    lastWrittenAt: string | null;
    alreadyDecided: boolean;
}

export interface SeedReviewWire {
    candidates: SeedCandidateWire[];
    excluded: Array<{
        address: string;
        reason: "robot-recipient" | "machine-sent" | "own-address";
    }>;
    scannedMessages: number;
    truncated: boolean;
}

/**
 * WEB PUSH — the browser's subscription plumbing, absent, and its absence is what BROKE the build.
 *
 * `notification-settings.ts` is shared shell code and imports this name unconditionally
 * (`import { apiConfigured, push as pushApi } from "../api-client"`). `vite.config.ts` aliases
 * that module to THIS one in both desktop artifacts, so a missing export here is not a missing
 * feature — it is an unresolved import, and the desktop bundle fails on every platform.
 *
 * It stayed invisible to `tsc` because the alias is the bundler's, not the compiler's: the
 * typecheck resolves the real module and is green while the bundle cannot be built at all. The
 * file header's rule — "when the real module's surface changes, change this one in the same
 * commit" — is exactly this, and the desktop typecheck is NOT what notices it.
 *
 * A typed refusal rather than a stub that answers: the desktop tier has no Cloud account and no
 * push service, and `notification-settings.ts` asks `apiConfigured()` before it acts, so nothing
 * here is reached on this build. Reaching it anyway must throw rather than quietly open a socket.
 */
export const push: {
    vapidKey: () => Promise<{
        publicKey: string | null;
    }>;
    subscribe: (endpoint: string, p256dh: string, auth: string) => Promise<{
        id: string;
    }>;
    unsubscribe: (id: string) => Promise<void>;
} = absent;

export const consent: {
    state: () => Promise<ConsentStateWire>;
    setAutoSuggest: (enabled: boolean) => Promise<{
        autoSuggestAt: string | null;
    }>;
    setDormancyDays: (days: number | null) => Promise<{
        dormancyDays: number;
    }>;
    setBlockRemoteImages: (blocked: boolean) => Promise<{
        blockRemoteImagesAt: string | null;
    }>;
    setBlockTrackingPixels: (blocked: boolean) => Promise<{
        loadTrackingPixelsAt: string | null;
    }>;
    setBlockAutoUnsubscribe: (blocked: boolean) => Promise<{
        blockAutoUnsubscribeAt: string | null;
    }>;
    setLocale: (locale: string | null) => Promise<string | null>;
    seedReview: () => Promise<SeedReviewWire>;
    confirmSeed: (addresses: string[], opts?: {
        idempotencyKey?: string;
    }) => Promise<{
        rulesCreated: number;
        contactsCreated: number;
        declined: number;
        skipped: number;
    }>;
    resetPreview: () => Promise<{
        unmoved: Array<{
            folder: string;
            messages: number;
            observed: number;
        }>;
    }>;
    reset: () => Promise<{
        rulesDeleted: number;
        contactsDeleted: number;
        screenerSuggestionsDeleted: number;
        learningSignalsDeleted: number;
        unmoved: Array<{
            folder: string;
            messages: number;
            observed: number;
        }>;
    }>;
} = absent;

export interface AwayResponderWire {
    enabled: boolean;
    subject: string | null;
    body: string | null;
    startsAt: string | null;
    endsAt: string | null;
    audience: "screened_in" | "everyone";
    updatedAt: string | null;
}

export const away: {
    state: () => Promise<AwayResponderWire>;
    save: (next: Omit<AwayResponderWire, "updatedAt">) => Promise<AwayResponderWire>;
} = absent;

export const account: {
    erase: () => Promise<ErasureResult>;
} = absent;

export const privacy: {
    loadRemote: (messageId: string) => Promise<{
        remoteContent: string;
    }>;
} = absent;

export interface ScreenerWireItem {
    id: string;
    messageId: string;
    sender: {
        name: string | null;
        address: string;
    };
    subject: string;
    snippet: string;
    receivedAt: string;
    aiSuggestion: {
        decision: "yes" | "no" | "hold";
        confidence: number;
        rationale: string;
    } | null;
}

export interface ScreenerWirePage {
    items: ScreenerWireItem[];
    nextCursor: string | null;
    suggestable: {
        senders: string[];
        credits: number;
        maxPerRequest: number;
    };
}

export type ScreenerSkipReason = "not_held" | "out_of_credits" | "spend_unavailable" | "model_unavailable";

export interface ScreenerSuggestWire {
    dryRun: boolean;
    requested: number;
    quoted: number;
    quotedCredits: number;
    charged: number;
    stopped?: "out_of_credits" | "spend_unavailable";
    remainingCredits?: number;
    suggestions: Array<{
        sender: string;
        messageId: string;
        decision: "yes" | "no" | "hold";
        destination?: string;
        spam?: boolean;
        confidence: number;
        rationale: string;
    }>;
    skipped: Array<{
        sender: string;
        reason: ScreenerSkipReason;
    }>;
}

export const screener: {
    list: (opts?: {
        limit?: number;
        cursor?: string;
    }) => Promise<ScreenerWirePage>;
    suggest: (senders: string[], opts?: {
        dryRun?: boolean;
        idempotencyKey?: string;
    }) => Promise<ScreenerSuggestWire>;
    junkList: (opts?: {
        cursor?: string;
    }) => Promise<JunkPageWire>;
    junkBody: (mailboxId: string, uid: number, uidValidity: string) => Promise<{
        subject: string;
        text: string;
    }>;
    junkRescue: (mailboxId: string, uid: number, uidValidity: string, opts?: {
        allow?: { sender: string };
    }) => Promise<JunkRescueWire>;
    junkSearch: (q: string) => Promise<JunkSearchWire>;
    junkSweepPreview: () => Promise<JunkSweepWire>;
    junkSweepRequest: () => Promise<JunkSweepWire>;
} = absent;

export interface JunkRescueWire {
    status: "rescued";
    allowed?: { disabledRuleIds: string[]; createdRuleId: string | null };
}

export interface JunkSearchWire {
    mailboxes: JunkMailboxWire[];
    items: JunkItemWire[];
    truncated: boolean;
}

export interface JunkSweepMailboxWire {
    id: string;
    address: string;
    candidates: number;
    hasJunkFolder: boolean;
    pending: boolean;
}

export interface JunkSweepWire {
    mailboxes: JunkSweepMailboxWire[];
    movable: number;
    pending: boolean;
}

export interface JunkItemWire {
    mailboxId: string;
    uid: number;
    uidValidity: string;
    subject: string;
    from: {
        name: string | null;
        address: string;
    };
    date: string | null;
    messageIdHeader: string | null;
    seen: boolean;
    origin: "verdict" | "provider";
}

export interface JunkMailboxWire {
    id: string;
    address: string;
    window: "ok" | "no_junk_folder" | "unreachable";
    reset?: boolean;
}

export interface JunkPageWire {
    mailboxes: JunkMailboxWire[];
    items: JunkItemWire[];
    nextCursor: string | null;
}

export interface PublicKeyCredentialCreationOptionsJSON {
    challenge: string;
    rp: {
        id?: string;
        name: string;
    };
    user: {
        id: string;
        name: string;
        displayName: string;
    };
    pubKeyCredParams: Array<{
        type: "public-key";
        alg: number;
    }>;
    timeout?: number;
    excludeCredentials?: Array<{
        id: string;
        type: "public-key";
        transports?: string[];
    }>;
    authenticatorSelection?: Record<string, unknown>;
    attestation?: string;
}

export interface PublicKeyCredentialRequestOptionsJSON {
    challenge: string;
    timeout?: number;
    rpId?: string;
    allowCredentials?: Array<{
        id: string;
        type: "public-key";
        transports?: string[];
    }>;
    userVerification?: string;
}

export const webauthnAvailable: () => boolean = absent;

export const createPasskey: (options: PublicKeyCredentialCreationOptionsJSON) => Promise<unknown> = absent;

export const assertPasskey: (options: PublicKeyCredentialRequestOptionsJSON) => Promise<unknown> = absent;

export const messageOf: (err: unknown) => string = absent;

export const codeOf: (err: unknown) => string = absent;

export {};
