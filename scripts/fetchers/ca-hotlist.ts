import { randomUUID } from "node:crypto";
import { loadEnv } from "../crawlers/env";
loadEnv();
import { readRows, writeRows, updateMeta } from "../../lib/json-store";

// Health Canada — Cosmetic Ingredient Hotlist (List of Prohibited and Restricted Cosmetic Ingredients).
// canada.ca 도메인은 Imperva WAF 로 한국/datacenter IP 차단. 따라서 1안 (직접 fetch)
// 실패 시 자동으로 archive.org Wayback Machine raw mode 로 fallback.
//
// Wayback Machine API 사용:
//   1) https://archive.org/wayback/available?url=... → 가장 최근 snapshot URL
//   2) snapshot URL 에 "id_" 플래그 삽입 → raw HTML (archive.org wrapper 제거)
//
// 매년 갱신되는 정부 자료라 "최근 archive 시점 데이터" 한계 있지만 차단 우회 유일한 방법.
// archive.org 가 자체적으로 매주 ~매월 페이지를 자동 archive 함.

const SOURCE_DOC = "Health Canada Cosmetic Ingredient Hotlist";
const ORIGINAL_URL = "https://www.canada.ca/en/health-canada/services/consumer-product-safety/cosmetics/cosmetic-ingredient-hotlist-prohibited-restricted-ingredients/hotlist.html";
const WAYBACK_API = "https://archive.org/wayback/available";

interface IngredientRow {
  id: string;
  inci_name: string;
  korean_name: string | null;
  chinese_name: string | null;
  japanese_name: string | null;
  cas_no: string | null;
  synonyms: string[];
  description: string | null;
  function_category: string | null;
  function_description: string | null;
}

interface RegulationRow {
  ingredient_id: string;
  country_code: string;
  status: string;
  max_concentration: number | null;
  concentration_unit: string;
  product_categories: string[];
  conditions: string | null;
  source_url: string | null;
  source_document: string;
  source_version: string | null;
  source_priority: number;
  last_verified_at: string;
  confidence_score: number;
  override_note: string | null;
}

interface HotlistEntry {
  name: string;
  cas: string | null;
  conditions: string | null;
  status: "banned" | "restricted";
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ");
}
function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

async function fetchHtml(): Promise<{ html: string; via: string; archivedAt: string | null }> {
  // 1안: canada.ca 직접
  try {
    const res = await fetch(ORIGINAL_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0.0.0", "Accept-Language": "en-CA,en;q=0.9" },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) {
      const html = await res.text();
      if (html.length > 50_000 && /tbl1|Prohibited/.test(html)) {
        return { html, via: "canada.ca direct", archivedAt: null };
      }
    }
  } catch {
    // 차단/timeout — fallback
  }

  // 2안: Wayback Machine
  console.log("  canada.ca 직접 차단/실패 → archive.org Wayback Machine 우회");
  // Wayback API 는 url= 뒤에 raw URL 그대로 받음 (host 부분 encode 시 매칭 실패).
  const lookupRes = await fetch(`${WAYBACK_API}?url=${ORIGINAL_URL.replace(/^https?:\/\//, "")}`, {
    headers: { "User-Agent": "Mozilla/5.0 Chrome/125.0.0.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!lookupRes.ok) throw new Error(`Wayback lookup failed: HTTP ${lookupRes.status}`);
  const lookup = await lookupRes.json() as { archived_snapshots?: { closest?: { url?: string; timestamp?: string } } };
  const snapshotUrl = lookup.archived_snapshots?.closest?.url;
  const timestamp = lookup.archived_snapshots?.closest?.timestamp;
  if (!snapshotUrl) throw new Error("Wayback Machine 에 archive 없음");
  // raw mode: id_ 플래그 삽입
  const rawUrl = snapshotUrl.replace(/(\d{14})\/(https?)/, "$1id_/$2");
  console.log(`  Wayback raw: ${rawUrl} (archived ${timestamp})`);
  const rawRes = await fetch(rawUrl, {
    headers: { "User-Agent": "Mozilla/5.0 Chrome/125.0.0.0", "Accept-Encoding": "gzip" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!rawRes.ok) throw new Error(`Wayback raw failed: HTTP ${rawRes.status}`);
  return { html: await rawRes.text(), via: `archive.org Wayback (${timestamp})`, archivedAt: timestamp ?? null };
}

function parseHotlist(html: string): HotlistEntry[] {
  const out: HotlistEntry[] = [];
  // 두 표: id="tbl1" Prohibited, id="tbl2" Restricted. 표 직전 h2 가 section 이름.
  const sections = [
    { id: "tbl1", status: "banned" as const },
    { id: "tbl2", status: "restricted" as const },
  ];
  for (const sec of sections) {
    // h2 #id 부터 다음 h2 또는 EOF 까지 영역 추출
    const startRe = new RegExp(`<h2[^>]*id="${sec.id}"[^>]*>`);
    const startMatch = html.match(startRe);
    if (!startMatch) continue;
    const start = (startMatch.index ?? 0) + startMatch[0].length;
    const tail = html.slice(start);
    const endIdx = tail.search(/<h2[^>]*>/) >= 0 ? tail.search(/<h2[^>]*>/) : tail.length;
    const region = tail.slice(0, endIdx);
    // 한 테이블 안에 tbody 여러 개 (id="t1a", "t1b" 등 알파벳별 그룹). 모두 순회.
    const tbodyRe = /<tbody[^>]*>([\s\S]*?)<\/tbody>/g;
    let tm;
    while ((tm = tbodyRe.exec(region))) {
      const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
      let m;
      while ((m = rowRe.exec(tm[1]))) {
        const cells: string[] = [];
        const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g;
        let cm;
        while ((cm = cellRe.exec(m[1]))) cells.push(stripTags(cm[1]));
        if (cells.length === 0) continue;
        const name = cells[0];
        if (!name || name.length < 2) continue;
        // 헤더 row skip ("Ingredient", "Restriction" 등)
        if (/^(Ingredient|Substance|Name|Numbered|Note|CAS)$/i.test(name)) continue;
        const cas = cells.slice(1).join(" ").match(/(\d{1,7}-\d{2}-\d)/)?.[1] ?? null;
        const conditions = cells.slice(1).filter(Boolean).join("\n").trim() || null;
        out.push({ name, cas, conditions, status: sec.status });
      }
    }
  }
  return out;
}

async function main() {
  const startedAt = Date.now();
  console.log(`▶ Health Canada Hotlist fetch`);
  const { html, via, archivedAt } = await fetchHtml();
  console.log(`  ${via} (${(html.length / 1024).toFixed(0)}KB)`);
  const entries = parseHotlist(html);
  console.log(`  parsed ${entries.length} entries (banned ${entries.filter(e => e.status === "banned").length}, restricted ${entries.filter(e => e.status === "restricted").length})`);

  if (entries.length === 0) {
    console.error("  ✗ 0 entries — 표 구조 변경 가능성. raw HTML 확인 필요.");
    process.exit(1);
  }

  const ingredients = await readRows<IngredientRow>("ingredients");
  const byInciLower = new Map<string, IngredientRow>();
  const byCas = new Map<string, IngredientRow>();
  for (const i of ingredients) {
    byInciLower.set(i.inci_name.toLowerCase(), i);
    if (i.cas_no) { byCas.set(i.cas_no, i); for (const c of i.cas_no.split(/[\s,;/]+/)) { const t = c.trim().replace(/\(.*$/, ""); if (t && t !== i.cas_no) byCas.set(t, i); } }  // 다중 CAS 토큰별 키 추가(쉼표/세미콜론/슬래시·주석strip·분절 방지·전체문자열 키 유지=무회귀)
  }

  const newRegs: RegulationRow[] = [];
  const now = new Date().toISOString();
  const sourceVersion = `Hotlist-${archivedAt ? archivedAt.slice(0, 8) : now.slice(0, 10)}`;

  let matched = 0, created = 0;
  for (const e of entries) {
    const key = e.name.toLowerCase();
    let ing = byInciLower.get(key);
    if (!ing && e.cas) ing = byCas.get(e.cas);
    if (!ing) {
      ing = {
        id: randomUUID(), inci_name: e.name,
        korean_name: null, chinese_name: null, japanese_name: null,
        cas_no: e.cas, synonyms: [], description: null,
        function_category: null, function_description: null,
      };
      ingredients.push(ing);
      byInciLower.set(key, ing);
      if (e.cas) byCas.set(e.cas, ing);
      created++;
    } else {
      matched++;
      if (!ing.cas_no && e.cas) ing.cas_no = e.cas;
    }
    const conds = [
      `Health Canada Hotlist 등재 — ${e.status === "banned" ? "사용 금지 (Prohibited)" : "조건부 허용 (Restricted)"}.`,
      e.conditions ? `조건/비고 (원문): ${e.conditions}` : null,
      `데이터 출처: ${via}`,
    ].filter(Boolean).join("\n\n");
    newRegs.push({
      ingredient_id: ing.id, country_code: "CA", status: e.status,
      max_concentration: null, concentration_unit: "%",
      product_categories: [], conditions: conds,
      source_url: ORIGINAL_URL, source_document: SOURCE_DOC,
      source_version: sourceVersion, source_priority: 100,
      last_verified_at: now, confidence_score: 1.0, override_note: null,
    });
  }
  console.log(`  matching: ${matched} matched, ${created} new`);

  const existingRegs = await readRows<RegulationRow>("regulations");
  const otherSources = existingRegs.filter((r) => r.source_document !== SOURCE_DOC);
  const finalRegs = [...otherSources, ...newRegs];

  await writeRows("ingredients", ingredients);
  await writeRows("regulations", finalRegs);
  await updateMeta({ ingredients: ingredients.length, regulations: finalRegs.length });

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n=== summary (${elapsed}s) ===`);
  console.log(`  CA Hotlist: ${newRegs.length} rows (priority 100, ${via})`);
  console.log(`  ingredients: ${ingredients.length}, regulations: ${finalRegs.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
