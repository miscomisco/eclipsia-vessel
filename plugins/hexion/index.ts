import { definePlugin } from "vessel";
import type { StreamResult } from "vessel";
import { rethrowIfDomainBlocked } from "./shared/core/http.ts";
import { buildTmdbPluginScaffold, parseRouteId } from "./shared/core/plugin-helpers.ts";
import { resolveHexionBase, resolveHexionStreams } from "./shared/core/sources/hexion.ts";
import { resolveTmdbIdentity, setTmdbLanguage } from "./shared/core/tmdb.ts";

const ID_PREFIX = "hexion";

setTmdbLanguage("en-US");

const scaffold = buildTmdbPluginScaffold({
  idPrefix: ID_PREFIX,
  mediaTypes: ["movie", "series"],
  movieSectionTitle: "Popular Movies",
  seriesSectionTitle: "Popular Shows",
});

export default definePlugin({
  ...scaffold,

  async getStreams(streamId: string): Promise<StreamResult> {
    try {
      const parsed = parseRouteId(streamId);
      if (parsed.mediaType === "live") return { streams: [] };
      let isSeries = parsed.mediaType === "series";
      let tmdbId = parsed.id;
      if (!/^\d+$/.test(tmdbId)) {
        const identity = await resolveTmdbIdentity(tmdbId, isSeries ? "series" : "movie");
        if (!identity) return { streams: [] };
        tmdbId = String(identity.tmdbId);
        isSeries = identity.mediaType === "series";
      }
      const base = await resolveHexionBase();
      const streams = await resolveHexionStreams(
        { id: tmdbId, isSeries, season: parsed.season, episode: parsed.episode },
        base,
      );
      return { streams };
    } catch (err) {
      rethrowIfDomainBlocked(err);
      return { streams: [] };
    }
  },
});
