import type { RoleTemplateKey } from "@/types/auth";

export type ScimErrorType =
  | "invalidFilter"
  | "tooMany"
  | "uniqueness"
  | "mutability"
  | "invalidSyntax"
  | "invalidPath"
  | "noTarget"
  | "invalidValue"
  | "invalidVers"
  | "sensitive";

type ScimMultiValue = { value?: string; primary?: boolean };

export type ScimUserInput = {
  userName?: string;
  emails?: ScimMultiValue[];
  roles?: ScimMultiValue[];
  active?: boolean;
};

export type ScimPatchOperation =
  | { op: "replace"; attribute: "active"; value: boolean }
  | { op: "replace"; attribute: "userName" | "email"; value: string }
  | { op: "replace"; attribute: "roles"; value: string[] }
  | { op: "remove"; attribute: "roles"; value: string[] | null };

export type ScimUserChanges = {
  userName?: string;
  email?: string;
  active?: boolean;
  roles?: string[];
};

export type ScimUserUpdate = {
  email?: string;
  username?: string;
  blocked?: boolean;
  roleKey?: RoleTemplateKey;
};
