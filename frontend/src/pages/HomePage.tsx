import { useQuery } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api/client";

interface HealthData {
  status: string;
  version: string;
  environment: string;
}

export default function HomePage() {
  const { data, isError } = useQuery({
    queryKey: ["health"],
    queryFn: () => apiFetch<HealthData>("/health"),
  });

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-2 bg-neutral-950 text-neutral-100">
      <h1 className="text-2xl font-semibold">Market Pulse</h1>
      <p className="text-sm text-neutral-400">
        {isError ? "API unreachable" : data ? `API ${data.status} · v${data.version}` : "Loading…"}
      </p>
    </main>
  );
}
