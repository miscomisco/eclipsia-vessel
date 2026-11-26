import type { Episode, ExternalIds, MediaDetail, MediaSummary, SeasonSummary } from "vessel";
import { fetchJson } from "./http.ts";
import { dedupeStrings, extractYear, titleSimilarity } from "./text.ts";

export const TMDB_API_BASE = "https://api.themoviedb.org/3";
export const TMDB_IMG_W500 = "https://image.tmdb.org/t/p/w500";
export const TMDB_IMG_ORIG = "https://image.tmdb.org/t/p/original";
let tmdbLanguage = "tr-TR";

export function setTmdbLanguage(language: string): void {
  tmdbLanguage = language;
}

export const DEFAULT_TMDB_KEY = "500330721680edb6d5f7f12ba7cd9023";

interface TmdbListItem {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  media_type?: string;
  genre_ids?: number[];
  origin_country?: string[];
  original_language?: string;
}

interface TmdbListResponse {
  results?: TmdbListItem[];
  total_pages?: number;
}

interface TmdbSeasonRaw {
  id: number;
  season_number: number;
  name?: string;
  episode_count?: number;
  poster_path?: string | null;
}

interface TmdbDetailRaw {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  overview?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  status?: string;
  imdb_id?: string;
  original_language?: string;
  origin_country?: string[];
  genres?: Array<{ id: number; name: string }>;
  seasons?: TmdbSeasonRaw[];
  external_ids?: {
    imdb_id?: string | null;
    tvdb_id?: number | null;
  };
  translations?: {
    translations?: Array<{
      iso_639_1?: string;
      data?: { title?: string; name?: string };
    }>;
  };
  alternative_titles?: {
    titles?: Array<{ title?: string }>;
    results?: Array<{ title?: string }>;
  };
}

interface TmdbEpisodeListRaw {
  episodes?: Array<{
    episode_number: number;
    season_number: number;
    name?: string;
    overview?: string;
    still_path?: string | null;
    air_date?: string;
  }>;
}

export interface ResolvedTmdbIdentity {
  tmdbId: number;
  imdbId?: string;
  mediaType: "movie" | "series";
  title: string;
  originalTitle: string;
  year?: number;
  poster?: string;
  backdrop?: string;
  synopsis?: string;
  genres: string[];
  originalLanguage?: string;
  isAnimation?: boolean;
  isAnime?: boolean;
  rating?: number;
  searchTitles: string[];
  seasons: SeasonSummary[];
}

export function tmdbPoster(path?: string | null): string | undefined {
  return path ? `${TMDB_IMG_W500}${path}` : undefined;
}

export function tmdbBackdrop(path?: string | null): string | undefined {
  return path ? `${TMDB_IMG_ORIG}${path}` : undefined;
}

export async function tmdbGet<T>(
  endpoint: string,
  params: Record<string, string | number> = {},
  apiKey = DEFAULT_TMDB_KEY,
): Promise<T | null> {
  const qs = new URLSearchParams({ api_key: apiKey });
  for (const [k, v] of Object.entries(params)) {
    qs.set(k, String(v));
  }
  return fetchJson<T>(`${TMDB_API_BASE}${endpoint}?${qs.toString()}`, {
    timeoutMs: 8_000,
  });
}

function mapTmdbSummary(
  item: TmdbListItem,
  idPrefix: string,
  forcedType?: "movie" | "series",
  isAnime = false,
): MediaSummary | null {
  const title = item.title ?? item.name;
  if (!title) return null;
  const mediaType: "movie" | "series" =
    forcedType ?? (item.media_type === "movie" || item.title ? "movie" : "series");
  const date = item.release_date ?? item.first_air_date;
  const isAnimGenre = Array.isArray(item.genre_ids) && item.genre_ids.includes(16);
  const isJp = item.original_language === "ja" || item.origin_country?.includes("JP");

  return {
    nativeId: `${idPrefix}:${mediaType}:${item.id}`,
    type: mediaType,
    isAnime: isAnime || (isAnimGenre && Boolean(isJp)),
    title,
    year: extractYear(date),
    poster: tmdbPoster(item.poster_path),
    rating:
      typeof item.vote_average === "number" && item.vote_average > 0
        ? Math.round(item.vote_average * 10) / 10
        : undefined,
  };
}

export async function tmdbDiscoverFeed(opts: {
  idPrefix: string;
  mediaType: "movie" | "series";
  isAnime?: boolean;
  originCountry?: string;
  withGenres?: string;
  sortBy?: string;
  page?: number;
}): Promise<MediaSummary[]> {
  const path = opts.mediaType === "movie" ? "/discover/movie" : "/discover/tv";
  const params: Record<string, string | number> = {
    language: tmdbLanguage,
    sort_by: opts.sortBy ?? "popularity.desc",
    page: opts.page ?? 1,
  };
  if (opts.originCountry) params["with_origin_country"] = opts.originCountry;
  if (opts.withGenres) params["with_genres"] = opts.withGenres;

  const data = await tmdbGet<TmdbListResponse>(path, params);
  if (!data?.results) return [];

  return data.results
    .map((item) => mapTmdbSummary(item, opts.idPrefix, opts.mediaType, Boolean(opts.isAnime)))
    .filter((item): item is MediaSummary => item !== null);
}

export async function tmdbSearch(opts: {
  idPrefix: string;
  query: string;
  mediaType?: "movie" | "series" | "all";
  isAnime?: boolean;
  page?: number;
}): Promise<{ items: MediaSummary[]; hasMore: boolean }> {
  const q = opts.query.trim();
  if (!q) return { items: [], hasMore: false };

  const endpoint =
    opts.mediaType === "movie"
      ? "/search/movie"
      : opts.mediaType === "series"
        ? "/search/tv"
        : "/search/multi";

  const data = await tmdbGet<TmdbListResponse>(endpoint, {
    query: q,
    language: tmdbLanguage,
    page: opts.page ?? 1,
  });
  if (!data?.results) return { items: [], hasMore: false };

  const items: MediaSummary[] = [];
  for (const row of data.results) {
    if (opts.mediaType === "all" && row.media_type !== "movie" && row.media_type !== "tv") {
      continue;
    }
    if (opts.isAnime) {
      const hasAnimGenre = Array.isArray(row.genre_ids) && row.genre_ids.includes(16);
      const origLang = (row.original_language ?? "").toLowerCase();
      const asianOrigin =
        origLang === "ja" ||
        origLang === "zh" ||
        origLang === "ko" ||
        (row.origin_country ?? []).some((c) => ["JP", "CN", "KR", "TW"].includes(c.toUpperCase()));
      if (!hasAnimGenre || !asianOrigin) continue;
    }
    const forced =
      opts.mediaType === "movie"
        ? "movie"
        : opts.mediaType === "series"
          ? "series"
          : undefined;
    const mapped = mapTmdbSummary(row, opts.idPrefix, forced, Boolean(opts.isAnime));
    if (mapped) items.push(mapped);
  }

  return {
    items,
    hasMore: (opts.page ?? 1) < (data.total_pages ?? 1),
  };
}

export function collectAnimeSearchTitles(identity: ResolvedTmdbIdentity): string[] {
  return dedupeStrings([
    identity.title,
    identity.originalTitle,
    ...identity.searchTitles,
  ]).filter((t) => t.length >= 2);
}

export async function resolveTmdbIdentity(
  idOrTitle: string,
  preferType: "movie" | "series" = "series",
): Promise<ResolvedTmdbIdentity | null> {
  let clean = idOrTitle.trim();
  let tmdbId: number | null = null;
  let mediaType: "movie" | "series" = preferType;

  const prefixMatch = /^(?:[a-z0-9_-]+:)?(movie|series|tv|anime):(\d+)$/i.exec(clean);
  if (prefixMatch && prefixMatch[1] && prefixMatch[2]) {
    mediaType = prefixMatch[1].toLowerCase() === "movie" ? "movie" : "series";
    tmdbId = Number.parseInt(prefixMatch[2], 10);
  } else if (/^tt\d+$/i.test(clean)) {
    const found = await tmdbGet<{
      movie_results?: TmdbListItem[];
      tv_results?: TmdbListItem[];
    }>(`/find/${clean}`, { external_source: "imdb_id", language: tmdbLanguage });
    const hit =
      preferType === "movie"
        ? (found?.movie_results?.[0] ?? found?.tv_results?.[0])
        : (found?.tv_results?.[0] ?? found?.movie_results?.[0]);
    if (hit) {
      tmdbId = hit.id;
      mediaType = hit.title ? "movie" : "series";
    }
  } else if (/^\d+$/.test(clean)) {
    tmdbId = Number.parseInt(clean, 10);
  } else {
    clean = clean.replace(/^tmdb:/i, "");
    const searchEndpoint = preferType === "movie" ? "/search/movie" : "/search/tv";
    const searched = await tmdbGet<TmdbListResponse>(searchEndpoint, {
      query: clean,
      language: tmdbLanguage,
      page: 1,
    });
    const list = searched?.results ?? [];
    let best = list[0];
    let bestScore = -1;
    for (const item of list) {
      const candidateTitle = item.title ?? item.name ?? "";
      const score = titleSimilarity(clean, candidateTitle);
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }
    if (best) tmdbId = best.id;
  }

  if (!tmdbId) return null;

  const path = mediaType === "movie" ? `/movie/${tmdbId}` : `/tv/${tmdbId}`;
  const [trRes, enData] = await Promise.all([
    tmdbGet<TmdbDetailRaw>(path, {
      language: tmdbLanguage,
      append_to_response: "external_ids,translations,alternative_titles",
    }),
    tmdbGet<TmdbDetailRaw>(path, { language: "en-US" }),
  ]);
  const trData = trRes ?? enData;
  if (!trData) return null;

  const title = trData.title ?? trData.name ?? enData?.title ?? enData?.name ?? "";
  const originalTitle =
    trData.original_title ?? trData.original_name ?? title;

  const candidates = [title, originalTitle, enData?.title ?? enData?.name ?? ""];
  for (const tr of trData.translations?.translations ?? []) {
    const tName = tr.data?.title ?? tr.data?.name;
    if (tName) candidates.push(tName);
  }
  const altItems =
    trData.alternative_titles?.titles ?? trData.alternative_titles?.results ?? [];
  for (const alt of altItems) {
    if (alt.title) candidates.push(alt.title);
  }

  const rawSeasons =
    trData.seasons && trData.seasons.length > 0 ? trData.seasons : (enData?.seasons ?? []);
  const seasons: SeasonSummary[] = rawSeasons
    .filter((s) => s.season_number > 0)
    .map((s) => ({
      id: String(s.season_number),
      season: s.season_number,
      title: s.name || (tmdbLanguage === "tr-TR" ? `${s.season_number}. Sezon` : `Season ${s.season_number}`),
      episodeCount: s.episode_count,
      poster: tmdbPoster(s.poster_path),
    }));

  const origLang = trData.original_language ?? enData?.original_language;
  const hasAnimGenre = (trData.genres ?? []).some((g) => g.id === 16);
  const isAsianAnimOrigin =
    origLang === "ja" ||
    origLang === "zh" ||
    origLang === "ko" ||
    (trData.origin_country ?? []).some((c) => ["JP", "CN", "KR", "TW"].includes(c.toUpperCase()));

  return {
    tmdbId,
    imdbId: trData.imdb_id ?? trData.external_ids?.imdb_id ?? undefined,
    mediaType,
    title,
    originalTitle,
    year: extractYear(trData.release_date ?? trData.first_air_date),
    poster: tmdbPoster(trData.poster_path),
    backdrop: tmdbBackdrop(trData.backdrop_path),
    synopsis: trData.overview || enData?.overview || undefined,
    genres: (trData.genres ?? []).map((g) => g.name).filter(Boolean),
    originalLanguage: origLang,
    isAnimation: hasAnimGenre,
    isAnime: hasAnimGenre && isAsianAnimOrigin,
    rating:
      typeof trData.vote_average === "number" && trData.vote_average > 0
        ? Math.round(trData.vote_average * 10) / 10
        : undefined,
    searchTitles: dedupeStrings(candidates),
    seasons,
  };
}

export async function tmdbGetSeasonEpisodes(
  tmdbId: number,
  seasonNumber: number,
  streamIdBuilder: (season: number, episode: number) => string,
): Promise<Episode[]> {
  let data = await tmdbGet<TmdbEpisodeListRaw>(
    `/tv/${tmdbId}/season/${seasonNumber}`,
    { language: tmdbLanguage },
  );
  if (!data?.episodes?.length) {
    data = await tmdbGet<TmdbEpisodeListRaw>(
      `/tv/${tmdbId}/season/${seasonNumber}`,
      { language: "en-US" },
    );
  }
  if (!data?.episodes) return [];

  return data.episodes.map((ep) => ({
    streamId: streamIdBuilder(ep.season_number, ep.episode_number),
    season: ep.season_number,
    episode: ep.episode_number,
    title: ep.name || (tmdbLanguage === "tr-TR" ? `${ep.episode_number}. Bölüm` : `Episode ${ep.episode_number}`),
    overview: ep.overview || undefined,
    thumbnail: tmdbPoster(ep.still_path),
    airDate: ep.air_date || undefined,
    tags: [],
  }));
}

export async function tmdbBuildMediaDetail(opts: {
  nativeId: string;
  preferType: "movie" | "series";
  isAnime?: boolean;
  streamIdBuilder: (
    identity: ResolvedTmdbIdentity,
    season: number,
    episode: number,
  ) => string;
}): Promise<MediaDetail | null> {
  const identity = await resolveTmdbIdentity(opts.nativeId, opts.preferType);
  if (!identity) return null;

  const externalIds: ExternalIds = {
    tmdb: identity.tmdbId,
    imdb: identity.imdbId,
  };

  if (identity.mediaType === "movie") {
    return {
      nativeId: opts.nativeId,
      type: "movie",
      isAnime: Boolean(opts.isAnime || identity.isAnime),
      title: identity.title,
      originalTitle: identity.originalTitle,
      year: identity.year,
      synopsis: identity.synopsis,
      poster: identity.poster,
      backdrop: identity.backdrop,
      genres: identity.genres,
      rating: identity.rating,
      externalIds,
      episodes: [
        {
          streamId: opts.streamIdBuilder(identity, 1, 1),
          season: 1,
          episode: 1,
          title: identity.title,
          tags: [],
        },
      ],
    };
  }

  const seasonNumbers =
    identity.seasons.length > 0
      ? identity.seasons.map((s) => s.season).filter((n) => n > 0)
      : [1];
  const episodes: Episode[] = [];
  const BATCH_SIZE = 8;
  for (let i = 0; i < seasonNumbers.length; i += BATCH_SIZE) {
    const chunk = seasonNumbers.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      chunk.map((sNum) =>
        tmdbGetSeasonEpisodes(
          identity.tmdbId,
          sNum,
          (s, e) => opts.streamIdBuilder(identity, s, e),
        ),
      ),
    );
    for (const epList of results) {
      episodes.push(...epList);
    }
  }
  episodes.sort((a, b) => a.season - b.season || a.episode - b.episode);

  return {
    nativeId: opts.nativeId,
    type: "series",
    isAnime: Boolean(opts.isAnime || identity.isAnime),
    title: identity.title,
    originalTitle: identity.originalTitle,
    year: identity.year,
    synopsis: identity.synopsis,
    poster: identity.poster,
    backdrop: identity.backdrop,
    genres: identity.genres,
    rating: identity.rating,
    externalIds,
    seasons: identity.seasons,
    episodes,
  };
}
