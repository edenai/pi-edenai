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

// A trimmed sample mirroring the real GET /v3/models response shape.
const SAMPLE = {
	object: "list",
	data: [
		{
			id: "openai/gpt-4o",
			owned_by: "openai",
			context_length: 128000,
			capabilities: { input_modalities: ["text", "image"], supports_reasoning: false },
			pricing: { input_cost_per_token: 2.5e-6, output_cost_per_token: 10e-6 },
			regions: [{ code: "us", name: "United States" }, { code: "eu", name: "Europe" }],
		},
		{
			id: "amazon/ai21.jamba-1-5-large-v1:0",
			owned_by: "amazon",
			context_length: 256000,
			capabilities: { input_modalities: ["text"], supports_reasoning: false },
			pricing: { input_cost_per_token: 2e-6, output_cost_per_token: 8e-6 },
			regions: [{ code: "eu", name: "Europe" }],
		},
		{
			id: "someprovider/us-only-model",
			context_length: 8192,
			capabilities: { input_modalities: ["text", "audio", "video"], supports_reasoning: true },
			pricing: { input_cost_per_token: 1e-6, output_cost_per_token: 3e-6 },
			regions: [{ code: "us", name: "United States" }],
		},
	],
};

function run(name: string, fn: () => void) {
	fn();
	console.log(`  ok  ${name}`);
}

console.log("pi-edenai tests");

run("mapEdenModel converts per-token pricing to $/million", () => {
	const m = mapEdenModel(SAMPLE.data[0]);
	assert.equal(m.id, "openai/gpt-4o");
	assert.equal(m.cost.input, 2.5);
	assert.equal(m.cost.output, 10);
	assert.equal(m.contextWindow, 128000);
	assert.deepEqual(m.input, ["text", "image"]);
	assert.equal(m.reasoning, false);
});

run("mapEdenModel drops unsupported input modalities and keeps text fallback", () => {
	const m = mapEdenModel(SAMPLE.data[2]);
	assert.deepEqual(m.input, ["text"]); // audio/video dropped
	assert.equal(m.reasoning, true);
});

run("mapEdenModel applies the maxTokens argument", () => {
	const m = mapEdenModel(SAMPLE.data[0], 4096);
	assert.equal(m.maxTokens, 4096);
});

run("mapCatalog maps every model by default", () => {
	const all = mapCatalog(SAMPLE);
	assert.equal(all.length, 3);
});

run("mapCatalog euOnly keeps only EU-region models", () => {
	const eu = mapCatalog(SAMPLE, { euOnly: true });
	const ids = eu.map((m) => m.id).sort();
	assert.deepEqual(ids, ["amazon/ai21.jamba-1-5-large-v1:0", "openai/gpt-4o"]);
});

run("mapCatalog tolerates a missing data array", () => {
	assert.deepEqual(mapCatalog({}), []);
});

run("isEuModel detects EU region case-insensitively", () => {
	assert.equal(isEuModel(SAMPLE.data[0]), true);
	assert.equal(isEuModel(SAMPLE.data[2]), false);
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
