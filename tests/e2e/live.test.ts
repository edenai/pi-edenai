/**
 * Live end-to-end tests for pi-edenai against the real Eden AI API.
 *
 * The API key is read from the environment only — never hardcoded (Fahima's
 * rule). Set EDENAI_API_KEY to run; the test skips cleanly if it is absent so
 * CI without a key stays green.
 *
 *   EDENAI_API_KEY=... npm run test:e2e
 *   EDENAI_API_KEY=... npx tsx tests/e2e/live.test.ts
 */
import assert from "node:assert/strict";
import { mapCatalog } from "../../index.ts";

const KEY = process.env.EDENAI_API_KEY?.trim();
const BASE = (process.env.EDENAI_BASE_URL?.trim() || "https://api.edenai.run/v3").replace(/\/+$/, "");

if (!KEY) {
	console.log("pi-edenai e2e: SKIPPED (EDENAI_API_KEY not set)");
	process.exit(0);
}

console.log(`pi-edenai e2e (${BASE})`);

// 1) Live catalog: GET /models -> maps to well-formed pi models.
const modelsRes = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${KEY}` } });
assert.equal(modelsRes.status, 200, "GET /models should return 200");
const payload = await modelsRes.json();
const catalog = mapCatalog(payload as never);
assert.ok(catalog.length > 100, `expected a large catalog, got ${catalog.length}`);
assert.equal(catalog.filter((m) => !m.id.includes("/")).length, 0, "every id should be provider/model");
assert.equal(
	catalog.filter((m) => Number.isNaN(m.cost.input) || Number.isNaN(m.cost.output)).length,
	0,
	"no NaN costs",
);
console.log(`  ok  GET /models -> ${catalog.length} models mapped`);

// 2) Live chat completion over the OpenAI-compatible path pi's client uses.
//    Assert only on stable, non-provider-specific fields (status + content).
const chatRes = await fetch(`${BASE}/chat/completions`, {
	method: "POST",
	headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
	body: JSON.stringify({
		model: "openai/gpt-4o-mini",
		messages: [{ role: "user", content: "Reply with exactly: pi-edenai ok" }],
		max_tokens: 20,
	}),
});
assert.equal(chatRes.status, 200, "POST /chat/completions should return 200");
const chat = await chatRes.json();
const content = chat?.choices?.[0]?.message?.content;
assert.equal(typeof content, "string", "assistant message content should be a string");
assert.ok(content.length > 0, "assistant message content should be non-empty");
console.log(`  ok  POST /chat/completions -> ${JSON.stringify(content)}`);

console.log("all e2e tests passed");
