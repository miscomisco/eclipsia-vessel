import { http } from "vessel";
import type { HttpRequestOptions, HttpResponse } from "vessel";

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export const MOBILE_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

export const EXOPLAYER_USER_AGENT = "ExoPlayerLib/2.19.1";

/**
 * Returns true when an error originated from Vessel's interactive DomainPolicy gate.
 * Plugins MUST rethrow domain-blocked errors so the host UI prompts the user for permission.
 */
export function isDomainBlockedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return msg.includes("[VesselDomainBlockedError]");
}

export function rethrowIfDomainBlocked(err: unknown): void {
  if (isDomainBlockedError(err)) {
    throw err;
  }
}

export function buildHeaders(
  referer?: string,
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": DEFAULT_USER_AGENT,
    Accept: "*/*",
  };
  if (referer) {
    headers["Referer"] = referer;
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      headers[k] = v;
    }
  }
  return headers;
}

export async function safeRequest(
  url: string,
  opts?: HttpRequestOptions,
): Promise<HttpResponse | null> {
  try {
    return await http.get(url, {
      timeoutMs: opts?.timeoutMs ?? 10_000,
      followRedirects: opts?.followRedirects ?? true,
      headers: opts?.headers ?? { "User-Agent": DEFAULT_USER_AGENT },
    });
  } catch (err) {
    rethrowIfDomainBlocked(err);
    return null;
  }
}

export async function fetchText(
  url: string,
  opts?: HttpRequestOptions,
): Promise<string | null> {
  const res = await safeRequest(url, opts);
  if (!res || res.status < 200 || res.status >= 400) {
    return null;
  }
  return res.text();
}

export async function fetchTextAnyStatus(
  url: string,
  opts?: HttpRequestOptions,
): Promise<{ status: number; url: string; body: string } | null> {
  const res = await safeRequest(url, opts);
  if (!res) return null;
  return { status: res.status, url: res.url, body: res.text() };
}

export async function fetchJson<T = unknown>(
  url: string,
  opts?: HttpRequestOptions,
): Promise<T | null> {
  const res = await safeRequest(url, {
    ...opts,
    headers: {
      Accept: "application/json, text/plain, */*",
      "User-Agent": DEFAULT_USER_AGENT,
      ...(opts?.headers ?? {}),
    },
  });
  if (!res || res.status < 200 || res.status >= 300) {
    return null;
  }
  try {
    return res.json<T>();
  } catch {
    return null;
  }
}

export async function postForm(
  url: string,
  data: Record<string, string>,
  opts?: HttpRequestOptions,
): Promise<HttpResponse | null> {
  const body = new URLSearchParams(data).toString();
  try {
    return await http.post(url, body, {
      timeoutMs: opts?.timeoutMs ?? 10_000,
      followRedirects: opts?.followRedirects ?? true,
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        ...(opts?.headers ?? {}),
      },
    });
  } catch (err) {
    rethrowIfDomainBlocked(err);
    return null;
  }
}

export async function postJson<T = unknown>(
  url: string,
  payload: Record<string, unknown>,
  opts?: HttpRequestOptions,
): Promise<T | null> {
  try {
    const res = await http.post(url, payload, {
      timeoutMs: opts?.timeoutMs ?? 10_000,
      followRedirects: opts?.followRedirects ?? true,
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(opts?.headers ?? {}),
      },
    });
    if (res.status < 200 || res.status >= 300) return null;
    try {
      return res.json<T>();
    } catch {
      return null;
    }
  } catch (err) {
    rethrowIfDomainBlocked(err);
    return null;
  }
}

/**
 * Lightweight playability probe for fragile/dead HLS playlists (such as FilmModu storage).
 */
export async function probeUrlReachable(
  url: string,
  headers?: Record<string, string>,
  timeoutMs = 3_500,
): Promise<boolean> {
  try {
    const res = await http.request({
      method: "GET",
      url,
      timeoutMs,
      headers: {
        Range: "bytes=0-1024",
        "User-Agent": DEFAULT_USER_AGENT,
        ...(headers ?? {}),
      },
    });
    return res.status >= 200 && res.status < 400;
  } catch (err) {
    rethrowIfDomainBlocked(err);
    return false;
  }
}
