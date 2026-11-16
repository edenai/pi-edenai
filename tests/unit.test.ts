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
	mapCatalog,
	mapEdenModel,
	resolveBaseUrl,
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

// A trimmed sample mirroring the real GET /v3/models?view=models response shape.
const SAMPLE = {
	object: "list",
	data: [
		{ id: "gpt-4o", endpoints: [OPENAI_GPT_4O, AZURE_GPT_4O] },
		{ id: "ai21.jamba-1-5-large-v1:0", endpoints: [JAMBA] },
		{ id: "us-only-model", endpoints: [US_ONLY] },
		{ id: "~gpt-latest", alias_of: "gpt-4o", endpoints: [OPENAI_GPT_4O, AZURE_GPT_4O] },
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

run("mapCatalog lists each endpoint once, by provider id", () => {
	const ids = mapCatalog(SAMPLE).map((m) => m.id).sort();
	// The ~ alias repeats gpt-4o's endpoints and policy/x has none.
	assert.deepEqual(ids, [
		"amazon/ai21.jamba-1-5-large-v1:0",
		"azure/gpt-4o",
		"openai/gpt-4o",
		"someprovider/us-only-model",
	]);
});

run("mapCatalog euOnly keeps only EU-region endpoints", () => {
	const eu = mapCatalog(SAMPLE, { euOnly: true });
	const ids = eu.map((m) => m.id).sort();
	assert.deepEqual(ids, ["amazon/ai21.jamba-1-5-large-v1:0", "openai/gpt-4o"]);
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

console.log("all tests passed");
