import type { RotationData, Sector } from "../types";

export const rotation: RotationData = {
  flow: ["Stocks", "BTC", "ETH", "AI", "Gaming", "Meme"],
  legs: [
    { from: "Stocks", to: "BTC", strength: 88 },
    { from: "BTC", to: "ETH", strength: 74 },
    { from: "ETH", to: "AI", strength: 82 },
    { from: "AI", to: "Gaming", strength: 46 },
    { from: "Gaming", to: "Meme", strength: 31 },
  ],
  strength: "High",
  confidence: 84,
  winning: "AI",
  losing: "Commodities",
};

export const sectors: Sector[] = [
  { group: "EQUITIES", ticker: "SPY", name: "S&P 500", change: 0.78 },
  { group: "EQUITIES", ticker: "QQQ", name: "Nasdaq 100", change: 1.04 },
  { group: "EQUITIES", ticker: "DIA", name: "Dow Jones", change: 0.55 },
  { group: "EQUITIES", ticker: "IWM", name: "Russell 2000", change: 0.32 },
  { group: "CRYPTO", ticker: "BTC", name: "Bitcoin", change: 2.35 },
  { group: "CRYPTO", ticker: "ETH", name: "Ethereum", change: 3.12 },
  { group: "CRYPTO", ticker: "SOL", name: "Solana", change: 2.18 },
  { group: "CRYPTO", ticker: "XRP", name: "Ripple", change: 1.45 },
  { group: "CRYPTO", ticker: "BNB", name: "Binance", change: 1.22 },
  { group: "SECTORS", ticker: "AI", name: "AI Basket", change: 5.61 },
  { group: "SECTORS", ticker: "SEMI", name: "Semiconductor", change: 3.21 },
  { group: "SECTORS", ticker: "TECH", name: "Technology", change: 1.32 },
  { group: "SECTORS", ticker: "CLOUD", name: "Cloud", change: 1.18 },
  { group: "COMMODITIES", ticker: "GOLD", name: "Gold", change: -0.32 },
  { group: "COMMODITIES", ticker: "SILVER", name: "Silver", change: -0.21 },
  { group: "COMMODITIES", ticker: "OIL", name: "Crude Oil", change: 0.41 },
  { group: "CURRENCIES", ticker: "DXY", name: "Dollar Index", change: -0.41 },
  { group: "CURRENCIES", ticker: "EURUSD", name: "EUR/USD", change: 0.22 },
  { group: "CURRENCIES", ticker: "JPYUSD", name: "JPY/USD", change: -0.15 },
];
