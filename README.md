# cosmetics-reg

화장품 원료 규제 정보 검색 — 한국·중국·EU·미국·일본·ASEAN(6국)·대만·브라질·아르헨티나·캐나다·안데스공동체(4국) 등 19국.
33.9K 원료 · 92K 규제. 데이터 소스: 식약처 공공데이터 API 4종 + 각국 공식 법령.

## 🖱️ 다른 PC 에 1-클릭 설치 (가장 간편)

설치 스크립트 하나만 빈 폴더에 두고 실행 → 다운로드·Node 설치·빌드·실행·브라우저까지 자동.

- **Windows**: [`install.bat`](install.bat) 다운로드 → 더블클릭
- **macOS / Linux**: `bash install.sh`

Node 가 없어도 됩니다(Windows 는 portable Node 자동 설치). git 이 있으면 매일 자동갱신, 없으면 zip 다운로드. 두 번째 실행부터는 만들어진 `cosmetics-reg/start.bat`(또는 `start.sh`)만 더블클릭하면 됩니다.

## 100% 로컬 (Phase 5b — Supabase·Netlify·서버 의존 0)

검색 path 도, **데이터 갱신 path 도** 외부 데이터베이스 없음.
모든 데이터는 `public/data/*.json` (git 에 포함). 사용자 PC 단독 구동.

```bash
git clone --depth 1 https://github.com/tim10000-alt/cosmetics-reg.git
cd cosmetics-reg
npm start                         # 설치+빌드+서버+브라우저 자동 (또는 아래 수동)
# npm install && npm run build && npm run serve   # http://localhost:3010
```

자격증명 한 줄도 없이 검색 사이트가 즉시 동작.

## 데이터 흐름

```
운영자 (식약처 API + Gemini 인터넷 필요)        사용자 (인터넷 0)
──────────────────                            ──────────────
npm run mfds:ingest                            npm run serve
   │                                              │
   ▼                                              ▼
public/data/ingredients.json     ──git─▶  out/data/ingredients.json
public/data/regulations.json                public/data/regulations.json
public/data/countries.json                  ...
public/data/quarantine.json                    │
public/data/regulation-sources.json            ▼ (브라우저 첫 로드 시 1회 fetch)
public/data/source-status.json              인메모리 인덱스 → 검색 RTT 0
public/data/detected-changes.json
public/data/meta.json
```

## 빌드·실행 (사용자) — 더블클릭 한 번

**Windows**: 폴더의 `start.bat` **더블클릭 한 번** — 그게 전부입니다.
- 설치가 끝난 뒤부터는 **검은 CMD 창 없이** 서버가 뜨고 브라우저만 열립니다 (첫 설치만 진행 표시용으로 창을 잠깐 보여줌).
- **브라우저(모든 탭)를 닫으면 서버가 ~75초 내 자동 종료** — 따로 끌 필요 없음.

**macOS / Linux**: 터미널에서 `./start.sh` (또는 `npm start`)

`scripts/launch.cjs` 가 자동으로:
1. `node_modules` 없으면 `npm install` (최초 1회)
2. `out/` 없으면 `npm run build` (최초 1회 또는 코드 변경 시)
3. `http://localhost:3010` 에 정적 서버 띄움 (`scripts/serve-local.cjs` — 브라우저 생존 heartbeat)
4. 기본 브라우저 자동 진입
5. **브라우저(모든 탭) 닫으면 ~75초 내 서버 자동 종료** (또는 `Ctrl+C`)

**전제조건**: Node.js LTS (https://nodejs.org). 그 외 자격증명 0.

수동 실행 (개발자):
```bash
npm install
npm run build && npm run serve   # http://localhost:3010
# 또는
npm run dev                       # next dev (HMR)
```

## 데이터 갱신 (운영자 — Gemini + 식약처 API 인터넷 필요)

| 명령 | 용도 | 인터넷 의존 |
|---|---|---|
| `npm run mfds:ingest` | 식약처 API 4종 → ingredients.json + regulations.json (MFDS 부분) 머지 | 식약처 API |
| `npm run sources:seed` | registry → regulation-sources.json (1회 / 변경 시) | 없음 |
| `npm run crawl` | regulation-sources 의 HTML hash diff → source-status.json + detected-changes.json + .crawl-raw/ | 각국 공식 사이트 |
| `npm run parse` | 변경된 raw → Gemini 듀얼 파싱 → regulations + quarantine 머지 | Gemini |
| `npm run enrich:functions` | 원료 function_category Gemini 보강 (~150건/일, RPD 250 한도) | Gemini |

각 명령은 in-place 머지 — 기존 다른 source 의 데이터, 보강 결과(function_category 등), id 보존.
완료 후 `git add public/data/ && git commit -m "data: refresh"` 로 영속화. push 시 정적 호스팅 자동 갱신.

GitHub Actions (`.github/workflows/crawl.yml`) 가 매일 KST 03:17 자동으로 위 흐름 실행 + commit + push.

## 자격증명 (`.env.local`)

```env
GEMINI_API_KEY=AIza...        # parsers / enrich-functions 만 필요
MFDS_API_KEY=...              # mfds:ingest 만 필요
```

검색만 하려면 두 변수 모두 불필요 (git 의 public/data/ 사용).

## 검증

```bash
npm run build && npm run serve &
E2E_BASE=http://localhost:3010 npm run e2e          # 25/25 PASS
npm run lighthouse http://localhost:3010             # perf 73 / a11y 95 / best 100 / seo 100
```

## 데이터 크기

| 파일 | raw | brotli (호스팅 시) | git pack |
|---|---|---|---|
| ingredients.json | 10MB | 1.3MB | ~1MB |
| regulations.json | 31MB | 0.5MB | ~3MB |
| 그 외 | <100KB | <30KB | 작음 |

첫 로드 ~2MB, 인덱스 빌드 1-2초 (첫 사용자 인터랙션 시점). 이후 검색 ms.
브라우저 캐시 + ETag 로 두 번째 방문은 변경 시만 다운로드.

## 호스팅 (선택)

`out/` 디렉토리만 배포. 정적 호스팅이면 어디서든. `public/_headers` 가 보안 헤더 자동 부여 (Netlify·Cloudflare Pages 인식).

## 폴더

```
app/                    Next.js 페이지 (정적 export)
lib/                    클라이언트 + scripts 공통
  data-loader.ts          public/data/*.json fetch + 인메모리 인덱스
  json-store.ts           atomic read/write (scripts 전용)
  regulations-query.ts    검색 (메모리)
  autocomplete-query.ts   자동완성 (메모리)
  gemini.ts               Gemini SDK 헬퍼
public/data/            정적 데이터 번들 (git 에 포함)
scripts/                인제스트 파이프라인 (Node)
  mfds/ingest.ts          식약처 API → JSON
  crawlers/               변경 감지 (hash diff)
  parsers/                Gemini 듀얼 파싱 → JSON
  sources/seed.ts         regulation-sources registry → JSON
  enrich-functions.ts     function_category 보강
  e2e-verify.ts           Playwright E2E (25 시나리오)
  lighthouse.ts           Lighthouse CLI 통합
supabase/migrations/    역사 기록 (Phase 5b 이후 적용 안 함)
```

자세한 운영 노트: `AGENTS.md`
