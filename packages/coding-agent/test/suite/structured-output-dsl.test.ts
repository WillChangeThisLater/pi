import { describe, expect, test } from "vitest";
import { loadStructuredOutputSchema } from "../../src/core/structured-output.ts";

describe("loadStructuredOutputSchema shorthand DSL and inline JSON", () => {
	test("basic comma-separated fields", () => {
		expect(loadStructuredOutputSchema("title string, points int")).toEqual({
			type: "object",
			properties: { title: { type: "string" }, points: { type: "integer" } },
			required: ["title", "points"],
		});
	});

	test("float/bool/str aliases", () => {
		expect(loadStructuredOutputSchema("x float, y bool, z str, w int")).toEqual({
			type: "object",
			properties: {
				x: { type: "number" },
				y: { type: "boolean" },
				z: { type: "string" },
				w: { type: "integer" },
			},
			required: ["x", "y", "z", "w"],
		});
	});

	test("unknown type falls back to string", () => {
		expect(loadStructuredOutputSchema("a xml, b string")).toEqual({
			type: "object",
			properties: { a: { type: "string" }, b: { type: "string" } },
			required: ["a", "b"],
		});
	});

	test("description after colon", () => {
		expect(loadStructuredOutputSchema("name string: a description here")).toEqual({
			type: "object",
			properties: { name: { type: "string", description: "a description here" } },
			required: ["name"],
		});
	});

	test("newline separator", () => {
		expect(loadStructuredOutputSchema("a string\nb int")).toEqual({
			type: "object",
			properties: { a: { type: "string" }, b: { type: "integer" } },
			required: ["a", "b"],
		});
	});

	test("whitespace run between name and type", () => {
		expect(loadStructuredOutputSchema("name   string")).toEqual({
			type: "object",
			properties: { name: { type: "string" } },
			required: ["name"],
		});
	});

	test("empty field skipped", () => {
		expect(loadStructuredOutputSchema("a string,, b int")).toEqual({
			type: "object",
			properties: { a: { type: "string" }, b: { type: "integer" } },
			required: ["a", "b"],
		});
	});

	test("trailing comma", () => {
		expect(loadStructuredOutputSchema("a string, b int,")).toEqual({
			type: "object",
			properties: { a: { type: "string" }, b: { type: "integer" } },
			required: ["a", "b"],
		});
	});

	test("leading/trailing whitespace", () => {
		expect(loadStructuredOutputSchema("  title string , points int  ")).toEqual({
			type: "object",
			properties: { title: { type: "string" }, points: { type: "integer" } },
			required: ["title", "points"],
		});
	});

	test("colon with no description", () => {
		expect(loadStructuredOutputSchema("name string:")).toEqual({
			type: "object",
			properties: { name: { type: "string" } },
			required: ["name"],
		});
	});

	test("missing type throws", () => {
		expect(() => loadStructuredOutputSchema("name")).toThrow(/Failed to read --schema/);
	});

	test("empty input throws", () => {
		expect(() => loadStructuredOutputSchema("")).toThrow(/Failed to read --schema/);
	});

	test("duplicate field: last wins, duplicate required (llm parity)", () => {
		expect(loadStructuredOutputSchema("dup int, dup string")).toEqual({
			type: "object",
			properties: { dup: { type: "string" } },
			required: ["dup", "dup"],
		});
	});

	test("description containing colons", () => {
		expect(loadStructuredOutputSchema("x int: desc: with colon")).toEqual({
			type: "object",
			properties: { x: { type: "integer", description: "desc: with colon" } },
			required: ["x"],
		});
	});

	test("extra tokens ignored", () => {
		expect(loadStructuredOutputSchema("name str extra words")).toEqual({
			type: "object",
			properties: { name: { type: "string" } },
			required: ["name"],
		});
	});

	test("spaces around comma", () => {
		expect(loadStructuredOutputSchema("e float , f str")).toEqual({
			type: "object",
			properties: { e: { type: "number" }, f: { type: "string" } },
			required: ["e", "f"],
		});
	});

	test("inline JSON passthrough", () => {
		expect(
			loadStructuredOutputSchema('{"type":"object","properties":{"n":{"type":"integer"}},"required":["n"]}'),
		).toEqual({ type: "object", properties: { n: { type: "integer" } }, required: ["n"] });
	});
});
