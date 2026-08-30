/**
 * Shared input-modality icon helpers for TUI indicators (footer, model selector).
 *
 * Icons are chosen to be consistently double-width (East Asian Wide) so the
 * TUI's width calculations stay correct.
 */
export const IMAGE_ICON = "📷";
export const AUDIO_ICON = "🔊";
export const VIDEO_ICON = "🎬";

/**
 * Return the icon string for the given model input modalities.
 * Order is stable: image, audio, video. Returns "" when none match.
 */
export function modalityIconsFor(input: readonly string[] | undefined): string {
	if (!input || input.length === 0) return "";
	let icons = "";
	if (input.includes("image")) icons += IMAGE_ICON;
	if (input.includes("audio")) icons += AUDIO_ICON;
	if (input.includes("video")) icons += VIDEO_ICON;
	return icons;
}
