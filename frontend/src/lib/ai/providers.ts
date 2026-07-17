// BYOK AI analyst providers. Three of the four providers (OpenRouter, OpenAI,
// and any OpenAI-compatible "custom" endpoint like z.ai/GLM or a local opencode
// server) speak the OpenAI Chat Completions wire format; Claude uses the
// Anthropic Messages API. Keys live in the browser (see stores/ai-settings) and
// are sent straight to the provider — never through this app's server.

export type AiProvider = "openrouter" | "openai" | "anthropic" | "custom";

/** Which wire format a provider speaks. */
export type ProviderKind = "openai" | "anthropic";

export interface RecommendedModel {
  id: string;
  label: string;
  note?: string;
}

export interface ProviderMeta {
  id: AiProvider;
  label: string;
  blurb: string;
  kind: ProviderKind;
  /** Default API base URL. Empty for `custom`, where the user supplies it. */
  baseUrl: string;
  /** Whether the user edits the base URL (custom / self-hosted endpoints). */
  editableBaseUrl: boolean;
  baseUrlPlaceholder?: string;
  keyPlaceholder: string;
  keyHelpUrl: string;
  keyHelpLabel: string;
  recommendedModels: RecommendedModel[];
  defaultModel: string;
  modelPlaceholder: string;
}

export const PROVIDERS: Record<AiProvider, ProviderMeta> = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    blurb: "One key, every model. DeepSeek, GLM, Claude, GPT and more.",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    editableBaseUrl: false,
    keyPlaceholder: "sk-or-v1-…",
    keyHelpUrl: "https://openrouter.ai/keys",
    keyHelpLabel: "openrouter.ai/keys",
    recommendedModels: [
      { id: "deepseek/deepseek-chat", label: "DeepSeek V3", note: "Fast, cheap" },
      { id: "deepseek/deepseek-r1", label: "DeepSeek R1", note: "Reasoning" },
      { id: "z-ai/glm-4.6", label: "GLM 4.6" },
      { id: "anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
      { id: "openai/gpt-4o-mini", label: "GPT-4o mini" },
    ],
    defaultModel: "deepseek/deepseek-chat",
    modelPlaceholder: "vendor/model-name",
  },
  openai: {
    id: "openai",
    label: "OpenAI (GPT)",
    blurb: "Direct to the OpenAI API with your own key.",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    editableBaseUrl: false,
    keyPlaceholder: "sk-…",
    keyHelpUrl: "https://platform.openai.com/api-keys",
    keyHelpLabel: "platform.openai.com/api-keys",
    recommendedModels: [
      { id: "gpt-4o", label: "GPT-4o" },
      { id: "gpt-4o-mini", label: "GPT-4o mini", note: "Fast, cheap" },
      { id: "gpt-4.1", label: "GPT-4.1" },
      { id: "gpt-4.1-mini", label: "GPT-4.1 mini" },
    ],
    defaultModel: "gpt-4o-mini",
    modelPlaceholder: "gpt-4o-mini",
  },
  anthropic: {
    id: "anthropic",
    label: "Claude",
    blurb: "Direct to the Anthropic Messages API with your own key.",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    editableBaseUrl: false,
    keyPlaceholder: "sk-ant-…",
    keyHelpUrl: "https://console.anthropic.com/settings/keys",
    keyHelpLabel: "console.anthropic.com",
    recommendedModels: [
      { id: "claude-opus-4-8", label: "Claude Opus 4.8", note: "Most capable" },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5", note: "Balanced" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", note: "Fast, cheap" },
    ],
    defaultModel: "claude-opus-4-8",
    modelPlaceholder: "claude-sonnet-5",
  },
  custom: {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    blurb: "Any OpenAI-compatible endpoint — z.ai/GLM, a local opencode server, Ollama, etc.",
    kind: "openai",
    baseUrl: "",
    editableBaseUrl: true,
    baseUrlPlaceholder: "https://api.z.ai/api/paas/v4",
    keyPlaceholder: "your-api-key (or any value for local servers)",
    keyHelpUrl: "https://docs.z.ai/guides/develop/http/introduction",
    keyHelpLabel: "provider docs",
    recommendedModels: [
      { id: "glm-4.6", label: "GLM 4.6" },
      { id: "glm-4.5-air", label: "GLM 4.5 Air" },
    ],
    defaultModel: "",
    modelPlaceholder: "glm-4.6",
  },
};

export const PROVIDER_ORDER: AiProvider[] = ["openrouter", "openai", "anthropic", "custom"];

export interface ResolvedAiConfig {
  provider: AiProvider;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Minimal shape of the persisted settings this resolver needs. */
export interface AiSettingsSnapshot {
  provider: AiProvider;
  apiKeys: Partial<Record<AiProvider, string>>;
  models: Partial<Record<AiProvider, string>>;
  customBaseUrl: string;
}

/**
 * Turn the stored settings into a ready-to-call config, or `null` when the
 * active provider isn't fully configured (missing key, model, or — for custom
 * providers — base URL). A `null` result is the signal to fall back to the
 * deterministic memo.
 */
export function resolveAiConfig(s: AiSettingsSnapshot): ResolvedAiConfig | null {
  const meta = PROVIDERS[s.provider];
  if (!meta) return null;
  const apiKey = (s.apiKeys[s.provider] ?? "").trim();
  const model = (s.models[s.provider] ?? meta.defaultModel).trim();
  const rawBase = meta.editableBaseUrl ? (s.customBaseUrl ?? "") : meta.baseUrl;
  const baseUrl = rawBase.trim().replace(/\/+$/, "");
  if (!apiKey || !model) return null;
  if (meta.editableBaseUrl && !baseUrl) return null;
  return { provider: s.provider, kind: meta.kind, baseUrl, apiKey, model };
}
