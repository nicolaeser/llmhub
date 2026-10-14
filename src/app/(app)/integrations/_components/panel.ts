import type { IntegrationPage } from "@/types/integrations";

export type PanelProps = {
  page: IntegrationPage;
  onPage: (page: IntegrationPage) => void;
};
