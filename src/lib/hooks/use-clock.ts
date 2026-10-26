"use client";

import { useSyncExternalStore } from "react";
import { useNow } from "next-intl";

type Clock = {
  read: () => Date;
  subscribe: (onChange: () => void) => () => void;
};

const clocks = new Map<number, Clock>();

export function createClock(updateInterval: number): Clock {
  const listeners = new Set<() => void>();
  let current: Date | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  function tick() {
    current = new Date();
    for (const listener of listeners) listener();
  }

  return {
    read() {
      if (!current || Date.now() - current.getTime() >= updateInterval) current = new Date();
      return current;
    },
    subscribe(onChange) {
      if (listeners.size === 0) timer = setInterval(tick, updateInterval);
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0) clearInterval(timer);
      };
    },
  };
}

function clockFor(updateInterval: number): Clock {
  let clock = clocks.get(updateInterval);
  if (!clock) {
    clock = createClock(updateInterval);
    clocks.set(updateInterval, clock);
  }
  return clock;
}

export function useClock(updateInterval: number): Date {
  const requestNow = useNow();
  const clock = clockFor(updateInterval);
  return useSyncExternalStore(clock.subscribe, clock.read, () => requestNow);
}
