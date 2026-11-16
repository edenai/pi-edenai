/**
 * pi-edenai — Eden AI provider extension for Pi
 * ---------------------------------------------------------------------------
 * Registers Eden AI as a provider in Pi (earendil-works/pi), exposing 700+
 * models from every major provider (OpenAI, Anthropic, Google, Mistral,
 * DeepSeek, Cohere, Amazon, xAI, …) behind ONE OpenAI-compatible, EU-hosted
 * API and a single key.
 *
 * Models are discovered live from Eden AI's `/v3/models` endpoint at startup,
 * so the catalog — and each model's pricing, context window, vision and
 * reasoning support — always reflects what is currently available on your
 * account. If the live catalog can't be reached (no key set yet, offline),
 * a small curated set of current models is registered as a fallback, and
 * `/edenai-sync` can pull the full catalog later.
 *
 * Setup:
 *   export EDENAI_API_KEY="your-eden-ai-key"   # get one at https://app.edenai.run
 *   pi -e ./index.ts                            # quick test
 *   # or install as a package: pi install npm:pi-edenai
 *
 * EU data residency (GDPR): point the provider at the EU endpoint and, if you
 * want, restrict the catalog to EU-eligible models:
 *   export EDENAI_BASE_URL="https://api.eu.edenai.run/v3"
 *   export EDENAI_EU_ONLY="1"
 *
 * Model ids follow Eden AI's `provider/model` convention, e.g.
 *   anthropic/claude-sonnet-4-5, openai/gpt-4o, mistral/mistral-large-latest
 *
 * SPDX-License-Identifier: MIT
 * Eden AI <support@edenai.co>
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const PROVIDER_ID = "edenai";
export const PROVIDER_NAME = "Eden AI";
export const DEFAULT_BASE_URL = "https://api.edenai.run/v3";
export const EU_BASE_URL = "https://api.eu.edenai.run/v3";

/**
 * Eden AI's `/models` response does not expose a per-model max output token
 * limit, so we apply a safe default cap. Override globally with
 * EDENAI_MAX_TOKENS; individual models can also be overridden via pi's
 * models.json.
 */
const DEFAULT_MAX_TOKENS = 8192;
const FETCH_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One endpoint (`provider/model`) of Eden AI's `GET /v3/models` catalog. */
interface EdenModel {
	id: string;
	owned_by?: string;
	context_length?: number | null;
	capabilities?: {
		input_modalities?: string[];
		supports_reasoning?: boolean;
		supports_function_calling?: boolean;
	} | null;
	pricing?: {
		input_cost_per_token?: number | null;
		output_cost_per_token?: number | null;
	} | null;
	regions?: Array<{ code: string; name: string }> | null;
	alias_of?: string | null;
}

/** One entry of `GET /v3/models?view=models`: a model grouping its endpoints. */
interface EdenModelGroup {
	id: string;
	endpoints?: EdenModel[] | null;
}

interface EdenModelsResponse {
	object?: string;
	data?: EdenModelGroup[];
}

/** Subset of pi's ProviderModelConfig that we populate. */
export interface PiModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in test.ts)
// ---------------------------------------------------------------------------

function resolveMaxTokens(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.EDENAI_MAX_TOKENS;
	const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_TOKENS;
}

/** Resolve the base URL from the environment (EU endpoint when EU-only). */
export function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.EDENAI_BASE_URL?.trim();
	if (override) return override.replace(/\/+$/, "");
	return env.EDENAI_EU_ONLY ? EU_BASE_URL : DEFAULT_BASE_URL;
}

/** True when a model is served from an EU region. */
export function isEuModel(m: EdenModel): boolean {
	return (m.regions ?? []).some((r) => r?.code?.toLowerCase() === "eu");
}

/** Map one Eden AI catalog entry to a pi model config. */
export function mapEdenModel(m: EdenModel, maxTokens: number = DEFAULT_MAX_TOKENS): PiModel {
	const cap = m.capabilities ?? {};
	// pi only understands "text" and "image" input; drop audio/video/document.
	const input = (cap.input_modalities ?? ["text"]).filter(
		(x): x is "text" | "image" => x === "text" || x === "image",
	);
	// Eden prices per-token; pi wants $ per million tokens.
	const inPerTok = m.pricing?.input_cost_per_token ?? 0;
	const outPerTok = m.pricing?.output_cost_per_token ?? 0;
	return {
		id: m.id,
		name: m.id,
		reasoning: Boolean(cap.supports_reasoning),
		input: input.length ? input : ["text"],
		cost: {
			input: inPerTok * 1_000_000,
			output: outPerTok * 1_000_000,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: m.context_length ?? 128_000,
		maxTokens,
	};
}

/** Flatten, map and optionally EU-filter a raw Eden `/models?view=models` payload. */
export function mapCatalog(
	payload: EdenModelsResponse,
	opts: { euOnly?: boolean; maxTokens?: number } = {},
): PiModel[] {
	const groups = Array.isArray(payload.data) ? payload.data : [];
	// pi saves the exact model id and needs per-endpoint limits and prices, so it
	// lists endpoints. Alias groups (`~...`) repeat their target's endpoints.
	const byId = new Map<string, EdenModel>();
	for (const e of groups.flatMap((g) => g.endpoints ?? [])) {
		if (!byId.has(e.id)) byId.set(e.id, e);
	}
	const raw = [...byId.values()];
	const filtered = opts.euOnly ? raw.filter(isEuModel) : raw;
	const mt = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
	return filtered.map((m) => mapEdenModel(m, mt));
}

// ---------------------------------------------------------------------------
// Live catalog fetch
// ---------------------------------------------------------------------------

async function fetchCatalog(baseUrl: string, apiKey: string, euOnly: boolean): Promise<PiModel[]> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(`${baseUrl}/models?view=models`, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: controller.signal,
		});
		if (!res.ok) {
			throw new Error(`Eden AI /models returned ${res.status} ${res.statusText}`);
		}
		const payload = (await res.json()) as EdenModelsResponse;
		return mapCatalog(payload, { euOnly, maxTokens: resolveMaxTokens() });
	} finally {
		clearTimeout(timer);
	}
}

// ---------------------------------------------------------------------------
// Curated fallback (verified against the live catalog; used only when live
// discovery fails at startup). Costs are $ per million tokens.
// ---------------------------------------------------------------------------

export const FALLBACK_MODELS: PiModel[] = [
	{ id: "anthropic/claude-opus-4-5", name: "anthropic/claude-opus-4-5", reasoning: true, input: ["text", "image"], cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 32_000 },
	{ id: "anthropic/claude-sonnet-4-5", name: "anthropic/claude-sonnet-4-5", reasoning: true, input: ["text", "image"], cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 64_000 },
	{ id: "anthropic/claude-haiku-4-5", name: "anthropic/claude-haiku-4-5", reasoning: true, input: ["text", "image"], cost: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 32_000 },
	{ id: "openai/gpt-4o", name: "openai/gpt-4o", reasoning: false, input: ["text", "image"], cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 16_384 },
	{ id: "openai/gpt-4o-mini", name: "openai/gpt-4o-mini", reasoning: false, input: ["text", "image"], cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 16_384 },
	{ id: "google/gemini-2.5-pro", name: "google/gemini-2.5-pro", reasoning: true, input: ["text", "image"], cost: { input: 1.25, output: 10, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 65_536 },
	{ id: "google/gemini-2.5-flash", name: "google/gemini-2.5-flash", reasoning: true, input: ["text", "image"], cost: { input: 0.3, output: 2.5, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 65_536 },
	{ id: "mistral/mistral-large-latest", name: "mistral/mistral-large-latest", reasoning: false, input: ["text", "image"], cost: { input: 2, output: 6, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262_144, maxTokens: 8192 },
	{ id: "mistral/codestral-latest", name: "mistral/codestral-latest", reasoning: false, input: ["text"], cost: { input: 1, output: 3, cacheRead: 0, cacheWrite: 0 }, contextWindow: 256_000, maxTokens: 8192 },
	{ id: "deepseek/deepseek-v4-pro", name: "deepseek/deepseek-v4-pro", reasoning: true, input: ["text"], cost: { input: 0.435, output: 0.87, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 8192 },
	{ id: "deepseek/deepseek-chat", name: "deepseek/deepseek-chat", reasoning: false, input: ["text"], cost: { input: 0.28, output: 0.42, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131_072, maxTokens: 8192 },
	{ id: "xai/grok-3", name: "xai/grok-3", reasoning: false, input: ["text"], cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131_072, maxTokens: 8192 },
];

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
	const baseUrl = resolveBaseUrl();
	const euOnly = Boolean(process.env.EDENAI_EU_ONLY);
	const apiKey = process.env.EDENAI_API_KEY?.trim();

	let models: PiModel[] = FALLBACK_MODELS;
	if (apiKey) {
		try {
			const fetched = await fetchCatalog(baseUrl, apiKey, euOnly);
			if (fetched.length) models = fetched;
		} catch {
			// Keep the curated fallback; user can refresh later with /edenai-sync.
		}
	}

	register(pi, baseUrl, models);

	pi.registerCommand("edenai-sync", {
		description: "Refresh the Eden AI model catalog from the live API",
		handler: async (_args, ctx) => {
			const key = process.env.EDENAI_API_KEY?.trim();
			if (!key) {
				ctx.ui.notify("EDENAI_API_KEY is not set — set it and run /edenai-sync again.", "error");
				return;
			}
			try {
				const url = resolveBaseUrl();
				const fetched = await fetchCatalog(url, key, Boolean(process.env.EDENAI_EU_ONLY));
				if (!fetched.length) {
					ctx.ui.notify("Eden AI returned no models.", "error");
					return;
				}
				register(pi, url, fetched);
				ctx.ui.notify(`Eden AI: ${fetched.length} models loaded from ${url}.`, "info");
			} catch (e) {
				ctx.ui.notify(`Eden AI sync failed: ${e instanceof Error ? e.message : String(e)}`, "error");
			}
		},
	});
}

function register(pi: ExtensionAPI, baseUrl: string, models: PiModel[]) {
	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl,
		apiKey: "$EDENAI_API_KEY",
		api: "openai-completions",
		models,
	});
}
