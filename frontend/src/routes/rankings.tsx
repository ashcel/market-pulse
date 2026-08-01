import { createFileRoute, redirect } from "@tanstack/react-router";

import { redirectIfNavV2 } from "@/lib/nav-redirects";

// Consolidated into the Markets view as a tab (START-HERE move #2). Under the
// 4-tab nav (Sprint 5) Markets itself retires, so this hops straight to Now
// rather than through a route that would only redirect again.
export const Route = createFileRoute("/rankings")({
  beforeLoad: () => {
    redirectIfNavV2("/rankings");
    throw redirect({ to: "/markets", search: { tab: "assets" } });
  },
});
