"use client";

import { Activity } from "lucide-react";
import { PageLoading } from "@/components/console/page-status";

export default function LogSessionLoading() {
  return <PageLoading icon={Activity} header tabs layout="chat" />;
}
