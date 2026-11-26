const ACCENT_MAP: Record<string, string> = {
  ç: "c",
  ğ: "g",
  ı: "i",
  ö: "o",
  ş: "s",
  ü: "u",
  â: "a",
  î: "i",
  û: "u",
  à: "a",
  á: "a",
  ä: "a",
  è: "e",
  é: "e",
  ê: "e",
  ë: "e",
  ì: "i",
  í: "i",
  ï: "i",
  ò: "o",
  ó: "o",
  ô: "o",
  ù: "u",
  ú: "u",
  ñ: "n",
};

/**
 * QuickJS-safe Turkish and Latin accent folding without relying on String.prototype.normalize.
 */
export function asciiFold(input: string): string {
  const lowered = String(input || "")
    .replace(/İ/g, "i")
    .replace(/I/g, "i")
    .toLowerCase();
  let out = "";
  for (let i = 0; i < lowered.length; i++) {
    const ch = lowered.charAt(i);
    out += ACCENT_MAP[ch] ?? ch;
  }
  return out;
}

export function ultraClean(input: string): string {
  return asciiFold(input).replace(/[^a-z0-9]/g, "");
}

export function normalizeWords(input: string): string {
  return asciiFold(input)
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function cleanTitle(input: string): string {
  return String(input || "")
    .replace(/\s*\(\d{4}\)\s*$/g, "")
    .replace(
      /\s*(?:izle|hd\s*izle|full\s*hd|t[üu]rk[çc]e\s*dublaj|t[üu]rk[çc]e\s*altyaz[ıi]l[ıi])\s*$/gi,
      "",
    )
    .trim();
}

export function slugify(input: string): string {
  return asciiFold(input)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function decodeHtmlEntities(input: string): string {
  return String(input || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, num: string) => {
      const code = Number.parseInt(num, 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    });
}

export function extractYear(input?: string | null): number | undefined {
  if (!input) return undefined;
  const match = /\b(19\d{2}|20\d{2})\b/.exec(input);
  if (!match || !match[1]) return undefined;
  const year = Number.parseInt(match[1], 10);
  return Number.isFinite(year) ? year : undefined;
}

export function tokenize(input: string): string[] {
  return normalizeWords(input)
    .split(" ")
    .filter((tok) => tok.length >= 2);
}

export function titleSimilarity(a: string, b: string): number {
  const normA = normalizeWords(a);
  const normB = normalizeWords(b);
  if (!normA || !normB) return 0;
  if (normA === normB) return 1;

  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length === 0 || tb.length === 0) {
    return normA === normB ? 1 : 0;
  }

  const setB = new Set(tb);
  let hits = 0;
  for (const token of ta) {
    if (setB.has(token)) hits += 1;
  }
  return hits / Math.max(ta.length, tb.length);
}

export function absoluteUrl(baseUrl: string, rawUrl?: string | null): string {
  const raw = String(rawUrl ?? "").trim();
  if (!raw) return "";
  if (raw.startsWith("https://") || raw.startsWith("http://")) return raw;
  if (raw.startsWith("//")) return `https:${raw}`;
  try {
    return new URL(raw, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
  } catch {
    return raw;
  }
}

export function parseSeasonEpisode(
  text: string,
  fallbackSeason = 1,
): { season: number; episode: number } | null {
  const sxe = /(\d+)\s*[x×]\s*0*(\d+)/i.exec(text);
  if (sxe && sxe[1] && sxe[2]) {
    return {
      season: Number.parseInt(sxe[1], 10),
      episode: Number.parseInt(sxe[2], 10),
    };
  }

  const se = /s0*(\d+)[\s._-]*e0*(\d+)/i.exec(text);
  if (se && se[1] && se[2]) {
    return {
      season: Number.parseInt(se[1], 10),
      episode: Number.parseInt(se[2], 10),
    };
  }

  const trFull = /(\d+)\.\s*sezon[\s,._/-]*(\d+)\.\s*b[oö]l[uü]m/i.exec(text);
  if (trFull && trFull[1] && trFull[2]) {
    return {
      season: Number.parseInt(trFull[1], 10),
      episode: Number.parseInt(trFull[2], 10),
    };
  }

  const trSlug = /sezon-(\d+)[\/_-]bolum-(\d+)/i.exec(text);
  if (trSlug && trSlug[1] && trSlug[2]) {
    return {
      season: Number.parseInt(trSlug[1], 10),
      episode: Number.parseInt(trSlug[2], 10),
    };
  }

  const epOnly =
    /(?:b[oö]l[uü]m|episode|ep)\s*[:._-]?\s*0*(\d+)|\b0*(\d+)\.\s*b[oö]l[uü]m/i.exec(text);
  if (epOnly) {
    const rawEp = epOnly[1] ?? epOnly[2];
    if (rawEp) {
      return {
        season: fallbackSeason,
        episode: Number.parseInt(rawEp, 10),
      };
    }
  }

  return null;
}

export function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = ultraClean(trimmed) || trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
