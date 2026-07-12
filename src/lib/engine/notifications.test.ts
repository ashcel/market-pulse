import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  publishNotification,
  subscribeToNotifications,
  type NotificationEvent,
} from "./notifications";

/**
 * P1.2 — owner-scoped delivery. Follow-settled events carry `ownerId` and are
 * private: they must reach only streams authenticated as that user, both on
 * live emit and on the replay of the recent-events buffer. A leak here would
 * broadcast one tester's trades to every connected browser.
 */

const realFetch = globalThis.fetch;
let unsubscribes: (() => void)[] = [];

function subscribe(userId?: string): NotificationEvent[] {
  const received: NotificationEvent[] = [];
  unsubscribes.push(subscribeToNotifications((e) => received.push(e), userId));
  return received;
}

function event(overrides: Partial<NotificationEvent>): NotificationEvent {
  return {
    id: `test-${Math.random()}`,
    type: "follow-settled",
    title: "t",
    body: "b",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  // Subscribing starts the market poller; starve its fetches so the test
  // never leaves the process.
  globalThis.fetch = (async () => new Response("[]", { status: 200 })) as typeof fetch;
});

afterEach(() => {
  for (const unsub of unsubscribes) unsub();
  unsubscribes = [];
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("owner-scoped notification delivery (P1.2)", () => {
  it("delivers owner events only to that owner's streams; global events to everyone", () => {
    const anonymous = subscribe();
    const owner = subscribe("user-a");
    const otherUser = subscribe("user-b");

    const privateEvent = event({ id: "private-1", ownerId: "user-a" });
    const globalEvent = event({ id: "global-1", type: "worker-health", ownerId: undefined });
    publishNotification(privateEvent);
    publishNotification(globalEvent);

    expect(owner.map((e) => e.id)).toContain("private-1");
    expect(anonymous.map((e) => e.id)).not.toContain("private-1");
    expect(otherUser.map((e) => e.id)).not.toContain("private-1");

    for (const inbox of [anonymous, owner, otherUser]) {
      expect(inbox.map((e) => e.id)).toContain("global-1");
    }
  });

  it("respects ownership in the replay buffer too — a late subscriber can't read others' history", () => {
    publishNotification(event({ id: "private-2", ownerId: "user-a" }));

    const lateAnonymous = subscribe();
    const lateOwner = subscribe("user-a");

    expect(lateAnonymous.map((e) => e.id)).not.toContain("private-2");
    expect(lateOwner.map((e) => e.id)).toContain("private-2");
  });
});
