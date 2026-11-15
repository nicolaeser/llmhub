import { errorFields } from "@/lib/logging/format";

export const PREFERENCE_CHANNEL = "llmhub-preferences-v1";

type Preference = "sidebar" | "time-zone";
type Subscription = { preference: Preference; listener: () => void };

const subscriptions = new Set<Subscription>();
let channel: BroadcastChannel | null = null;

function notify(preference?: Preference) {
  for (const subscription of subscriptions) {
    if (!preference || subscription.preference === preference) subscription.listener();
  }
}

function syncOnFocus() {
  notify();
}

function syncOnVisible() {
  if (document.visibilityState === "visible") notify();
}

function openChannel(): BroadcastChannel | null {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return null;
  try {
    return new BroadcastChannel(PREFERENCE_CHANNEL);
  } catch (err) {
    console.warn("preferences.channel_unavailable", errorFields(err));
    return null;
  }
}

export function onPreferenceChange(preference: Preference, listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const subscribedWindow = window;
  const subscribedDocument = document;
  if (subscriptions.size === 0) {
    channel = openChannel();
    if (channel) {
      channel.onmessage = (event: MessageEvent<unknown>) => {
        if (event.data === "sidebar" || event.data === "time-zone") notify(event.data);
      };
    }
    window.addEventListener("focus", syncOnFocus);
    document.addEventListener("visibilitychange", syncOnVisible);
  }
  const subscription = { preference, listener };
  subscriptions.add(subscription);
  listener();
  return () => {
    if (!subscriptions.delete(subscription)) return;
    if (subscriptions.size > 0) return;
    channel?.close();
    channel = null;
    subscribedWindow.removeEventListener("focus", syncOnFocus);
    subscribedDocument.removeEventListener("visibilitychange", syncOnVisible);
  };
}

export function notifyPreferenceChange(preference: Preference) {
  if (typeof window === "undefined") return;
  notify(preference);
  const target = channel ?? openChannel();
  try {
    target?.postMessage(preference);
  } catch (err) {
    console.warn("preferences.broadcast_failed", errorFields(err));
  } finally {
    if (target !== channel) target?.close();
  }
}
