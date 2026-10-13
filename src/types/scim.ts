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
  externalId?: string;
  emails?: ScimMultiValue[];
  roles?: ScimMultiValue[];
  active?: boolean;
};

export type ScimPatchOperation =
  | { op: "replace"; attribute: "active"; value: boolean }
  | { op: "replace"; attribute: "userName" | "email"; value: string }
  | { op: "replace"; attribute: "roles"; value: string[] }
  | { op: "replace"; attribute: "externalId"; value: string | null }
  | { op: "remove"; attribute: "roles"; value: string[] | null };

export type ScimUserChanges = {
  userName?: string;
  externalId?: string | null;
  email?: string;
  active?: boolean;
  roles?: string[];
};

export type ScimUserUpdate = {
  externalId?: string | null;
  email?: string;
  username?: string;
  blocked?: boolean;
  roleKey?: RoleTemplateKey;
};

export type ScimMeta = {
  resourceType: "User" | "Group";
  created?: string;
  lastModified?: string;
};

export type ScimUser = {
  schemas: string[];
  id: string;
  externalId?: string;
  userName: string;
  active: boolean;
  name: { formatted: string };
  emails: { value: string; primary: boolean }[];
  roles?: { value: string }[];
  groups?: { value: string; display: string }[];
  meta: ScimMeta;
};

export type ScimMember = { value: string; display: string; type: "User" };

export type ScimGroup = {
  schemas: string[];
  id: string;
  displayName: string;
  externalId?: string;
  members?: ScimMember[];
  meta: ScimMeta;
};

export type ScimGroupInput = {
  displayName: string;
  externalId: string | null;
  members: string[];
};

export type ScimGroupOperation =
  | { kind: "displayName"; value: string }
  | { kind: "externalId"; value: string | null }
  | { kind: "addMembers"; ids: string[] }
  | { kind: "removeMembers"; ids: string[] | null }
  | { kind: "replaceMembers"; ids: string[] };

export type ScimFilter = { attribute: string; value: string } | null;

export type ScimPage = { startIndex: number; count: number };

export type ScimAttribute = {
  name: string;
  type: "string" | "boolean" | "complex" | "reference";
  multiValued: boolean;
  required: boolean;
  caseExact: boolean;
  mutability: "readOnly" | "readWrite" | "immutable";
  returned: "default";
  uniqueness: "none" | "server";
  subAttributes?: ScimAttribute[];
};
