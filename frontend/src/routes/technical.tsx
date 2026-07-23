import { createFileRoute, redirect } from "@tanstack/react-router";

// Consolidated into the Markets view as a tab (START-HERE move #2).
export const Route = createFileRoute("/technical")({
  beforeLoad: () => {
    throw redirect({ to: "/markets", search: { tab: "technical" } });
  },
});
