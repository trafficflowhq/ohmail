/**
 * The local diagnostic file's builder — `@trafficflow/core/diagnostics`, re-exported so the phone,
 * which reaches core only through this package, builds the file with the desktop's one builder.
 * A change is made in core. This package's tests hold the mirror's entity types equal to the
 * builder's list.
 */
export {
  DIAGNOSTIC_FILE_NAME,
  DIAGNOSTIC_LOG_LINES,
  buildDiagnosticBundle,
  diagnosticInstall,
  readSelfCheck,
  renderDiagnosticBundle,
  selfCheckSaid,
  type DiagnosticBundle,
  type DiagnosticInput,
  type DiagnosticInstallRecord,
  type DiagnosticMailboxInput,
  type SelfCheck,
  type SelfCheckDiffer,
  type SelfCheckSaid,
  type SelfCheckUnreadable,
} from "@trafficflow/core/diagnostics";
