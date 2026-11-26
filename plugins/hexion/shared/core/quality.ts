import type {
  AudioType,
  StreamCandidate,
  StreamFlag,
  StreamKind,
  SubtitleTrack,
} from "vessel";

export function inferStreamKind(url: string, hint?: string): StreamKind {
  const h = (hint ?? "").toLowerCase();
  const u = url.toLowerCase();
  if (h === "embed") return "embed";
  if (h === "hls" || h === "m3u8" || u.includes(".m3u8")) return "hls";
  if (h === "dash" || u.includes(".mpd")) return "dash";
  if (h === "mpeg_ts" || h === "ts" || u.endsWith(".ts") || u.includes(".ts?")) {
    return "mpeg_ts";
  }
  if (h === "mkv" || u.includes(".mkv")) return "mkv";
  if (h === "webm" || u.includes(".webm")) return "webm";
  if (h === "mp4" || u.includes(".mp4")) return "mp4";
  return "auto";
}

export function getQualityScore(stream: StreamCandidate): number {
  const q = `${stream.quality ?? ""} ${stream.label ?? ""}`.toLowerCase();
  let score = 0;

  if (/\b(4k|2160p?|uhd)\b/.test(q)) score = 2160;
  else if (/\b(2k|1440p?|qhd)\b/.test(q)) score = 1440;
  else if (/\b(1080p?|fhd)\b/.test(q)) score = 1080;
  else if (/\b(720p?|hd)\b/.test(q)) score = 720;
  else if (/\b(540p?)\b/.test(q)) score = 540;
  else if (/\b(480p?|sd)\b/.test(q)) score = 480;
  else if (/\b(360p?)\b/.test(q)) score = 360;
  else if (/\b(240p?)\b/.test(q)) score = 240;

  if (score === 0 && stream.url) {
    const u = stream.url.toLowerCase();
    if (/[\/_.-](2160p?|4k)[\/_.-]/.test(u)) score = 2160;
    else if (/[\/_.-](1440p?|2k)[\/_.-]/.test(u)) score = 1440;
    else if (/[\/_.-](1080p?|fhd)[\/_.-]/.test(u)) score = 1080;
    else if (/[\/_.-](720p?|hd)[\/_.-]/.test(u)) score = 720;
    else if (/[\/_.-](480p?|sd)[\/_.-]/.test(u)) score = 480;
    else if (/[\/_.-](360p?)[\/_.-]/.test(u)) score = 360;
  }

  if (stream.kind === "mp4" && score > 0) {
    score += 1;
  }
  if (stream.kind === "embed" || stream.needsExtractor) {
    score -= 1000;
  }
  return score;
}

export function sortStreamsByQuality(
  streams: StreamCandidate[],
): StreamCandidate[] {
  if (streams.length === 0) return [];

  const deduped: StreamCandidate[] = [];
  const seen = new Set<string>();
  for (const s of streams) {
    if (!s.url) continue;
    if (seen.has(s.url)) continue;
    seen.add(s.url);
    deduped.push(s);
  }

  const sorted = deduped.slice().sort((a, b) => {
    const diff = getQualityScore(b) - getQualityScore(a);
    if (diff !== 0) return diff;
    return (b.priority ?? 0) - (a.priority ?? 0);
  });

  if (sorted.length > 0 && !sorted.some((s) => s.isDefault)) {
    const firstPlayable = sorted.find((s) => s.kind !== "embed" && !s.needsExtractor);
    if (firstPlayable) {
      firstPlayable.isDefault = true;
    }
  }

  return sorted;
}

export interface CreateStreamInput {
  url: string;
  label: string;
  kind?: StreamKind;
  quality?: string;
  language?: string;
  audioType?: AudioType;
  priority?: number;
  isDefault?: boolean;
  headers?: Record<string, string>;
  flags?: StreamFlag[];
  subtitles?: SubtitleTrack[];
  needsExtractor?: boolean;
}

export function createStream(input: CreateStreamInput): StreamCandidate {
  const kind = input.kind ?? inferStreamKind(input.url);
  const headers = input.headers ? { ...input.headers } : {};
  const flags = new Set<StreamFlag>(input.flags ?? []);

  if (Object.keys(headers).length > 0) {
    flags.add("requires_proxy");
  } else if (kind === "mp4" || kind === "mkv") {
    flags.add("direct");
  }
  if (input.audioType === "dub") flags.add("dubbed");
  if (input.audioType === "sub" || (input.subtitles?.length ?? 0) > 0) {
    flags.add("subtitled");
  }

  return {
    url: input.url,
    kind,
    quality: input.quality,
    label: input.label,
    language: input.language,
    audioType: input.audioType,
    priority: input.priority,
    isDefault: input.isDefault ?? false,
    flags: Array.from(flags),
    headers,
    needsExtractor: input.needsExtractor ?? false,
    subtitles: input.subtitles ?? [],
  };
}
