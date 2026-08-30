/**
 * Process @file CLI arguments into text content and image attachments
 */

import { access, readFile, stat } from "node:fs/promises";
import type { AudioContent, ImageContent, VideoContent } from "@earendil-works/pi-ai";
import chalk from "chalk";
import { resolve } from "path";
import { resolveReadPath } from "../core/tools/path-utils.ts";
import { processImage } from "../utils/image-process.ts";
import {
	detectSupportedAudioMimeTypeFromFile,
	detectSupportedImageMimeTypeFromFile,
	detectSupportedVideoMimeTypeFromFile,
} from "../utils/mime.ts";
import { stripBom } from "../utils/text.ts";

export interface ProcessedFiles {
	text: string;
	images: ImageContent[];
	videos: VideoContent[];
	audios: AudioContent[];
}

export interface ProcessFileOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
	/** Whether to exit the process on missing/unreadable files. Default: true (CLI behavior). Set false for interactive use. */
	exitOnError?: boolean;
}

/** Process @file arguments into text content and image attachments */
export async function processFileArguments(fileArgs: string[], options?: ProcessFileOptions): Promise<ProcessedFiles> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const exitOnError = options?.exitOnError ?? true;
	let text = "";
	const images: ImageContent[] = [];
	const videos: VideoContent[] = [];
	const audios: AudioContent[] = [];

	for (const fileArg of fileArgs) {
		// Expand and resolve path (handles ~ expansion and macOS screenshot Unicode spaces)
		const absolutePath = resolve(resolveReadPath(fileArg, process.cwd()));

		// Check if file exists
		try {
			await access(absolutePath);
		} catch {
			if (exitOnError) {
				console.error(chalk.red(`Error: File not found: ${absolutePath}`));
				process.exit(1);
			}
			text += `<file name="${absolutePath}">error: file not found</file>\n`;
			continue;
		}

		// Check if file is empty
		const stats = await stat(absolutePath);
		if (stats.size === 0) {
			// Skip empty files
			continue;
		}

		const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);

		if (!mimeType) {
			// Handle video file (before falling back to text)
			const videoMimeType = await detectSupportedVideoMimeTypeFromFile(absolutePath);
			if (videoMimeType) {
				const content = await readFile(absolutePath);
				const attachment: VideoContent = {
					type: "video",
					mimeType: videoMimeType,
					data: content.toString("base64"),
				};
				videos.push(attachment);
				text += `<file name="${absolutePath}"></file>\n`;
				continue;
			}

			// Handle audio file (before falling back to text)
			const audioMimeType = await detectSupportedAudioMimeTypeFromFile(absolutePath);
			if (audioMimeType) {
				const content = await readFile(absolutePath);
				const attachment: AudioContent = {
					type: "audio",
					mimeType: audioMimeType,
					data: content.toString("base64"),
				};
				audios.push(attachment);
				text += `<file name="${absolutePath}"></file>\n`;
				continue;
			}
		}

		if (mimeType) {
			// Handle image file
			const content = await readFile(absolutePath);
			const processed = await processImage(content, mimeType, { autoResizeImages });

			if (!processed.ok) {
				text += `<file name="${absolutePath}">${processed.message}</file>\n`;
				continue;
			}

			const attachment: ImageContent = {
				type: "image",
				mimeType: processed.mimeType,
				data: processed.data,
			};
			images.push(attachment);

			// Add text reference to image with optional processing hints
			if (processed.hints.length > 0) {
				text += `<file name="${absolutePath}">${processed.hints.join("\n")}</file>\n`;
			} else {
				text += `<file name="${absolutePath}"></file>\n`;
			}
		} else {
			// Handle text file
			try {
				const content = stripBom(await readFile(absolutePath, "utf-8"));
				text += `<file name="${absolutePath}">\n${content}\n</file>\n`;
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				if (exitOnError) {
					console.error(chalk.red(`Error: Could not read file ${absolutePath}: ${message}`));
					process.exit(1);
				}
				text += `<file name="${absolutePath}">error: could not read file: ${message}</file>\n`;
			}
		}
	}

	return { text, images, videos, audios };
}
