/**
 * Lightweight language detection for the user's session content.
 *
 * Strategy: scan user/assistant messages on the current branch and tally
 * stop-word / character frequencies. If a non-English language is clearly
 * dominant, switch to it; otherwise stick with English. The detected
 * language is persisted into pi.md (in the front-matter) so the next
 * session picks it up without re-detecting.
 */

import type { LanguageCode } from "./config.js";

interface LangProfile {
	code: LanguageCode;
	/** function words and characters that strongly mark the language. */
	markers: RegExp[];
}

const PROFILES: LangProfile[] = [
	{
		code: "es",
		markers: [
			/\b(que|qué|para|por|con|sin|sobre|como|cómo|pero|aunque|porque|porqué)\b/gi,
			/\b(el|la|los|las|un|una|unos|unas)\b/gi,
			/\b(es|son|está|están|fue|fueron|ser|estar|tener|tiene|tenemos)\b/gi,
			/\b(esto|esta|estos|estas|eso|esa|esos|esas|aquel|aquella)\b/gi,
			/\b(yo|tú|vos|usted|él|ella|nosotros|vosotros|ellos|ellas)\b/gi,
			/\b(muy|más|menos|también|siempre|nunca|ahora|hoy|ayer|mañana)\b/gi,
			/[ñáéíóúü¿¡]/g,
		],
	},
	{
		code: "fr",
		markers: [
			/\b(le|la|les|un|une|des|du|de|d')\b/gi,
			/\b(je|tu|il|elle|nous|vous|ils|elles|on)\b/gi,
			/\b(est|sont|était|étaient|être|avoir|a|ont)\b/gi,
			/\b(que|qui|quoi|donc|parce|parceque|où|quand|comment|pourquoi)\b/gi,
			/\b(avec|sans|pour|dans|sur|sous|entre|contre|devant|derrière)\b/gi,
			/\b(très|plus|moins|beaucoup|peu|toujours|jamais|souvent|parfois)\b/gi,
			/[àâäéèêëïîôöùûüçœæ]/g,
		],
	},
	{
		code: "de",
		markers: [
			/\b(der|die|das|den|dem|des|ein|eine|einen|einem|einer)\b/gi,
			/\b(ich|du|er|sie|es|wir|ihr|Sie)\b/gi,
			/\b(ist|sind|war|waren|sein|haben|hat|hatte|hatten)\b/gi,
			/\b(nicht|kein|keine|keinen|auch|sehr|noch|schon|jetzt|dann)\b/gi,
			/\b(mit|ohne|für|gegen|bei|nach|seit|während|wegen|statt)\b/gi,
			/[äöüß]/g,
		],
	},
	{
		code: "it",
		markers: [
			/\b(il|lo|la|i|gli|le|un|una|uno)\b/gi,
			/\b(io|tu|lui|lei|noi|voi|loro)\b/gi,
			/\b(è|sono|era|erano|essere|avere|ha|hanno|aveva)\b/gi,
			/\b(non|molto|poco|sempre|mai|ora|oggi|ieri|domani)\b/gi,
			/\b(con|senza|per|contro|tra|fra|sopra|sotto|dentro)\b/gi,
			/[àèéìòóùù]/g,
		],
	},
	{
		code: "pt",
		markers: [
			/\b(o|a|os|as|um|uma|uns|umas)\b/gi,
			/\b(eu|tu|ele|ela|nós|vós|eles|elas)\b/gi,
			/\b(é|são|era|eram|ser|ter|tem|tinha|tiveram)\b/gi,
			/\b(não|muito|pouco|sempre|nunca|agora|hoje|ontem|amanhã)\b/gi,
			/\b(com|sem|para|por|em|no|na|nos|nas|sobre|entre)\b/gi,
			/[ãõâêôáéíóúç]/g,
		],
	},
	{
		code: "ru",
		markers: [/[а-яё]/gi],
	},
	{
		code: "ja",
		markers: [/[぀-ゟ゠-ヿ㐀-䶿一-鿿]/g],
	},
	{
		code: "zh",
		markers: [/[一-鿿]/g],
	},
	{
		code: "en",
		markers: [
			/\b(the|and|or|but|so|for|nor|yet)\b/gi,
			/\b(is|are|was|were|be|been|being|have|has|had|do|does|did)\b/gi,
			/\b(this|that|these|those|here|there)\b/gi,
			/\b(very|always|never|often|sometimes|now|today|yesterday|tomorrow)\b/gi,
			/\b(with|without|for|from|into|onto|upon|about|between|through)\b/gi,
		],
	},
];

const MIN_SAMPLES = 80; // characters of user content before we trust the detector

export interface DetectionResult {
	language: LanguageCode;
	confidence: number; // 0..1
}

/** Detect the dominant language from a free-form text sample. */
export function detectLanguage(samples: string[]): DetectionResult {
	const text = samples.join("\n").slice(0, 20000);
	if (text.replace(/\s/g, "").length < MIN_SAMPLES) {
		return { language: "en", confidence: 0 };
	}

	const totalChars = text.length;
	const scores = new Map<LanguageCode, number>();

	for (const profile of PROFILES) {
		let count = 0;
		for (const re of profile.markers) {
			const m = text.match(re);
			if (m) count += m.length;
		}
		// Normalize: characters with accents/diacritics are strong signals, words are weaker
		scores.set(profile.code, count / totalChars);
	}

	// Pick the highest scoring language
	let bestCode: LanguageCode = "en";
	let bestScore = -Infinity;
	for (const [code, score] of scores) {
		if (score > bestScore) {
			bestScore = score;
			bestCode = code;
		}
	}

	// Confidence: ratio of best vs second best
	const sorted = Array.from(scores.values()).sort((a, b) => b - a);
	const confidence =
		sorted.length >= 2 && sorted[0]! + sorted[1]! > 0
			? Math.min(1, sorted[0]! / (sorted[0]! + sorted[1]!))
			: 0;

	return { language: bestCode, confidence };
}