import type { MfdsListResponse } from "./types";

const BASE = "https://apis.data.go.kr/1471000";
const PAGE_SIZE = 500;
const PAGE_DELAY_MS = 200;

async function callWithRetry<T>(fn: () => Promise<T>, maxAttempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      const retriable = /\b(429|500|502|503|504|UNAVAILABLE|ETIMEDOUT|ECONNRESET|fetch failed)\b/.test(msg);
      if (!retriable || attempt === maxAttempts) throw e;
      const backoff = Math.min(30_000, 1_500 * 2 ** (attempt - 1));
      console.log(`    · retry ${attempt}/${maxAttempts - 1} after ${backoff}ms (${msg.slice(0, 80)})`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

async function fetchPage<T>(
  service: string,
  operation: string,
  key: string,
  pageNo: number,
): Promise<MfdsListResponse<T>> {
  const url = `${BASE}/${service}/${operation}?serviceKey=${encodeURIComponent(key)}&pageNo=${pageNo}&numOfRows=${PAGE_SIZE}&type=json`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${service}/${operation} page ${pageNo}`);
  const text = await res.text();
  if (text.startsWith("<") || text.includes("API not found") || text.includes("인증키")) {
    throw new Error(`Non-JSON response from ${service}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text) as MfdsListResponse<T>;
}

export async function fetchAllPages<T>(
  service: string,
  operation: string,
  opts: { label?: string; onProgress?: (loaded: number, total: number) => void } = {},
): Promise<T[]> {
  const key = process.env.MFDS_API_KEY;
  if (!key) throw new Error("MFDS_API_KEY not set in environment");

  const label = opts.label ?? `${service}/${operation}`;
  const all: T[] = [];
  let pageNo = 1;
  let total = Infinity;

  while (all.length < total) {
    const resp = await callWithRetry(() => fetchPage<T>(service, operation, key, pageNo));
    if (resp.header.resultCode !== "00") {
      throw new Error(`${label} non-OK result: ${resp.header.resultCode} ${resp.header.resultMsg}`);
    }
    total = resp.body.totalCount;
    const items = resp.body.items ?? [];
    all.push(...items);
    opts.onProgress?.(all.length, total);
    if (all.length >= total) break;
    // F18: total 미달인데 페이지가 0건 → 페이지네이션 불완전(API 이상). 부분 데이터로 진행하면
    // ingest 가 완전한 MFDS 데이터를 부분 데이터로 교체해 소실되므로, 조용한 break 대신 throw.
    if (items.length === 0) {
      throw new Error(`${label} pagination incomplete: ${all.length}/${total} 수집 후 page ${pageNo} 가 0건 반환 — 부분 데이터 방지 위해 중단`);
    }
    pageNo++;
    if (PAGE_DELAY_MS > 0) await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
  }

  return all;
}
