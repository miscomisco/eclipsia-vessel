import { html } from "vessel";
import type {
  Episode,
  HomeFeed,
  HomeSection,
  MediaDetail,
  MediaSummary,
  MediaType,
  SearchPage,
  StreamCandidate,
  StreamResult,
} from "vessel";
import { rethrowIfDomainBlocked } from "./http.ts";
import { sortStreamsByQuality } from "./quality.ts";
import { absoluteUrl, titleSimilarity, ultraClean } from "./text.ts";
import {
  tmdbBuildMediaDetail,
  tmdbDiscoverFeed,
  tmdbGetSeasonEpisodes,
  tmdbSearch,
} from "./tmdb.ts";

export interface MatchableCandidate {
  title: string;
  altTitle?: string;
  year?: number;
}

export interface ParsedRouteId {
  isTmdb: boolean;
  mediaType: MediaType;
  id: string;
  season: number;
  episode: number;
}

export function parseRouteId(rawId: string): ParsedRouteId {
  const parts = rawId.split(":");
  if (parts.length >= 3 && (parts[1] === "movie" || parts[1] === "series" || parts[1] === "live")) {
    return {
      isTmdb: true,
      mediaType: parts[1],
      id: parts[2] ?? rawId,
      season: Number.parseInt(parts[3] ?? "1", 10) || 1,
      episode: Number.parseInt(parts[4] ?? "1", 10) || 1,
    };
  }
  if (parts.length === 3 && /^\d+$/.test(parts[1] ?? "") && /^\d+$/.test(parts[2] ?? "")) {
    return {
      isTmdb: true,
      mediaType: "series",
      id: parts[0] ?? rawId,
      season: Number.parseInt(parts[1]!, 10) || 1,
      episode: Number.parseInt(parts[2]!, 10) || 1,
    };
  }
  return {
    isTmdb: /^(?:tt\d+|\d+)$/.test(rawId.trim()),
    mediaType: "movie",
    id: rawId.trim(),
    season: 1,
    episode: 1,
  };
}

export function finalizeStreams(streams: StreamCandidate[]): StreamResult {
  return {
    streams: sortStreamsByQuality(streams),
  };
}

export function pickBestCandidate<T extends MatchableCandidate>(
  candidates: readonly T[],
  targetTitle: string,
  targetAltTitle?: string,
  targetYear?: number,
): T | null {
  if (candidates.length === 0) return null;

  const queries = [targetTitle, targetAltTitle]
    .map((s) => (s ?? "").trim())
    .filter(Boolean);

  let best: T | null = null;
  let bestScore = -1;

  for (const cand of candidates) {
    let score = 0;
    const cleanCandTitle = ultraClean(cand.title);
    const cleanCandAlt = cand.altTitle ? ultraClean(cand.altTitle) : "";

    for (const q of queries) {
      const cleanQ = ultraClean(q);
      if (!cleanQ) continue;
      if (cleanCandTitle === cleanQ || (cleanCandAlt && cleanCandAlt === cleanQ)) {
        score = Math.max(score, 100);
      } else if (
        cleanCandTitle.includes(cleanQ) ||
        cleanQ.includes(cleanCandTitle) ||
        (cleanCandAlt && (cleanCandAlt.includes(cleanQ) || cleanQ.includes(cleanCandAlt)))
      ) {
        score = Math.max(score, 65);
      } else {
        const sim = Math.max(
          titleSimilarity(cand.title, q),
          cand.altTitle ? titleSimilarity(cand.altTitle, q) : 0,
        );
        score = Math.max(score, Math.round(sim * 50));
      }
    }

    if (targetYear && cand.year) {
      if (cand.year === targetYear) score += 20;
      else if (Math.abs(cand.year - targetYear) === 1) score += 8;
      else if (Math.abs(cand.year - targetYear) >= 3) score -= 10;
    }

    if (score > bestScore) {
      bestScore = score;
      best = cand;
    }
  }

  return bestScore >= 25 ? best : candidates[0] ?? null;
}

export function dedupeMediaSummaries(items: readonly MediaSummary[]): MediaSummary[] {
  const out: MediaSummary[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.nativeId || seen.has(item.nativeId)) continue;
    seen.add(item.nativeId);
    out.push(item);
  }
  return out;
}

export function encodeSiteNativeId(
  mediaType: MediaType,
  urlOrSlug: string,
): string {
  return `${mediaType}:${encodeURIComponent(urlOrSlug)}`;
}

export function decodeSiteNativeId(
  nativeId: string,
  defaultType: MediaType = "movie",
): { mediaType: MediaType; target: string } {
  const match = /^(movie|series|live):(.*)$/.exec(nativeId);
  if (match && match[1] && match[2] !== undefined) {
    let target = match[2];
    try {
      target = decodeURIComponent(match[2]);
    } catch {
      target = match[2];
    }
    return {
      mediaType: match[1] as MediaType,
      target,
    };
  }
  return { mediaType: defaultType, target: nativeId };
}

export function extractUniqueFrameUrls(
  rawHtml: string,
  baseUrl: string,
): string[] {
  const doc = html.parse(rawHtml);
  const found: string[] = [];
  const seen = new Set<string>();

  const pushUrl = (raw?: string | null): void => {
    if (!raw) return;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("data:") || trimmed.startsWith("about:")) {
      return;
    }
    const resolved = absoluteUrl(baseUrl, trimmed);
    if (!resolved || seen.has(resolved)) return;
    seen.add(resolved);
    found.push(resolved);
  };

  for (const el of doc.select("iframe, [data-frame], [data-src], [data-embed], [data-vsrc]")) {
    pushUrl(el.attr("data-vsrc"));
    pushUrl(el.attr("data-frame"));
    pushUrl(el.attr("data-embed"));
    pushUrl(el.attr("data-src"));
    pushUrl(el.attr("src"));
  }

  return found;
}

export async function getTmdbBackedMovieDetails(opts: {
  nativeId: string;
  idPrefix: string;
  mediaType?: "movie" | "series";
  isAnime?: boolean;
}): Promise<MediaDetail> {
  const parts = opts.nativeId.split(":");
  const isExplicitAnime = parts[1] === "anime";
  const inferredType: "movie" | "series" =
    parts[1] === "series" || parts[1] === "tv" || isExplicitAnime
      ? "series"
      : parts[1] === "movie"
        ? "movie"
        : opts.mediaType ?? "movie";
  const detail = await tmdbBuildMediaDetail({
    nativeId: opts.nativeId,
    preferType: inferredType,
    isAnime: Boolean(opts.isAnime || isExplicitAnime),
    streamIdBuilder: (identity, season, episode) =>
      identity.mediaType === "movie"
        ? `${opts.idPrefix}:movie:${identity.tmdbId}`
        : `${opts.idPrefix}:series:${identity.tmdbId}:${season}:${episode}`,
  });
  if (!detail) {
    throw new Error(`TMDB detayı alınamadı: ${opts.nativeId}`);
  }
  return detail;
}

export async function getTmdbMovieHomeSections(opts: {
  idPrefix: string;
  includeSeries?: boolean;
}): Promise<{
  popularMovies: MediaSummary[];
  topMovies: MediaSummary[];
  popularSeries: MediaSummary[];
}> {
  const [popularMovies, topMovies, popularSeries] = await Promise.all([
    tmdbDiscoverFeed({
      idPrefix: opts.idPrefix,
      mediaType: "movie",
      sortBy: "popularity.desc",
    }),
    tmdbDiscoverFeed({
      idPrefix: opts.idPrefix,
      mediaType: "movie",
      sortBy: "vote_average.desc",
    }),
    opts.includeSeries
      ? tmdbDiscoverFeed({
          idPrefix: opts.idPrefix,
          mediaType: "series",
          sortBy: "popularity.desc",
        })
      : Promise.resolve([]),
  ]);
  return { popularMovies, topMovies, popularSeries };
}

export async function searchTmdbBackedCatalog(opts: {
  idPrefix: string;
  query: string;
  mediaType?: "movie" | "series" | "all";
  isAnime?: boolean;
  page: number;
}): Promise<{ items: MediaSummary[]; hasMore: boolean }> {
  return tmdbSearch({
    idPrefix: opts.idPrefix,
    query: opts.query,
    mediaType: opts.mediaType ?? "movie",
    isAnime: opts.isAnime,
    page: opts.page,
  });
}

export function buildTmdbPluginScaffold(opts: {
  idPrefix: string;
  mediaTypes: Array<"movie" | "series">;
  isAnime?: boolean;
  originCountry?: string;
  withGenres?: string;
  movieSectionTitle?: string;
  seriesSectionTitle?: string;
}): {
  getHomeFeed: (cursor?: string | null) => Promise<HomeFeed>;
  search: (query: string, filters: Record<string, string>, page: number) => Promise<SearchPage>;
  getDetails: (nativeId: string) => Promise<MediaDetail>;
  getSeasonEpisodes: (nativeId: string, seasonId: string) => Promise<Episode[]>;
} {
  const hasMovie = opts.mediaTypes.includes("movie");
  const hasSeries = opts.mediaTypes.includes("series");

  return {
    async getHomeFeed(): Promise<HomeFeed> {
      try {
        const sections: HomeSection[] = [];
        const [movies, series] = await Promise.all([
          hasMovie
            ? tmdbDiscoverFeed({
                idPrefix: opts.idPrefix,
                mediaType: "movie",
                isAnime: opts.isAnime,
                originCountry: opts.originCountry,
                withGenres: opts.withGenres,
              })
            : Promise.resolve([]),
          hasSeries
            ? tmdbDiscoverFeed({
                idPrefix: opts.idPrefix,
                mediaType: "series",
                isAnime: opts.isAnime,
                originCountry: opts.originCountry,
                withGenres: opts.withGenres,
              })
            : Promise.resolve([]),
        ]);
        if (movies.length > 0) {
          sections.push({
            id: "popular-movies",
            title: opts.movieSectionTitle ?? "Popüler Filmler",
            layout: "poster",
            items: movies,
          });
        }
        if (series.length > 0) {
          sections.push({
            id: "popular-series",
            title: opts.seriesSectionTitle ?? "Popüler Diziler",
            layout: "poster",
            items: series,
          });
        }
        return { sections };
      } catch (err) {
        rethrowIfDomainBlocked(err);
        return { sections: [] };
      }
    },

    async search(query, _filters, page): Promise<SearchPage> {
      try {
        const searchType =
          hasMovie && hasSeries ? "all" : hasSeries ? "series" : "movie";
        return await tmdbSearch({
          idPrefix: opts.idPrefix,
          query,
          mediaType: searchType,
          isAnime: opts.isAnime,
          page,
        });
      } catch (err) {
        rethrowIfDomainBlocked(err);
        return { items: [], hasMore: false };
      }
    },

    async getDetails(nativeId): Promise<MediaDetail> {
      return getTmdbBackedMovieDetails({
        nativeId,
        idPrefix: opts.idPrefix,
        mediaType: hasSeries && !hasMovie ? "series" : "movie",
        isAnime: opts.isAnime,
      });
    },

    async getSeasonEpisodes(nativeId, seasonId): Promise<Episode[]> {
      const parts = nativeId.split(":");
      const tmdbId = Number.parseInt(parts[2] ?? nativeId, 10);
      const seasonNum = Number.parseInt(seasonId, 10) || 1;
      if (!Number.isFinite(tmdbId)) return [];
      return tmdbGetSeasonEpisodes(
        tmdbId,
        seasonNum,
        (s, ep) => `${opts.idPrefix}:series:${tmdbId}:${s}:${ep}`,
      );
    },
  };
}
