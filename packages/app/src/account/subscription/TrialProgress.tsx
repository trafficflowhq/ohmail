import { SettingLine } from "@ohmail/ui/mail";
import { useText } from "../../text/index.js";
import type { SubscriptionStatus } from "./model.js";
import "./trial-progress.css";

export function TrialProgress({
  progress,
  phone,
}: {
  phone?: boolean;
  progress: NonNullable<SubscriptionStatus["trialProgress"]>;
}) {
  const t = useText("accountSubscription");
  const steps = Math.min(progress.total, 31);
  return (
    <>
      <SettingLine label={t("trialDay")} value={t("trialDayOf", progress)} />
      <div className="trial-progress" data-phone={phone ? "" : undefined} aria-hidden="true">
        {Array.from({ length: steps }, (_, index) => (
          <span
            className="trial-progress-day"
            key={index}
            data-elapsed={index < (progress.day * steps) / progress.total ? "" : undefined}
          />
        ))}
      </div>
    </>
  );
}
