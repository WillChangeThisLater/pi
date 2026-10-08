import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { loadStructuredOutputSchema } from "../../src/core/structured-output.ts";

function fixture(name: string): string {
	return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

function multiWrapper(inner: unknown) {
	return {
		type: "object",
		properties: {
			items: {
				type: "array",
				items: inner,
			},
		},
		required: ["items"],
	};
}

describe("loadStructuredOutputSchema (multiSchema)", () => {
	test("wraps a shorthand spec in an items array", () => {
		const schema = loadStructuredOutputSchema("title string, points int", true);
		expect(schema).toEqual(
			multiWrapper({
				type: "object",
				properties: {
					title: { type: "string" },
					points: { type: "integer" },
				},
				required: ["title", "points"],
			}),
		);
	});

	test("wraps inline JSON in an items array", () => {
		const schema = loadStructuredOutputSchema(
			'{"type":"object","properties":{"x":{"type":"number"}},"required":["x"]}',
			true,
		);
		expect(schema).toEqual(
			multiWrapper({
				type: "object",
				properties: {
					x: { type: "number" },
				},
				required: ["x"],
			}),
		);
	});

	test("wraps a schema file in an items array", () => {
		const schema = loadStructuredOutputSchema(fixture("structured-output-schema.json"), true);
		expect(schema).toEqual(
			multiWrapper({
				type: "object",
				properties: {
					count: { type: "integer" },
					label: { type: "string" },
				},
				required: ["count", "label"],
				additionalProperties: false,
			}),
		);
	});
});
