import { loadEnv } from "../crawlers/env";
loadEnv();
import { writeRows, updateMeta } from "../../lib/json-store";

// 대한화장품협회 (KCIA) 의 해외법령·중국법령 게시물 metadata fetcher.
// 첨부(PDF/HWP/XLSX) 는 비회원 자동 다운로드 가능 — detail 페이지의 down.php 링크로 받음.
// UI 에서 "관련 협회 자료 N건" 보조 정보로 사용자에게 link 안내.
//
// 한국 사이트라 한국 IP 차단 X. 100% 자동화 가능.

const BASE = "https://kcia.or.kr";
const REFERER = `${BASE}/home/main/`;
const PAGES = [
  { url: `${BASE}/home/law/law_01.php`, category: "국내법령" }, // 한국 국내법령(화장품법·시행규칙·식약처 고시·안전기준) → KR 2차
  { url: `${BASE}/home/law/law_05.php`, category: "해외법령" },
  { url: `${BASE}/home/law/law_09.php`, category: "중국법령" },
];

interface KciaArticle {
  no: string;
  title: string;
  category: string;       // 페이지 카테고리 (해외법령/중국법령)
  country_inferred: string | null;  // 제목에서 국가 추론 (US/EU/CN/JP/CA/...)
  date: string;           // YYYY-MM-DD
  views: number;
  attach_pdf: boolean;
  attach_hwp: boolean;
  attach_excel: boolean;
  detail_url: string;     // KCIA 게시물 페이지 (사용자 클릭용)
  body_excerpt?: string | null;  // 본문 한국어 발췌 (비회원 본문 text 만)
  attachments?: KciaAttachment[]; // 비회원 다운로드된 첨부 metadata
}

// 국가 추론 휴리스틱 — 제목 키워드 매칭
const COUNTRY_KEYWORDS: { keys: string[]; code: string }[] = [
  { keys: ["미국", "FDA", "캘리포니아", "MoCRA", "California", "U.S."], code: "US" },
  { keys: ["EU", "유럽", "European Commission", "CosIng", "EUR-Lex"], code: "EU" },
  { keys: ["중국", "NMPA", "中国", "化妆品", "IECIC", "안전기술규범"], code: "CN" },
  { keys: ["일본", "MHLW", "厚生労働省", "化粧品基準"], code: "JP" },
  { keys: ["대만", "TFDA", "台灣"], code: "TW" },
  { keys: ["캐나다", "Health Canada", "Hotlist"], code: "CA" },
  { keys: ["베트남"], code: "VN" },
  { keys: ["태국", "Thailand"], code: "TH" },
  { keys: ["인도네시아", "BPOM"], code: "ID" },
  { keys: ["말레이시아", "NPRA"], code: "MY" },
  { keys: ["필리핀", "Philippines"], code: "PH" },
  { keys: ["싱가포르", "HSA"], code: "SG" },
  { keys: ["브라질", "ANVISA", "Brasil"], code: "BR" },
  { keys: ["아르헨티나", "ANMAT"], code: "AR" },
  { keys: ["콜롬비아", "DECISIÓN", "Colombia"], code: "CO" },
];

function inferCountry(title: string, fallbackCategory: string): string | null {
  // 국내법령 카테고리 = 한국 자국 법령(화장품법·식약처 고시) → 정의상 KR(키워드보다 우선).
  if (fallbackCategory === "국내법령") return "KR";
  for (const { keys, code } of COUNTRY_KEYWORDS) {
    if (keys.some((k) => title.includes(k))) return code;
  }
  // category fallback
  if (fallbackCategory === "중국법령") return "CN";
  return null;
}

// 성분 규제와 무관한 행정·등록·튜토리얼 자료는 사이트 노출 대상 X.
// 사이트는 "성분 및 제한·금지" 정보를 제공하는 게 목적이므로 절차·매뉴얼·수수료
// 글은 사용자 가치 0. 키워드 매칭으로 보수적 거부.
const NON_INGREDIENT_KEYWORDS = [
  "Tutorial",
  "튜토리얼",
  "사용자 가이드",
  "사용자가이드",
  "Cosmetic Direct",
  "Electronic Drug Registration",
  "OMUFA",
  "사용자 수수료",
  "수수료 프로그램",
  "OTC Monograph",
  "User Fee",
  "등록 자료 관리",
  "허가, 등록 자료",
  "허가·등록 자료",
  "시설등록",
  "州법 관련 자료집",
  "州法 관련 자료집",
];

function isIngredientRegArticle(title: string): boolean {
  for (const kw of NON_INGREDIENT_KEYWORDS) {
    if (title.includes(kw)) return false;
  }
  return true;
}

async function fetchListPage(url: string, category: string, cookies: Record<string, string>): Promise<{ html: string; cookies: Record<string, string> }> {
  // GET with cookie + referer
  const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0.0.0",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "ko-KR,ko;q=0.9",
      "Referer": REFERER,
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const newCookies = { ...cookies };
  for (const sc of setCookie) {
    const m = sc.match(/^([^=]+)=([^;]+)/);
    if (m) newCookies[m[1]] = m[2];
  }
  return { html: await res.text(), cookies: newCookies };
}

function parseList(html: string, category: string): KciaArticle[] {
  const articles: KciaArticle[] = [];
  // table row pattern — 위 분석에서 본 구조:
  //   <td class="no"><p>16330</p></td>  또는 <p>공지</p>
  //   <td class="left"> <a href="?type=view&no=NNNN..." class="link">제목</a> </td>
  //   <td class="attach"> ...btn_attach pdf|hwp|excel ... </td>
  //   <td><p>조회수</p></td>
  //   <td><p>YYYY-MM-DD</p></td>
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRe.exec(html))) {
    const row = m[1];
    const linkM = row.match(/href="(\?type=view&no=(\d+)[^"]*)"[^>]*>([^<]+)</);
    if (!linkM) continue;
    const detailUrl = linkM[1];
    const no = linkM[2];
    const title = linkM[3].trim();
    const dateM = row.match(/(\d{4}-\d{2}-\d{2})/);
    const viewsM = row.match(/<td>\s*<p>\s*(\d+)\s*<\/p>/);
    const attachPdf = /btn_attach\s+pdf/.test(row);
    const attachHwp = /btn_attach\s+hwp/.test(row);
    const attachExcel = /btn_attach\s+excel/.test(row);
    articles.push({
      no,
      title,
      category,
      country_inferred: inferCountry(title, category),
      date: dateM?.[1] ?? "",
      views: viewsM ? Number(viewsM[1]) : 0,
      attach_pdf: attachPdf,
      attach_hwp: attachHwp,
      attach_excel: attachExcel,
      // 카테고리별 정확한 게시판 페이지로 detail URL 구성(이전엔 국내법령도 law_05 로 잘못 매핑 → 첨부 0).
      detail_url: detailUrl.startsWith("http") ? detailUrl
        : `${BASE}/home/law/${category === "국내법령" ? "law_01" : category === "중국법령" ? "law_09" : "law_05"}.php${detailUrl}`,
    });
  }
  return articles;
}

interface KciaAttachment {
  filename: string;        // 원본 한국어 파일명 (rename param)
  download_path: string;   // /inc/down.php?dir=... query string 그대로
  ext: string;             // pdf | xlsx | hwp | docx | etc
  saved_to: string | null; // public/data/raw-attach/kcia-<no>/<filename>
  size_bytes: number | null;
  fetched_at: string | null;
}

// detail 페이지 HTML 에서 btn_attach 링크 5종 추출 + KCIA 비회원 다운로드.
// 화장품 성분 규제와 무관한 첨부 (튜토리얼 동영상 링크 등) 는 list 단계에서 거부됨.
// 같은 게시물의 첨부 파일명에 timestamp 가 들어 있어 파일 변경 시 새 이름이 됨 → 단순 비교로 변경 감지.
async function fetchAttachments(
  no: string,
  detailHtml: string,
  cookies: Record<string, string>,
  referer: string,
  alwaysFresh: boolean,
): Promise<KciaAttachment[]> {
  const { mkdirSync, writeFileSync, existsSync, statSync } = await import("node:fs");
  const path = await import("node:path");
  const out: KciaAttachment[] = [];
  const re = /<a\s+href="(\/inc\/down\.php\?[^"]+)"\s+class="btn_attach\s+([a-z]+)"[^>]*>([^<]+)<\/a>/g;
  const dir = `public/data/raw-attach/kcia-${no}`;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  let m;
  const seen = new Set<string>();
  while ((m = re.exec(detailHtml))) {
    const downloadPath = m[1].replace(/&amp;/g, "&");
    const ext = m[2];
    const filename = m[3].trim();
    if (seen.has(downloadPath)) continue;
    seen.add(downloadPath);
    // 파일명 sanitize (path traversal 차단)
    const safeName = filename.replace(/[\\/:*?"<>|]/g, "_").slice(0, 200);
    const savedTo = path.join(dir, safeName);
    let sizeBytes: number | null = null;
    let needDownload = alwaysFresh;
    if (!alwaysFresh && existsSync(savedTo)) {
      sizeBytes = statSync(savedTo).size;
    } else {
      needDownload = true;
    }
    if (needDownload) {
      try {
        const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
        const res = await fetch(`${BASE}${downloadPath}`, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0.0.0",
            "Accept": "*/*",
            "Accept-Language": "ko-KR,ko;q=0.9",
            "Referer": referer,
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          },
        });
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          writeFileSync(savedTo, buf);
          sizeBytes = buf.length;
          console.log(`    ↓ kcia-${no}/${safeName} (${(buf.length / 1024).toFixed(0)}KB)`);
        } else {
          console.warn(`    ✗ ${no}/${safeName}: HTTP ${res.status}`);
        }
      } catch (e) {
        console.warn(`    ✗ ${no}/${safeName}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    out.push({ filename, download_path: downloadPath, ext, saved_to: savedTo, size_bytes: sizeBytes, fetched_at: needDownload ? new Date().toISOString() : null });
    // KCIA 트래픽 부담 — 첨부 다운로드 사이 0.5s
    await new Promise((r) => setTimeout(r, 500));
  }
  return out;
}

function extractBodyExcerpt(html: string): string | null {
  const i = html.indexOf("sp_title");
  if (i < 0) return null;
  const region = html.slice(i, i + 12000);
  let text = region
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  const startMatch = text.match(/조회수\s*\d+\s*(.+?)(?:이전글|다음글|var page_|function )/);
  if (startMatch) text = startMatch[1].trim();
  return text.length > 1500 ? text.slice(0, 1500) + "..." : text || null;
}

async function main() {
  const startedAt = Date.now();
  // session 시작 — main 페이지 GET
  const initRes = await fetch(REFERER, {
    headers: { "User-Agent": "Mozilla/5.0 Chrome/125.0.0.0" },
  });
  if (!initRes.ok) throw new Error(`init: HTTP ${initRes.status}`);
  const initSetCookie = initRes.headers.getSetCookie?.() ?? [];
  let cookies: Record<string, string> = {};
  for (const sc of initSetCookie) {
    const m = sc.match(/^([^=]+)=([^;]+)/);
    if (m) cookies[m[1]] = m[2];
  }
  console.log(`▶ KCIA session: ${Object.keys(cookies).join(",")}`);

  const all: KciaArticle[] = [];
  for (const { url, category } of PAGES) {
    const { html, cookies: newCookies } = await fetchListPage(url, category, cookies);
    cookies = newCookies;
    const list = parseList(html, category);
    console.log(`  ${category}: ${list.length} 게시물`);
    all.push(...list);
  }

  // 정렬: 최신 순 (date desc)
  all.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

  // 중복 제거 (no 기준)
  const unique = new Map<string, KciaArticle>();
  for (const a of all) if (!unique.has(a.no)) unique.set(a.no, a);
  // 성분 규제 외 행정·튜토리얼·수수료 글 거부
  const beforeFilter = unique.size;
  const final = Array.from(unique.values()).filter((a) => isIngredientRegArticle(a.title));
  console.log(`▶ 성분 규제 필터: ${beforeFilter} → ${final.length} (${beforeFilter - final.length} 거부)`);

  // 본문 발췌 + 첨부 자동 다운로드 (KCIA 부담 최소화 — 게시물 사이 0.5s)
  // 첨부는 attach_pdf/hwp/excel 플래그 있는 게시물에 대해서만 다운로드 시도 (비회원 가능 확인됨).
  console.log(`▶ detail body + 첨부 추출 (${final.length}건)...`);
  for (let i = 0; i < final.length; i++) {
    const a = final[i];
    const referer = a.category === "중국법령"
      ? `${BASE}/home/law/law_09.php`
      : `${BASE}/home/law/law_05.php`;
    // detail HTML 한 번만 fetch — body + 첨부 둘 다 처리
    const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    let detailHtml: string | null = null;
    try {
      const res = await fetch(a.detail_url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0.0.0",
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "ko-KR,ko;q=0.9",
          "Referer": referer,
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
      });
      if (res.ok) detailHtml = await res.text();
    } catch (e) {
      console.warn(`  detail fetch 실패 ${a.no}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (detailHtml) {
      a.body_excerpt = extractBodyExcerpt(detailHtml);
      if (a.attach_pdf || a.attach_hwp || a.attach_excel) {
        a.attachments = await fetchAttachments(a.no, detailHtml, cookies, referer, false);
      }
    }
    if ((i + 1) % 5 === 0) console.log(`  ${i + 1}/${final.length}`);
    await new Promise((r) => setTimeout(r, 500));
  }

  await writeRows("kcia-articles", final);
  await updateMeta({});

  // country별 카운트
  const byCountry: Record<string, number> = {};
  for (const a of final) {
    if (a.country_inferred) byCountry[a.country_inferred] = (byCountry[a.country_inferred] ?? 0) + 1;
    else byCountry["?"] = (byCountry["?"] ?? 0) + 1;
  }
  console.log(`\n=== summary (${((Date.now()-startedAt)/1000).toFixed(1)}s) ===`);
  console.log(`  KCIA articles: ${final.length}`);
  console.log(`  by country:`, byCountry);
}

main().catch((e) => { console.error(e); process.exit(1); });
