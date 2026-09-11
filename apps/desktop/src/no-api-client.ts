/**
 * The ohmail Cloud API client, absent. This module mirrors `apps/webapp/app/api-client.ts`'s
 * exported TYPE surface — a signature is a shape, not a secret — and every value export is a
 * refusal: paths, headers, token handling and call construction live in the bodies, and no body
 * is here. `vite.config.ts` aliases the real module to this one in BOTH desktop artifacts, so
 * no released binary carries a Cloud client; the desktop suite pins the alias and the exports
 * that must answer instead of refuse. When the real module's surface changes, change this one
 * in the same commit. The desktop tier has no Cloud account and no server — it talks to a local
 * engine over a pipe; reaching for anything here throws rather than quietly opening a socket.
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

/**
 * Facts about a response this build never receives — declared so the shared shell's types
 * resolve, exactly as `status`/`code`/`details` are. Spelled out rather than imported: the
 * whole purpose of this module is that `apps/webapp/app/api-client.ts` is not in the desktop
 * bundle. `test/no-api-client-census.test.ts` compares the two files' export names, so this
 * interface has to be here the moment the real one has it.
 */
export interface ApiWire {
  coded: boolean;
  retryable?: boolean;
  retryAfterMs?: number;
}

export class ApiError extends Error {
  declare readonly status: number;
  declare readonly code: string;
  declare readonly details?: unknown | undefined;
  declare readonly wire: ApiWire;
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

/**
 * ── THE OWNER BOUNDARY, AND THE THREE OF THESE THAT ARE NOT REFUSALS ────────────────────────
 * Everything else refuses, because calling it on a build with no server is a wiring bug worth
 * failing loudly. These three answer "is this window still speaking for the account it was
 * bound to?" — a browser cookie jar shared between tabs is the problem they exist for, and
 * there is no such jar here: the desktop holds its mail through a local process and keys its
 * engine to the mounted mailbox, so no two windows can disagree about whose session this is.
 * The honest answer is "yes, always", not "you should not have asked" — a thrown refusal would
 * take a working window down, since these are reached by shared code in the desktop bundle.
 */
export const bindApiOwner: (accountId: string | null) => void = () => {};

export const pendApiOwner: (owner: string | null) => void = () => {};

export const blockApiOwner: () => void = () => {};

export const boundApiOwner: () => string | null = () => null;

/** Mirrors the hosted client's shape so the shared shell's types resolve. Always `public` here. */
export const apiOwnerBinding: () => { kind: "public" } = () => ({ kind: "public" });

export const apiOwnerHolds: (path: string, opts?: { ceremony?: boolean }) => boolean = () => true;

/**
 * WITHDRAW THE CONFIRMATION — a no-op, for the same reason the four above are.
 *
 * The hosted client calls this when a response could not name the account it was for. This door
 * has no cookie jar, no session and no account to be wrong about: its mail arrives from a process
 * on the same machine over a channel that is not `fetch`, and there is no confirmation to
 * withdraw.
 */
export const reResolveApiOwner: () => void = () => {};

/**
 * The account-header negotiation, for the shared shell's types. Always `null` here — "nobody has
 * asked" — which is the honest value: this door has no `/hello` to ask and no answers to check,
 * so the About pane's disclosure row is correctly absent rather than wrongly present.
 */
export const setAccountHeaderCapability: (advertised: boolean | null) => void = () => {};

export const accountHeaderCapability: () => boolean | null = () => null;

/**
 * The hosted client's cookie-writer census, for the test that derives it from the server's route
 * table. Empty here: this door writes no browser cookies at all, so there is nothing to lock and
 * nothing to compare — see the note above these five.
 */
export const cookieWritingPaths: () => readonly string[] = () => [];

/**
 * The routes on which a response header naming another account is a SIGN-IN rather than a leak.
 * Empty here for `cookieWritingPaths`' reason: no session is established through this door, so no
 * response through it can name an account the credential resolved to.
 */
export const credentialRoutes: () => readonly string[] = () => [];

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
    organizerEventAt?: string | null;
    organizerEventSeenAt?: string | null;
    organizerReleasedAt?: string | null;
    organizerAcceptsRequests?: boolean;
    errorCode?: "auth" | "connect" | "tls" | "timeout" | "storage" | "sync" | "unknown" | null;
    errorDetail?: string | null;
    failedAt?: string | null;
    retryCount?: number;
    syncBlockedReason?: string | null;
    syncBlockedSince?: string | null;
    pendingMoves?: number;
    filing?: {
        due: number;
        deferred: number;
        oldestPendingAt: string | null;
        nextAttemptAt: string | null;
        attempts: number;
        lastRefusalClass: string | null;
        asOf: string;
        lastCycleAt: string | null;
    };
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
    storageUsedBytes?: number;
    entitlements: {
        mailboxLimit: number;
        canAddMailbox: boolean;
        aiEnabled: boolean;
        syncEnabled: boolean;
        storageBytesLimit?: number;
        reason: string;
    };
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
    release: (id: string) => Promise<MailboxRelease>;
    dismissOrganizerNotice: (id: string) => Promise<MailboxDTO>;
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

export type MailboxRelease = {
    outcome: "requested";
} | {
    outcome: "not_organizing";
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
 * WEB PUSH — the browser's subscription plumbing, absent; its absence once BROKE the build.
 * `notification-settings.ts` is shared shell code and imports this name unconditionally, and
 * the alias is the BUNDLER's, not the compiler's — a missing export here is an unresolved
 * import that fails the desktop bundle on every platform while `tsc` resolves the real module
 * and stays green. A typed refusal rather than an answering stub: the desktop tier has no
 * Cloud account and no push service, and `notification-settings.ts` asks `apiConfigured()`
 * before it acts, so nothing here is reached on this build; reaching it anyway throws.
 */
export interface DeviceDTO {
    id: string;
    kind:
        | "web" | "macos"
        | "desktop-linux" | "desktop-macos" | "desktop-windows"
        | "mobile-android" | "mobile-ios"
        | (string & {});
    label: string;
    createdAt: string;
    lastSeenAt: string;
    ip: string;
    current: boolean;
    named?: boolean;
    pushToken: string | null;
}

export interface PairingTokenDTO {
    id: string;
    grant: "invite" | "device-pair";
    label: string;
    createdAt: string;
    expiresAt: string;
    consumedAt: string | null;
    revokedAt: string | null;
    status: "live" | "consumed" | "revoked" | "expired";
}

/**
 * SESSIONS AND PAIRING — the two remaining Cloud surfaces, absent, added BEFORE anything
 * imports them. `push` above was added reactively, after a shared-shell import had already
 * broken the desktop bundle on every platform; these two are the same shape waiting to happen,
 * and the failure mode — an unresolved import at bundle time — is invisible to any typecheck
 * because the alias is the bundler's. `test/no-api-client-census.test.ts` compares the two
 * export sets directly, so the next addition to the real client is a red test, not a release.
 */
export const devices: {
    list: () => Promise<{ items: DeviceDTO[] }>;
    revoke: (id: string) => Promise<void>;
    revokeWebSessions: () => Promise<{ revoked: number }>;
} = absent;

export const pair: {
    mint: (b: { label?: string }) => Promise<{
        id: string; token: string; grant: "invite"; label: string; expiresAt: string;
    }>;
    mintDevice: (b: { label?: string }) => Promise<{
        id: string; token: string; grant: "device-pair"; label: string; expiresAt: string;
    }>;
    list: () => Promise<{ items: PairingTokenDTO[] }>;
    revoke: (id: string) => Promise<void>;
    redeemInvite: (b: { token: string; email: string }) => Promise<{
        grant: "invite"; invite: { code: string; email: string; expiresAt: string };
    }>;
} = absent;

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
    setDormancyDays: (days: number | null | undefined, scope?: "window" | "all_time") => Promise<{
        dormancyDays?: number;
        screeningScope?: "window" | "all_time";
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
    body: string | null;
    startsAt: string | null;
    /** The instant the responder stops; the pane resolves a picked day to the end of it. */
    endsAt: string | null;
    audience: "screened_in" | "everyone";
    throttle: "always" | "per_message" | "per_day" | "per_week";
    /** Folder names. `ohmail/Screener` is storable only beside `audience: "everyone"`. */
    piles: ("INBOX" | "ohmail/Reads" | "ohmail/Receipts" | "ohmail/Screener")[];
    updatedAt: string | null;
}

/**
 * The SAVE's answer: the row plus the 202 discriminator. Mirrored here because the shared
 * settings control imports it by name and this module stands in for the real one in both
 * desktop artifacts — see this file's header on keeping the surface in step.
 */
export interface AwayResponderSaveWire extends AwayResponderWire {
    pending?: boolean;
}

export const away: {
    state: () => Promise<AwayResponderWire>;
    save: (next: Omit<AwayResponderWire, "updatedAt">) => Promise<AwayResponderSaveWire>;
} = absent;

export type AccountAccess = {
    metered: false;
} | {
    metered: true;
    canAddMailbox: boolean;
    mailboxes: number | null;
};

export const account: {
    erase: () => Promise<ErasureResult>;
    access: () => Promise<AccountAccess>;
    manageLink: () => Promise<{
        url: string;
    } | null>;
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

/**
 * The live Trash window's shapes and its two reads. `vite.config.ts` aliases the real module to
 * this one, so a name missing here is an unresolved import and the desktop bundle fails to build
 * on every platform — `test/no-api-client-census.test.ts` compares the two files' export names.
 * The desktop reaches its own local engine and has no Cloud door for these routes, so the value
 * export refuses like every other one here.
 */
export const trashWindow: {
    list: (opts?: { cursor?: string }) => Promise<TrashWindowPageWire>;
    body: (mailboxId: string, uid: number, uidValidity: string) => Promise<{
        subject: string;
        text: string;
    }>;
} = absent;

export interface TrashWindowItemWire {
    mailboxId: string;
    uid: number;
    uidValidity: string;
    subject: string;
    from: { name: string | null; address: string };
    date: string | null;
    messageIdHeader: string | null;
    seen: boolean;
    origin: "ohmail" | "provider";
}

export interface TrashWindowMailboxWire {
    id: string;
    address: string;
    window: "ok" | "no_trash_folder" | "unreachable";
    reset?: boolean;
}

export interface TrashWindowPageWire {
    mailboxes: TrashWindowMailboxWire[];
    items: TrashWindowItemWire[];
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

/**
 * THE ACCESS REFUSAL'S SURFACE — two protocol constants, the facts type, and a subscription.
 *
 * The constants carry their real VALUES: they are what the server answers, not a way to reach it,
 * and a consumer comparing against a refusing stand-in would silently never match. The
 * subscription ANSWERS rather than refuses, on this file's own rule for `apiConfigured`: the
 * shell subscribes in an effect at mount, so a refusal here is a crash on first render. Nothing
 * in this build can raise one — there is no Cloud client to meet a 402 — so the sink is never
 * called and the unsubscribe is a no-op.
 */
export const ACCESS_REFUSED_STATUS = 402;
export const ACCESS_REFUSED_CODE = "subscription_required";

export interface AccessRefusedFacts {
    reason: "payment_required" | "suspended";
    manageUrl?: string;
}

export function onAccessRefused(_sink: (facts: AccessRefusedFacts) => void): () => void {
    return () => {};
}

export const messageOf: (err: unknown) => string = absent;

export const codeOf: (err: unknown) => string = absent;

export {};
