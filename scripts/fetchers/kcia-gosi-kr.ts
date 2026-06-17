import { loadEnv } from "../crawlers/env";
loadEnv();
import { readRows, writeRows } from "../../lib/json-store";
import yauzl from "yauzl";
import { randomUUID } from "node:crypto";

// 🎯 KR 「화장품 안전기준 등에 관한 규정」 고시 전문(KCIA HWPX) 파서 — 별표 1(사용금지)·별표 2(사용제한).
// 배경: KR 1차였던 MFDS data.go.kr API 가 401(키/quota) 로 취약하고, *그 API 가 현행 고시의 일부 물질을
// 누락*(실측: 별표1 의약 금지물질 ~104종 미수록)했다. KCIA 는 식약처 고시 전문을 HWPX 로 게시(IP 차단
// 없음·항상 현행). 표 셀(<hp:tc>) 단위 파싱이라 flattened text 의 이름-CAS 정렬붕괴 없이 정확. 이 fetcher 는
// 고시에 있으나 DB 에 없는(CAS 기준) 물질을 **결정론 생성**(id=krgosi-<CAS>, 멱등)하고 KR 규제(별표1=banned,
// 별표2=restricted)를 단다. 기존 MFDS/KCIA 소스는 보존(추가만, 중복 CAS 는 생성 안 함). 무AI·무 API키.

const POST_URL = "https://kcia.or.kr/home/law/law_01.php?type=view&no=17489";  // 최신 안전기준 개정 게시물
const BASE = "https://kcia.or.kr/home/law/law_01.php";
const SOURCE_DOC = "KCIA 게시 식약처 「화장품 안전기준 등에 관한 규정」 고시 전문(별표)";

interface IngredientRow {
  id: string; inci_name: string; korean_name: string | null; chinese_name: string | null;
  japanese_name: string | null; cas_no: string | null; synonyms: string[];
  description: string | null; function_category: string | null; function_description: string | null;
}
interface RegulationRow {
  ingredient_id: string; country_code: string; status: string; max_concentration: number | null;
  concentration_unit: string; product_categories: string[]; conditions: string | null;
  source_url: string | null; source_document: string; source_version: string | null;
  source_priority: number; last_verified_at: string; confidence_score: number; override_note: string | null;
}

const CAS_RE = /^\d{1,7}-\d{2}-\d$/;

async function fetchHwpx(): Promise<Buffer | null> {
  const sess = await fetch(BASE, { headers: { "User-Agent": "Mozilla/5.0" } });
  const cookie = (sess.headers.get("set-cookie") || "").split(";")[0];
  const v = await (await fetch(POST_URL, { headers: { "User-Agent": "Mozilla/5.0", Cookie: cookie } })).text();
  const links = [...v.matchAll(/(inc\/down\.php\?[^"'<> ]+)/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
  // 붙임2(전문) = rename 에 전문(%EC%A0%84%EB%AC%B8) 포함, 없으면 마지막 첨부
  const target = links.find((l) => /%EC%A0%84%EB%AC%B8/.test(l)) || links[links.length - 1];
  if (!target) return null;
  const r = await fetch("https://kcia.or.kr/" + target, {
    headers: { "User-Agent": "Mozilla/5.0", Cookie: cookie, Referer: POST_URL },
    signal: AbortSignal.timeout(60_000),
  });
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.subarray(0, 2).toString("hex") === "504b" ? buf : null;
}

function cellText(tc: string): string {
  return [...tc.matchAll(/<hp:t>([\s\S]*?)<\/hp:t>/g)].map((m) => m[1]).join("")
    .replace(/<[^>]+>/g, "").replace(/&#13;|&lt;|&gt;|&amp;/g, " ").replace(/\s+/g, " ").trim();
}

async function parseGosi(buf: Buffer): Promise<{ cas: string; name: string; status: string }[]> {
  const xml = await new Promise<string>((res, rej) => {
    let out = "";
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return rej(err);
      zip.readEntry();
      zip.on("entry", (e) => {
        if (/section\d+\.xml/i.test(e.fileName)) {
          zip.openReadStream(e, (er, rs) => {
            if (er || !rs) { zip.readEntry(); return; }
            const c: Buffer[] = []; rs.on("data", (d) => c.push(d as Buffer)); rs.on("end", () => { out += Buffer.concat(c).toString("utf8"); zip.readEntry(); });
          });
        } else zip.readEntry();
      });
      zip.on("end", () => res(out));
      zip.on("error", rej);
    });
  });
  // 상태 분류(분별력·안전 우선): 별표 2(사용제한) 행은 *그 행에 사용한도(%·ppm)* 를 가진다. 별표 1
  // (사용금지) 행은 이름+CAS 만(한도 없음). → **한도 있으면 restricted, 없으면 banned**. 경계텍스트
  // 기반 분류는 제5조의 "별표 2" 참조를 오인해 금지물질을 restricted 로 오분류(=false-allowed 방향, 위험)
  // 했다(dry-test 발견). 모호하면 banned(과제한=안전방향, under-warn 0). 한도값이 별도 컬럼이라도
  // 같은 행 셀에 들어오므로 hasPct 로 포착.
  const out: { cas: string; name: string; status: string }[] = [];
  for (const tr of xml.matchAll(/<hp:tr\b[\s\S]*?<\/hp:tr>/g)) {
    const cells = [...tr[0].matchAll(/<hp:tc\b[\s\S]*?<\/hp:tc>/g)].map((m) => cellText(m[0]));
    const casCell = cells.find((c) => CAS_RE.test(c.trim()));
    if (!casCell) continue;
    const cas = casCell.trim();
    const name = (cells.filter((c) => c !== casCell && /[가-힣]/.test(c)).sort((a, b) => b.length - a.length)[0] || "").slice(0, 80);
    if (!name || name.length < 2) continue;  // 이름 없는 행 skip(정확성)
    const hasPct = cells.some((c) => /\d+(?:\.\d+)?\s*(?:%|퍼센트|ppm)/.test(c));
    out.push({ cas, name, status: hasPct ? "restricted" : "banned" });
  }
  return out;
}

async function main() {
  console.log("▶ KCIA 게시 식약처 안전기준 고시(HWPX) 파싱 — 별표 1/2...");
  const buf = await fetchHwpx();
  if (!buf) { console.error("✗ 고시 HWPX 못 받음 — 보존(write 생략)"); process.exit(1); }
  const subs = await parseGosi(buf);
  console.log(`  고시 별표 물질(CAS+이름): ${subs.length} (금지 ${subs.filter((s) => s.status === "banned").length} · 제한 ${subs.filter((s) => s.status === "restricted").length})`);
  if (subs.length < 500) { console.error(`✗ ${subs.length}행 — 파싱 이상(양식 변경?) 보존 위해 중단`); process.exit(1); }

  const ingredients = await readRows<IngredientRow>("ingredients");
  const dbCas = new Set<string>();
  for (const i of ingredients) for (const c of String(i.cas_no || "").split(/[\s,;/^]+/)) { const t = c.trim().replace(/\[.*/, "").replace(/\(.*/, ""); if (CAS_RE.test(t)) dbCas.add(t); }

  // 고시에 있으나 DB 에 없는 CAS → 생성. 중복 dedup.
  const now = new Date().toISOString();
  const seen = new Set<string>();
  const newIng: IngredientRow[] = [];
  const newRegs: RegulationRow[] = [];
  for (const s of subs) {
    if (dbCas.has(s.cas) || seen.has(s.cas)) continue;
    seen.add(s.cas);
    const id = `krgosi-${s.cas}`;
    newIng.push({
      id, inci_name: s.name, korean_name: s.name, chinese_name: null, japanese_name: null,
      cas_no: s.cas, synonyms: [], description: null, function_category: null, function_description: null,
    });
    newRegs.push({
      ingredient_id: id, country_code: "KR", status: s.status,
      max_concentration: null, concentration_unit: "%", product_categories: [],
      conditions: `「화장품 안전기준 등에 관한 규정」 ${s.status === "banned" ? "별표 1 사용할 수 없는 원료" : "별표 2 사용상의 제한이 필요한 원료"} 등재.\nCAS: ${s.cas}`,
      source_url: POST_URL, source_document: SOURCE_DOC, source_version: `gosi-${now.slice(0, 10)}`,
      source_priority: 100, last_verified_at: now, confidence_score: 1.0, override_note: null,
    });
  }
  console.log(`  DB 누락 → 신규 생성: ${newIng.length} 성분 (banned ${newRegs.filter((r) => r.status === "banned").length} · restricted ${newRegs.filter((r) => r.status === "restricted").length})`);

  if (newIng.length) {
    const have = new Set(ingredients.map((i) => i.id));
    const addIng = newIng.filter((i) => !have.has(i.id));
    if (addIng.length) await writeRows("ingredients", [...ingredients, ...addIng]);
    const existing = await readRows<RegulationRow>("regulations");
    // 이 소스 기존 행 교체(멱등) + 타 소스 보존.
    const other = existing.filter((r) => r.source_document !== SOURCE_DOC);
    await writeRows("regulations", [...other, ...newRegs]);
    console.log(`✓ KCIA 고시: 성분 +${addIng.length}, KR 규제 ${newRegs.length} (krgosi-<CAS>, 멱등·추가전용)`);
  } else {
    console.log("  신규 없음(모두 기존 DB 보유) — 멱등");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
