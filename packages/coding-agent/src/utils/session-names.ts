/**
 * Human-readable session ids for pi agents.
 *
 * Format: `<word>-<word>-<number>`, e.g. "springer-katahdin-4217".
 * Words are Appalachian Trail themed (trailheads, landmarks, peaks, shelters,
 * and huts from Springer Mountain, GA to Katahdin, ME). All three components
 * are drawn independently with crypto randomness (~56M combinations), and
 * session file names embed a millisecond timestamp besides, so practical
 * collision risk is negligible even across tens of thousands of agent runs.
 *
 * Ids must satisfy assertValidSessionId(): alphanumeric plus '.', '-', '_',
 * starting and ending alphanumeric — these names do.
 */

import { webcrypto } from "node:crypto";

const WORDS_A = [
	"springer",
	"amicalola",
	"neels",
	"woody",
	"hightower",
	"blood-mountain",
	"unicoi",
	"tray",
	"dicks-creek",
	"rock-gap",
	"wayah",
	"wesser",
	"nantahala",
	"fontana",
	"shuckstack",
	"spence",
	"silers",
	"charlies-bunion",
	"newfound",
	"clingmans",
	"double-spring",
	"pecks",
	"tri-corner",
	"roan",
	"hampton",
	"carvers",
	"grayson",
	"damascus",
	"mount-rogers",
	"dragon-tooth",
	"mcafee",
	"catawba",
	"rollers",
	"harpers-ferry",
	"weverton",
	"pogo",
	"cove",
	"peters",
	"wind-gap",
	"high-point",
	"delaware-water",
	"bear-mountain",
	"harriman",
	"leatherman",
	"kent",
	"lion",
	"grey",
	"ten-mile",
	"schaghticoke",
	"everett",
	"greylock",
	"basin",
	"baker",
	"glastenbury",
	"stratton",
	"bennington",
	"hanover",
	"smarts",
	"moosilauke",
	"kinsman",
	"hancocks",
	"hale",
	"zeland",
	"ethan-pond",
	"ozed",
	"sanford",
	"hurd",
	"dolly-sods",
	"priest",
	"caratunk",
	"bemis",
	"rangeley",
	"pierce-pond",
	"whitehouse",
	"monson",
];

const WORDS_B = [
	"katahdin",
	"mahoosuc",
	"goose-eye",
	"old-speck",
	"baldpate",
	"carter",
	"wildcat",
	"presidential",
	"crawford",
	"franconia",
	"moat",
	"saddleback",
	"sugarloaf",
	"bigelow",
	"white-cap",
	"gulf-hagas",
	"nectar",
	"horns-pond",
	"east-brook",
	"leeman",
	"bald-mountain",
	"pierce",
	"lafayette",
	"liberty",
	"osceola",
	"guyot",
	"gentian",
	"pleasants",
	"fuller",
	"sunfish",
	"kancamagus",
	"bondcliff",
	"mountain",
	"ridge",
	"shelter",
	"notch",
	"gap",
	"knob",
	"bald",
	"ledge",
	"spruce",
	"cedar",
	"hickory",
	"laurel",
	"heath",
	"fog",
	"brook",
	"falls",
	"overlook",
	"camp",
	"spring",
	"meadow",
	"hollow",
	"point",
];

/** Uniform random integer in [0, max) via rejection sampling on crypto bytes. */
function rand(max: number): number {
	const limit = Math.floor(0x100000000 * Math.floor(0x100000000 / max)) || max;
	for (;;) {
		const buf = new Uint32Array(1);
		webcrypto.getRandomValues(buf);
		const v = buf[0]!;
		if (v < limit) return v % max;
	}
}

/** Generate a human-readable session id, e.g. "springer-katahdin-4217". */
export function generateSessionId(): string {
	const a = WORDS_A[rand(WORDS_A.length)];
	const b = WORDS_B[rand(WORDS_B.length)];
	const n = rand(10000);
	return `${a}-${b}-${n}`;
}
