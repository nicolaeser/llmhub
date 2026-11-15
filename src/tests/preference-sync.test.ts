import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useSidebarCollapsed } from "@/lib/hooks/use-sidebar-collapsed";
import { consoleTimeZone, setConsoleTimeZone } from "@/lib/hooks/use-console-time-zone";
import { notifyPreferenceChange, onPreferenceChange, PREFERENCE_CHANNEL } from "@/lib/utils/preference-sync";
import { sidebarCollapsedFromCookieHeader, writeSidebarCookie } from "@/lib/utils/sidebar-cookie";

class Channel {
  static instances: Channel[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  sent: unknown[] = [];
  closed = false;

  constructor(readonly name: string) {
    Channel.instances.push(this);
  }

  postMessage(value: unknown) {
    assert.equal(this.closed, false);
    this.sent.push(value);
  }

  close() {
    this.closed = true;
    this.onmessage = null;
  }
}

function replaceGlobal(t: TestContext, name: string, value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  });
}

function browser(t: TestContext, broadcast: unknown = Channel) {
  Channel.instances = [];
  const window = Object.assign(new EventTarget(), {
    location: { protocol: "https:" },
    localStorage: { getItem: () => null },
  });
  const document = Object.assign(new EventTarget(), { cookie: "", visibilityState: "visible" });
  replaceGlobal(t, "window", window);
  replaceGlobal(t, "document", document);
  replaceGlobal(t, "BroadcastChannel", broadcast);
  return { window, document };
}

test("preference subscriptions share one channel and deliver only the changed preference without echoes", (t) => {
  browser(t);
  let sidebar = 0;
  let timeZone = 0;
  const stopSidebar = onPreferenceChange("sidebar", () => sidebar++);
  const stopZone = onPreferenceChange("time-zone", () => timeZone++);
  t.after(stopSidebar);
  t.after(stopZone);
  assert.equal(Channel.instances.length, 1);
  const channel = Channel.instances[0];
  assert.equal(channel.name, PREFERENCE_CHANNEL);
  assert.deepEqual([sidebar, timeZone], [1, 1]);

  notifyPreferenceChange("sidebar");
  assert.deepEqual([sidebar, timeZone], [2, 1]);
  assert.deepEqual(channel.sent, ["sidebar"]);

  channel.onmessage?.({ data: "time-zone" });
  assert.deepEqual([sidebar, timeZone], [2, 2]);
  for (const data of [null, {}, { type: "sidebar" }, "theme", 1]) channel.onmessage?.({ data });
  assert.deepEqual([sidebar, timeZone], [2, 2]);
  assert.deepEqual(channel.sent, ["sidebar"]);

  stopSidebar();
  assert.equal(channel.closed, false);
  stopZone();
  assert.equal(channel.closed, true);
});

test("focus and visibility reconcile cookies and cleanup supports remounts", (t) => {
  const { window, document } = browser(t);
  document.cookie = "llmhub_sidebar=expanded";
  const seen: (boolean | null)[] = [];
  const stop = onPreferenceChange("sidebar", () => seen.push(sidebarCollapsedFromCookieHeader(document.cookie)));
  t.after(stop);
  document.cookie = "llmhub_sidebar=collapsed";
  Channel.instances[0].onmessage?.({ data: "sidebar" });
  document.cookie = "llmhub_sidebar=expanded";
  window.dispatchEvent(new Event("focus"));
  document.visibilityState = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  document.cookie = "llmhub_sidebar=collapsed";
  document.visibilityState = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  assert.deepEqual([...seen], [false, true, false, true]);
  stop();
  window.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(seen.length, 4);
  const stopAgain = onPreferenceChange("sidebar", () => seen.push(sidebarCollapsedFromCookieHeader(document.cookie)));
  t.after(stopAgain);
  assert.equal(Channel.instances.length, 2);
  assert.equal(Channel.instances[0].closed, true);
  assert.equal(Channel.instances[1].closed, false);
  assert.equal(seen.length, 5);
});

test("local updates and focus reconciliation work without BroadcastChannel", (t) => {
  const { window } = browser(t, null);
  Reflect.set(globalThis, "BroadcastChannel", undefined);
  let changes = 0;
  const stop = onPreferenceChange("sidebar", () => changes++);
  t.after(stop);
  writeSidebarCookie(true);
  window.dispatchEvent(new Event("focus"));
  assert.equal(changes, 3);
  assert.equal(sidebarCollapsedFromCookieHeader(document.cookie), true);
  assert.equal(Channel.instances.length, 0);
});

test("blocked channels and failed sends cannot break local preferences", (t) => {
  browser(t, class {
    constructor() {
      throw new Error("blocked");
    }
  });
  t.mock.method(console, "warn", () => {});
  let changes = 0;
  const stop = onPreferenceChange("sidebar", () => changes++);
  t.after(stop);
  assert.doesNotThrow(() => writeSidebarCookie(true));
  assert.equal(changes, 2);
  stop();

  Reflect.set(globalThis, "BroadcastChannel", Channel);
  const stopAgain = onPreferenceChange("sidebar", () => changes++);
  t.after(stopAgain);
  t.mock.method(Channel.instances[0], "postMessage", () => { throw new Error("send failed"); });
  assert.doesNotThrow(() => writeSidebarCookie(false));
  assert.equal(changes, 4);
});

test("preference writes broadcast only invalidations after persisting the cookie", (t) => {
  browser(t);
  writeSidebarCookie(true);
  assert.equal(sidebarCollapsedFromCookieHeader(document.cookie), true);
  assert.deepEqual(Channel.instances[0].sent, ["sidebar"]);
  assert.equal(Channel.instances[0].closed, true);

  const seen: string[] = [];
  const stop = onPreferenceChange("time-zone", () => seen.push(document.cookie));
  t.after(stop);
  setConsoleTimeZone("Europe/Berlin");
  assert.equal(consoleTimeZone(), "Europe/Berlin");
  assert.match(seen.at(-1)!, /llmhub_time_zone=Europe%2FBerlin/);
  assert.deepEqual(Channel.instances[1].sent, ["time-zone"]);
  setConsoleTimeZone("Mars/Olympus");
  assert.equal(consoleTimeZone(), "Europe/Berlin");
  assert.equal(seen.length, 2);
});

test("sidebar cookie parsing ignores similarly named cookies", () => {
  assert.equal(sidebarCollapsedFromCookieHeader("other=1; llmhub_sidebar=collapsed; theme=dark"), true);
  assert.equal(sidebarCollapsedFromCookieHeader("llmhub_sidebar=expanded"), false);
  assert.equal(sidebarCollapsedFromCookieHeader("xllmhub_sidebar=collapsed"), null);
  assert.equal(sidebarCollapsedFromCookieHeader(""), null);
});

test("server rendering keeps the requested sidebar state and opens no channel", (t) => {
  replaceGlobal(t, "window", undefined);
  replaceGlobal(t, "document", undefined);
  replaceGlobal(t, "BroadcastChannel", Channel);
  Channel.instances = [];
  function SidebarState({ initial }: { initial: boolean }) {
    return String(useSidebarCollapsed(initial));
  }
  assert.equal(renderToStaticMarkup(createElement(SidebarState, { initial: true })), "true");
  assert.equal(renderToStaticMarkup(createElement(SidebarState, { initial: false })), "false");
  const stop = onPreferenceChange("sidebar", () => assert.fail("server listener"));
  notifyPreferenceChange("sidebar");
  stop();
  assert.equal(Channel.instances.length, 0);
});
