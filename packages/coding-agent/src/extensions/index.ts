import type { InlineExtension } from "../core/extensions/types.ts";
import dictationExtension from "./dictation/index.ts";
import llamaExtension from "./llama/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "dictation", factory: dictationExtension },
];
