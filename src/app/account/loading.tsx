"use client";

import AccountShell from "@/app/account/_components/account-shell";
import FormSkeleton from "@/app/account/_components/form-skeleton";

export default function AccountLoading() {
  return (
    <AccountShell>
      <FormSkeleton fields={2} />
    </AccountShell>
  );
}
