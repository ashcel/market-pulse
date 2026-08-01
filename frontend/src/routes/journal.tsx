import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { CandlestickChart, History, Sparkles } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/features/page-header";
import { OpenPositionsPanel, TradeHistoryPanel } from "@/components/features/trades-panel";
import { ReviewPanel } from "@/components/features/review-panel";
import { DecisionJournal } from "@/components/features/decision-journal";

import { redirectIfNavV2 } from "@/lib/nav-redirects";

const JOURNAL_TABS = ["open", "history", "habits"] as const;
type JournalTab = (typeof JOURNAL_TABS)[number];

function isJournalTab(v: unknown): v is JournalTab {
  return typeof v === "string" && (JOURNAL_TABS as readonly string[]).includes(v);
}

function normalizeTab(v: unknown): JournalTab | undefined {
  if (typeof v !== "string") return undefined;
  return isJournalTab(v) ? v : undefined;
}

export const Route = createFileRoute("/journal")({
  // Retired by the 4-tab nav (Sprint 5): decision history lives in Lab. No-op while NAV_V2=0.
  beforeLoad: () => redirectIfNavV2("/journal"),
  // `tab` is optional so bare `/journal` links stay valid; absent/invalid ==
  // the default "open" tab. Kept out of the URL when it's the default —
  // same convention as `/markets` (IA-REDESIGN-2026-07-23 §4.3/§4.5).
  validateSearch: (search: Record<string, unknown>): { tab?: JournalTab } => {
    const tab = normalizeTab(search.tab);
    return { tab: tab && tab !== "open" ? tab : undefined };
  },
  head: () => ({
    meta: [
      { title: "Journal — Market Pulse" },
      {
        name: "description",
        content: "Open positions, trade history, and habits — am I trading well over time?",
      },
      { property: "og:title", content: "Journal — Market Pulse" },
      {
        property: "og:description",
        content: "One loop, three lenses: open, history, habits.",
      },
    ],
  }),
  component: JournalPage,
});

const TAB_META: { value: JournalTab; label: string; icon: React.ElementType }[] = [
  { value: "open", label: "Open", icon: CandlestickChart },
  { value: "history", label: "History", icon: History },
  { value: "habits", label: "Habits", icon: Sparkles },
];

// Merge of `/trades` + `/review` (IA-REDESIGN-2026-07-23 §4.3): one header,
// one filter per tab, am-I-trading-well-over-time in one destination. Both
// source routes stay live as thin wrappers over the same extracted panels
// (`trades-panel.tsx`, `review-panel.tsx`) so old links/bookmarks/deep
// notifications still resolve.
function JournalPage() {
  const { tab } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const active: JournalTab = tab ?? "open";

  return (
    <div className="mx-auto flex max-w-[1000px] flex-col gap-6 pb-20 lg:pb-6">
      <PageHeader
        eyebrow="Journal"
        title="Journal"
        subtitle="Open positions, trade history, and habits — am I trading well over time?"
      />
      <DecisionJournal />

      <Tabs
        value={active}
        onValueChange={(v) =>
          navigate({ search: { tab: v === "open" ? undefined : (v as JournalTab) } })
        }
        className="flex flex-col gap-6"
      >
        <TabsList className="grid h-auto w-full grid-cols-3 gap-1 rounded-xl border border-border bg-card p-1 sm:w-auto sm:max-w-md">
          {TAB_META.map((t) => (
            <TabsTrigger key={t.value} value={t.value} className="gap-1.5 px-3 py-1.5 text-xs">
              <t.icon className="h-3.5 w-3.5" aria-hidden />
              <span>{t.label}</span>
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="open" className="mt-0">
          <OpenPositionsPanel />
        </TabsContent>
        <TabsContent value="history" className="mt-0">
          <TradeHistoryPanel />
        </TabsContent>
        <TabsContent value="habits" className="mt-0">
          <ReviewPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
