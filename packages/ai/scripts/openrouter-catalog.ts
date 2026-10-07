import type { ClassifierModel, ImageModel, Model, ModelCost } from "../src/types.ts";
import { getOpenRouterThinkingLevelMap, type OpenRouterReasoningMetadata } from "./openrouter-reasoning-options.ts";

export interface OpenRouterModelListItem {
	id: string;
	name: string;
	supported_parameters?: string[];
	architecture?: { modality?: string; input_modalities?: string[]; output_modalities?: string[] };
	pricing?: {
		prompt?: string;
		completion?: string;
		input_cache_read?: string;
		input_cache_write?: string;
	};
	top_provider?: {
		context_length?: number;
		max_completion_tokens?: number;
	};
	context_length?: number;
	reasoning?: OpenRouterReasoningMetadata;
}

export interface OpenRouterCatalog {
	chat: Model<"anthropic-messages" | "openai-completions">[];
	images: ImageModel<"openrouter-images">[];
	classifiers: ClassifierModel<"typesafe-system-one">[];
}

/** Input modalities declared by a model definition. */
export type InputModality = "text" | "image" | "video" | "audio";

/**
 * Map a models.dev/OpenRouter input-modality list to our input union, always
 * including text. Video and audio input declarations are preserved so the
 * TUI can surface them (and so media attachments are not needlessly rejected).
 */
export function inputMods(mods?: string[]): InputModality[] {
	const input: InputModality[] = ["text"];
	if (mods?.includes("image")) input.push("image");
	if (mods?.includes("video")) input.push("video");
	if (mods?.includes("audio")) input.push("audio");
	return input;
}

function roundCost(value: number): number {
	return Number(value.toFixed(6));
}

function modalities(values: string[] | undefined): ("text" | "image" | "video" | "audio")[] {
	return Array.from(
		new Set(
			(values ?? []).filter(
				(value): value is "text" | "image" | "video" | "audio" =>
					value === "text" || value === "image" || value === "video" || value === "audio",
			),
		),
	);
}

function cost(model: OpenRouterModelListItem): ModelCost {
	// Convert pricing from $/token to $/million tokens
	return {
		input: roundCost(parseFloat(model.pricing?.prompt || "0") * 1_000_000),
		output: roundCost(parseFloat(model.pricing?.completion || "0") * 1_000_000),
		cacheRead: roundCost(parseFloat(model.pricing?.input_cache_read || "0") * 1_000_000),
		cacheWrite: roundCost(parseFloat(model.pricing?.input_cache_write || "0") * 1_000_000),
	};
}

/**
 * Build the OpenRouter catalog from the default listing and the
 * `output_modalities=image` and `output_modalities=decisions` listings. The
 * default listing omits image-only and decision models, so those come from
 * the other listings. An upstream model may appear in several results; it then
 * gets separate entries per operation.
 */
export function buildOpenRouterCatalog(
	listed: readonly OpenRouterModelListItem[],
	imageListed: readonly OpenRouterModelListItem[],
	decisionListed: readonly OpenRouterModelListItem[],
): OpenRouterCatalog {
	const chat: OpenRouterCatalog["chat"] = [];

	for (const model of listed) {
		// Only include models that support tools
		if (!model.supported_parameters?.includes("tools")) continue;
		// Parse input modalities. Prefer input_modalities when present; fall back to
		// the legacy "text->image" modality string. Video/audio declarations are kept.
		const input = inputMods(
			model.architecture?.input_modalities ??
				model.architecture?.modality?.split("->")[0]?.split(","),
		);

		const thinkingLevelMap = getOpenRouterThinkingLevelMap(model.reasoning);
		const useAnthropicMessages = /^anthropic\//.test(model.id) && !model.id.endsWith(":batch");
		chat.push({
			type: "chat",
			id: model.id,
			name: model.name,
			api: useAnthropicMessages ? "anthropic-messages" : "openai-completions",
			baseUrl: useAnthropicMessages ? "https://openrouter.ai/api" : "https://openrouter.ai/api/v1",
			provider: "openrouter",
			reasoning: model.supported_parameters?.includes("reasoning") || false,
			...(thinkingLevelMap && { thinkingLevelMap }),
			input,
			cost: cost(model),
			contextWindow: model.top_provider?.context_length || model.context_length || 4096,
			maxTokens: model.top_provider?.max_completion_tokens || 4096,
		});
	}

	const images: OpenRouterCatalog["images"] = [];
	for (const model of imageListed) {
		if (images.some((entry) => entry.id === model.id)) continue;
		const output = modalities(model.architecture?.output_modalities).filter(
			(value): value is "text" | "image" => value === "text" || value === "image",
		);
		if (!output.includes("image")) continue;
		const input = modalities(model.architecture?.input_modalities);
		images.push({
			type: "image",
			id: model.id,
			name: model.name,
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			input: input.length > 0 ? input : ["text"],
			output,
			cost: cost(model),
		});
	}

	// Decision models such as TypeSafe's Jev are served through OpenRouter's
	// TypeSafe-compatible System One endpoint.
	const classifiers: OpenRouterCatalog["classifiers"] = [];
	for (const model of decisionListed) {
		if (classifiers.some((entry) => entry.id === model.id)) continue;
		if (!model.architecture?.output_modalities?.includes("decisions")) continue;
		const input = modalities(model.architecture.input_modalities);
		classifiers.push({
			type: "classifier",
			id: model.id,
			name: model.name,
			api: "typesafe-system-one",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			input: input.length > 0 ? input : ["text"],
			cost: cost(model),
			contextWindow: model.top_provider?.context_length || model.context_length || 4096,
		});
	}

	return { chat, images, classifiers };
}
