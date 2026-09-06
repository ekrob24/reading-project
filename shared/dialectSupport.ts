export const readingLanguageSupportValues = ["STANDARD_ENGLISH", "IRISH_ENGLISH_SUPPORT"] as const;
export type ReadingLanguageSupport = (typeof readingLanguageSupportValues)[number];

export const readingLanguageSupportLabels: Record<ReadingLanguageSupport, string> = {
  STANDARD_ENGLISH: "Standard English comparison",
  IRISH_ENGLISH_SUPPORT: "Irish English support · teacher review",
};

/**
 * IMPORTANT — scope of this layer.
 *
 * Whisper returns *words*, not phonemes. This matcher only recognises Irish
 * English features that actually change the spelling of a transcript. In
 * practice that is the consonantal features:
 *   - TH-stopping   (thin -> tin,  that -> dat)
 *   - G-dropping    (running -> runnin)
 *   - irregular TH-cluster reductions (through -> true)
 *   - homophone pairs from a vowel merger where BOTH forms are real words
 *     (caught -> cot) — the only way a vowel feature can surface in text.
 *
 * Vowel and rhotic features — TRAP-BATH broad-a, the cot/caught vowel itself,
 * post-vocalic /r/ (the "horse" demo) — are real in speech but Whisper renders
 * them with standard spelling, so they are invisible here and CANNOT be handled
 * at the word level. Those belong to the phoneme-level scorer, not this file.
 *
 * Every accepted variant is a *provisional* match routed to teacher review,
 * never a silent auto-accept.
 */

const normalise = (word: string) => word.toLocaleLowerCase("en-IE").replace(/[^a-z']/g, "");

export type DialectFeature =
  | "th-stopping-voiceless"
  | "th-stopping-voiced"
  | "g-dropping"
  | "th-cluster"
  | "cot-caught-merger";

export const dialectFeatureLabels: Record<DialectFeature, string> = {
  "th-stopping-voiceless": "TH-stopping (theta->t, e.g. thin->tin)",
  "th-stopping-voiced": "TH-stopping (edh->d, e.g. that->dat)",
  "g-dropping": "G-dropping (-ing->-in, e.g. running->runnin)",
  "th-cluster": "TH cluster reduction (e.g. through->true)",
  "cot-caught-merger": "Cot-caught vowel merger (homophone pair)",
};

const voicedThInitial = new Set([
  "the", "this", "that", "these", "those", "them", "then", "they", "there",
  "their", "theirs", "themselves", "though", "than", "thus", "thee", "thy", "thine",
]);

const monosyllabicIng = new Set([
  "thing", "king", "ring", "sing", "wing", "bring", "cling", "sting", "spring",
  "string", "swing", "bling", "zing", "ding", "ping", "fling", "sling",
]);

const irregularVariants: Record<string, ReadonlyArray<{ variant: string; feature: DialectFeature }>> = {
  through: [{ variant: "true", feature: "th-cluster" }, { variant: "tru", feature: "th-cluster" }],
  they: [{ variant: "day", feature: "th-stopping-voiced" }],
  caught: [{ variant: "cot", feature: "cot-caught-merger" }],
};

export function irishEnglishVariants(expected: string): Map<string, DialectFeature> {
  const word = normalise(expected);
  const variants = new Map<string, DialectFeature>();
  if (!word) return variants;

  const add = (candidate: string, feature: DialectFeature) => {
    const clean = normalise(candidate);
    if (clean && clean !== word && !variants.has(clean)) variants.set(clean, feature);
  };

  if (word.includes("th")) {
    if (voicedThInitial.has(word)) {
      add(word.replace(/th/g, "d"), "th-stopping-voiced");
    } else {
      add(word.replace(/th/g, "t"), "th-stopping-voiceless");
      if (word === "with") add("wid", "th-stopping-voiced");
    }
  }

  if (word.endsWith("ing") && !monosyllabicIng.has(word)) {
    add(`${word.slice(0, -3)}in`, "g-dropping");
    if (word.includes("th")) add(`${word.slice(0, -3).replace(/th/g, "t")}in`, "g-dropping");
  }

  for (const { variant, feature } of irregularVariants[word] ?? []) add(variant, feature);

  return variants;
}

export type DialectMatch = { matches: boolean; provisionalIrishEnglish: boolean; feature?: DialectFeature };

export function matchExpectedReadingWord(
  expectedWord: string,
  recognisedWord: string,
  support: ReadingLanguageSupport = "STANDARD_ENGLISH",
): DialectMatch {
  const expected = normalise(expectedWord);
  const recognised = normalise(recognisedWord);
  if (expected === recognised) return { matches: true, provisionalIrishEnglish: false };
  if (support !== "IRISH_ENGLISH_SUPPORT" || !expected) return { matches: false, provisionalIrishEnglish: false };

  const feature = irishEnglishVariants(expected).get(recognised);
  if (!feature) return { matches: false, provisionalIrishEnglish: false };
  return { matches: true, provisionalIrishEnglish: true, feature };
}

export function isIrishEnglishSupportEnabled(support: ReadingLanguageSupport) {
  return support === "IRISH_ENGLISH_SUPPORT";
}
