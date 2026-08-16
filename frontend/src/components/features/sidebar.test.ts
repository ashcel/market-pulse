import { describe, expect, it } from "vitest";

import { NAV_GROUPS, visibleNavGroups } from "./sidebar";
import { PROTECTED_ROUTES } from "@/lib/auth/guard";

describe("visibleNavGroups", () => {
  it("gives a signed-in user the whole nav", () => {
    expect(visibleNavGroups(true)).toEqual(NAV_GROUPS);
  });

  it("hides every auth-only destination from an anonymous visitor", () => {
    const items = visibleNavGroups(false).flatMap((g) => g.items);
    expect(items.some((i) => i.requiresAuth)).toBe(false);
    expect(items.map((i) => i.to)).toEqual([
      "/",
      "/markets",
      "/discover",
      // The listing screener is part of the public market plane: its API
      // carries no session dependency, so an anonymous visitor sees it.
      "/listings",
      "/news",
      "/events",
      "/regime",
      "/rotation",
      "/rankings",
      "/technical",
      "/forward-test",
    ]);
  });

  it("drops a group that ends up empty instead of rendering a bare heading", () => {
    const keys = visibleNavGroups(false).map((g) => g.groupKey);
    expect(keys).not.toContain("trading");
    expect(keys).not.toContain("account");
  });

  /**
   * The nav flag and the server-side guard list must agree: a link shown to an
   * anonymous visitor that then redirects to /login is a broken promise, and a
   * hidden link with no guard is a hole.
   */
  it("marks exactly the routes the server guard protects", () => {
    const flagged = NAV_GROUPS.flatMap((g) => g.items)
      .filter((i) => i.requiresAuth)
      .map((i) => i.to)
      .sort();
    expect(flagged).toEqual([...PROTECTED_ROUTES].sort());
  });
});
