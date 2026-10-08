/**
 * Structured output: forced schema-conformant final results for headless runs.
 *
 * Two-phase design:
 * 1. The agent runs normally with its own tools.
 * 2. A standalone extraction request is sent to the same model with the transcript
 *    as context and a single forced `report` tool whose parameters are the user's
 *    JSON Schema. Where the provider supports it, tool choice is pinned to `report`
 *    and strict constrained sampling is requested; all paths validate the tool-call
 *    arguments against the schema and retry once before failing.
 */

import { readFileSync } from "node:fs";
import type {
	AnthropicOptions,
	AssistantMessage,
	BedrockOptions,
	Context,
	GoogleOptions,
	GoogleVertexOptions,
	Message,
	MistralOptions,
	Model,
	OpenAICompletionsOptions,
	OpenAIResponsesOptions,
	Tool,
	ToolCall,
} from "@earendil-works/pi-ai";
import { validateToolCall } from "@earendil-works/pi-ai";
import { makeStrictJsonSchema } from "@earendil-works/pi-ai/api/constrained-sampling";
import type { AgentSession } from "./agent-session.ts";
import { convertToLlm } from "./messages.ts";
import type { ModelRuntime } from "./model-runtime.ts";

const REPORT_TOOL_NAME = "report";

const EXTRACTION_SYSTEM_PROMPT = `You are a structured-output extractor. You are given the transcript of a coding-agent session and must produce its final result as structured data.

Call the "${REPORT_TOOL_NAME}" tool exactly once. Its arguments must conform to the provided JSON Schema and fully capture the outcome of the conversation. Do not answer in plain text.`;

const EXTRACTION_INSTRUCTION = `Based on the conversation above, call the "${REPORT_TOOL_NAME}" tool with the final result conforming to the requested schema.`;

/**
 * Build a JSON Schema from llm's shorthand DSL (ported from llm's
 * `schema_dsl`, utils.py):
 *   - fields separated by commas or newlines
 *   - each field is "name type" (space-separated), type optional (default string)
 *   - an optional ": description" suffix is copied to the property
 *   - type indicators: int, float, bool, str (mapped to integer/number/boolean/string)
 * Unrecognised type indicators fall back to string (matching llm).
 */
function schemaDsl(dsl: string): Record<string, unknown> {
	const typeMapping: Record<string, string> = {
		int: "integer",
		float: "number",
		bool: "boolean",
		str: "string",
	};

	const fields = dsl.includes("\n")
		? dsl
				.split("\n")
				.map((f) => f.trim())
				.filter(Boolean)
		: dsl
				.split(",")
				.map((f) => f.trim())
				.filter(Boolean);

	const properties: Record<string, Record<string, unknown>> = {};
	const required: string[] = [];

	for (const field of fields) {
		let fieldInfo = field;
		let description = "";
		const colon = field.indexOf(":");
		if (colon !== -1) {
			fieldInfo = field.slice(0, colon);
			description = field.slice(colon + 1).trim();
		}

		const parts = fieldInfo.trim().split(/\s+/).filter(Boolean);
		if (parts.length === 0) {
			continue;
		}
		const fieldName = parts[0];
		let fieldType = "string";
		if (parts.length > 1 && parts[1] in typeMapping) {
			fieldType = typeMapping[parts[1]];
		}

		const prop: Record<string, unknown> = { type: fieldType };
		if (description) {
			prop.description = description;
		}
		properties[fieldName] = prop;
		required.push(fieldName);
	}

	return { type: "object", properties, required };
}

/** Wrap a schema in an items array (llm's --schema-multi semantics). */
function multiSchema(schema: Record<string, unknown>): Record<string, unknown> {
	return {
		type: "object",
		properties: { items: { type: "array", items: schema } },
		required: ["items"],
	};
}

function parseJsonSchema(raw: string, label: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`--schema (${label}) is not valid JSON: ${detail}`);
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`--schema (${label}) must be a JSON Schema object`);
	}
	return parsed as Record<string, unknown>;
}

/**
 * Fail fast (before spending tokens) if the schema cannot be converted to the
 * strict subset used by provider constrained sampling. Returns the schema.
 */
function validateStrict(schema: Record<string, unknown>, spec: string): Record<string, unknown> {
	try {
		makeStrictJsonSchema(schema as Tool["parameters"]);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`--schema "${spec}" is not supported for strict structured output: ${detail}`);
	}
	return schema;
}

/**
 * Load a JSON Schema from a file path, stdin ("-"), inline JSON, or shorthand
 * DSL ("field string, points int: points on HN"). When `multi` is true the
 * schema is wrapped in an items array (llm's --schema-multi semantics).
 * Throws with a user-facing message on failure.
 */
export function loadStructuredOutputSchema(spec: string, multi = false): Record<string, unknown> {
	const trimmed = spec.trim();

	let schema: Record<string, unknown>;
	if (spec === "-") {
		schema = parseJsonSchema(readFileSync(0, "utf8"), "<stdin>");
	} else if (trimmed.startsWith("{")) {
		schema = parseJsonSchema(spec, "inline JSON");
	} else if (/[\s,]/.test(trimmed)) {
		// Shorthand DSL wins over a file path that happens to contain a space/comma.
		schema = schemaDsl(spec);
	} else {
		let raw: string;
		try {
			raw = readFileSync(spec, "utf8");
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`Failed to read --schema "${spec}": ${detail}`);
		}
		schema = parseJsonSchema(raw, spec);
	}

	if (multi) {
		schema = multiSchema(schema);
	}
	return validateStrict(schema, spec);
}

function buildReportTool(schema: Record<string, unknown>): Tool {
	return {
		name: REPORT_TOOL_NAME,
		description: "Report the final structured result of the task.",
		parameters: schema as Tool["parameters"],
		constrainedSampling: { type: "json_schema", strict: "prefer" },
	};
}

/**
 * Send the extraction request with tool choice pinned to the report tool where
 * the provider API supports naming a forced tool. Unknown/custom APIs fall back
 * to prompt-only forcing (the system prompt still demands the tool call).
 */
function streamExtraction(
	modelRuntime: ModelRuntime,
	model: Model<any>,
	context: Context,
	signal?: AbortSignal,
): Promise<AssistantMessage> {
	const name = REPORT_TOOL_NAME;
	switch (model.api) {
		case "anthropic-messages": {
			const options: AnthropicOptions = { toolChoice: { type: "tool", name }, signal };
			return modelRuntime.stream(model as Model<"anthropic-messages">, context, options).result();
		}
		case "openai-completions": {
			const options: OpenAICompletionsOptions = {
				toolChoice: { type: "function", function: { name } },
				signal,
			};
			return modelRuntime.stream(model as Model<"openai-completions">, context, options).result();
		}
		case "openai-responses":
		case "azure-openai-responses": {
			const options: OpenAIResponsesOptions = { toolChoice: { type: "function", name }, signal };
			return modelRuntime
				.stream(model as Model<"openai-responses" | "azure-openai-responses">, context, options)
				.result();
		}
		case "google-generative-ai": {
			// "any" forces a function call; report is the only declared tool.
			const options: GoogleOptions = { toolChoice: "any", signal };
			return modelRuntime.stream(model as Model<"google-generative-ai">, context, options).result();
		}
		case "google-vertex": {
			const options: GoogleVertexOptions = { toolChoice: "any", signal };
			return modelRuntime.stream(model as Model<"google-vertex">, context, options).result();
		}
		case "mistral-conversations": {
			const options: MistralOptions = { toolChoice: { type: "function", function: { name } }, signal };
			return modelRuntime.stream(model as Model<"mistral-conversations">, context, options).result();
		}
		case "bedrock-converse-stream": {
			const options: BedrockOptions = { toolChoice: { type: "tool", name }, signal };
			return modelRuntime.stream(model as Model<"bedrock-converse-stream">, context, options).result();
		}
		default: {
			return modelRuntime.stream(model, context, { signal }).result();
		}
	}
}

function firstToolCall(message: AssistantMessage): ToolCall | undefined {
	for (const content of message.content) {
		if (content.type === "toolCall") {
			return content;
		}
	}
	return undefined;
}

function extractionContext(session: AgentSession, schema: Record<string, unknown>): Context {
	const messages: Message[] = [...convertToLlm(session.agent.state.messages)];
	if (messages.length === 0) {
		throw new Error("No conversation to extract structured output from");
	}
	messages.push({
		role: "user",
		content: [{ type: "text", text: EXTRACTION_INSTRUCTION }],
		timestamp: Date.now(),
	});

	return {
		systemPrompt: EXTRACTION_SYSTEM_PROMPT,
		messages,
		tools: [buildReportTool(schema)],
	};
}

function validateResult(schema: Record<string, unknown>, toolCall: ToolCall): unknown {
	const tool = buildReportTool(schema);
	return validateToolCall([tool], toolCall);
}

/**
 * Run the extraction phase: a standalone forced tool-call request over the
 * session transcript. Returns schema-validated structured output.
 *
 * On validation failure the request is retried once with the validation errors
 * appended; a second failure throws instead of emitting non-conforming output.
 */
export async function extractStructuredOutput(
	session: AgentSession,
	schema: Record<string, unknown>,
): Promise<unknown> {
	const model = session.model;
	if (!model) {
		throw new Error("No model selected; cannot extract structured output");
	}

	const context = extractionContext(session, schema);
	const validationErrors: string[] = [];

	for (let attempt = 0; attempt < 2; attempt++) {
		const attemptContext: Context =
			validationErrors.length > 0
				? {
						...context,
						messages: [
							...context.messages,
							{
								role: "user",
								content: [
									{
										type: "text",
										text: `Your previous "${REPORT_TOOL_NAME}" tool call failed schema validation:\n${validationErrors.join("\n")}\nCall "${REPORT_TOOL_NAME}" again with corrected arguments.`,
									},
								],
								timestamp: Date.now(),
							},
						],
					}
				: context;

		const message = await streamExtraction(session.modelRuntime, model, attemptContext);
		if (message.stopReason === "aborted") {
			throw new Error("Structured-output extraction was aborted");
		}
		if (message.stopReason === "error") {
			throw new Error(message.errorMessage || "Structured-output extraction request failed");
		}

		const toolCall = firstToolCall(message);
		if (!toolCall) {
			validationErrors.push(`No "${REPORT_TOOL_NAME}" tool call was made.`);
			continue;
		}

		try {
			return validateResult(schema, toolCall);
		} catch (error) {
			validationErrors.push(error instanceof Error ? error.message : String(error));
		}
	}

	throw new Error(`Failed to produce output conforming to --schema after retry:\n${validationErrors.join("\n")}`);
}
