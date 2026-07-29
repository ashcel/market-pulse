import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Layers, Activity, BarChart3, History, Newspaper } from "lucide-react";
import { MarketsPanel } from "@/components/features/markets-panel";
import { RankingsPanel } from "@/components/features/rankings-panel";
import { RegimePanel } from "@/components/features/regime-panel";
import { TechnicalPanel } from "@/components/features/technical-panel";
import { RecordPanel } from "@/components/features/record-panel";
import { NewsPanel } from "@/components/features/news-panel";

const MARKETS_TABS = ["overview", "regime", "assets", "news", "record"] as const;
type MarketsTab = (typeof MARKETS_TABS)[number];

function isMarketsTab(v: unknown): v is MarketsTab {
  return typeof v === "string" && (MARKETS_TABS as readonly string[]).includes(v);
}

// Old tab values still land correctly (deep links, notifications, bookmarks)
// — see IA-REDESIGN-2026-07-23 §4.5: market→overview, rankings/technical→
// assets, rotation→regime (regime→regime is unchanged).
const LEGACY_TAB_MAP: Record<string, MarketsTab> = {
  market: "overview",
  rankings: "assets",
  technical: "assets",
  rotation: "regime",
};

function normalizeTab(v: unknown): MarketsTab | undefined {
  if (typeof v !== "string") return undefined;
  if (isMarketsTab(v)) return v;
  return LEGACY_TAB_MAP[v];
}

export const Route = createFileRoute("/markets")({
  // `tab` is optional so bare `/markets` links stay valid; absent/invalid ==
  // the default "overview" tab. Kept out of the URL when it's the default.
  validateSearch: (search: Record<string, unknown>): { tab?: MarketsTab } => {
    const tab = normalizeTab(search.tab);
    return { tab: tab && tab !== "overview" ? tab : undefined };
  },
  head: () => ({
    meta: [
      { title: "Markets — Market Pulse" },
      {
        name: "description",
        content: "Overview, regime, assets, and the forward-test record in one consolidated view.",
      },
      { property: "og:title", content: "Markets — Market Pulse" },
      { property: "og:description", content: "Live view of every asset Market Pulse tracks." },
    ],
  }),
  component: MarketsPage,
});

const TAB_META: { value: MarketsTab; label: string; icon: React.ElementType }[] = [
  { value: "overview", label: "Overview", icon: Layers },
  { value: "regime", label: "Regime", icon: Activity },
  { value: "assets", label: "Assets", icon: BarChart3 },
  { value: "news", label: "News", icon: Newspaper },
  { value: "record", label: "Record", icon: History },
];

function MarketsPage() {
  const { tab } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const active: MarketsTab = tab ?? "overview";

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-4 sm:gap-6">
      <Tabs
        value={active}
        onValueChange={(v) =>
          navigate({ search: { tab: v === "overview" ? undefined : (v as MarketsTab) } })
        }
        className="flex flex-col gap-4 sm:gap-6"
      >
        <TabsList className="flex h-auto w-full justify-start gap-1 overflow-x-auto rounded-xl border border-border bg-card p-1 sm:max-w-2xl">
          {TAB_META.map((t) => (
            <TabsTrigger
              key={t.value}
              value={t.value}
              className="min-h-11 shrink-0 gap-1.5 px-3 py-1.5 text-xs sm:min-h-0"
            >
              <t.icon className="h-3.5 w-3.5" aria-hidden />
              <span>{t.label}</span>
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview" className="mt-0">
          <MarketsPanel />
        </TabsContent>
        <TabsContent value="regime" className="mt-0">
          <RegimePanel />
        </TabsContent>
        <TabsContent value="assets" className="mt-0 flex flex-col gap-8">
          <RankingsPanel />
          <div className="border-t border-border pt-6">
            <TechnicalPanel asSection />
          </div>
        </TabsContent>
        <TabsContent value="news" className="mt-0">
          <NewsPanel asSection />
        </TabsContent>
        <TabsContent value="record" className="mt-0">
          <RecordPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
