import { useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, Clock, Flame, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { Change } from "@/components/iq/change";
import { formatPrice } from "@/components/iq/market-card";
import { useAssets, useBinanceTickers } from "@/hooks/queries";
import { UNIVERSE } from "@/lib/engine/market";
import type { Asset } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useSearchStore } from "@/stores/search";

import { AssetIcon } from "./asset-icon";

/** True while the user is typing in some other text field. */
function isEditingText(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA";
}

export function SearchCommand({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const { recent, addRecent, clearRecent } = useSearchStore();
  const { data: assets } = useAssets();
  // Full Binance USDT directory; only fetched once the palette is opened.
  const { data: allTickers } = useBinanceTickers(open);

  // Global shortcut: Shift+Enter opens the palette from anywhere.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Enter" && event.shiftKey && !open && !isEditingText(event.target)) {
        event.preventDefault();
        onOpenChange(true);
      }
      if (event.key === "Escape" && open) onOpenChange(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const byTicker = useMemo(() => {
    const map = new Map<string, Asset>();
    for (const asset of assets ?? []) map.set(asset.ticker, asset);
    return map;
  }, [assets]);

  // "Hot" = the biggest 24h movers in either direction.
  const hot = useMemo(
    () =>
      [...(assets ?? [])].sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h)).slice(0, 3),
    [assets],
  );

  const trimmed = query.trim();
  const matches = useMemo(() => {
    if (!trimmed) return [];
    const q = trimmed.toLowerCase();
    return UNIVERSE.filter(
      (entry) =>
        entry.ticker.toLowerCase().includes(q) ||
        entry.name.toLowerCase().includes(q) ||
        entry.sector.toLowerCase().includes(q),
    );
  }, [trimmed]);

  const freeSymbol = trimmed.replace(/[^a-z0-9]/gi, "").toUpperCase();

  // Autocomplete over every tradable Binance USDT pair beyond the universe.
  const directoryMatches = useMemo(() => {
    if (!freeSymbol || !allTickers) return [];
    const inUniverse = new Set(UNIVERSE.map((u) => u.ticker));
    return allTickers
      .filter((ticker) => ticker.includes(freeSymbol) && !inUniverse.has(ticker))
      .sort(
        (a, b) =>
          Number(b.startsWith(freeSymbol)) - Number(a.startsWith(freeSymbol)) || a.localeCompare(b),
      )
      .slice(0, 8);
  }, [freeSymbol, allTickers]);

  // Only offer a blind "go to" jump when the directory is unavailable —
  // otherwise the directory itself decides what exists.
  const showFreeSearch =
    freeSymbol.length > 0 && !allTickers && !matches.some((m) => m.ticker === freeSymbol);

  // Selection is controlled: directory results arrive async, and when the item
  // cmdk had highlighted unmounts it would otherwise leave nothing selected,
  // making Enter a no-op. Snap back to the first item whenever that happens.
  const [selected, setSelected] = useState("");
  const itemValues = useMemo(() => {
    if (trimmed) {
      return [
        ...matches.map((m) => itemValue("match", m.ticker)),
        ...directoryMatches.map((t) => itemValue("directory", t)),
        ...(showFreeSearch ? [itemValue("goto", freeSymbol)] : []),
      ];
    }
    return [
      ...recent.map((t) => itemValue("recent", t)),
      ...hot.map((a) => itemValue("hot", a.ticker)),
    ];
  }, [trimmed, matches, directoryMatches, showFreeSearch, freeSymbol, recent, hot]);

  useEffect(() => {
    if (!itemValues.includes(selected)) setSelected(itemValues[0] ?? "");
  }, [itemValues, selected]);

  function goTo(ticker: string) {
    addRecent(ticker);
    onOpenChange(false);
    void navigate({ to: "/token/$symbol", params: { symbol: ticker } });
  }

  // Portal to <body>: the sticky header is its own z-30 stacking context, so
  // rendering in place would trap the overlay beneath other fixed layers.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted || typeof document === "undefined" || !document.body) return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[80] flex items-start justify-center px-4 pt-[18vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <div
            className="absolute inset-0 bg-background/70 backdrop-blur-sm"
            onClick={() => onOpenChange(false)}
          />
          <motion.div
            className="relative w-full max-w-lg overflow-hidden rounded-xl border border-border bg-popover shadow-2xl"
            initial={{ opacity: 0, scale: 0.95, y: -12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -8 }}
            transition={{ type: "spring", duration: 0.35, bounce: 0.15 }}
          >
            <Command
              shouldFilter={false}
              label="Search tokens"
              value={selected}
              onValueChange={setSelected}
            >
              <div className="flex items-center gap-2 border-b border-border px-4">
                <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
                <Command.Input
                  autoFocus
                  value={query}
                  onValueChange={setQuery}
                  placeholder="Search tokens by name, ticker, or sector..."
                  className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
                <kbd className="rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                  Esc
                </kbd>
              </div>

              <Command.List className="max-h-[min(50vh,20rem)] overflow-y-auto p-2">
                {trimmed ? (
                  <>
                    {matches.map((entry) => (
                      <TokenItem
                        key={entry.ticker}
                        group="match"
                        ticker={entry.ticker}
                        name={entry.name}
                        sector={entry.sector}
                        asset={byTicker.get(entry.ticker)}
                        onSelect={goTo}
                      />
                    ))}
                    {directoryMatches.map((ticker) => (
                      <Command.Item
                        key={ticker}
                        value={itemValue("directory", ticker)}
                        onSelect={() => goTo(ticker)}
                        className={itemClass}
                      >
                        <AssetIcon ticker={ticker} className="text-base" />
                        <span className="font-semibold">{ticker}</span>
                        <span className="ml-auto text-xs text-muted-foreground">{ticker}/USDT</span>
                      </Command.Item>
                    ))}
                    {matches.length === 0 && directoryMatches.length === 0 && !showFreeSearch && (
                      <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                        No Binance USDT pair matches "{trimmed}".
                      </p>
                    )}
                    {showFreeSearch && (
                      <Command.Item
                        value={itemValue("goto", freeSymbol)}
                        onSelect={() => goTo(freeSymbol)}
                        className={itemClass}
                      >
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-surface">
                          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                        </span>
                        <span className="text-sm">
                          Go to <span className="font-semibold">{freeSymbol}</span>
                        </span>
                        <span className="ml-auto text-xs text-muted-foreground">Binance pair</span>
                      </Command.Item>
                    )}
                  </>
                ) : (
                  <>
                    {recent.length > 0 && (
                      <Command.Group heading={<GroupHeading icon={Clock} label="Recent" />}>
                        {recent.map((ticker) => {
                          const entry = UNIVERSE.find((u) => u.ticker === ticker);
                          return (
                            <TokenItem
                              key={ticker}
                              group="recent"
                              ticker={ticker}
                              name={entry?.name ?? ticker}
                              sector={entry?.sector}
                              asset={byTicker.get(ticker)}
                              onSelect={goTo}
                            />
                          );
                        })}
                        <button
                          type="button"
                          onClick={clearRecent}
                          className="mt-0.5 flex items-center gap-1 px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                        >
                          <X className="h-3 w-3" /> Clear recent
                        </button>
                      </Command.Group>
                    )}
                    <Command.Group heading={<GroupHeading icon={Flame} label="Hot right now" />}>
                      {hot.map((asset) => (
                        <TokenItem
                          key={asset.ticker}
                          group="hot"
                          ticker={asset.ticker}
                          name={asset.name}
                          sector={asset.sector}
                          asset={asset}
                          onSelect={goTo}
                        />
                      ))}
                      {hot.length === 0 && (
                        <p className="px-2 py-3 text-xs text-muted-foreground">
                          Loading market data...
                        </p>
                      )}
                    </Command.Group>
                  </>
                )}
              </Command.List>
            </Command>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

const itemClass = cn(
  "flex cursor-pointer select-none items-center gap-2.5 rounded-lg px-2 py-2 text-sm outline-none",
  "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
);

// cmdk normalizes item values to lowercase, so build ours pre-lowercased to
// keep them comparable with what onValueChange reports.
function itemValue(group: string, ticker: string): string {
  return `${group}-${ticker}`.toLowerCase();
}

function GroupHeading({ icon: Icon, label }: { icon: typeof Clock; label: string }) {
  return (
    <span className="flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium text-muted-foreground">
      <Icon className="h-3 w-3" /> {label}
    </span>
  );
}

function TokenItem({
  group,
  ticker,
  name,
  sector,
  asset,
  onSelect,
}: {
  group: string;
  ticker: string;
  name: string;
  sector?: string;
  asset?: Asset;
  onSelect: (ticker: string) => void;
}) {
  return (
    <Command.Item
      value={itemValue(group, ticker)}
      onSelect={() => onSelect(ticker)}
      className={itemClass}
    >
      <AssetIcon ticker={ticker} className="text-base" />
      <span className="font-semibold">{ticker}</span>
      <span className="truncate text-muted-foreground">{name}</span>
      {sector && (
        <span className="hidden rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] text-muted-foreground sm:block">
          {sector}
        </span>
      )}
      {asset && (
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <span className="num text-xs">{formatPrice(asset.price)}</span>
          <Change value={asset.change24h} />
        </span>
      )}
    </Command.Item>
  );
}
