/**
 * Canonical asset mapping: internal bare ticker ↔ provider-specific IDs.
 *
 * Providers identify coins by their own IDs, and ticker strings collide across
 * projects — so calendar/market ingestion matches by provider ID, NEVER by raw
 * ticker text. This map is a code constant (like the universe itself, which
 * carries name+sector): a PR-reviewed ~50-entry table beats a DB table that
 * needs seeding and can drift silently. A unit test asserts every
 * WORKER_UNIVERSE ticker has an explicit entry; null is allowed but must be
 * deliberate. Provider coins that map to no entry are dropped at ingest —
 * high-signal over volume.
 *
 * CoinMarketCal slugs follow their /v1/coins directory; entries were curated
 * from the providers' public naming and should be spot-verified against a real
 * API key before trusting full coverage (see plan: pending user action).
 */
export interface AssetIds {
  coingeckoId: string | null;
  coinmarketcalId: string | null;
}

export const ASSET_IDS: Record<string, AssetIds> = {
  BTC: { coingeckoId: "bitcoin", coinmarketcalId: "bitcoin" },
  ETH: { coingeckoId: "ethereum", coinmarketcalId: "ethereum" },
  SOL: { coingeckoId: "solana", coinmarketcalId: "solana" },
  BNB: { coingeckoId: "binancecoin", coinmarketcalId: "binance-coin" },
  XRP: { coingeckoId: "ripple", coinmarketcalId: "xrp" },
  ADA: { coingeckoId: "cardano", coinmarketcalId: "cardano" },
  AVAX: { coingeckoId: "avalanche-2", coinmarketcalId: "avalanche" },
  SUI: { coingeckoId: "sui", coinmarketcalId: "sui" },
  NEAR: { coingeckoId: "near", coinmarketcalId: "near-protocol" },
  LINK: { coingeckoId: "chainlink", coinmarketcalId: "chainlink" },
  UNI: { coingeckoId: "uniswap", coinmarketcalId: "uniswap" },
  AAVE: { coingeckoId: "aave", coinmarketcalId: "aave" },
  FET: {
    coingeckoId: "artificial-superintelligence-alliance",
    coinmarketcalId: "fetch-ai",
  },
  RENDER: { coingeckoId: "render-token", coinmarketcalId: "render" },
  TAO: { coingeckoId: "bittensor", coinmarketcalId: "bittensor" },
  DOGE: { coingeckoId: "dogecoin", coinmarketcalId: "dogecoin" },
  PEPE: { coingeckoId: "pepe", coinmarketcalId: "pepe" },
  WIF: { coingeckoId: "dogwifcoin", coinmarketcalId: "dogwifhat" },
  LTC: { coingeckoId: "litecoin", coinmarketcalId: "litecoin" },
  BCH: { coingeckoId: "bitcoin-cash", coinmarketcalId: "bitcoin-cash" },
  ETC: { coingeckoId: "ethereum-classic", coinmarketcalId: "ethereum-classic" },
  DOT: { coingeckoId: "polkadot", coinmarketcalId: "polkadot" },
  ATOM: { coingeckoId: "cosmos", coinmarketcalId: "cosmos" },
  FIL: { coingeckoId: "filecoin", coinmarketcalId: "filecoin" },
  APT: { coingeckoId: "aptos", coinmarketcalId: "aptos" },
  ARB: { coingeckoId: "arbitrum", coinmarketcalId: "arbitrum" },
  OP: { coingeckoId: "optimism", coinmarketcalId: "optimism" },
  TRX: { coingeckoId: "tron", coinmarketcalId: "tron" },
  XLM: { coingeckoId: "stellar", coinmarketcalId: "stellar" },
  HBAR: { coingeckoId: "hedera-hashgraph", coinmarketcalId: "hedera" },
  ICP: { coingeckoId: "internet-computer", coinmarketcalId: "internet-computer" },
  TIA: { coingeckoId: "celestia", coinmarketcalId: "celestia" },
  SEI: { coingeckoId: "sei-network", coinmarketcalId: "sei" },
  ALGO: { coingeckoId: "algorand", coinmarketcalId: "algorand" },
  STX: { coingeckoId: "blockstack", coinmarketcalId: "stacks" },
  INJ: { coingeckoId: "injective-protocol", coinmarketcalId: "injective" },
  LDO: { coingeckoId: "lido-dao", coinmarketcalId: "lido-dao" },
  CRV: { coingeckoId: "curve-dao-token", coinmarketcalId: "curve-dao-token" },
  RUNE: { coingeckoId: "thorchain", coinmarketcalId: "thorchain" },
  ENA: { coingeckoId: "ethena", coinmarketcalId: "ethena" },
  ONDO: { coingeckoId: "ondo-finance", coinmarketcalId: "ondo" },
  JUP: { coingeckoId: "jupiter-exchange-solana", coinmarketcalId: "jupiter" },
  ETHFI: { coingeckoId: "ether-fi", coinmarketcalId: "ether-fi" },
  GRT: { coingeckoId: "the-graph", coinmarketcalId: "the-graph" },
  WLD: { coingeckoId: "worldcoin-wld", coinmarketcalId: "worldcoin" },
  AR: { coingeckoId: "arweave", coinmarketcalId: "arweave" },
  SHIB: { coingeckoId: "shiba-inu", coinmarketcalId: "shiba-inu" },
  BONK: { coingeckoId: "bonk", coinmarketcalId: "bonk" },
  IMX: { coingeckoId: "immutable-x", coinmarketcalId: "immutable" },
  ZEC: { coingeckoId: "zcash", coinmarketcalId: "zcash" },
};

/** Reverse lookup: CoinMarketCal coin ID → canonical ticker. */
export const TICKER_BY_COINMARKETCAL_ID: Record<string, string> = Object.fromEntries(
  Object.entries(ASSET_IDS)
    .filter(([, ids]) => ids.coinmarketcalId !== null)
    .map(([ticker, ids]) => [ids.coinmarketcalId!, ticker]),
);

/** Every mapped CoinMarketCal ID — the ingest query's `coins=` filter. */
export const COINMARKETCAL_IDS: string[] = Object.values(ASSET_IDS)
  .map((ids) => ids.coinmarketcalId)
  .filter((id): id is string => id !== null);
