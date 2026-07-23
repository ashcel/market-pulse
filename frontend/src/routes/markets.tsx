import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Layers, BarChart3, Activity, ArrowLeftRight, LineChart } from "lucide-react";
import { MarketsPanel } from "@/components/features/markets-panel";
import { RankingsPanel } from "@/components/features/rankings-panel";
import { RegimePanel } from "@/components/features/regime-panel";
import { RotationPanel } from "@/components/features/rotation-panel";
import { TechnicalPanel } from "@/components/features/technical-panel";

const MARKETS_TABS = ["market", "rankings", "regime", "rotation", "technical"] as const;
type MarketsTab = (typeof MARKETS_TABS)[number];

function isMarketsTab(v: unknown): v is MarketsTab {
  return typeof v === "string" && (MARKETS_TABS as readonly string[]).includes(v);
}

export const Route = createFileRoute("/markets")({
  // `tab` is optional so bare `/markets` links stay valid; absent/invalid ==
  // the default "market" tab. Kept out of the URL when it's the default.
  validateSearch: (search: Record<string, unknown>): { tab?: MarketsTab } => ({
    tab: isMarketsTab(search.tab) && search.tab !== "market" ? search.tab : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Markets — Market Pulse" },
      {
        name: "description",
        content:
          "Markets, rankings, regime, rotation, and technical analysis in one consolidated view.",
      },
      { property: "og:title", content: "Markets — Market Pulse" },
      { property: "og:description", content: "Live view of every asset Market Pulse tracks." },
    ],
  }),
  component: MarketsPage,
});

const TAB_META: { value: MarketsTab; label: string; icon: React.ElementType }[] = [
  { value: "market", label: "Markets", icon: Layers },
  { value: "rankings", label: "Rankings", icon: BarChart3 },
  { value: "regime", label: "Regime", icon: Activity },
  { value: "rotation", label: "Rotation", icon: ArrowLeftRight },
  { value: "technical", label: "Technical", icon: LineChart },
];

function MarketsPage() {
  const { tab } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const active: MarketsTab = tab ?? "market";

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
      <Tabs
        value={active}
        onValueChange={(v) =>
          navigate({ search: { tab: v === "market" ? undefined : (v as MarketsTab) } })
        }
        className="flex flex-col gap-6"
      >
        <TabsList className="grid h-auto w-full grid-cols-5 gap-1 rounded-xl border border-border bg-card p-1 sm:w-auto sm:max-w-xl">
          {TAB_META.map((t) => (
            <TabsTrigger key={t.value} value={t.value} className="gap-1.5 px-3 py-1.5 text-xs">
              <t.icon className="h-3.5 w-3.5" aria-hidden />
              <span className="hidden sm:inline">{t.label}</span>
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="market" className="mt-0">
          <MarketsPanel />
        </TabsContent>
        <TabsContent value="rankings" className="mt-0">
          <RankingsPanel />
        </TabsContent>
        <TabsContent value="regime" className="mt-0">
          <RegimePanel />
        </TabsContent>
        <TabsContent value="rotation" className="mt-0">
          <RotationPanel />
        </TabsContent>
        <TabsContent value="technical" className="mt-0">
          <TechnicalPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
