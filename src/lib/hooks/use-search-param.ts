import { useSyncExternalStore } from "react";

const CHANGE_EVENT = "llmhub:searchparams";

const subscribe = (onChange: () => void) => {
  window.addEventListener("popstate", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
};

export function useSearchParam(name: string): string | null | undefined {
  return useSyncExternalStore(
    subscribe,
    () => new URLSearchParams(window.location.search).get(name),
    () => undefined,
  );
}

function writeSearch(params: URLSearchParams) {
  const query = params.toString();
  window.history.replaceState(null, "", query ? `?${query}` : window.location.pathname);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function setSearchParams(values: Record<string, string | null>) {
  const params = new URLSearchParams(window.location.search);
  for (const [name, value] of Object.entries(values)) {
    if (value === null) params.delete(name);
    else params.set(name, value);
  }
  writeSearch(params);
}

export function useTabParam<T extends string>(tabs: readonly T[]): [T | undefined, (tab: string) => void] {
  const requested = useSearchParam("tab");
  const selected = tabs.find((tab) => tab === requested) ?? tabs[0];
  const select = (tab: string) => writeSearch(new URLSearchParams(tab === tabs[0] ? {} : { tab }));
  return [selected, select];
}
