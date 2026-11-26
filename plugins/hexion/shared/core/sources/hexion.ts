import { crypto, html, storage } from "vessel";
import type { HtmlDocument, StreamCandidate } from "vessel";
import {
  fetchJson,
  fetchText,
  isDomainBlockedError,
  rethrowIfDomainBlocked,
} from "../http.ts";
import { createStream, inferStreamKind } from "../quality.ts";
import { tmdbGet } from "../tmdb.ts";

export const HEXION_DEFAULT_BASE = "https://4khdhub.one";

const PROVIDER = "4kHdHub";
const MOBILE_UAS = [
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
];
const PLAY_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 15_000;

export interface HexionQuery {
  id: string;
  isSeries: boolean;
  season: number;
  episode: number;
}

export interface HexionSettings {
  sortBySize: boolean;
  enable4K: boolean;
  enable1080p: boolean;
  max4K: number;
  max1080p: number;
  maxFSLv2: number;
  maxFSL: number;
  maxPixelDrain: number;
}

export interface HexionEntry {
  res: string;
  host: string;
  mb: number | null;
  stream: StreamCandidate;
}

interface Ctx {
  base: string;
  ua: string;
}

interface Info {
  title: string;
  year: string;
  imdbId: string;
  runtime: number | null;
}

interface Link {
  href: string;
  text: string;
}

interface Item {
  links: Link[];
  context: string;
}

interface TmdbRaw {
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  imdb_id?: string | null;
  runtime?: number | null;
  episode_run_time?: number[];
  external_ids?: { imdb_id?: string | null };
}

interface WpPost {
  link?: string;
}

interface ProbeResult {
  stop: boolean;
  url: string;
}

function compact(parts: Array<string | false | null | undefined>): string[] {
  const out: string[] = [];
  for (const p of parts) {
    if (p) out.push(p);
  }
  return out;
}

function pad(n: number): string {
  const s = String(n);
  return s.length < 2 ? `0${s}` : s;
}

function clean(value: string): string {
  return String(value).replace(/\s+/g, " ").trim();
}

export function decode64(text: string): string {
  let s = String(text).replace(/[\t\n\f\r ]/g, "");
  if (s.length % 4 === 0) s = s.replace(/={1,2}$/, "");
  if (s.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(s)) throw new Error("base64");
  while (s.length % 4 !== 0) s += "=";
  return crypto.base64Decode(s);
}

export function rot13(value: string): string {
  return String(value).replace(/[a-zA-Z]/g, (c) => {
    const code = c.charCodeAt(0) + 13;
    const limit = c <= "Z" ? 90 : 122;
    return String.fromCharCode(code <= limit ? code : code - 26);
  });
}

export function unwrapPayload(page: string): string | null {
  const m = /['"]o['"]\s*,\s*['"]([^'"]+)['"]/.exec(page);
  if (!m || !m[1]) return null;
  const payload = JSON.parse(decode64(rot13(decode64(decode64(m[1]))))) as {
    o?: string;
  };
  return payload.o ? decode64(payload.o).trim() : null;
}

function dots(rawPath: string): string {
  let path = rawPath;
  let tail = "";
  const cut = path.search(/[?#]/);
  if (cut >= 0) {
    tail = path.substring(cut);
    path = path.substring(0, cut);
  }
  const segs = path.split("/");
  const out: string[] = [];
  for (let i = 1; i < segs.length; i++) {
    const last = i === segs.length - 1;
    const seg = segs[i] ?? "";
    if (seg === "..") {
      if (out.length) out.pop();
      if (last) out.push("");
    } else if (seg === ".") {
      if (last) out.push("");
    } else {
      out.push(seg);
    }
  }
  return `/${out.join("/")}${tail}`.replace(/ /g, "%20");
}

function resolveUrl(href: string, base: string): string {
  const m = /^([a-zA-Z][a-zA-Z0-9+.\-]*:)\/\/([^\/?#]*)([^?#]*)(\?[^#]*)?/.exec(base);
  if (!m) return "";
  if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(href)) return href;
  const scheme = m[1] ?? "";
  const head = `${scheme}//${m[2] ?? ""}`;
  const path = m[3] || "/";
  if (href.substring(0, 2) === "//") return scheme + href;
  if (href.charAt(0) === "#") return head + path + (m[4] ?? "") + href;
  if (href.charAt(0) === "?") return head + path + href;
  if (href.charAt(0) === "/") return head + dots(href);
  const dir = path.substring(0, path.lastIndexOf("/") + 1);
  return head + dots(dir + href);
}

export function absolute(href: string, base: string): string {
  if (!href) return "";
  if (/^https?:\/\//i.test(href)) return href;
  return resolveUrl(String(href).replace(/&amp;/g, "&"), base);
}

function hostOf(url: string): string {
  const m = /^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\/(?:[^\/?#@]*@)?([^\/?#:]*)/.exec(
    String(url).trim(),
  );
  return m && m[1] ? m[1].toLowerCase() : "";
}

function normalize(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/\[[^\]]*]/g, " ")
    .replace(/\b(the|a|an|directors?|cut)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function words(value: string): string[] {
  return normalize(value)
    .split(" ")
    .filter((w) => w.length > 0);
}

function titleScore(expected: string, candidate: string): number {
  const want = words(expected);
  if (!want.length) return 0;
  const have = new Set(words(candidate));
  let hits = 0;
  for (const w of want) {
    if (have.has(w)) hits++;
  }
  return hits / want.length;
}

function parseSizeMB(size: string): number | null {
  if (!size) return null;
  const m = /(\d+\.?\d*)\s*(GB|MB)/i.exec(size);
  if (!m || !m[1] || !m[2]) return null;
  return m[2].toUpperCase() === "GB" ? parseFloat(m[1]) * 1024 : parseFloat(m[1]);
}

function bitrate(sizeMB: number | null, runtime: number | null): string | null {
  if (!sizeMB || !runtime) return null;
  return `${((sizeMB * 1024 * 1024 * 8) / (runtime * 60) / 1000000).toFixed(1)} Mbps`;
}

function qualityOf(text: string): string {
  const m = /(2160|1080|720|480)p|(4K|UHD)/i.exec(text);
  if (!m) return "1080P";
  const v = (m[1] ?? m[2] ?? "").toUpperCase();
  return v === "4K" || v === "UHD" ? "2160P" : `${v}P`;
}

function sizeOf(text: string): string {
  const m = /(?:^|[\s>])(\d+\.?\d*)\s*(GB|MB)\b/i.exec(text);
  return m ? `${m[1] ?? ""} ${m[2] ?? ""}` : "";
}

function languageOf(hay: string): string {
  const out: string[] = [];
  if (/\b(?:english|eng)\b/.test(hay)) out.push("English");
  if (/\bhindi\b/.test(hay)) out.push("Hindi");
  if (/\btamil\b/.test(hay)) out.push("Tamil");
  if (/\btelugu\b/.test(hay)) out.push("Telugu");
  return out.join(" \u2022 ");
}

function hdrOf(hay: string): string {
  if (/\b(?:hdr10\+|hdr10p)\b/.test(hay)) return "HDR10+";
  if (/\bhdr10\b/.test(hay)) return "HDR10";
  if (/\bhdr\b/.test(hay)) return "HDR";
  if (/\bsdr\b/.test(hay)) return "SDR";
  return "";
}

function audioOf(hay: string): string {
  let label = "DDP 5.1";
  if (/ddp.?51.*truehd.*71|truehd.*71.*ddp.?51/i.test(hay)) label = "DDP 5.1 + TrueHD 7.1";
  else if (/ddp.?51.*ddp.?71|ddp.?71.*ddp.?51/i.test(hay)) label = "DDP 5.1 + DDP 7.1";
  else if (/ddp.?51.*aac.?71|aac.?71.*ddp.?51/i.test(hay)) label = "DDP 5.1 + AAC 7.1";
  else if (/ddp.?51/i.test(hay)) label = "DDP 5.1";
  else if (/truehd/i.test(hay)) label = "TrueHD 7.1";
  else if (/aac.*71|71.*aac/i.test(hay)) label = "AAC 7.1";
  else if (/aac/i.test(hay)) label = "AAC 5.1";
  return /\batmos\b/.test(hay) ? `${label} Atmos` : label;
}

function headersFor(ctx: Ctx, referer?: string): Record<string, string> {
  return {
    "User-Agent": ctx.ua,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: referer || `${ctx.base}/`,
  };
}

function getText(ctx: Ctx, url: string, referer?: string): Promise<string | null> {
  return fetchText(url, {
    headers: headersFor(ctx, referer),
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
}

function getJson<T>(ctx: Ctx, url: string): Promise<T | null> {
  return fetchJson<T>(url, {
    headers: headersFor(ctx),
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
}

function toEntry(
  ctx: Ctx,
  filename: string,
  host: string,
  url: string,
  res: string,
  referer: string,
  size: string,
  runtime: number | null,
): HexionEntry {
  const encoded = url.replace(/ /g, "%20");
  const hay = `${String(filename || "")} ${host} ${encoded}`.toLowerCase();
  const remux = /\bremux\b/.test(hay);
  let source = "WEB-DL";
  if (remux || /\bblu[-\s]?ray\b/.test(hay)) source = "Blu-ray";
  else if (/\b(?:webrip|hdrip)\b/.test(hay)) source = "WEB-Rip";
  const hdr = hdrOf(hay);
  const main = compact([PROVIDER, res, size]).join(" \u2022 ");
  const detail = compact([
    languageOf(hay),
    compact([
      source,
      remux && "REMUX",
      /\bimax\b/.test(hay) && "IMAX",
      host,
      bitrate(parseSizeMB(size), runtime),
    ]).join(" \u2022 "),
    compact([
      /\b10bit\b/.test(hay) && "10Bit",
      /\b(?:dv|dolby\s*vision)\b/.test(hay) && "DV",
      hdr,
      /\b(?:hevc|x265|265)\b/.test(hay) || res === "2160P" ? "H.265" : "H.264",
      audioOf(hay),
    ]).join(" \u2022 "),
  ]).join(" | ");
  return {
    res,
    host,
    mb: parseSizeMB(size),
    stream: createStream({
      url: encoded,
      label: detail ? `${main} | ${detail}` : main,
      kind: inferStreamKind(encoded),
      quality: res.toLowerCase(),
      headers: { "User-Agent": PLAY_UA, Referer: referer || `${ctx.base}/` },
      flags: hdr && hdr !== "SDR" ? ["hdr"] : [],
    }),
  };
}

async function tmdbInfo(q: HexionQuery): Promise<Info> {
  const info: Info = { title: "", year: "", imdbId: "", runtime: null };
  const d = q.isSeries
    ? await tmdbGet<TmdbRaw>(`/tv/${q.id}`, {
        language: "en-US",
        append_to_response: "external_ids",
      })
    : await tmdbGet<TmdbRaw>(`/movie/${q.id}`, { language: "en-US" });
  if (!d) return info;
  if (q.isSeries) {
    info.title = d.name ?? "";
    info.year = (d.first_air_date ?? "").slice(0, 4);
    info.imdbId = d.external_ids?.imdb_id ?? "";
    info.runtime = d.episode_run_time?.[0] ?? null;
  } else {
    info.title = d.title ?? "";
    info.year = (d.release_date ?? "").slice(0, 4);
    info.imdbId = d.imdb_id ?? "";
    info.runtime = d.runtime ?? null;
  }
  return info;
}

function searchTerm(info: Info, q: HexionQuery): string {
  if (q.isSeries && q.season) return `${info.title} Season ${q.season}`;
  return `${info.title} ${info.year || ""}`.trim();
}

function allText(node: { select(css: string): Array<{ text(): string }> }, css: string): string {
  return node
    .select(css)
    .map((e) => e.text())
    .join("");
}

function bestCard(page: string | null, info: Info, q: HexionQuery, base: string): string | null {
  if (!page) return null;
  let best: { url: string; score: number } | null = null;
  for (const card of html.parse(page).select(".movie-card")) {
    const title = allText(card, ".movie-card-title").trim();
    const format = allText(card, ".movie-card-format").trim();
    const href = card.attr("href") || card.selectOne("a[href]")?.attr("href") || "";
    if (!title || !href) continue;
    if (q.isSeries && !/series/i.test(format)) continue;
    if (!q.isSeries && !/movies?/i.test(format)) continue;
    const ym = allText(card, ".movie-card-meta").match(/\b(19|20)\d{2}\b/);
    const cardYear = ym ? Number(ym[0]) : null;
    let score = titleScore(info.title, title);
    if (info.year && cardYear === Number(info.year)) score += 0.35;
    else if (info.year && cardYear && Math.abs(cardYear - Number(info.year)) > 1) score -= 0.5;
    if (q.isSeries && q.season) {
      const sm = title.match(/(?:season\s*|s)(\d+)/i);
      if (sm && Number(sm[1]) === Number(q.season)) score += 0.4;
      else if (sm) score -= 0.6;
    }
    if (!best || score > best.score) best = { url: absolute(href, base), score };
  }
  return best !== null && best.score >= 0.5 ? best.url : null;
}

async function findPage(ctx: Ctx, info: Info, q: HexionQuery): Promise<string | null> {
  const [posts, page] = await Promise.all([
    info.imdbId
      ? getJson<WpPost[]>(
          ctx,
          `${ctx.base}/wp-json/wp/v2/posts?search=${encodeURIComponent(info.imdbId)}`,
        )
      : Promise.resolve(null),
    getText(ctx, `${ctx.base}/?s=${encodeURIComponent(searchTerm(info, q))}`),
  ]);
  const first = posts && posts.length > 0 ? posts[0] : null;
  if (first) return first.link || null;
  return bestCard(page, info, q, ctx.base);
}

function linksOf(node: { select(css: string): Array<{ attr(n: string): string | null; text(): string }> }): Link[] {
  const links: Link[] = [];
  for (const a of node.select("a")) {
    const href = a.attr("href");
    if (href !== null) links.push({ href, text: a.text() });
  }
  return links;
}

function itemsOf(root: HtmlDocument, q: HexionQuery): Item[] {
  const items: Item[] = [];
  if (q.isSeries) {
    const code = `S${pad(q.season)}`;
    const mark = `Episode-${pad(q.episode)}`;
    for (const section of root.select(".episode-item")) {
      const heading = section
        .select(".episode-title")
        .map((e) => e.text())
        .join("");
      if (heading.indexOf(code) < 0) continue;
      for (const dl of section.select(".episode-download-item")) {
        const text = dl.text();
        if (text.indexOf(mark) >= 0) items.push({ links: linksOf(dl), context: text });
      }
    }
    return items;
  }
  for (const dl of root.select(".download-item")) {
    items.push({ links: linksOf(dl), context: dl.text() });
  }
  return items;
}

async function unwrap(ctx: Ctx, url: string): Promise<string> {
  if (/hubcloud|hubdrive/i.test(url)) return url;
  const page = await getText(ctx, url);
  if (!page) return url;
  try {
    return unwrapPayload(page) ?? url;
  } catch {
    return url;
  }
}

function cloudOnPage(page: string | null, base: string): string {
  if (!page) return "";
  for (const a of html.parse(page).select("a")) {
    const href = a.attr("href");
    if (href === null) continue;
    if (/hubcloud/i.test(`${a.text()} ${href}`)) return href ? absolute(href, base) : "";
  }
  return "";
}

async function probe(ctx: Ctx, link: Link, pageUrl: string): Promise<ProbeResult> {
  if (!link.href) return { stop: false, url: "" };
  const abs = absolute(link.href, pageUrl);
  if (!abs) return { stop: false, url: "" };
  if (/hubcloud/i.test(link.text) || /hubcloud/i.test(link.href)) {
    return { stop: true, url: await unwrap(ctx, abs) };
  }
  if (/hubdrive/i.test(link.text) || /hubdrive/i.test(link.href)) {
    const drive = await unwrap(ctx, abs);
    const page = await getText(ctx, drive, pageUrl);
    return { stop: false, url: cloudOnPage(page, drive) };
  }
  return { stop: false, url: "" };
}

async function findCloud(ctx: Ctx, links: Link[], pageUrl: string): Promise<string> {
  const found = await Promise.all(links.map((l) => probe(ctx, l, pageUrl)));
  for (const f of found) {
    if (f.stop || f.url) return f.url;
  }
  return "";
}

function hasUrl(entries: HexionEntry[], url: string): boolean {
  return entries.some((e) => e.stream.url === url);
}

function collect(
  ctx: Ctx,
  page: string,
  pageUrl: string,
  res: string,
  initialSize: string,
  runtime: number | null,
): HexionEntry[] {
  const out: HexionEntry[] = [];
  let size = initialSize;
  const root = html.parse(page);
  let head = clean(
    root
      .select("div.card-header")
      .map((e) => e.text())
      .join(""),
  );
  if (!head) {
    head = root
      .select("title")
      .map((e) => e.text())
      .join("")
      .trim();
  }
  const filename = head.replace(/\.(mkv|mp4|avi|rar|zip)$/i, "");
  const found =
    /<td[^>]*>\s*File\s*Size\s*:\s*<\/td>\s*<td[^>]*>\s*([\d\.]+\s*[MGBtbi]+)\s*<\/td>/i.exec(page) ||
    /Size\s*:\s*<\/strong>\s*([\d\.]+\s*[MGBtbi]+)/i.exec(page);
  if (found && found[1]) size = found[1].trim();
  for (const a of root.select("a")) {
    const href = a.attr("href");
    if (!href || href.indexOf("javascript:") === 0) continue;
    const abs = href.replace(/&amp;/g, "&");
    if (/\.zip|\.rar/.test(abs)) continue;
    const host = hostOf(abs);
    if (host.length < 1) continue;
    if (
      !/\.r2\.cloudflarestorage\.com$|\.r2\.dev$|^cdn\.fsl-buckets\.life$|\.fsl-buckets\.life$/.test(
        host,
      )
    ) {
      continue;
    }
    if (!hasUrl(out, abs)) out.push(toEntry(ctx, filename, "FSL-v2", abs, res, pageUrl, size, runtime));
  }
  const pxl =
    /var\s+pxl\s*=\s*["']https?:\/\/pixeldrain\.[a-z0-9.-]+\/u\/([A-Za-z0-9_-]+)["']/i.exec(page) ||
    /href=["']https?:\/\/pixeldrain\.[a-z0-9.-]+\/u\/([A-Za-z0-9_-]+)["']/i.exec(page);
  if (pxl && pxl[1]) {
    const drain = `https://pixeldrain.com/api/file/${pxl[1]}`;
    if (!hasUrl(out, drain)) {
      out.push(toEntry(ctx, filename, "PixelDrain", drain, res, pageUrl, size, runtime));
    }
  }
  return out;
}

function redirectOf(page: string): string {
  const m =
    /var\s+url\s*=\s*['"]([^'"]+)['"]/.exec(page) ||
    /id=["']download["'][^>]*href=["']([^'"]+)["']/i.exec(page) ||
    /href=["']([^'"]+)["'][^>]*id=["']download["']/i.exec(page);
  return m && m[1] ? m[1] : "";
}

async function hubEntries(
  ctx: Ctx,
  cloudUrl: string,
  res: string,
  size: string,
  runtime: number | null,
): Promise<HexionEntry[]> {
  const first = await getText(ctx, cloudUrl, `${ctx.base}/`);
  if (!first) return [];
  const redirect = redirectOf(first);
  if (!redirect) return collect(ctx, first, cloudUrl, res, size, runtime);
  const next = absolute(redirect.replace(/&amp;/g, "&"), cloudUrl);
  const second = await getText(ctx, next, cloudUrl);
  return second ? collect(ctx, second, next, res, size, runtime) : [];
}

async function resolveItem(
  ctx: Ctx,
  item: Item,
  pageUrl: string,
  runtime: number | null,
): Promise<HexionEntry[]> {
  const text = clean(item.context);
  const res = qualityOf(text);
  if (res === "480P") return [];
  const size = sizeOf(text);
  try {
    const cloud = await findCloud(ctx, item.links, pageUrl);
    return cloud ? await hubEntries(ctx, cloud, res, size, runtime) : [];
  } catch (err) {
    rethrowIfDomainBlocked(err);
    return [];
  }
}

async function gather(
  ctx: Ctx,
  pageUrl: string,
  q: HexionQuery,
  runtime: number | null,
): Promise<HexionEntry[]> {
  const page = await getText(ctx, pageUrl);
  if (!page) return [];
  const items = itemsOf(html.parse(page), q);
  const settled = await Promise.allSettled(
    items.map((item) => resolveItem(ctx, item, pageUrl, runtime)),
  );
  const out: HexionEntry[] = [];
  let blocked: unknown = null;
  for (const r of settled) {
    if (r.status === "fulfilled") out.push(...r.value);
    else if (isDomainBlockedError(r.reason)) blocked = blocked ?? r.reason;
  }
  if (blocked && out.length === 0) throw blocked;
  return out;
}

function weight(res: string): number {
  if (res === "2160P") return 4;
  if (res === "1080P") return 3;
  if (res === "720P") return 2;
  return 1;
}

function resolutionLimit(entry: HexionEntry, set: HexionSettings): number {
  if (entry.res === "2160P") return set.max4K;
  if (entry.res === "1080P") return set.max1080p;
  return Infinity;
}

function hostLimit(host: string, set: HexionSettings): number {
  if (host === "FSL-v2") return set.maxFSLv2;
  if (host === "FSL") return set.maxFSL;
  if (host === "PixelDrain") return set.maxPixelDrain;
  return Infinity;
}

export function rankEntries(entries: HexionEntry[], set: HexionSettings): StreamCandidate[] {
  const kept: Array<{ e: HexionEntry; i: number }> = [];
  entries.forEach((e, i) => {
    if (e.res === "2160P" && !set.enable4K) return;
    if (e.res === "1080P" && !set.enable1080p) return;
    kept.push({ e, i });
  });
  kept.sort((a, b) => {
    let d = 0;
    if (!set.sortBySize) d = weight(b.e.res) - weight(a.e.res);
    if (d === 0) d = (b.e.mb ?? 0) - (a.e.mb ?? 0);
    return d !== 0 ? d : a.i - b.i;
  });
  const seenRes: Record<string, number> = {};
  const byRes: HexionEntry[] = [];
  for (const { e } of kept) {
    const limit = resolutionLimit(e, set);
    if (limit !== Infinity) {
      seenRes[e.res] = (seenRes[e.res] ?? 0) + 1;
      if ((seenRes[e.res] ?? 0) > limit) continue;
    }
    byRes.push(e);
  }
  const seenHost: Record<string, number> = {};
  const seenUrl = new Set<string>();
  const out: HexionEntry[] = [];
  for (const e of byRes) {
    const limit = hostLimit(e.host, set);
    if (limit !== Infinity) {
      const key = `${e.host}:${e.res}`;
      seenHost[key] = (seenHost[key] ?? 0) + 1;
      if ((seenHost[key] ?? 0) > limit) continue;
    }
    if (!e.stream.url || seenUrl.has(e.stream.url)) continue;
    seenUrl.add(e.stream.url);
    out.push(e);
  }
  return out.map((entry, index) => ({
    ...entry.stream,
    priority: 1000 - index,
    isDefault: index === 0,
  }));
}

async function readToggle(key: string, fallback: boolean): Promise<boolean> {
  try {
    const v = await storage.getSetting<boolean | string | number>(key);
    if (v === undefined || v === null) return fallback;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    const norm = String(v).trim().toLowerCase();
    if (norm === "true" || norm === "1" || norm === "on" || norm === "yes") return true;
    if (norm === "false" || norm === "0" || norm === "off" || norm === "no") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

async function readCap(key: string): Promise<number> {
  try {
    const v = await storage.getSetting<string | number>(key);
    if (v === null || v === undefined || v === "" || v === "unlimited") return Infinity;
    const n = Number.parseInt(String(v), 10);
    return Number.isNaN(n) || n <= 0 ? Infinity : n;
  } catch {
    return Infinity;
  }
}

export async function readHexionSettings(): Promise<HexionSettings> {
  const [sortBySize, enable4K, enable1080p, max4K, max1080p, maxFSLv2, maxFSL, maxPixelDrain] =
    await Promise.all([
      readToggle("sortBySize", false),
      readToggle("enable4K", true),
      readToggle("enable1080p", true),
      readCap("max4K"),
      readCap("max1080p"),
      readCap("maxFSLv2"),
      readCap("maxFSL"),
      readCap("maxPixelDrain"),
    ]);
  return { sortBySize, enable4K, enable1080p, max4K, max1080p, maxFSLv2, maxFSL, maxPixelDrain };
}

export async function resolveHexionBase(): Promise<string> {
  try {
    const v = await storage.getSetting<string>("mirrorUrl");
    if (typeof v === "string" && /^https?:\/\//i.test(v.trim())) {
      return v.trim().replace(/\/+$/, "");
    }
  } catch {
    return HEXION_DEFAULT_BASE;
  }
  return HEXION_DEFAULT_BASE;
}

export async function resolveHexionStreams(
  q: HexionQuery,
  base: string,
): Promise<StreamCandidate[]> {
  const ua = MOBILE_UAS[Math.floor(Math.random() * MOBILE_UAS.length)] ?? PLAY_UA;
  const ctx: Ctx = { base, ua };
  const info = await tmdbInfo(q);
  if (!info.title) return [];
  const pageUrl = await findPage(ctx, info, q);
  if (!pageUrl) return [];
  const entries = await gather(ctx, pageUrl, q, info.runtime);
  return rankEntries(entries, await readHexionSettings());
}
