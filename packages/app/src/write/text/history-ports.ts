export interface QuotedHistoryControl {
  readonly load: () => Promise<readonly string[]>;
  readonly show: string;
  readonly hide: string;
  readonly edit: string;
  readonly restore: string;
  readonly unavailable: string;
}
