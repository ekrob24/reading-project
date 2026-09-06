import { describe, expect, it } from "vitest";
import { irishEnglishVariants, matchExpectedReadingWord } from "../shared/dialectSupport";

const IE = "IRISH_ENGLISH_SUPPORT" as const;
const STD = "STANDARD_ENGLISH" as const;

describe("Irish English variation support", () => {
  it("keeps the reviewed variation opt-in and bounded", () => {
    expect(matchExpectedReadingWord("caught", "cot", STD)).toEqual({ matches: false, provisionalIrishEnglish: false });
    expect(matchExpectedReadingWord("caught", "cot", IE)).toEqual({ matches: true, provisionalIrishEnglish: true, feature: "cot-caught-merger" });
    expect(matchExpectedReadingWord("caught", "cat", IE)).toEqual({ matches: false, provisionalIrishEnglish: false });
  });

  it("recognises TH-stopping across vocabulary it was never hand-listed for", () => {
    for (const [expected, heard] of [["north", "nort"], ["month", "mont"], ["teeth", "teet"], ["path", "pat"], ["thin", "tin"]]) {
      const result = matchExpectedReadingWord(expected, heard, IE);
      expect(result.matches).toBe(true);
      expect(result.feature).toBe("th-stopping-voiceless");
    }
  });

  it("uses voiced TH (d) for function words and allows wit/wid for with", () => {
    expect(matchExpectedReadingWord("that", "dat", IE).feature).toBe("th-stopping-voiced");
    expect(matchExpectedReadingWord("this", "dis", IE).feature).toBe("th-stopping-voiced");
    expect(matchExpectedReadingWord("with", "wit", IE).matches).toBe(true);
    expect(matchExpectedReadingWord("with", "wid", IE).matches).toBe(true);
  });

  it("drops g on real -ing suffixes but not on monosyllabic -ing words", () => {
    expect(matchExpectedReadingWord("running", "runnin", IE).feature).toBe("g-dropping");
    expect(matchExpectedReadingWord("reading", "readin", IE).feature).toBe("g-dropping");
    expect(matchExpectedReadingWord("thing", "thin", IE).matches).toBe(false);
    expect(matchExpectedReadingWord("king", "kin", IE).matches).toBe(false);
    expect(matchExpectedReadingWord("sing", "sin", IE).matches).toBe(false);
  });

  it("combines features for words like nothing", () => {
    const variants = irishEnglishVariants("nothing");
    expect(variants.has("nothin")).toBe(true);
    expect(variants.has("noting")).toBe(true);
    expect(variants.has("notin")).toBe(true);
  });

  it("handles irregular cluster reductions", () => {
    expect(matchExpectedReadingWord("through", "true", IE).feature).toBe("th-cluster");
    expect(matchExpectedReadingWord("they", "day", IE).matches).toBe(true);
  });

  it("does NOT accept non-rhotic r-dropping (Irish English is rhotic)", () => {
    expect(matchExpectedReadingWord("park", "pork", IE).matches).toBe(false);
    expect(matchExpectedReadingWord("hard", "hod", IE).matches).toBe(false);
    expect(matchExpectedReadingWord("card", "cod", IE).matches).toBe(false);
  });
});
