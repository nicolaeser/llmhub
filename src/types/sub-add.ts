import type { z } from "zod";
import type { subAddLinkInputSchema } from "@/schemas/sub-add";
import type { AssignmentTarget, SignInKind, SignInStatus } from "@/types/providers";

export type SubAddStatus = "active" | "expired" | "revoked" | "used_up";

export type SubAddLinkState = {
  expiresAt: Date | string;
  revokedAt: Date | string | null;
  maxAccounts: number | null;
  added: number;
};

export type SubAddLinkRecord = SubAddLinkState & {
  id: string;
  label: string;
  kinds: string[];
  expiresAt: Date;
  revokedAt: Date | null;
};

export type SubAddAccountRecord = {
  providerId: string;
  createdAt: Date;
  provider: { kind: string; enabled: boolean; login: { account: string; plan: string; status: string } | null };
};

export type SubAddLinkInput = z.infer<typeof subAddLinkInputSchema>;

export type SubAddAccountView = {
  providerId: string;
  kind: SignInKind;
  account: string;
  plan: string;
  status: SignInStatus;
  enabled: boolean;
  addedAt: string;
};

export type SubAddLinkView = {
  id: string;
  label: string;
  kinds: SignInKind[];
  maxAccounts: number | null;
  added: number;
  restricted: boolean;
  targets: AssignmentTarget[];
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  createdBy: string;
  accounts: SubAddAccountView[];
};

export type SubAddLinksPayload = {
  links: SubAddLinkView[];
  kinds: SignInKind[];
  canManage: boolean;
};

export type SubAddCreated = {
  link: SubAddLinkView;
  url: string;
};

export type SubAddOffer = {
  label: string;
  instance: string;
  kinds: SignInKind[];
  remaining: number | null;
  expiresAt: string;
};

export type SubAddOutcome = "created" | "updated";

export type SubAddDone = {
  kind: SignInKind;
  account: string;
  plan: string;
  outcome: SubAddOutcome;
  manageToken: string;
};

export type SubAddStep = { state: "pending"; interval: number } | ({ state: "done" } & SubAddDone);

export type SubAddContributions = {
  instance: string;
  accounts: SubAddAccountView[];
};
