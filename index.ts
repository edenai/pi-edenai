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
 * Model ids are the names Eden AI routes, e.g. ~claude-sonnet-latest or
 * ~gpt-mini-latest: provider routing picks the provider for each call. A
 * `provider/model` id (anthropic/claude-sonnet-latest) still works with --model
 * to pin one.
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
 * Output limits for a model whose catalog entry states none. Each model otherwise
 * takes its own `max_output_tokens`: the smallest limit among the providers that
 * serve it, so it is accepted whichever one routing picks. A reasoning model gets
 * more room, as its thinking counts toward the limit. EDENAI_MAX_TOKENS overrides
 * every model; pi's models.json overrides one.
 */
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_REASONING_MAX_TOKENS = 32_768;
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Pi sends its session id with each call as `x-session-id` (the header it uses for
 * OpenRouter), which Eden AI reads as the call's session: Monitoring and the tools Trace
 * Export sends to group a Pi session's calls under Pi's own id. Pi leaves it out when
 * prompt caching is off (`cacheRetention: "none"`).
 */
export const SESSION_COMPAT = {
	sendSessionAffinityHeaders: true,
	sessionAffinityFormat: "openrouter",
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One model of Eden AI's `GET /v3/models` catalog, or one of its endpoints (`provider/model`). */
interface EdenModel {
	id: string;
	owned_by?: string;
	context_length?: number | null;
	max_output_tokens?: number | null;
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

/** One entry of `GET /v3/models?view=models`: a model, with the endpoints routing picks from. */
interface EdenModelGroup extends EdenModel {
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

/** EDENAI_MAX_TOKENS when set to a positive integer, else undefined (each model's own). */
export function resolveMaxTokens(env: NodeJS.ProcessEnv = process.env): number | undefined {
	const raw = env.EDENAI_MAX_TOKENS;
	const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** The output limit pi sends for `m`: the override, else the model's own, else a default. */
export function modelMaxTokens(m: EdenModel, override?: number): number {
	if (override) return override;
	const own = m.max_output_tokens;
	if (own && own > 0) return own;
	const fallback = m.capabilities?.supports_reasoning
		? DEFAULT_REASONING_MAX_TOKENS
		: DEFAULT_MAX_TOKENS;
	return m.context_length ? Math.min(fallback, m.context_length) : fallback;
}

/** The key's variable: `EDENAI_API_KEY`, else `EDEN_AI_API_KEY` (the name Eden AI's docs used). */
export function keyVariable(env: NodeJS.ProcessEnv = process.env): string {
	if (!env.EDENAI_API_KEY?.trim() && env.EDEN_AI_API_KEY?.trim()) return "EDEN_AI_API_KEY";
	return "EDENAI_API_KEY";
}

function readKey(): string | undefined {
	return process.env[keyVariable()]?.trim() || undefined;
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
export function mapEdenModel(m: EdenModel, maxTokens?: number): PiModel {
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
		maxTokens: modelMaxTokens(m, maxTokens),
	};
}

/**
 * One pi model per model Eden AI routes, from a raw `/models?view=models` payload: its name
 * (`claude-opus-5.5`, or an alias such as `~claude-fable-latest`), which provider routing sends
 * to one of its endpoints, with the model's own context window, pricing and capabilities. A
 * model with no endpoint is left out; EU-only keeps a model with an EU-region endpoint.
 */
export function mapCatalog(
	payload: EdenModelsResponse,
	opts: { euOnly?: boolean; maxTokens?: number } = {},
): PiModel[] {
	const groups = (Array.isArray(payload.data) ? payload.data : []).filter(
		(g) => g.endpoints?.length,
	);
	const kept = opts.euOnly
		? groups.filter((g) => (g.endpoints ?? []).some(isEuModel))
		: groups;
	return kept.map((g) => mapEdenModel(g, opts.maxTokens));
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
// Curated fallback, used only when live discovery fails at startup: the `~`
// aliases, which follow the newest model of each family, as the live catalog
// maps them (the e2e test fails when one is stale). Costs are $ per million tokens.
// ---------------------------------------------------------------------------

export const FALLBACK_MODELS: PiModel[] = [
	{ id: "~claude-sonnet-latest", name: "~claude-sonnet-latest", reasoning: true, input: ["text", "image"], cost: { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 128_000 },
	{ id: "~claude-opus-latest", name: "~claude-opus-latest", reasoning: true, input: ["text", "image"], cost: { input: 4, output: 20, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 128_000 },
	{ id: "~claude-haiku-latest", name: "~claude-haiku-latest", reasoning: true, input: ["text", "image"], cost: { input: 0.1, output: 0.5, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 128_000 },
	{ id: "~gpt-sol-latest", name: "~gpt-sol-latest", reasoning: true, input: ["text", "image"], cost: { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_050_000, maxTokens: 128_000 },
	{ id: "~gpt-terra-latest", name: "~gpt-terra-latest", reasoning: true, input: ["text", "image"], cost: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_050_000, maxTokens: 128_000 },
	{ id: "~gpt-mini-latest", name: "~gpt-mini-latest", reasoning: true, input: ["text", "image"], cost: { input: 0.75, output: 4.5, cacheRead: 0, cacheWrite: 0 }, contextWindow: 400_000, maxTokens: 128_000 },
	{ id: "~gemini-pro-latest", name: "~gemini-pro-latest", reasoning: true, input: ["text", "image"], cost: { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 32_768 },
	{ id: "~gemini-flash-latest", name: "~gemini-flash-latest", reasoning: true, input: ["text", "image"], cost: { input: 1.5, output: 7.5, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 65_536 },
	{ id: "~deepseek-pro-latest", name: "~deepseek-pro-latest", reasoning: true, input: ["text"], cost: { input: 0.429, output: 1.287, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 64_000 },
	{ id: "~deepseek-flash-latest", name: "~deepseek-flash-latest", reasoning: true, input: ["text", "image"], cost: { input: 0.0975, output: 0.39, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 32_768 },
	{ id: "~kimi-latest", name: "~kimi-latest", reasoning: true, input: ["text", "image"], cost: { input: 1.95, output: 9.75, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 64_000 },
	{ id: "~glm-latest", name: "~glm-latest", reasoning: true, input: ["text"], cost: { input: 0.2, output: 0.64, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_048_576, maxTokens: 64_000 },
	{ id: "~grok-latest", name: "~grok-latest", reasoning: true, input: ["text", "image"], cost: { input: 2, output: 6, cacheRead: 0, cacheWrite: 0 }, contextWindow: 524_288, maxTokens: 32_768 },
];

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
	const baseUrl = resolveBaseUrl();
	const euOnly = Boolean(process.env.EDENAI_EU_ONLY);
	const apiKey = readKey();

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
			const key = readKey();
			if (!key) {
				ctx.ui.notify("EDENAI_API_KEY is not set (EDEN_AI_API_KEY works too). Set it and run /edenai-sync again.", "error");
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

/** The provider as registered: every model sends Pi's session id (`SESSION_COMPAT`). */
export function providerConfig(baseUrl: string, models: PiModel[]) {
	return {
		name: PROVIDER_NAME,
		baseUrl,
		apiKey: `$${keyVariable()}`,
		api: "openai-completions" as const,
		models: models.map((m) => ({ ...m, compat: SESSION_COMPAT })),
	};
}

function register(pi: ExtensionAPI, baseUrl: string, models: PiModel[]) {
	pi.registerProvider(PROVIDER_ID, providerConfig(baseUrl, models));
}
