import { useSyncExternalStore } from "react";

export const BELOW_MD = "(width < 48rem)";
export const BELOW_LG = "(width < 64rem)";
export const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
