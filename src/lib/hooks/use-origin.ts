import { useSyncExternalStore } from "react";

const noSubscription = () => () => {};

export function useOrigin(): string {
  return useSyncExternalStore(
    noSubscription,
    () => window.location.origin,
    () => "",
  );
}
