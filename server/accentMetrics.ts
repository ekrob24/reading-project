/**
 * Accent fairness metrics for the dashboard — the numbers behind the pitch.
 *
 * Two independent measurements, both honest:
 *  1. measureCuratedContrast() — runs a curated set of genuine Irish-English
 *     pronunciations through the REAL analysis engine twice: accent-blind vs
 *     accent-aware. Shows how many valid pronunciations each would wrongly mark
 *     as errors. This is a live, reproducible before/after, not a scripted claim.
 *  2. computeLiveFairness(sessions) — the false-correction rate measured from
 *     real teacher confirm/override decisions accumulated in use.
 *
 * Scope (state it when presenting): the curated contrast measures the word-level
 * dialect layer on curated features; it is not an end-to-end ASR benchmark. The
 * live rate grows as teachers review. The honest edge is the roadmap, not a flaw.
 */
import { analyseReadingText } from "./reader";

type Pair = { expected: string; heard: string; feature: string };

const IRISH_READINGS: Pair[] = [
  { expected: "thin", heard: "tin", feature: "TH-stopping" },
  { expected: "path", heard: "pat", feature: "TH-stopping" },
  { expected: "three", heard: "tree", feature: "TH-stopping" },
  { expected: "month", heard: "mont", feature: "TH-stopping" },
  { expected: "north", heard: "nort", feature: "TH-stopping" },
  { expected: "teeth", heard: "teet", feature: "TH-stopping" },
  { expected: "with", heard: "wit", feature: "TH-stopping" },
  { expected: "that", heard: "dat", feature: "TH-stopping (voiced)" },
  { expected: "this", heard: "dis", feature: "TH-stopping (voiced)" },
  { expected: "them", heard: "dem", feature: "TH-stopping (voiced)" },
  { expected: "they", heard: "dey", feature: "TH-stopping (voiced)" },
  { expected: "running", heard: "runnin", feature: "G-dropping" },
  { expected: "reading", heard: "readin", feature: "G-dropping" },
  { expected: "morning", heard: "mornin", feature: "G-dropping" },
  { expected: "through", heard: "true", feature: "TH-cluster" },
  { expected: "caught", heard: "cot", feature: "cot-caught merger" },
];

const carrier = (w: string) => `we can see the ${w} today`;

function markedAsError(expected: string, heard: string, mode: "STANDARD_ENGLISH" | "IRISH_ENGLISH_SUPPORT"): boolean {
  const a = analyseReadingText(carrier(expected), carrier(heard), 10, "ASSISTED_PRACTICE", undefined, mode);
  const ev = a.events.find(e => e.expectedWord.toLowerCase() === expected.toLowerCase());
  return !!ev && ev.eventType !== "dialect_variation" && !ev.provisionalIrishEnglish && ev.eventType !== "correct";
}

export function measureCuratedContrast() {
  const total = IRISH_READINGS.length;
  const flaggedIn = (mode: "STANDARD_ENGLISH" | "IRISH_ENGLISH_SUPPORT") =>
    IRISH_READINGS.filter(p => markedAsError(p.expected, p.heard, mode)).length;
  const baselineFlagged = flaggedIn("STANDARD_ENGLISH");
  const ourFlagged = flaggedIn("IRISH_ENGLISH_SUPPORT");

  const features = Array.from(new Set(IRISH_READINGS.map(p => p.feature)));
  const byFeature = features.map(feature => {
    const set = IRISH_READINGS.filter(p => p.feature === feature);
    const accepted = set.filter(p => !markedAsError(p.expected, p.heard, "IRISH_ENGLISH_SUPPORT")).length;
    return { feature, accepted, total: set.length, ratePct: Math.round((accepted / set.length) * 100) };
  });

  return {
    total,
    baseline: { label: "Accent-blind handling", flagged: baselineFlagged, falseCorrectionRatePct: Math.round((baselineFlagged / total) * 100) },
    readerLeader: { label: "Reader Leader (accent-aware)", flagged: ourFlagged, falseCorrectionRatePct: Math.round((ourFlagged / total) * 100) },
    byFeature,
  };
}

// ---- live fairness from real teacher decisions ----
export type DecidedSessionLike = {
  interventions: Array<{ word: string; heardWord?: string; eventType?: string; provisionalIrishEnglish?: boolean; teacherDecision?: string }>;
};

export function computeLiveFairness(sessions: DecidedSessionLike[]) {
  const c = { true_accept: 0, false_accept: 0, true_reject: 0, false_correction: 0 };
  for (const s of sessions) for (const iv of s.interventions) {
    const d = iv.teacherDecision;
    if (d !== "confirmed" && d !== "overridden") continue;
    const acceptedVariant = iv.eventType === "dialect_variation" || iv.provisionalIrishEnglish === true;
    const validVariant = (acceptedVariant) === (d === "confirmed");
    if (acceptedVariant) validVariant ? c.true_accept++ : c.false_accept++;
    else validVariant ? c.false_correction++ : c.true_reject++;
  }
  const reviewed = c.true_accept + c.false_accept + c.true_reject + c.false_correction;
  const validTotal = c.true_accept + c.false_correction;
  const errorTotal = c.true_reject + c.false_accept;
  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : null);
  return {
    totalReviewed: reviewed,
    falseCorrectionRatePct: pct(c.false_correction, validTotal),
    falseAcceptanceRatePct: pct(c.false_accept, errorTotal),
    counts: c,
  };
}

export function getAccentFairnessSummary(sessions: DecidedSessionLike[]) {
  return { curated: measureCuratedContrast(), live: computeLiveFairness(sessions) };
}
