/**
 * VERSIONS THIS REPOSITORY'S HISTORY NEVER CARRIED, named by hash so the setup can still
 * identify them.
 *
 * `classifyDrift` identifies what an applied migration row ran by finding, in the deploying
 * checkout's git history, the version of that file whose sha256 is the one the row records. A
 * database migrated from the project's development history before this repository was published
 * records the versions that history held then, and thirty-one of those files were edited before
 * their first published version — twenty-eight in comments and layout only, mail 0021, 0022 and
 * 0037 also by the replay guards their allowances name. No clone of this repository carries those versions, so
 * the lookup finds nothing and the setup refuses the entry as `unknown-provenance` although
 * nothing drifted.
 *
 * Each row is a FACT about one such version, never a verdict: the journal and tag it belongs to,
 * the sha256 of its text (what `__drizzle_migrations.hash` holds), the sha256 of its executable
 * SQL as `normalizeSql` reads it, and the commit that introduced it, an opaque label. Hashes only:
 * no text of a version is here. A hit makes the version IDENTIFIED and nothing more —
 * `classifyDrift` still compares its executable SQL with the file this tree ships, live, and an
 * executable difference still needs the allowance naming that exact pair.
 *
 * Consulted only for a hash git did not identify, and only by exact (journal, tag, recorded):
 * never by tag alone, by prefix or by pattern. The set is CLOSED — that history is frozen, and
 * every version written since is in this repository's history, which the classifier reads
 * directly — so a new row is by construction one nothing can back. The eleven mail rows 0006-0027
 * came later only because the refusal that named them was cut off by a 20-line deploy log; each
 * is proven against the frozen history like the rest (the test's store arm).
 * `migration-provenance-record.test.ts` pins the rows, their shape and the set.
 */

/** The one kind of version this record names. */
export const PRE_PUBLICATION = "pre-publication version" as const;

export interface PrePublicationVersion {
  /** `mail` | `cloud` — the journal whose migrations table holds the row. */
  readonly journal: "mail" | "cloud";
  readonly tag: string;
  /** 64-hex: sha256 of this version's text — what `__drizzle_migrations.hash` records. */
  readonly recorded: string;
  /** 64-hex: sha256 of `normalizeSql(<this version's text>)` — its executable SQL. */
  readonly executable: string;
  /** 40-hex: the commit that introduced this version, an opaque label. */
  readonly introducedBy: string;
  readonly label: typeof PRE_PUBLICATION;
}

/** Every row derived from the frozen history, read-only; each version at exactly one commit. */
export const PRE_PUBLICATION_VERSIONS: readonly PrePublicationVersion[] = [
  {
    journal: "mail",
    tag: "0006_idempotency_keys",
    recorded: "90fd292bc0820b9e7abf8b7c063d30ea59e5b371943ecda271cda0bd76abf448",
    executable: "e9fb2d3f1bab981de7ef8a111b1bfb715ee601c4912365bf6491aae6c3d292f2",
    introducedBy: "fc882c5fd10ed77f05fb963141e4182b22ad6c9b",
    label: PRE_PUBLICATION,
  },
  {
    journal: "mail",
    tag: "0015_workflow_step_dedup",
    recorded: "fccf1e354500b9c0d55a3b0c5c0ede3305927c4eac12897fe948c7d652b3cd9f",
    executable: "3526b819e47e25181ceed0a214e1093cf6029d36f4590baf99fb8dacfb68db01",
    introducedBy: "fc882c5fd10ed77f05fb963141e4182b22ad6c9b",
    label: PRE_PUBLICATION,
  },
  {
    journal: "mail",
    tag: "0016_workflow_proposals",
    recorded: "4f0f2c39fcdbde2a67529eac6e5ce262458ced19cc3cefb2fbf4cd7d9bde4622",
    executable: "72f2508816bf11ff8fe4d799ffde5a860462f52333b6993edae1412449751cbf",
    introducedBy: "fc882c5fd10ed77f05fb963141e4182b22ad6c9b",
    label: PRE_PUBLICATION,
  },
  {
    journal: "mail",
    tag: "0017_enrollment",
    recorded: "4aca9b1f59c90975cb0ae34eab683743e223ceb7758a8e93c123c6a17dfdc89b",
    executable: "07259c123f4fcdb548aa24563c121ab2056a562ebde5e578ee968c8f8dafeeb5",
    introducedBy: "fc882c5fd10ed77f05fb963141e4182b22ad6c9b",
    label: PRE_PUBLICATION,
  },
  {
    journal: "mail",
    tag: "0021_mailbox_address_unique",
    recorded: "7201608975888466d3fdc2b95ec472a50e272c30b322ad3071100e909aeb2c57",
    executable: "a5cde314acf8cb5cf8b651fa0d60c0c176541d55d69bdd3a9ad401f9c1692c92",
    introducedBy: "156cbda64ccea2c366c2556dbc9dc1363afa5b36",
    label: PRE_PUBLICATION,
  },
  {
    journal: "mail",
    tag: "0022_message_body_html_cap",
    recorded: "6c8d15b02a2fbaeece3b5aacab167566ae4aa43f43f41468bc278ccb61905d34",
    executable: "8dadb1da38d0ac8f17483219b302fe07ac59170209dcc4aa4adea7b6bc622656",
    introducedBy: "a1b69cdb62f986c0b4cb25a5f300741747e0902c",
    label: PRE_PUBLICATION,
  },
  {
    journal: "mail",
    tag: "0023_mailbox_failure_reason",
    recorded: "dbc15fae438882a2c8005f6605d66bd576db513a2eb657fea196f0a454e444ee",
    executable: "62a1d71819763e5ae25dfd1a8e966d31062983890ed88935f68472d2e910beb9",
    introducedBy: "00aadba9728e36b2e3792676bdfebad4047383ac",
    label: PRE_PUBLICATION,
  },
  {
    journal: "mail",
    tag: "0024_flag_state",
    recorded: "28372bb0cb85a434480cfbc9901a378eb59f495798279475139c8955bb1403a5",
    executable: "bdea492301b5d1376b373c7e73051fea8752e825d7bf5023f01b911ec464fe5a",
    introducedBy: "5956682af99c372001ad9d8b6145fcd0041ab377",
    label: PRE_PUBLICATION,
  },
  {
    journal: "mail",
    tag: "0025_mailbox_kickstart",
    recorded: "c1fcd9dd449648bcde5894cb775733f3ca784b2b3130f2af18114735cf41844e",
    executable: "05334688d345a898098edf11f2a3188856ef44310e4360b2d7a4430f89f45d53",
    introducedBy: "35133eadfd42b263107e0e3b18bc86ca2fa7b639",
    label: PRE_PUBLICATION,
  },
  {
    journal: "mail",
    tag: "0026_thread_resolution",
    recorded: "20572b3b6ba1d5a872756ea0378387126138f373c7c42b13077f311f484b9c83",
    executable: "308f51035814a30351d9cda95a15749ee9c3022c48c42643adc58a8032a417c4",
    introducedBy: "583cb9e8263635d1d417ff5c7b3497603043c501",
    label: PRE_PUBLICATION,
  },
  {
    journal: "mail",
    tag: "0027_organizer_lease",
    recorded: "559044c0f5a4622043321f5a1fe890b3d13817f3ea5fd6ff81b1ed125b246aef",
    executable: "81735de3372475ad14745698137a836e341a60275545ae3410a2b06c0b1c215a",
    introducedBy: "627dc031b6f92dfdceb07c61131046101ad98d3b",
    label: PRE_PUBLICATION,
  },
  {
    journal: "mail",
    tag: "0028_message_instances",
    recorded: "82b0e2c9ce4d758f665caade9c68b757c2b23ed9d3c8790e8bde1b3c56f4dc05",
    executable: "f845f020bb18d3bb3c238b9187e0b0f2905fdf7e77f9cf39930a3a1b332d4c9a",
    introducedBy: "982a0bed94773f85187ef71bd7469067ad92079b",
    label: PRE_PUBLICATION,
  },
  {
    journal: "mail",
    tag: "0029_mailbox_sync_block",
    recorded: "38a14344f094e951662f736a316b1732544619bde158dcfd5be777af258710c3",
    executable: "4749fcf1d108f51c2a94e3fd569894bacfc0c0828bbe10834ddf6e518b872498",
    introducedBy: "0e02b38fcbad81be3e833077eed0ad9ec286d457",
    label: PRE_PUBLICATION,
  },
  {
    journal: "mail",
    tag: "0030_sensitive_rescreen",
    recorded: "f938b6eaa871b83976817e50f2bc242a8d9c85c0bbf2b21b3f2b8c542087d0dd",
    executable: "f008077010f42e02688ac94b48f473dcdaadde14a28a2d9ec34edb5a79817f5d",
    introducedBy: "b829af7fccf9bf63f04c74343d57bafc9a38bea9",
    label: PRE_PUBLICATION,
  },
  {
    journal: "mail",
    tag: "0032_unsubscribe_records",
    recorded: "5ac32e8e1dbc7224bdf1e0ea0478359bf3de05cabfc0bcf8a5c6e626c8ce5084",
    executable: "4feb459b06e5171758e3627f7af3885288a83e58435b2ffb34ea72567d4f31ff",
    introducedBy: "2b84add176bb9c6fae45d8b8a55bc26c2d392411",
    label: PRE_PUBLICATION,
  },
  {
    journal: "mail",
    tag: "0033_workflow_run_claim",
    recorded: "f94ff5e1d1f27db85ae7b351f653a05afaa4ee3c6a1d68e7a48ebf5a6825434e",
    executable: "dc488109390010cf7f2054b38b6861ce76f773c96f5254dfebcd0d211511bee5",
    introducedBy: "4a368bedfc3dfb03db94df349ac42d252648cc3b",
    label: PRE_PUBLICATION,
  },
  {
    journal: "mail",
    tag: "0034_rule_retro",
    recorded: "e93e94879e8725ea0ad677abd62d321056ad971a51d26333e34c2ad83b97a50b",
    executable: "da577f83f218a973af4b9451476b543ce833e9429e5cf712b34a96a733ba5972",
    introducedBy: "364f54326903067fd19e70dd00193e83f42e757a",
    label: PRE_PUBLICATION,
  },
  {
    journal: "mail",
    tag: "0035_account_settings",
    recorded: "d5824b7286bb9c1452a596a6f984a783e22c07406c76ef6825614b79b419f843",
    executable: "15ac202a4b51c792bf2ecd87cc4abce50ef3d71c5032c71c05cfc8440a10f093",
    introducedBy: "4afc7211913aad7a17fc90286b5a51d2aeebfb0d",
    label: PRE_PUBLICATION,
  },
  {
    journal: "mail",
    tag: "0036_sensitive_fp_backfill",
    recorded: "a7e1b60faddd2a56f28537cc507eadfe5ed0abde42536e1d5f171c92014b6a8b",
    executable: "b7862f6f290242d759346d8303636819ccf2fa9c283fc2df7841cba5df361700",
    introducedBy: "4905debfdfb0facbf224d3e6b9116a52189048f9",
    label: PRE_PUBLICATION,
  },
  {
    journal: "mail",
    tag: "0037_draft_html",
    recorded: "7237cafe837fe1cd50c567f2e2de8fbd4ac57370970a9b437c79d4a61cd1ae0f",
    executable: "b12400fff79547a4079dd6b27ec1359cd8ccc7fe32be759b579d73aa5ee844e0",
    introducedBy: "25f88b99294beabd62da68708eebb16ce07f56ff",
    label: PRE_PUBLICATION,
  },
  {
    journal: "mail",
    tag: "0038_initial_import_completed",
    recorded: "96108996ae39f92c83f80abaffb958ed846396b07551a65949e884ba21e4830f",
    executable: "8a15b219ce45c10aec294c694cddc23f4687900f3181647133edccc53109d99e",
    introducedBy: "59aa570dbc37ad62ce18da3254e933b1ffb397c6",
    label: PRE_PUBLICATION,
  },
  {
    journal: "mail",
    tag: "0039_mailbox_retry_after",
    recorded: "a73d0420bece3eee966752f284ceb3c0e893ba265dc7f6bd4b01844d6d82e7ee",
    executable: "81aaa4e346c1c35827c2361af5d8659ae7bdffcac48dc503b3af28a36e7f98b9",
    introducedBy: "4612278d41e0ca71193cfbc6702deb40df740aa6",
    label: PRE_PUBLICATION,
  },
  {
    journal: "mail",
    tag: "0040_auto_suggest",
    recorded: "f0c90bfce57e2b8f674eecec384ca55ce6b8f5d0f612f255262dabbec83071bd",
    executable: "44cce2724050b984b7a236e2b2198f5c96f067de4a0b46744dc680b473fe8954",
    introducedBy: "19dbc1389571280a2588d4971a6d3581a68938f9",
    label: PRE_PUBLICATION,
  },
  {
    journal: "mail",
    tag: "0042_screening_preference",
    recorded: "d0ebddb6db6fc5ee8e844669c2391797d4a14a281ef72e467267dfe138247b0e",
    executable: "781bc038a7bc40d1fb655d19cdfaeb3cec357416ba9cbd3d8fae33186a9f14e2",
    introducedBy: "9b39c787cf5ba667acfa2e2b5811d86ebe7d66f9",
    label: PRE_PUBLICATION,
  },
  {
    journal: "mail",
    tag: "0043_ohbox_tidy",
    recorded: "78ed7d3e46380942dad8fc7d2c20dfd82afd82bb8175806b09f6bf319d2b3cf2",
    executable: "79538f130496ae93cb322e89f203d3f6e5d28b1e941fc85b29f900287b879238",
    introducedBy: "53b11838beb33738a91bb1a69c0f59c007220d49",
    label: PRE_PUBLICATION,
  },
  {
    journal: "mail",
    tag: "0051_away_responder",
    recorded: "2fbd6faa50c8e2332ea00d116fd25547b435c88cedffc6adb1acf43d24d5d1d2",
    executable: "20e2812719b32eb43d8202669ae6b96aeaee89133966121df3318f7743d4e3cc",
    introducedBy: "d02db6ee1fc8d806325354f3ae4c65402af09d96",
    label: PRE_PUBLICATION,
  },
  {
    journal: "mail",
    tag: "0076_junk_sweep_request",
    recorded: "e58f7a5bb0d132a275dc04b1015c35c9cd83abef1b351fd693340384ac0a9cc8",
    executable: "5954646982b56de75fe4effedcddb8c3b8b81eb3ab4c323ec5be20e8641c0447",
    introducedBy: "e5ec1fd356f09d67d9cd98e7d3b5142d12b7ca6b",
    label: PRE_PUBLICATION,
  },
  {
    journal: "cloud",
    tag: "0003_observability",
    recorded: "3a51cf24c18aaf3c719424f039ef422e2a7a24a7700652047d49561eea130841",
    executable: "37f3e58c6c3d953e3b1f864e278efa80622a05900a5cfc9e02ff6e13359d3895",
    introducedBy: "fc882c5fd10ed77f05fb963141e4182b22ad6c9b",
    label: PRE_PUBLICATION,
  },
  {
    journal: "cloud",
    tag: "0004_waitlist_invites",
    recorded: "7bccabc24e8136cc1fe079aeb213f0109dfa080a713cc6aac236e94805822496",
    executable: "a504e5e633bc4d5ea8116ace8d3f3cc0c6548aa68f5e0e33d6693700445179f1",
    introducedBy: "fc882c5fd10ed77f05fb963141e4182b22ad6c9b",
    label: PRE_PUBLICATION,
  },
  {
    journal: "cloud",
    tag: "0007_staff_users",
    recorded: "38420eef2df9959405ea2f4cfe5e52c7c10c657b73b2942efe5f8ccc64bed56a",
    executable: "9aabfa85c3f93ad2521d81c3e26c407828b275d26c658243e21d4921eed2e864",
    introducedBy: "4e5a9cd62f8aa00773445e79fd31ba6b296543c8",
    label: PRE_PUBLICATION,
  },
  {
    journal: "cloud",
    tag: "0009_mailbox_oauth",
    recorded: "3340bdb8c316ad148d73751190d0df2d7ce6cfbde3bccdbcf24ad6d76dfd1672",
    executable: "80d32b9eda9393c957a6588d04009e684f479bc5f6728f6cd5812b4c5e77ea87",
    introducedBy: "1d596962b3bc8bd16ffbe13d9d217f25e3e2cc67",
    label: PRE_PUBLICATION,
  },
] as const;

/**
 * The version this record names for EXACTLY this journal, tag and recorded hash, or null. Plain
 * equality on all three: a row can never answer for another tag, another journal, or a hash it
 * does not spell out in full.
 */
export function prePublicationVersionFor(
  journal: string,
  tag: string,
  recorded: string,
  record: readonly PrePublicationVersion[] = PRE_PUBLICATION_VERSIONS,
): PrePublicationVersion | null {
  return record.find((v) => v.journal === journal && v.tag === tag && v.recorded === recorded) ?? null;
}
