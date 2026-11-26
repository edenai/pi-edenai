/**
 * Unit tests for pi-edenai pure helpers.
 * Run:  npm test        (uses tsx)
 *   or  npx tsx test.ts
 */
import assert from "node:assert/strict";
import {
	DEFAULT_BASE_URL,
	EU_BASE_URL,
	FALLBACK_MODELS,
	isEuModel,
	keyVariable,
	mapCatalog,
	mapEdenModel,
	providerConfig,
	resolveBaseUrl,
	resolveMaxTokens,
} from "../index.ts";

// Endpoint entries, as nested under each model by GET /v3/models?view=models.
const OPENAI_GPT_4O = {
	id: "openai/gpt-4o",
	owned_by: "openai",
	context_length: 128000,
	capabilities: { input_modalities: ["text", "image"], supports_reasoning: false },
	pricing: { input_cost_per_token: 2.5e-6, output_cost_per_token: 10e-6 },
	regions: [{ code: "us", name: "United States" }, { code: "eu", name: "Europe" }],
};
const AZURE_GPT_4O = {
	id: "azure/gpt-4o",
	owned_by: "azure",
	context_length: 128000,
	capabilities: { input_modalities: ["text", "image"], supports_reasoning: false },
	pricing: { input_cost_per_token: 2.5e-6, output_cost_per_token: 10e-6 },
	regions: [{ code: "us", name: "United States" }],
};
const JAMBA = {
	id: "amazon/ai21.jamba-1-5-large-v1:0",
	owned_by: "amazon",
	context_length: 256000,
	capabilities: { input_modalities: ["text"], supports_reasoning: false },
	pricing: { input_cost_per_token: 2e-6, output_cost_per_token: 8e-6 },
	regions: [{ code: "eu", name: "Europe" }],
};
const US_ONLY = {
	id: "someprovider/us-only-model",
	context_length: 8192,
	capabilities: { input_modalities: ["text", "audio", "video"], supports_reasoning: true },
	pricing: { input_cost_per_token: 1e-6, output_cost_per_token: 3e-6 },
	regions: [{ code: "us", name: "United States" }],
};

// A trimmed sample mirroring the real GET /v3/models?view=models response shape: each model
// carries its own context window, capabilities and pricing beside its endpoints.
const SAMPLE = {
	object: "list",
	data: [
		{ ...OPENAI_GPT_4O, id: "gpt-4o", regions: [], endpoints: [OPENAI_GPT_4O, AZURE_GPT_4O] },
		{ ...JAMBA, id: "ai21.jamba-1-5-large-v1:0", regions: [], endpoints: [JAMBA] },
		{ ...US_ONLY, id: "us-only-model", regions: [], endpoints: [US_ONLY] },
		{
			...OPENAI_GPT_4O,
			id: "~gpt-latest",
			alias_of: "gpt-4o",
			regions: [],
			endpoints: [OPENAI_GPT_4O, AZURE_GPT_4O],
		},
		{ id: "policy/x", endpoints: [] },
	],
};

function run(name: string, fn: () => void) {
	fn();
	console.log(`  ok  ${name}`);
}

console.log("pi-edenai tests");

run("mapEdenModel converts per-token pricing to $/million", () => {
	const m = mapEdenModel(OPENAI_GPT_4O);
	assert.equal(m.id, "openai/gpt-4o");
	assert.equal(m.cost.input, 2.5);
	assert.equal(m.cost.output, 10);
	assert.equal(m.contextWindow, 128000);
	assert.deepEqual(m.input, ["text", "image"]);
	assert.equal(m.reasoning, false);
});

run("mapEdenModel drops unsupported input modalities and keeps text fallback", () => {
	const m = mapEdenModel(US_ONLY);
	assert.deepEqual(m.input, ["text"]); // audio/video dropped
	assert.equal(m.reasoning, true);
});

run("mapEdenModel applies the maxTokens argument", () => {
	const m = mapEdenModel(OPENAI_GPT_4O, 4096);
	assert.equal(m.maxTokens, 4096);
});

run("mapEdenModel takes the model's own max_output_tokens", () => {
	const opus = { ...OPENAI_GPT_4O, context_length: 1_000_000, max_output_tokens: 128_000 };
	assert.equal(mapEdenModel(opus).maxTokens, 128_000);
	assert.equal(mapEdenModel(opus, 4096).maxTokens, 4096); // EDENAI_MAX_TOKENS still wins
});

run("mapEdenModel without a stated limit gives a reasoning model more room", () => {
	assert.equal(mapEdenModel(OPENAI_GPT_4O).maxTokens, 8192);
	const thinker = { ...JAMBA, capabilities: { supports_reasoning: true } };
	assert.equal(mapEdenModel(thinker).maxTokens, 32_768);
	assert.equal(mapEdenModel(US_ONLY).maxTokens, 8192); // capped at its 8,192 window
});

run("resolveMaxTokens is unset unless EDENAI_MAX_TOKENS is a positive integer", () => {
	assert.equal(resolveMaxTokens({} as NodeJS.ProcessEnv), undefined);
	assert.equal(resolveMaxTokens({ EDENAI_MAX_TOKENS: "0" } as NodeJS.ProcessEnv), undefined);
	assert.equal(resolveMaxTokens({ EDENAI_MAX_TOKENS: "64000" } as NodeJS.ProcessEnv), 64000);
});

run("mapCatalog lists each model once, by the name provider routing takes", () => {
	const models = mapCatalog(SAMPLE);
	// Aliases are names routing takes too; policy/x has no endpoint.
	assert.deepEqual(models.map((m) => m.id).sort(), [
		"ai21.jamba-1-5-large-v1:0",
		"gpt-4o",
		"us-only-model",
		"~gpt-latest",
	]);
	const gpt = models.find((m) => m.id === "gpt-4o")!;
	assert.equal(gpt.contextWindow, 128000);
	assert.equal(gpt.cost.input, 2.5);
});

run("mapCatalog euOnly keeps the models with an EU-region endpoint", () => {
	const eu = mapCatalog(SAMPLE, { euOnly: true });
	const ids = eu.map((m) => m.id).sort();
	assert.deepEqual(ids, ["ai21.jamba-1-5-large-v1:0", "gpt-4o", "~gpt-latest"]);
});

run("mapCatalog tolerates a missing data array", () => {
	assert.deepEqual(mapCatalog({}), []);
});

run("isEuModel detects EU region case-insensitively", () => {
	assert.equal(isEuModel(OPENAI_GPT_4O), true);
	assert.equal(isEuModel(US_ONLY), false);
});

run("resolveBaseUrl defaults to the global endpoint", () => {
	assert.equal(resolveBaseUrl({} as NodeJS.ProcessEnv), DEFAULT_BASE_URL);
});

run("resolveBaseUrl switches to EU endpoint when EU-only", () => {
	assert.equal(resolveBaseUrl({ EDENAI_EU_ONLY: "1" } as NodeJS.ProcessEnv), EU_BASE_URL);
});

run("resolveBaseUrl honors an explicit override and trims trailing slash", () => {
	assert.equal(
		resolveBaseUrl({ EDENAI_BASE_URL: "https://proxy.example.com/v3/" } as NodeJS.ProcessEnv),
		"https://proxy.example.com/v3",
	);
});

run("FALLBACK_MODELS are well-formed", () => {
	assert.ok(FALLBACK_MODELS.length >= 8);
	for (const m of FALLBACK_MODELS) {
		assert.ok(m.id.includes("/"), `id should be provider/model: ${m.id}`);
		assert.ok(m.contextWindow > 0);
		assert.ok(m.maxTokens > 0);
		assert.ok(m.cost.input >= 0 && m.cost.output >= 0);
		assert.ok(m.input.length > 0);
	}
});

run("every registered model sends Pi's session id as x-session-id", () => {
	const config = providerConfig(DEFAULT_BASE_URL, FALLBACK_MODELS);
	assert.equal(config.models.length, FALLBACK_MODELS.length);
	for (const m of config.models) {
		assert.deepEqual(m.compat, {
			sendSessionAffinityHeaders: true,
			sessionAffinityFormat: "openrouter",
		});
	}
});

run("reads the key from EDENAI_API_KEY, else EDEN_AI_API_KEY", () => {
	assert.equal(keyVariable({} as NodeJS.ProcessEnv), "EDENAI_API_KEY");
	assert.equal(keyVariable({ EDEN_AI_API_KEY: "k" } as NodeJS.ProcessEnv), "EDEN_AI_API_KEY");
	assert.equal(
		keyVariable({ EDENAI_API_KEY: "a", EDEN_AI_API_KEY: "b" } as NodeJS.ProcessEnv),
		"EDENAI_API_KEY",
	);
});

console.log("all tests passed");
