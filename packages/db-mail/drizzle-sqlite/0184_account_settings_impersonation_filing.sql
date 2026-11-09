-- 0184_account_settings_impersonation_filing — the pg column's twin (epoch ms).

ALTER TABLE "account_settings" ADD COLUMN "impersonation_filing_off_at" integer;
