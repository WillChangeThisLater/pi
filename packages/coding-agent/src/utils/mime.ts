import { open } from "node:fs/promises";

const IMAGE_TYPE_SNIFF_BYTES = 4100;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function detectSupportedImageMimeType(buffer: Uint8Array): string | null {
	if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
		return buffer[3] === 0xf7 ? null : "image/jpeg";
	}
	if (startsWith(buffer, PNG_SIGNATURE)) {
		return isPng(buffer) && !isAnimatedPng(buffer) ? "image/png" : null;
	}
	if (startsWithAscii(buffer, 0, "GIF")) {
		return "image/gif";
	}
	if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP")) {
		return "image/webp";
	}
	if (startsWithAscii(buffer, 0, "BM") && isBmp(buffer)) {
		return "image/bmp";
	}
	return null;
}

export async function detectSupportedImageMimeTypeFromFile(filePath: string): Promise<string | null> {
	const fileHandle = await open(filePath, "r");
	try {
		const buffer = Buffer.alloc(IMAGE_TYPE_SNIFF_BYTES);
		const { bytesRead } = await fileHandle.read(buffer, 0, IMAGE_TYPE_SNIFF_BYTES, 0);
		return detectSupportedImageMimeType(buffer.subarray(0, bytesRead));
	} finally {
		await fileHandle.close();
	}
}

export function detectSupportedVideoMimeType(buffer: Uint8Array): string | null {
	// MP4 / MOV: ISO base media file format, brand string at offset 4 ("ftyp")
	if (startsWithAscii(buffer, 4, "ftyp")) {
		const brand = String.fromCharCode(buffer[8] ?? 0, buffer[9] ?? 0, buffer[10] ?? 0, buffer[11] ?? 0);
		if (brand === "qt  ") return "video/quicktime";
		return "video/mp4";
	}
	// WebM / Matroska: EBML header
	if (startsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3])) {
		return "video/webm";
	}
	// MPEG program stream / elementary stream
	if (startsWith(buffer, [0x00, 0x00, 0x01, 0xba]) || startsWith(buffer, [0x00, 0x00, 0x01, 0xb3])) {
		return "video/mpeg";
	}
	return null;
}

export async function detectSupportedVideoMimeTypeFromFile(filePath: string): Promise<string | null> {
	const fileHandle = await open(filePath, "r");
	try {
		const buffer = Buffer.alloc(IMAGE_TYPE_SNIFF_BYTES);
		const { bytesRead } = await fileHandle.read(buffer, 0, IMAGE_TYPE_SNIFF_BYTES, 0);
		return detectSupportedVideoMimeType(buffer.subarray(0, bytesRead));
	} finally {
		await fileHandle.close();
	}
}

const AUDIO_TYPE_SNIFF_BYTES = 4100;

export function detectSupportedAudioMimeType(buffer: Uint8Array): string | null {
	// WAV: "RIFF"...."WAVE"
	if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WAVE")) {
		return "audio/wav";
	}
	// FLAC: "fLaC"
	if (startsWithAscii(buffer, 0, "fLaC")) {
		return "audio/flac";
	}
	// OGG: "OggS"
	if (startsWithAscii(buffer, 0, "OggS")) {
		return "audio/ogg";
	}
	// AIFF: "FORM"...."AIFF"
	if (startsWithAscii(buffer, 0, "FORM") && startsWithAscii(buffer, 8, "AIFF")) {
		return "audio/aiff";
	}
	// MP3: "ID3" tag or frame sync (0xFF Ex/Fx, excluding ADTS)
	if (startsWithAscii(buffer, 0, "ID3")) {
		return "audio/mpeg";
	}
	if (buffer.length >= 2 && (buffer[0] ?? 0) === 0xff && (buffer[1] ?? 0) === 0xf1) {
		return "audio/aac"; // ADTS
	}
	if (buffer.length >= 2 && (buffer[0] ?? 0) === 0xff && ((buffer[1] ?? 0) & 0xe0) === 0xe0) {
		return "audio/mpeg";
	}
	// M4A: ISO base media with M4A brand
	if (startsWithAscii(buffer, 4, "ftyp")) {
		const brand = String.fromCharCode(buffer[8] ?? 0, buffer[9] ?? 0, buffer[10] ?? 0, buffer[11] ?? 0);
		if (brand.startsWith("M4A")) {
			return "audio/mp4";
		}
	}
	return null;
}

export async function detectSupportedAudioMimeTypeFromFile(filePath: string): Promise<string | null> {
	const fileHandle = await open(filePath, "r");
	try {
		const buffer = Buffer.alloc(AUDIO_TYPE_SNIFF_BYTES);
		const { bytesRead } = await fileHandle.read(buffer, 0, AUDIO_TYPE_SNIFF_BYTES, 0);
		return detectSupportedAudioMimeType(buffer.subarray(0, bytesRead));
	} finally {
		await fileHandle.close();
	}
}

function isPng(buffer: Uint8Array): boolean {
	return (
		buffer.length >= 16 && readUint32BE(buffer, PNG_SIGNATURE.length) === 13 && startsWithAscii(buffer, 12, "IHDR")
	);
}

function isAnimatedPng(buffer: Uint8Array): boolean {
	let offset = PNG_SIGNATURE.length;
	while (offset + 8 <= buffer.length) {
		const chunkLength = readUint32BE(buffer, offset);
		const chunkTypeOffset = offset + 4;
		if (startsWithAscii(buffer, chunkTypeOffset, "acTL")) return true;
		if (startsWithAscii(buffer, chunkTypeOffset, "IDAT")) return false;

		const nextOffset = offset + 8 + chunkLength + 4;
		if (nextOffset <= offset || nextOffset > buffer.length) return false;
		offset = nextOffset;
	}
	return false;
}

function isBmp(buffer: Uint8Array): boolean {
	if (buffer.length < 26) return false;

	const declaredFileSize = readUint32LE(buffer, 2);
	const pixelDataOffset = readUint32LE(buffer, 10);
	const dibHeaderSize = readUint32LE(buffer, 14);
	if (declaredFileSize !== 0 && declaredFileSize < 26) return false;
	if (pixelDataOffset < 14 + dibHeaderSize) return false;
	if (declaredFileSize !== 0 && pixelDataOffset >= declaredFileSize) return false;

	let colorPlanes: number;
	let bitsPerPixel: number;
	if (dibHeaderSize === 12) {
		colorPlanes = readUint16LE(buffer, 22);
		bitsPerPixel = readUint16LE(buffer, 24);
	} else if (dibHeaderSize >= 40 && dibHeaderSize <= 124) {
		if (buffer.length < 30) return false;
		colorPlanes = readUint16LE(buffer, 26);
		bitsPerPixel = readUint16LE(buffer, 28);
	} else {
		return false;
	}

	return colorPlanes === 1 && [1, 4, 8, 16, 24, 32].includes(bitsPerPixel);
}

function readUint16LE(buffer: Uint8Array, offset: number): number {
	return (buffer[offset] ?? 0) + ((buffer[offset + 1] ?? 0) << 8);
}

function readUint32BE(buffer: Uint8Array, offset: number): number {
	return (
		(buffer[offset] ?? 0) * 0x1000000 +
		((buffer[offset + 1] ?? 0) << 16) +
		((buffer[offset + 2] ?? 0) << 8) +
		(buffer[offset + 3] ?? 0)
	);
}

function readUint32LE(buffer: Uint8Array, offset: number): number {
	return (
		(buffer[offset] ?? 0) +
		((buffer[offset + 1] ?? 0) << 8) +
		((buffer[offset + 2] ?? 0) << 16) +
		(buffer[offset + 3] ?? 0) * 0x1000000
	);
}

function startsWith(buffer: Uint8Array, bytes: number[]): boolean {
	if (buffer.length < bytes.length) return false;
	return bytes.every((byte, index) => buffer[index] === byte);
}

function startsWithAscii(buffer: Uint8Array, offset: number, text: string): boolean {
	if (buffer.length < offset + text.length) return false;
	for (let index = 0; index < text.length; index++) {
		if (buffer[offset + index] !== text.charCodeAt(index)) return false;
	}
	return true;
}
