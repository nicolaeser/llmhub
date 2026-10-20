"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "@/i18n/routing";
import { useErrorToast } from "@/components/console/use-error-toast";
import { notifyWorkspace, onWorkspaceChange, relayOtherTabs } from "@/lib/auth/workspace-event";
import { isActionFail } from "@/lib/http/action-result";
import type { Permission } from "@/types/auth";
import type { ConsoleScope, ConsoleScopeState, ScopeCompany, ScopeKind, WorkspaceChange } from "@/types/console";
import { loadConsoleScopeAction, setWorkspaceAction } from "../_action";
import { homePath, platformOnlyPath } from "./nav-data";

type ConsoleScopeValue = ConsoleScopeState & {
  kind: ScopeKind;
  shown: boolean;
  pending: boolean;
  switchTo: (orgId: string | null) => void;
  refresh: () => void;
};

const PLATFORM_ONLY: ConsoleScopeValue = {
  scope: { kind: "platform" },
  companies: [],
  canSwitch: false,
  kind: "platform",
  shown: false,
  pending: false,
  switchTo: () => {},
  refresh: () => {},
};

const ConsoleScopeContext = createContext<ConsoleScopeValue>(PLATFORM_ONLY);

export function useConsoleScope(): ConsoleScopeValue {
  return useContext(ConsoleScopeContext);
}

function scopeKey(scope: ConsoleScope): string | null {
  return scope.kind === "company" ? scope.id : null;
}

function byAlias(a: ScopeCompany, b: ScopeCompany) {
  return a.alias.localeCompare(b.alias);
}

function applyChange(state: ConsoleScopeState, change: WorkspaceChange): ConsoleScopeState {
  if (!change.orgId) return { ...state, scope: { kind: "platform" } };
  const known = state.companies.find((company) => company.id === change.orgId);
  const company = { id: change.orgId, alias: change.alias || known?.alias || "" };
  return {
    ...state,
    scope: { kind: "company", ...company },
    companies: known
      ? state.companies.map((row) => (row.id === company.id ? company : row))
      : [...state.companies, company].sort(byAlias),
  };
}

export default function ConsoleScopeProvider({
  initial,
  permissions,
  children,
}: {
  initial: ConsoleScopeState;
  permissions: readonly Permission[];
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const showError = useErrorToast();
  const [state, setState] = useState(initial);
  const [pending, startSwitch] = useTransition();
  const [, startRefresh] = useTransition();
  const current = useRef(state);

  useEffect(() => {
    current.current = state;
  });

  const kind = state.scope.kind;

  useEffect(() => {
    if (kind === "company" && platformOnlyPath(pathname)) router.replace(homePath(permissions, "company"));
  }, [kind, pathname, permissions, router]);

  useEffect(() => relayOtherTabs(), []);

  useEffect(
    () => onWorkspaceChange((change: WorkspaceChange) => setState((previous) => applyChange(previous, change))),
    [],
  );

  const switchTo = useCallback(
    (orgId: string | null) => {
      if (orgId === scopeKey(current.current.scope)) return;
      startSwitch(async () => {
        const result = await setWorkspaceAction(orgId ?? "");
        if (isActionFail(result)) {
          showError(result.error);
          return;
        }
        notifyWorkspace({ orgId: result.orgId, alias: result.alias });
      });
    },
    [showError],
  );

  const refresh = useCallback(() => {
    startRefresh(async () => {
      const result = await loadConsoleScopeAction();
      if (isActionFail(result)) return;
      const moved = scopeKey(result.scope) !== scopeKey(current.current.scope);
      setState(result);
      if (moved) {
        notifyWorkspace({
          orgId: scopeKey(result.scope),
          alias: result.scope.kind === "company" ? result.scope.alias : "",
        });
      }
    });
  }, []);

  const value = useMemo(
    () => ({
      ...state,
      kind,
      shown: state.scope.kind === "company" || (state.canSwitch && state.companies.length > 0),
      pending,
      switchTo,
      refresh,
    }),
    [state, kind, pending, switchTo, refresh],
  );

  return <ConsoleScopeContext.Provider value={value}>{children}</ConsoleScopeContext.Provider>;
}
