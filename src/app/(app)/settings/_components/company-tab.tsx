"use client";

import { Card } from "@heroui/react";
import { Blocks, Building2, KeyRound, Shield, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import McpConnectionsCard from "@/components/mcp/connections-card";
import { Link } from "@/i18n/routing";
import { loadCompanyMcpSettingsAction, saveCompanyMcpSettingsAction } from "../_action";

const AREAS: { id: "structure" | "keys" | "guardrails" | "mcp"; icon: LucideIcon; href: (orgId: string) => string }[] = [
  { id: "structure", icon: Building2, href: (orgId) => `/companies?node=org:${orgId}` },
  { id: "keys", icon: KeyRound, href: () => "/keys" },
  { id: "guardrails", icon: Shield, href: () => "/guardrails" },
  { id: "mcp", icon: Blocks, href: () => "/mcp" },
];

export default function CompanyTab({ company }: { company: { id: string; alias: string } }) {
  const t = useTranslations("Settings.company");

  return (
    <div className="space-y-5">
      <Card>
        <Card.Header>
          <Card.Title>{t("title", { name: company.alias })}</Card.Title>
          <Card.Description>{t("description")}</Card.Description>
        </Card.Header>
        <Card.Content>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {AREAS.map((area) => (
              <Card key={area.id} variant="secondary">
                <Card.Header className="gap-3">
                  <IconTile icon={area.icon} size="sm" />
                  <Card.Title className="text-sm">{t("area", { area: area.id })}</Card.Title>
                  <Card.Description>{t("areaHint", { area: area.id })}</Card.Description>
                </Card.Header>
                <Card.Footer>
                  <Link href={area.href(company.id)} className="text-sm font-medium text-accent">
                    {t("open")}
                  </Link>
                </Card.Footer>
              </Card>
            ))}
          </div>
        </Card.Content>
      </Card>
      <McpConnectionsCard
        key={company.id}
        orgId={company.id}
        load={loadCompanyMcpSettingsAction}
        onInstall={saveCompanyMcpSettingsAction}
      />
    </div>
  );
}
