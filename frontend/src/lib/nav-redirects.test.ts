import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NAV_V2_REDIRECTS } from "./nav-redirects";

/**
 * The Sprint 5 exit criterion, enforced rather than grepped once:
 * "nol rute yatim (`grep` routeTree vs nav + redirect map)".
 *
 * Reads the generated route tree and the nav components, and fails if any page
 * route under NAV_V2 would neither render nor redirect — i.e. if someone adds
 * a route and forgets it, or retires one without giving it a home. A 404 on a
 * bookmarked URL is the exact failure this sprint set out to avoid.
 */

const ROOT = join(import.meta.dirname, "..");

function pageRoutes(): string[] {
  const tree = readFileSync(join(ROOT, "routeTree.gen.ts"), "utf8");
  const paths = new Set<string>();
  for (const match of tree.matchAll(/^ {2}path: '(\/[^']*)'/gm)) paths.add(match[1]);
  return [...paths].filter(
    // `/api/*` are server handlers, and their nested children (e.g. the
    // `/telegram` under `/api/auth`) surface as bare fragments here.
    (path) => !path.startsWith("/api") && !path.startsWith("/$") && path !== "/telegram",
  );
}

function navDestinations(): Set<string> {
  const bottom = readFileSync(join(ROOT, "components/features/bottom-nav.tsx"), "utf8");
  const sidebar = readFileSync(join(ROOT, "components/features/sidebar.tsx"), "utf8");
  const reachable = new Set<string>();
  for (const source of [bottom, sidebar]) {
    for (const match of source.matchAll(/to: "(\/[^"]*)"/g)) reachable.add(match[1]);
  }
  // Not in the tab bar, but reachable by design:
  reachable.add("/settings"); // header avatar + mobile drawer
  reachable.add("/login"); // unauthenticated entry
  reachable.add("/token/$symbol"); // the one "market detail" behind Now
  return reachable;
}

describe("NAV_V2 redirect map", () => {
  const routes = pageRoutes();
  const retired = Object.keys(NAV_V2_REDIRECTS);

  it("leaves no page route orphaned under NAV_V2", () => {
    const reachable = navDestinations();
    const orphans = routes.filter((path) => !(path in NAV_V2_REDIRECTS) && !reachable.has(path));
    expect(orphans).toEqual([]);
  });

  it("never redirects to a route that is itself retired", () => {
    // Otherwise a bookmark takes two hops through a page that no longer
    // renders — which is how a redirect loop ships.
    const targets = new Set(Object.values(NAV_V2_REDIRECTS));
    for (const target of targets) {
      expect(retired).not.toContain(target);
      expect(routes).toContain(target);
    }
  });

  it("wires every retired route to a beforeLoad call site", () => {
    const dir = join(ROOT, "routes");
    const sources = readdirSync(dir)
      .filter((name) => name.endsWith(".tsx"))
      .map((name) => readFileSync(join(dir, name), "utf8"))
      .join("\n");
    for (const path of retired) {
      expect(sources).toContain(`redirectIfNavV2("${path}")`);
    }
  });

  it("keeps the four surviving tabs and the market detail", () => {
    for (const path of ["/", "/ideas", "/book", "/lab", "/token/$symbol"]) {
      expect(routes).toContain(path);
      expect(retired).not.toContain(path);
    }
  });
});
