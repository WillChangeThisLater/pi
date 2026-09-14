import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";

import { extractStructuredOutput, loadStructuredOutputSchema } from "../../src/core/structured-output.ts";
import { createHarness, type Harness } from "./harness.ts";

function fixture(name: string): string {
	return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

const countSchema = {
	type: "object",
	properties: {
		count: { type: "integer" },
		label: { type: "string" },
	},
	required: ["count", "label"],
	additionalProperties: false,
} as const;

async function promptOnce(harness: Harness): Promise<void> {
	harness.setResponses([fauxAssistantMessage("working on it")]);
	await harness.session.prompt("count the files");
}

describe("loadStructuredOutputSchema", () => {
	test("parses a valid schema file", () => {
		const schema = loadStructuredOutputSchema(fixture("structured-output-schema.json"));
		expect(schema).toEqual(countSchema);
	});

	test("rejects invalid JSON", () => {
		expect(() => loadStructuredOutputSchema(fixture("structured-output-invalid.json"))).toThrow(/not valid JSON/);
	});

	test("rejects schemas unsupported by strict constrained sampling", () => {
		expect(() => loadStructuredOutputSchema(fixture("structured-output-unsupported.json"))).toThrow(
			/not supported for strict structured output/,
		);
	});

	test("rejects type arrays with multiple non-null members (OpenAI strict constraint)", () => {
		expect(() => loadStructuredOutputSchema(fixture("structured-output-type-array.json"))).toThrow(
			/type arrays may contain at most one non-null type/,
		);
	});
});

describe("extractStructuredOutput", () => {
	test("extracts validated tool-call arguments from the transcript", async () => {
		const harness = await createHarness();
		await promptOnce(harness);
		harness.appendResponses([fauxAssistantMessage(fauxToolCall("report", { count: 3, label: "three files" }))]);

		const result = await extractStructuredOutput(harness.session, countSchema);
		expect(result).toEqual({ count: 3, label: "three files" });
	});

	test("retries with validation errors and recovers", async () => {
		const harness = await createHarness();
		await promptOnce(harness);
		harness.appendResponses([
			fauxAssistantMessage(fauxToolCall("report", { count: "not-a-number" })),
			fauxAssistantMessage(fauxToolCall("report", { count: 5, label: "five" })),
		]);

		const result = await extractStructuredOutput(harness.session, countSchema);
		expect(result).toEqual({ count: 5, label: "five" });
		expect(harness.faux.getPendingResponseCount()).toBe(0);
	});

	test("throws after a failed retry instead of emitting non-conforming output", async () => {
		const harness = await createHarness();
		await promptOnce(harness);
		harness.appendResponses([
			fauxAssistantMessage(fauxToolCall("report", { count: "nope" })),
			fauxAssistantMessage(fauxToolCall("report", { count: "still-nope" })),
		]);

		await expect(extractStructuredOutput(harness.session, countSchema)).rejects.toThrow(
			/Failed to produce output conforming to --schema/,
		);
	});

	test("throws when the model never calls the report tool", async () => {
		const harness = await createHarness();
		await promptOnce(harness);
		harness.appendResponses([fauxAssistantMessage("I refuse"), fauxAssistantMessage("still refusing")]);

		await expect(extractStructuredOutput(harness.session, countSchema)).rejects.toThrow(
			/Failed to produce output conforming to --schema/,
		);
	});
});
