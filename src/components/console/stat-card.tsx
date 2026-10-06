import { Card } from "@heroui/react";

export default function StatCard({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <Card className="gap-1">
      <Card.Description>{label}</Card.Description>
      <p className="text-xl font-semibold tracking-tight">{value}</p>
    </Card>
  );
}
