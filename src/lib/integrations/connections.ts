import "server-only";
import prisma from "@/lib/db/prisma";
import { companyOf } from "@/lib/auth/scope";
import { metadataOf, openEnvelope, sealEnvelope } from "@/lib/integrations/credentials";
import { assertCompany, audit, credentialUser } from "@/lib/integrations/guards";
import { authorizeUrl, exchangeClient, exchangeCode, oauthState, pkcePair } from "@/lib/integrations/oauth";
import { loadIntegrationPage } from "@/lib/integrations/page";
import { asJson, fail, parse, strings } from "@/lib/integrations/records";
import { tokenFetch } from "@/lib/integrations/runtime";
import { checkServerUrl } from "@/lib/mcp/url-guard";
import { guardedFetch } from "@/lib/mcp/transport";
import { McpError } from "@/lib/mcp/errors";
import { connectionSchema, oauthCompleteSchema } from "@/schemas/integrations";
import type { IntegrationPage } from "@/types/integrations";

export async function saveConnection(raw: unknown): Promise<IntegrationPage> {
  const session = await credentialUser();
  const input = parse(connectionSchema, raw);
  const integration = await prisma.companyIntegration.findUnique({
    where: { id: input.companyIntegrationId },
    include: { blueprint: { select: { baseUrl: true } } },
  });
  if (!integration) fail("INTEGRATION_NOT_FOUND");
  assertCompany(session, integration.orgId);
  if (input.internal && companyOf(session)) fail("PLATFORM_ONLY");
  const baseUrl = input.baseUrl || integration.blueprint?.baseUrl || "";
  if (baseUrl) {
    const verdict = checkServerUrl(baseUrl, input.internal);
    if (!verdict.ok) fail(verdict.code);
  }
  const metadata = {
    headerName: input.headerName,
    tokenUrl: input.tokenUrl,
    authorizeUrl: input.authorizeUrl,
    clientId: input.clientId,
    scopes: input.scopes ?? [],
  };
  const envelope = input.secret
    ? input.authMethod === "basic"
      ? { apiKey: input.secret }
      : input.authMethod === "oauth2"
        ? { clientSecret: input.secret }
        : { apiKey: input.secret, accessToken: input.authMethod === "bearer" || input.authMethod === "service_account" ? input.secret : undefined }
    : null;
  const secretData = envelope ? sealEnvelope(envelope) : undefined;
  if (input.authMethod !== "none" && !secretData && !input.id) fail("CREDENTIAL_REQUIRED");
  const data = {
    name: input.name,
    authMethod: input.authMethod,
    baseUrl,
    internal: input.internal,
    status: secretData || input.authMethod === "none" ? "configured" : "unconfigured",
    providerScopes: asJson(input.scopes ?? []),
  };
  const connection = input.id
    ? await prisma.connection.update({ where: { id: input.id }, data })
    : await prisma.connection.create({
        data: { ...data, orgId: integration.orgId, companyIntegrationId: integration.id, createdById: session.user.id },
      });
  if (connection.orgId !== integration.orgId) fail("FORBIDDEN");
  if (secretData) {
    await prisma.credentialReference.upsert({
      where: { connectionId: connection.id },
      create: {
        orgId: integration.orgId,
        connectionId: connection.id,
        kind: input.authMethod,
        label: input.label ?? "",
        sealedSecret: secretData,
        metadata: asJson(metadata),
      },
      update: { sealedSecret: secretData, label: input.label ?? "", kind: input.authMethod, metadata: asJson(metadata), revokedAt: null, rotatedAt: new Date() },
    });
  }
  await audit(session, "integration.connection_save", connection.id, { authMethod: input.authMethod, hasSecret: Boolean(secretData) });
  return loadIntegrationPage();
}

export async function beginOauth(connectionId: string): Promise<{ authorizeUrl: string; state: string; page: IntegrationPage }> {
  const session = await credentialUser();
  const connection = await prisma.connection.findUnique({ where: { id: connectionId }, include: { credential: true } });
  if (!connection) fail("INTEGRATION_NOT_FOUND");
  assertCompany(session, connection.orgId);
  const metadata = metadataOf(connection.credential?.metadata);
  if (!metadata.authorizeUrl || !metadata.clientId) fail("CREDENTIAL_REQUIRED");
  const pair = pkcePair();
  const state = oauthState();
  const current = openEnvelope(connection.credential?.sealedSecret ?? "");
  const sealed = sealEnvelope({ ...current, verifier: pair.verifier });
  await prisma.credentialReference.upsert({
    where: { connectionId: connection.id },
    create: {
      orgId: connection.orgId,
      connectionId: connection.id,
      kind: "oauth2",
      sealedSecret: sealed,
      metadata: asJson({ ...metadata, state }),
    },
    update: { sealedSecret: sealed, metadata: asJson({ ...metadata, state }) },
  });
  return {
    authorizeUrl: authorizeUrl({
      authorizeUrl: metadata.authorizeUrl,
      clientId: metadata.clientId,
      scopes: metadata.scopes ?? [],
      state,
      challenge: pair.challenge,
    }),
    state,
    page: await loadIntegrationPage(),
  };
}

export async function completeOauth(raw: unknown): Promise<IntegrationPage> {
  const session = await credentialUser();
  const input = parse(oauthCompleteSchema, raw);
  const connection = await prisma.connection.findUnique({ where: { id: input.connectionId }, include: { credential: true } });
  if (!connection?.credential) fail("CREDENTIAL_REQUIRED");
  assertCompany(session, connection.orgId);
  const metadata = metadataOf(connection.credential.metadata);
  if (!metadata.state || metadata.state !== input.state || !metadata.tokenUrl || !metadata.clientId) fail("VALIDATION");
  const current = openEnvelope(connection.credential.sealedSecret);
  if (!current.verifier) fail("CREDENTIAL_REQUIRED");
  const fetched = await exchangeCode(
    {
      tokenUrl: metadata.tokenUrl,
      clientId: metadata.clientId,
      clientSecret: current.clientSecret,
      code: input.code,
      verifier: current.verifier,
    },
    tokenFetch(connection.internal),
  );
  await prisma.credentialReference.update({
    where: { connectionId: connection.id },
    data: {
      sealedSecret: sealEnvelope({ ...current, ...fetched.envelope, verifier: undefined }),
      expiresAt: fetched.expiresAt ? new Date(fetched.expiresAt) : null,
      metadata: asJson({ ...metadata, state: "" }),
    },
  });
  await prisma.connection.update({
    where: { id: connection.id },
    data: { status: "configured", providerScopes: asJson(fetched.scopes.length ? fetched.scopes : strings(connection.providerScopes)) },
  });
  await audit(session, "integration.oauth_complete", connection.id, { hasSecret: true });
  return loadIntegrationPage();
}

export async function checkConnection(connectionId: string): Promise<IntegrationPage> {
  const session = await credentialUser();
  const connection = await prisma.connection.findUnique({ where: { id: connectionId } });
  if (!connection) fail("INTEGRATION_NOT_FOUND");
  assertCompany(session, connection.orgId);
  let status = "unconfigured";
  let healthError: string;
  if (!connection.baseUrl) healthError = "MCP_URL_INVALID";
  else {
    try {
      const response = await guardedFetch(connection.internal)(connection.baseUrl, { method: "GET", headers: {}, signal: AbortSignal.timeout(10_000) });
      await response.body?.cancel();
      status = response.status >= 200 && response.status < 300 ? "healthy" : "error";
      healthError = status === "healthy" ? "" : `http_${response.status}`;
    } catch (err) {
      status = "error";
      healthError = err instanceof McpError ? err.code : "MCP_UNREACHABLE";
    }
  }
  await prisma.connection.update({
    where: { id: connection.id },
    data: { status, healthError, healthCheckedAt: new Date() },
  });
  await audit(session, "integration.connection_health", connection.id, { status, healthError });
  return loadIntegrationPage();
}

export async function revokeCredential(connectionId: string): Promise<IntegrationPage> {
  const session = await credentialUser();
  const connection = await prisma.connection.findUnique({ where: { id: connectionId }, include: { credential: true } });
  if (!connection?.credential) fail("CREDENTIAL_REQUIRED");
  assertCompany(session, connection.orgId);
  await prisma.credentialReference.update({
    where: { id: connection.credential.id },
    data: { sealedSecret: "", revokedAt: new Date() },
  });
  await prisma.connection.update({ where: { id: connection.id }, data: { status: "revoked" } });
  await audit(session, "integration.credential_revoke", connection.id, { revoked: true });
  return loadIntegrationPage();
}

export async function clientCredentials(connectionId: string): Promise<IntegrationPage> {
  const session = await credentialUser();
  const connection = await prisma.connection.findUnique({ where: { id: connectionId }, include: { credential: true } });
  if (!connection?.credential) fail("CREDENTIAL_REQUIRED");
  assertCompany(session, connection.orgId);
  const metadata = metadataOf(connection.credential.metadata);
  const envelope = openEnvelope(connection.credential.sealedSecret);
  if (!metadata.tokenUrl || !metadata.clientId || !envelope.clientSecret) fail("CREDENTIAL_REQUIRED");
  const fetched = await exchangeClient(
    { tokenUrl: metadata.tokenUrl, clientId: metadata.clientId, clientSecret: envelope.clientSecret, scopes: metadata.scopes ?? [] },
    tokenFetch(connection.internal),
  );
  await prisma.credentialReference.update({
    where: { id: connection.credential.id },
    data: {
      sealedSecret: sealEnvelope({ ...envelope, ...fetched.envelope }),
      expiresAt: fetched.expiresAt ? new Date(fetched.expiresAt) : null,
      rotatedAt: new Date(),
    },
  });
  await audit(session, "integration.client_credentials", connection.id, { hasSecret: true });
  return loadIntegrationPage();
}
