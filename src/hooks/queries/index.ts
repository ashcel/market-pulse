import { useQuery } from "@tanstack/react-query";
import { assets } from "@/lib/mock/assets";
import { regime } from "@/lib/mock/regime";
import { rotation, sectors } from "@/lib/mock/rotation";
import { news } from "@/lib/mock/news";
import { signals, sentiment, technical, volatility, technicalConfidence } from "@/lib/mock/signals";

const fake = <T>(data: T, delay = 350) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(data), delay));

export const useAssets = () =>
  useQuery({ queryKey: ["assets"], queryFn: () => fake(assets) });

export const useTopAssets = (n = 5) =>
  useQuery({
    queryKey: ["assets", "top", n],
    queryFn: () => fake([...assets].sort((a, b) => b.score - a.score).slice(0, n)),
  });

export const useRegime = () =>
  useQuery({ queryKey: ["regime"], queryFn: () => fake(regime) });

export const useRotation = () =>
  useQuery({ queryKey: ["rotation"], queryFn: () => fake(rotation) });

export const useSectors = () =>
  useQuery({ queryKey: ["sectors"], queryFn: () => fake(sectors) });

export const useNews = () =>
  useQuery({ queryKey: ["news"], queryFn: () => fake(news) });

export const useSignals = () =>
  useQuery({
    queryKey: ["signals"],
    queryFn: () => fake({ signals, confidence: technicalConfidence }),
  });

export const useSentiment = () =>
  useQuery({ queryKey: ["sentiment"], queryFn: () => fake(sentiment, 250) });

export const useTechnicalQuality = () =>
  useQuery({ queryKey: ["technical-quality"], queryFn: () => fake(technical, 250) });

export const useVolatility = () =>
  useQuery({ queryKey: ["volatility"], queryFn: () => fake(volatility, 250) });
