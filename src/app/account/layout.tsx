import AreaMessages from "@/components/i18n/area-messages";

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return <AreaMessages area="account">{children}</AreaMessages>;
}
