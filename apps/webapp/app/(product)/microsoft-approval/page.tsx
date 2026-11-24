import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { DEFAULT_LOCALE, localeFromCookieHeader } from "../../shell/locale";

export default async function MicrosoftApprovalPage({
  searchParams,
}: {
  searchParams: Promise<{ oauth?: string | string[] }>;
}) {
  const { oauth } = await searchParams;
  if (oauth !== "approved" && oauth !== "declined") notFound();

  const request = await headers();
  const locale = localeFromCookieHeader(request.get("cookie")) ?? DEFAULT_LOCALE;
  const t = await getTranslations({ locale, namespace: "microsoftApprovalResult" });
  return (
    <main className="gate">
      <div className="gate-card">
        <p role="status">{oauth === "approved" ? t("approved") : t("declined")}</p>
      </div>
    </main>
  );
}
