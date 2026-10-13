import "server-only";
import { SCIM_GROUP_SCHEMA } from "@/lib/auth/scim-groups";
import { SCIM_LIST_SCHEMA, SCIM_USER_SCHEMA } from "@/lib/auth/scim";
import type { ScimAttribute } from "@/types/scim";

const SERVICE_PROVIDER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig";
const RESOURCE_TYPE_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:ResourceType";
const SCHEMA_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Schema";

function attribute(
  name: string,
  options: Partial<Pick<ScimAttribute, "type" | "multiValued" | "required" | "mutability" | "uniqueness" | "subAttributes">> = {},
): ScimAttribute {
  return {
    name,
    type: options.type ?? "string",
    multiValued: options.multiValued ?? false,
    required: options.required ?? false,
    caseExact: false,
    mutability: options.mutability ?? "readWrite",
    returned: "default",
    uniqueness: options.uniqueness ?? "none",
    ...(options.subAttributes ? { subAttributes: options.subAttributes } : {}),
  };
}

const valueList = (name: string, mutability: "readOnly" | "readWrite" = "readWrite") =>
  attribute(name, {
    type: "complex",
    multiValued: true,
    mutability,
    subAttributes: [attribute("value", { mutability }), attribute("display", { mutability: "readOnly" })],
  });

export const SCIM_SERVICE_PROVIDER_CONFIG = {
  schemas: [SERVICE_PROVIDER_SCHEMA],
  documentationUri: "https://datatracker.ietf.org/doc/html/rfc7644",
  patch: { supported: true },
  bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults: 200 },
  changePassword: { supported: false },
  sort: { supported: false },
  etag: { supported: false },
  authenticationSchemes: [
    {
      type: "oauthbearertoken",
      name: "OAuth Bearer Token",
      description: "The SCIM token created in the console settings.",
      primary: true,
    },
  ],
  meta: { resourceType: "ServiceProviderConfig" },
};

const RESOURCE_TYPES = [
  {
    schemas: [RESOURCE_TYPE_SCHEMA],
    id: "User",
    name: "User",
    endpoint: "/Users",
    schema: SCIM_USER_SCHEMA,
    meta: { resourceType: "ResourceType" },
  },
  {
    schemas: [RESOURCE_TYPE_SCHEMA],
    id: "Group",
    name: "Group",
    endpoint: "/Groups",
    schema: SCIM_GROUP_SCHEMA,
    meta: { resourceType: "ResourceType" },
  },
];

const SCHEMAS = [
  {
    schemas: [SCHEMA_SCHEMA],
    id: SCIM_USER_SCHEMA,
    name: "User",
    attributes: [
      attribute("userName", { required: true, uniqueness: "server" }),
      attribute("externalId", { uniqueness: "server" }),
      attribute("active", { type: "boolean" }),
      valueList("emails"),
      valueList("roles"),
      valueList("groups", "readOnly"),
    ],
    meta: { resourceType: "Schema" },
  },
  {
    schemas: [SCHEMA_SCHEMA],
    id: SCIM_GROUP_SCHEMA,
    name: "Group",
    attributes: [
      attribute("displayName", { required: true, uniqueness: "server" }),
      attribute("externalId", { uniqueness: "server" }),
      valueList("members"),
    ],
    meta: { resourceType: "Schema" },
  },
];

function listOf<T>(resources: T[]) {
  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: resources.length,
    startIndex: 1,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

export const SCIM_RESOURCE_TYPES = listOf(RESOURCE_TYPES);

export const SCIM_SCHEMAS = listOf(SCHEMAS);
