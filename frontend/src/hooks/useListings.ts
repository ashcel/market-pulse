import { useQuery } from "@tanstack/react-query";

/**
 * New-listing screener reads.
 *
 * The browser is a pure view here, exactly like the forward-test plane: the
 * Python worker owns every write and every score, and these hooks only read
 * back what it already decided. Nothing on this page ever recomputes a score.
 */

export type ListingGrade = "PRIORITY" | "WATCH" | "THIN" | "SKIP";
export type ListingStatus = "UPCOMING" | "ALPHA" | "SPOT" | "FUTURES";
export type ListingSort = "time" | "score" | "change";

export interface ListingSummary {
  symbol: string;
  name: string;
  chain: string | null;
  iconUrl: string | null;
  status: ListingStatus;
  hoursToListing: number | null;
  listingAt: string | null;
  listingVenue: string | null;
  score: number | null;
  grade: ListingGrade | null;
  coverage: number | null;
  rejectedBecause: string | null;
  currentPrice: number | null;
  launchPrice: number | null;
  launchPriceSource: string | null;
  pctChangeSinceLaunch: number | null;
  percentChange24h: number | null;
  marketCap: number | null;
  fdv: number | null;
  liquidity: number | null;
  volume24h: number | null;
  holders: number | null;
  airdropLive: boolean;
  tgeLive: boolean;
  hotTag: boolean;
  seedTag: boolean;
  onAlpha: boolean;
  onSpot: boolean;
  onFutures: boolean;
  headline: string | null;
  warningCount: number;
  socialSentiment: number | null;
  top10Pct: number | null;
  lastSeenAt: string | null;
}

export interface HolderBubble {
  address: string;
  label: string;
  kind: "wallet" | "pool" | "burn" | "contract" | "exchange" | "team";
  pct: number;
  x: number;
  y: number;
  r: number;
  counted: boolean;
}

export interface HolderMapRead {
  top10Pct: number | null;
  top50Pct: number | null;
  largestHolderPct: number | null;
  hhi: number | null;
  holdersCounted: number;
  poolPct: number;
  burnPct: number;
  unavailableReason: string | null;
  version: string | null;
  bubbles: HolderBubble[];
}

export interface SocialPostRead {
  id: string;
  source: string;
  author: string;
  text: string;
  url: string;
  createdAt: string;
  likes: number;
  reposts: number;
  replies: number;
  followers: number;
  sentiment: number;
  ageHours: number;
}

export interface SocialPulseRead {
  sentiment: number | null;
  postsTotal: number;
  posts24h: number;
  posts1h: number;
  velocity: number | null;
  spamRatio: number;
  reach: number;
  bullishShare: number | null;
  bearishShare: number | null;
  sources: Record<string, number>;
  unavailableReason: string | null;
  version: string | null;
  topPosts: SocialPostRead[];
}

export interface ScoreComponentRead {
  key: string;
  score: number;
  weight: number;
  evidence: string;
}

export interface PricePointRead {
  observedAt: string;
  price: number;
  pctChangeSinceLaunch: number | null;
  marketCap: number | null;
  volume24h: number | null;
  liquidity: number | null;
  score: number | null;
}

export interface ListingDetail extends ListingSummary {
  contractAddress: string | null;
  coingeckoId: string | null;
  announcementTitle: string | null;
  announcementUrl: string | null;
  announcedAt: string | null;
  spotPair: string | null;
  futuresPair: string | null;
  alphaListedAt: string | null;
  spotListedAt: string | null;
  futuresListedAt: string | null;
  circulatingSupply: number | null;
  totalSupply: number | null;
  tradeCount24h: number | null;
  alphaScore: number | null;
  mulPoint: number | null;
  maxPriceSinceLaunch: number | null;
  minPriceSinceLaunch: number | null;
  components: ScoreComponentRead[];
  evidence: string[];
  warnings: string[];
  scoreVersion: string | null;
  scoredAt: string | null;
  holderMap: HolderMapRead | null;
  holderMapAt: string | null;
  social: SocialPulseRead | null;
  socialPulseAt: string | null;
  priceSeries: PricePointRead[];
  firstSeenAt: string | null;
  inactive: boolean;
}

export interface ListingListMeta {
  count: number;
  upcoming: number;
  trading: number;
  sort: string;
  generatedAt: string;
}

/**
 * The API speaks snake_case (FastAPI); the client speaks camelCase. One
 * mapper rather than per-field access at every call site — and it is explicit
 * rather than a generic deep-transform so a renamed backend field breaks the
 * type check instead of turning into `undefined` at render time.
 */
type Raw = Record<string, unknown>;

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const bool = (value: unknown): boolean => value === true;

function toSummary(raw: Raw): ListingSummary {
  return {
    symbol: String(raw.symbol ?? ""),
    name: String(raw.name ?? ""),
    chain: str(raw.chain),
    iconUrl: str(raw.icon_url),
    status: (str(raw.status) ?? "ALPHA") as ListingStatus,
    hoursToListing: num(raw.hours_to_listing),
    listingAt: str(raw.listing_at),
    listingVenue: str(raw.listing_venue),
    score: num(raw.score),
    grade: str(raw.grade) as ListingGrade | null,
    coverage: num(raw.coverage),
    rejectedBecause: str(raw.rejected_because),
    currentPrice: num(raw.current_price),
    launchPrice: num(raw.launch_price),
    launchPriceSource: str(raw.launch_price_source),
    pctChangeSinceLaunch: num(raw.pct_change_since_launch),
    percentChange24h: num(raw.percent_change_24h),
    marketCap: num(raw.market_cap),
    fdv: num(raw.fdv),
    liquidity: num(raw.liquidity),
    volume24h: num(raw.volume_24h),
    holders: num(raw.holders),
    airdropLive: bool(raw.airdrop_live),
    tgeLive: bool(raw.tge_live),
    hotTag: bool(raw.hot_tag),
    seedTag: bool(raw.seed_tag),
    onAlpha: bool(raw.on_alpha),
    onSpot: bool(raw.on_spot),
    onFutures: bool(raw.on_futures),
    headline: str(raw.headline),
    warningCount: num(raw.warning_count) ?? 0,
    socialSentiment: num(raw.social_sentiment),
    top10Pct: num(raw.top10_pct),
    lastSeenAt: str(raw.last_seen_at),
  };
}

function toHolderMap(raw: Raw | null): HolderMapRead | null {
  if (!raw) return null;
  const bubbles = Array.isArray(raw.bubbles) ? (raw.bubbles as Raw[]) : [];
  return {
    top10Pct: num(raw.top10_pct),
    top50Pct: num(raw.top50_pct),
    largestHolderPct: num(raw.largest_holder_pct),
    hhi: num(raw.hhi),
    holdersCounted: num(raw.holders_counted) ?? 0,
    poolPct: num(raw.pool_pct) ?? 0,
    burnPct: num(raw.burn_pct) ?? 0,
    unavailableReason: str(raw.unavailable_reason),
    version: str(raw.version),
    bubbles: bubbles.map((bubble) => ({
      address: String(bubble.address ?? ""),
      label: String(bubble.label ?? ""),
      kind: (str(bubble.kind) ?? "wallet") as HolderBubble["kind"],
      pct: num(bubble.pct) ?? 0,
      x: num(bubble.x) ?? 0,
      y: num(bubble.y) ?? 0,
      r: num(bubble.r) ?? 0,
      counted: bool(bubble.counted),
    })),
  };
}

function toSocial(raw: Raw | null): SocialPulseRead | null {
  if (!raw) return null;
  const posts = Array.isArray(raw.top_posts) ? (raw.top_posts as Raw[]) : [];
  return {
    sentiment: num(raw.sentiment),
    postsTotal: num(raw.posts_total) ?? 0,
    posts24h: num(raw.posts_24h) ?? 0,
    posts1h: num(raw.posts_1h) ?? 0,
    velocity: num(raw.velocity),
    spamRatio: num(raw.spam_ratio) ?? 0,
    reach: num(raw.reach) ?? 0,
    bullishShare: num(raw.bullish_share),
    bearishShare: num(raw.bearish_share),
    sources: (raw.sources as Record<string, number>) ?? {},
    unavailableReason: str(raw.unavailable_reason),
    version: str(raw.version),
    topPosts: posts.map((post) => ({
      id: String(post.id ?? ""),
      source: String(post.source ?? ""),
      author: String(post.author ?? ""),
      text: String(post.text ?? ""),
      url: String(post.url ?? ""),
      createdAt: String(post.created_at ?? ""),
      likes: num(post.likes) ?? 0,
      reposts: num(post.reposts) ?? 0,
      replies: num(post.replies) ?? 0,
      followers: num(post.followers) ?? 0,
      sentiment: num(post.sentiment) ?? 0,
      ageHours: num(post.age_hours) ?? 0,
    })),
  };
}

function toDetail(raw: Raw): ListingDetail {
  const components = Array.isArray(raw.components) ? (raw.components as Raw[]) : [];
  const series = Array.isArray(raw.price_series) ? (raw.price_series as Raw[]) : [];
  return {
    ...toSummary(raw),
    contractAddress: str(raw.contract_address),
    coingeckoId: str(raw.coingecko_id),
    announcementTitle: str(raw.announcement_title),
    announcementUrl: str(raw.announcement_url),
    announcedAt: str(raw.announced_at),
    spotPair: str(raw.spot_pair),
    futuresPair: str(raw.futures_pair),
    alphaListedAt: str(raw.alpha_listed_at),
    spotListedAt: str(raw.spot_listed_at),
    futuresListedAt: str(raw.futures_listed_at),
    circulatingSupply: num(raw.circulating_supply),
    totalSupply: num(raw.total_supply),
    tradeCount24h: num(raw.trade_count_24h),
    alphaScore: num(raw.alpha_score),
    mulPoint: num(raw.mul_point),
    maxPriceSinceLaunch: num(raw.max_price_since_launch),
    minPriceSinceLaunch: num(raw.min_price_since_launch),
    components: components.map((component) => ({
      key: String(component.key ?? ""),
      score: num(component.score) ?? 0,
      weight: num(component.weight) ?? 0,
      evidence: String(component.evidence ?? ""),
    })),
    evidence: Array.isArray(raw.evidence) ? (raw.evidence as string[]) : [],
    warnings: Array.isArray(raw.warnings) ? (raw.warnings as string[]) : [],
    scoreVersion: str(raw.score_version),
    scoredAt: str(raw.scored_at),
    holderMap: toHolderMap((raw.holder_map as Raw) ?? null),
    holderMapAt: str(raw.holder_map_at),
    social: toSocial((raw.social as Raw) ?? null),
    socialPulseAt: str(raw.social_pulse_at),
    priceSeries: series.map((point) => ({
      observedAt: String(point.observed_at ?? ""),
      price: num(point.price) ?? 0,
      pctChangeSinceLaunch: num(point.pct_change_since_launch),
      marketCap: num(point.market_cap),
      volume24h: num(point.volume_24h),
      liquidity: num(point.liquidity),
      score: num(point.score),
    })),
    firstSeenAt: str(raw.first_seen_at),
    inactive: bool(raw.inactive),
  };
}

export interface ListingsQuery {
  limit?: number;
  status?: ListingStatus;
  grade?: ListingGrade;
  minScore?: number;
  sort?: ListingSort;
  includeRejected?: boolean;
}

async function fetchListings(
  query: ListingsQuery,
): Promise<{ rows: ListingSummary[]; meta: ListingListMeta | null }> {
  const params = new URLSearchParams();
  if (query.limit) params.set("limit", String(query.limit));
  if (query.status) params.set("status", query.status);
  if (query.grade) params.set("grade", query.grade);
  if (query.minScore != null) params.set("min_score", String(query.minScore));
  if (query.sort) params.set("sort", query.sort);
  if (query.includeRejected) params.set("include_rejected", "true");

  const res = await fetch(`/api/listings?${params.toString()}`);
  if (!res.ok) throw new Error(`listings ${res.status}`);
  const body = (await res.json()) as { data?: Raw[]; meta?: Raw };
  return {
    rows: (body.data ?? []).map(toSummary),
    meta: body.meta
      ? {
          count: num(body.meta.count) ?? 0,
          upcoming: num(body.meta.upcoming) ?? 0,
          trading: num(body.meta.trading) ?? 0,
          sort: String(body.meta.sort ?? "time"),
          generatedAt: String(body.meta.generated_at ?? ""),
        }
      : null,
  };
}

/** The screener list. Refetched on a minute — the worker writes every 15. */
export function useListings(query: ListingsQuery = {}) {
  return useQuery({
    queryKey: ["listings", query],
    queryFn: () => fetchListings(query),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}

async function fetchListingDetail(symbol: string): Promise<ListingDetail | null> {
  const res = await fetch(`/api/listings/${encodeURIComponent(symbol)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`listing ${res.status}`);
  const body = (await res.json()) as { data?: Raw | null };
  return body.data ? toDetail(body.data) : null;
}

export function useListingDetail(symbol: string) {
  return useQuery({
    queryKey: ["listing", symbol.toUpperCase()],
    queryFn: () => fetchListingDetail(symbol),
    enabled: Boolean(symbol),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}

/**
 * The deterministic evidence pack the AI analyst narrates. Fetched lazily —
 * only when the reader actually asks for an analysis, since it exists purely
 * to be handed to a model.
 */
export async function fetchListingBrief(symbol: string): Promise<unknown> {
  const res = await fetch(`/api/listings/${encodeURIComponent(symbol)}?view=brief`);
  if (!res.ok) throw new Error(`listing brief ${res.status}`);
  const body = (await res.json()) as { data?: unknown };
  return body.data ?? null;
}
