import { describe, expect, it } from "vitest";
import {
  baseDirection,
  breakUnits,
  charScript,
  dominantScript,
  hasCjk,
  htmlLang,
  isRtlLanguage,
  isWideChar,
  languageScript,
  needsShaping,
  scriptFontFamilies,
  scriptsIn,
  textDirection,
} from "./script.js";

describe("script detection", () => {
  it("classifies characters, with digits and punctuation neutral", () => {
    expect(charScript("a")).toBe("latin");
    expect(charScript("é")).toBe("latin");
    expect(charScript("Ж")).toBe("latin");
    expect(charScript("日")).toBe("cjk");
    expect(charScript("の")).toBe("cjk");
    expect(charScript("カ")).toBe("cjk");
    expect(charScript("한")).toBe("hangul");
    expect(charScript("क")).toBe("devanagari");
    expect(charScript("ि")).toBe("devanagari");
    expect(charScript("ع")).toBe("arabic");
    expect(charScript("ש")).toBe("hebrew");
    expect(charScript("ก")).toBe("other");
    for (const n of ["1", " ", "。", "、", "!", "।", "،"]) expect(charScript(n)).toBeNull();
  });

  it("finds the dominant script (ties go to the non-Latin script)", () => {
    expect(dominantScript("Vector databases")).toBe("latin");
    expect(dominantScript("ベクトルデータベースは API です")).toBe("cjk");
    expect(dominantScript("वेक्टर डेटाबेस API")).toBe("devanagari");
    expect(dominantScript("نموذج Whisper لعام")).toBe("arabic");
    expect(dominantScript("نموذج Whisper")).toBe("latin");
    expect(dominantScript("ab अब")).toBe("devanagari");
    expect(dominantScript("2022 — !")).toBe("latin");
    expect(scriptsIn("Whisperは音声")).toEqual(["latin", "cjk"]);
  });

  it("knows wide characters, shaping and direction", () => {
    expect(isWideChar("日")).toBe(true);
    expect(isWideChar("、")).toBe(true);
    expect(isWideChar("ー")).toBe(true);
    expect(isWideChar("ｶ")).toBe(false); // half-width katakana
    expect(isWideChar("a")).toBe(false);
    expect(hasCjk("abc。")).toBe(true);
    expect(hasCjk("abc")).toBe(false);
    expect(needsShaping("नमस्ते")).toBe(true);
    expect(needsShaping("مرحبا")).toBe(true);
    expect(needsShaping("日本語")).toBe(false);
    expect(textDirection("مرحبا بالعالم")).toBe("rtl");
    expect(textDirection("نموذج Whisper")).toBe("mixed");
    expect(textDirection("hello 2022")).toBe("ltr");
    expect(baseDirection("نموذج Whisper لعام 2022")).toBe("rtl");
    expect(baseDirection("Whisper")).toBe("ltr");
    expect(baseDirection("نموذج Whisper")).toBe("rtl"); // first strong letter
    expect(baseDirection("Whisper نموذج لعام")).toBe("ltr");
    expect(baseDirection("2022", "ar")).toBe("rtl");
  });
});

describe("languages", () => {
  it("maps BCP-47 tags to scripts", () => {
    expect(languageScript("ja")).toBe("cjk");
    expect(languageScript("ja-JP")).toBe("cjk");
    expect(languageScript("zh-Hant-TW")).toBe("cjk");
    expect(languageScript("hi")).toBe("devanagari");
    expect(languageScript("ar-EG")).toBe("arabic");
    expect(languageScript("he")).toBe("hebrew");
    expect(languageScript("en-US")).toBe("latin");
    expect(languageScript("sr-Latn")).toBe("latin");
    expect(languageScript("pa-Arab")).toBe("arabic");
    expect(languageScript(undefined)).toBeUndefined();
    expect(isRtlLanguage("ar")).toBe(true);
    expect(isRtlLanguage("hi")).toBe(false);
  });

  it("gives html lang from the language, else a guess from the script", () => {
    expect(htmlLang("ja-JP", "cjk")).toBe("ja-JP");
    expect(htmlLang(undefined, "devanagari")).toBe("hi");
    expect(htmlLang(undefined, "latin")).toBeUndefined();
  });

  it("lists bundled Noto families first for each script", () => {
    expect(scriptFontFamilies("cjk")[0]).toBe("Noto Sans JP");
    expect(scriptFontFamilies("cjk", "zh-CN")[0]).toBe("Noto Sans SC");
    expect(scriptFontFamilies("devanagari")[0]).toBe("Noto Sans Devanagari");
    expect(scriptFontFamilies("arabic")[0]).toBe("Noto Sans Arabic");
    expect(scriptFontFamilies("latin")).toEqual([]);
  });
});

describe("breakUnits (kinsoku)", () => {
  const texts = (s: string) => breakUnits(s).map((u) => u.text);
  it("splits CJK per character and glues closing punctuation and small kana to the character before", () => {
    expect(texts("意味で検索します。")).toEqual(["意", "味", "で", "検", "索", "し", "ま", "す。"]);
    expect(texts("ベクトル、データ")).toEqual(["ベ", "ク", "ト", "ル、", "デー", "タ"]);
    expect(texts("しょう")).toEqual(["しょ", "う"]);
  });
  it("glues opening brackets to the character after, and keeps Latin words whole", () => {
    expect(texts("モデル（2022年）")).toEqual(["モ", "デ", "ル", "（2022", "年）"]);
    expect(texts("「本」です")).toEqual(["「本」", "で", "す"]);
    expect(texts("Whisperは音声")).toEqual(["Whisper", "は", "音", "声"]);
  });
  it("marks spaces for spaced scripts", () => {
    expect(breakUnits("वेक्टर डेटाबेस")).toEqual([
      { text: "वेक्टर", space: false },
      { text: "डेटाबेस", space: true },
    ]);
  });
});
