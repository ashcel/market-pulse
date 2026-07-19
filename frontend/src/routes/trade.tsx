import { createFileRoute } from "@tanstack/react-router";
import { ExecutionPanel } from "@/components/features/execution-panel";

export const Route = createFileRoute("/trade")({
  // Only accessible if user is authenticated - this is handled by router context or middleware if available
  // To keep it standard TanStack Start, we can just define the component
  head: () => ({
    meta: [
      { title: "Trade Desk — IQ" },
      { name: "description", content: "Constitution-gated trade execution" },
    ],
  }),
  component: TradePage,
});

function TradePage() {
  return (
    <div className="flex flex-col gap-6 p-4 pb-20 md:p-6 lg:p-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight">Trade Desk</h1>
        <p className="text-sm text-muted-foreground">Constitution-gated trade execution</p>
      </div>

      <div className="mx-auto w-full max-w-lg">
        <ExecutionPanel />
      </div>
    </div>
  );
}
