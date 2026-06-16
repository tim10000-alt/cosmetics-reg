"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { lookupRegulation, type LookupResponse, type CountryLookupResult } from "@/lib/regulations-query";
import { fetchSuggestions, type Suggestion } from "@/lib/autocomplete-query";
import { asset } from "@/lib/base-path";

export default function Home() {
  return (
    <Suspense fallback={null}>
      <HomeInner />
    </Suspense>
  );
}

function HomeInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialQ = searchParams.get("q") ?? "";
  const [query, setQuery] = useState(initialQ);
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<LookupResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 헤더 카운트 — meta.json 에서 동적 로드(하드코딩 시 매일 stale). 실패 시 폴백 텍스트.
  const [counts, setCounts] = useState<{ ingredients: number; regulations: number } | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(asset("/data/meta.json"))
      .then((r) => r.json())
      .then((m) => { if (alive && m?.counts) setCounts({ ingredients: m.counts.ingredients, regulations: m.counts.regulations }); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLFormElement>(null);
  const listboxId = "autocomplete-listbox";

  // Autocomplete — debounced fetch. Empty query는 아래 렌더 조건에서 처리 (effect 내 setState 회피).
  useEffect(() => {
    const q = query.trim();
    if (q.length < 1) return;
    const ac = new AbortController();
    const t = setTimeout(async () => {
      try {
        const data = await fetchSuggestions(q, ac.signal);
        if (!ac.signal.aborted) {
          setSuggestions(data);
          setActiveIdx(-1);
        }
      } catch (e) {
        if ((e as { name?: string }).name !== "AbortError") setSuggestions([]);
      }
    }, 120);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [query]);

  // Close dropdown on outside click
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setShowSuggestions(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  async function runSearch(q: string) {
    const trimmed = q.trim();
    if (trimmed.length < 1) return;
    setLoading(true);
    setError(null);
    setResponse(null);
    setShowSuggestions(false);
    // URL 딥링크: ?q=... 로 직접 공유·뒤로가기 가능. replace로 history 폭증 방지.
    router.replace(`/?q=${encodeURIComponent(trimmed)}`, { scroll: false });
    try {
      // 자유텍스트 남용 방지용 상한. 단 일부 규제 group entry(EU borates/nickel/PFOS 묶음·
      // 복합 발효/IUPAC 폴리머명)는 inci_name 이 최대 ~1900자 → 256 으로 막으면 그 성분을
      // 풀네임/자동완성 선택으로 못 찾는 사각 발생. 실제 최장(1886) 위로 상향.
      if (trimmed.length > 2048) throw new Error("query too long (max 2048)");
      const data = await lookupRegulation(trimmed);
      setResponse(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  // 초기 ?q= 파라미터 있으면 자동 검색 (새로고침·공유 링크 진입 지원).
  // setState는 runSearch 내부 async 콜백에서 일어나지만 정적 분석이 이를 직접 호출로 판정
  // → mount-once effect 전체에 disable 주석.
  /* eslint-disable react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */
  useEffect(() => {
    if (initialQ.trim().length >= 2) void runSearch(initialQ);
  }, []);
  /* eslint-enable react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    runSearch(query);
  }

  function pickSuggestion(s: Suggestion) {
    const pick = s.korean_name ?? s.inci_name;
    setQuery(pick);
    setShowSuggestions(false);
    runSearch(pick);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!showSuggestions || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, -1));
    } else if (e.key === "Enter" && activeIdx >= 0) {
      e.preventDefault();
      pickSuggestion(suggestions[activeIdx]);
    } else if (e.key === "Escape") {
      setShowSuggestions(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
          화장품 원료 규제 검색
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          식약처 공공데이터 API (4종) + 각국 공식 법령 · 총 원료 {counts ? `${Math.round(counts.ingredients / 1000)}K` : "35K"}·규제 {counts ? `${Math.round(counts.regulations / 1000)}K` : "94K"}건 (19개국: 한국·중국·EU·미국·일본·ASEAN 6국·대만·브라질·아르헨티나·캐나다·안데안공동체 4국)
        </p>
      </header>

      <form onSubmit={handleSubmit} className="relative mb-8 flex gap-2" ref={containerRef}>
        <div className="relative flex-1">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setShowSuggestions(true);
            }}
            onFocus={() => setShowSuggestions(true)}
            onKeyDown={onKeyDown}
            placeholder="원료명 (INCI / 한글 / CAS 번호 — 예: Retinol, 레티놀, 68-26-8)"
            className="w-full rounded-lg border border-zinc-300 bg-white px-4 py-2.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-500/30 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
            autoFocus
            autoComplete="off"
            role="combobox"
            aria-label="화장품 원료 검색"
            aria-expanded={showSuggestions && suggestions.length > 0}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={activeIdx >= 0 ? `ac-option-${activeIdx}` : undefined}
          />
          {query.trim().length > 0 && showSuggestions && suggestions.length > 0 && (
            <ul
              id={listboxId}
              role="listbox"
              aria-label="검색 제안"
              className="absolute left-0 right-0 top-full z-10 mt-1 max-h-80 overflow-y-auto rounded-lg border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
            >
              {suggestions.map((s, i) => (
                <li
                  key={`${s.inci_name}-${i}`}
                  id={`ac-option-${i}`}
                  role="option"
                  aria-selected={i === activeIdx}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickSuggestion(s);
                  }}
                  onMouseEnter={() => setActiveIdx(i)}
                  className={`cursor-pointer px-4 py-2 text-sm [overflow-wrap:anywhere] ${
                    i === activeIdx
                      ? "bg-zinc-100 dark:bg-zinc-800"
                      : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                  }`}
                >
                  <div className="text-zinc-900 dark:text-zinc-50">{s.korean_name ?? s.inci_name}</div>
                  <div className="text-xs text-zinc-500">
                    {s.inci_name}
                    {s.cas_no ? ` · CAS ${s.cas_no.split(/\s/)[0]}` : ""}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          type="submit"
          disabled={loading || query.trim().length < 1}
          className="rounded-lg bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:opacity-40 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {loading ? "검색 중..." : "검색"}
        </button>
      </form>

      {error && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </div>
      )}

      {response && response.ingredient === null && (
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-6 text-center text-sm text-zinc-600 [overflow-wrap:anywhere] dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-400">
          &ldquo;{response.query}&rdquo; 에 대한 원료를 DB에서 찾지 못했습니다.
        </div>
      )}

      {response?.ingredient && (
        <>
          <IngredientHeader ingredient={response.ingredient} />
          {/* 다중결과 — 같은 질의에 다른 원료도 매칭됐을 때 선택지로 노출(단일 best 가 가리던 결과
              shadowing 제거). 클릭 시 해당 원료로 전환. */}
          {response.other_matches && response.other_matches.length > 0 && (
            <div className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 dark:border-zinc-700 dark:bg-zinc-900/60">
              <div className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
                같은 검색어에 매칭된 다른 원료 {response.other_matches.length}건 — 클릭하여 보기
              </div>
              <ul className="mt-2 space-y-1">
                {response.other_matches.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => { setQuery(m.inci_name); setShowSuggestions(false); runSearch(m.inci_name); }}
                      className="w-full rounded px-2 py-1 text-left text-xs [overflow-wrap:anywhere] hover:bg-zinc-200 dark:hover:bg-zinc-800"
                    >
                      <span className="font-medium text-zinc-800 dark:text-zinc-100">{m.inci_name}</span>
                      {m.korean_name && <span className="text-zinc-500 dark:text-zinc-400"> · {m.korean_name}</span>}
                      {m.cas_no && <span className="text-zinc-400"> · CAS {m.cas_no}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {response.related_variants && response.related_variants.length > 0 && (
            <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-800 dark:bg-amber-950/40">
              <div className="text-sm font-medium text-amber-900 dark:text-amber-200">
                ⚠ 확인 필요 — 표기가 다른 동일 물질 추정 레코드
              </div>
              <p className="mt-1 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
                같은 한글명이나 INCI 표기·CAS 차이로 <b>자동 통합되지 않은</b> 레코드가 있습니다. 아래가 동일 물질이라면
                해당 국가 규제도 함께 적용될 수 있으니, 공식 원문으로 동일 물질 여부를 확인해 주세요.
              </p>
              <ul className="mt-2 space-y-1.5">
                {response.related_variants.map((v, i) => (
                  <li key={i} className="text-xs text-amber-900 [overflow-wrap:anywhere] dark:text-amber-200">
                    <span className="font-mono">{v.inci_name}</span>
                    <span className="text-amber-700 dark:text-amber-400">
                      {" "}— 이 표기에만 규제 있는 국가: {v.extra_country_names.join(", ")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <section className="mt-6 grid gap-3 sm:grid-cols-2">
            {response.results.map((r) => (
              <CountryCard
                key={r.country_code}
                result={r}
                bannedElsewhere={response.results.filter((x) => x.status === "banned").map((x) => x.country_name_ko)}
              />
            ))}
          </section>
        </>
      )}

      <footer className="mt-12 border-t border-zinc-200 pt-6 text-xs leading-relaxed text-zinc-500 dark:border-zinc-800">
        본 서비스 정보는 식약처 공공데이터 포털의 공식 API를 자동 수집·정리한 참고 자료입니다.
        최종 규제 판단은 반드시 해당 국가 공식 문서 원문을 확인해 주세요.
        <div className="mt-2">
          <a href="/sources/" className="underline decoration-dotted hover:text-zinc-800 dark:hover:text-zinc-200">
            데이터 상태·갱신 시점 보기 →
          </a>
        </div>
      </footer>
    </main>
  );
}

function IngredientHeader({ ingredient }: { ingredient: NonNullable<LookupResponse["ingredient"]> }) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white px-5 py-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="text-sm text-zinc-500">INCI</div>
      {/* overflow-wrap:anywhere — 복합 발효명 등 공백 없는 긴 "/"-연결 토큰(예 388자)이 CSS 기본
          줄바꿈("/"는 break point 아님)에 안 걸려 가로 오버플로우하던 것 방지(전수 sweep 30,397중 1건). */}
      <div className="text-lg font-semibold text-zinc-900 dark:text-zinc-50 [overflow-wrap:anywhere]">
        {ingredient.inci_name}
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400 sm:grid-cols-4">
        {ingredient.korean_name && (
          <>
            <dt className="text-zinc-400">한글명</dt>
            <dd className="min-w-0 [overflow-wrap:anywhere]">{ingredient.korean_name}</dd>
          </>
        )}
        {ingredient.cas_no && (
          <>
            <dt className="text-zinc-400">CAS</dt>
            <dd className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{ingredient.cas_no}</dd>
          </>
        )}
        {ingredient.chinese_name && (
          <>
            <dt className="text-zinc-400">중국어</dt>
            <dd className="min-w-0 [overflow-wrap:anywhere]">{ingredient.chinese_name}</dd>
          </>
        )}
        {ingredient.japanese_name && (
          <>
            <dt className="text-zinc-400">일본어</dt>
            <dd className="min-w-0 [overflow-wrap:anywhere]">{ingredient.japanese_name}</dd>
          </>
        )}
      </dl>
      {ingredient.function_category && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="inline-block rounded-md bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-800 dark:bg-sky-950/60 dark:text-sky-200">
            {ingredient.function_category}
          </span>
          {ingredient.function_description && (
            <span className="text-xs text-zinc-600 dark:text-zinc-400">
              {ingredient.function_description}
            </span>
          )}
        </div>
      )}
      {ingredient.description && (
        <p className="mt-3 rounded-md bg-zinc-50 px-3 py-2 text-xs leading-relaxed text-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300">
          {ingredient.description}
        </p>
      )}
      {ingredient.synonyms.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
          {ingredient.synonyms.slice(0, 8).map((s) => (
            <span
              key={s}
              className="max-w-full rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-600 [overflow-wrap:anywhere] dark:bg-zinc-800 dark:text-zinc-400"
            >
              {s}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

const COUNTRY_FLAG: Record<string, string> = {
  KR: "🇰🇷",
  CN: "🇨🇳",
  EU: "🇪🇺",
  US: "🇺🇸",
  JP: "🇯🇵",
  VN: "🇻🇳",
  TH: "🇹🇭",
  ID: "🇮🇩",
  MY: "🇲🇾",
  PH: "🇵🇭",
  SG: "🇸🇬",
  TW: "🇹🇼",
  BR: "🇧🇷",
  AR: "🇦🇷",
  CA: "🇨🇦",
  CO: "🇨🇴",
  EC: "🇪🇨",
  PE: "🇵🇪",
  BO: "🇧🇴",
};

// 상태 배지 — ring(테두리)로 강조해 가독성·식별성↑. listed(수록)는 allowed(허용)와 의미가 달라
// sky 색으로 구분. 색상은 위험도 직관: 금지=red·한도=amber·허용=emerald·수록=sky·미수록=slate.
const STATUS_STYLE: Record<string, { label: string; className: string }> = {
  banned: { label: "배합금지", className: "bg-red-100 text-red-900 ring-1 ring-inset ring-red-300 dark:bg-red-950/60 dark:text-red-100 dark:ring-red-800/70" },
  restricted: {
    label: "배합한도",
    className: "bg-amber-100 text-amber-900 ring-1 ring-inset ring-amber-300 dark:bg-amber-950/60 dark:text-amber-100 dark:ring-amber-800/70",
  },
  allowed: {
    label: "허용",
    className: "bg-emerald-100 text-emerald-900 ring-1 ring-inset ring-emerald-300 dark:bg-emerald-950/60 dark:text-emerald-100 dark:ring-emerald-800/70",
  },
  listed: {
    label: "수록 (수출 가능)",
    className: "bg-sky-100 text-sky-900 ring-1 ring-inset ring-sky-300 dark:bg-sky-950/60 dark:text-sky-100 dark:ring-sky-800/70",
  },
  not_listed: {
    label: "미수록 (수출 불가)",
    className: "bg-slate-200 text-slate-800 ring-1 ring-inset ring-slate-300 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-600",
  },
  unknown: {
    label: "분류 확인 필요",
    className: "bg-zinc-100 text-zinc-700 ring-1 ring-inset ring-zinc-300 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-600",
  },
};

// 용도-변종 블록의 좌측 강조선/틴트 — 상태별 색으로 한눈에 위험도 스캔(단조로움 방지).
const STATUS_ACCENT: Record<string, string> = {
  banned: "border-red-400 bg-red-50/50 dark:border-red-700 dark:bg-red-950/20",
  restricted: "border-amber-400 bg-amber-50/50 dark:border-amber-700 dark:bg-amber-950/20",
  allowed: "border-emerald-400 bg-emerald-50/40 dark:border-emerald-700 dark:bg-emerald-950/20",
  listed: "border-sky-400 bg-sky-50/40 dark:border-sky-700 dark:bg-sky-950/20",
  not_listed: "border-slate-300 dark:border-slate-600",
  unknown: "border-zinc-300 dark:border-zinc-600",
};
const accentFor = (s?: string | null) => STATUS_ACCENT[s ?? "unknown"] ?? STATUS_ACCENT.unknown;

// cascade fallback 단계 표시 — 1안(공식)/2안(KCIA)/3안(MFDS) 시각 구분.
// priority 100=공식 1차, 80=KCIA Gemini auto, 그 외=MFDS·기타 보조.
function SourceTier({ priority }: { priority: number | null }) {
  let tier = "3차";
  let title = "MFDS·기타 보조 자료";
  let className = "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
  if (priority != null && priority >= 100) {
    tier = "1차"; title = "해당국 공식 기관 사이트";
    className = "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200";
  } else if (priority != null && priority >= 70) {
    tier = "2차"; title = "KCIA(한국 화장품 협회) — 1안 차단/부재 시 fallback";
    className = "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-200";
  }
  return (
    <span title={title} className={`inline-block rounded px-1 py-px text-[10px] font-medium ${className}`}>
      {tier}
    </span>
  );
}

function CountryCard({ result, bannedElsewhere = [] }: { result: CountryLookupResult; bannedElsewhere?: string[] }) {
  return (
    <article className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <header className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-900 dark:text-zinc-50">
          <span className="text-lg leading-none">{COUNTRY_FLAG[result.country_code] ?? "🏳️"}</span>
          {result.country_name_ko}
          {result.inherits_from && (
            <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs font-normal text-zinc-500 dark:bg-zinc-800">
              {result.inherits_from} 상속
            </span>
          )}
        </div>
        {result.source === "verified" && result.last_verified_at && (
          <span className="text-xs text-zinc-400">🤖 {daysAgo(result.last_verified_at)}</span>
        )}
      </header>

      {/* positive_list / hybrid 국가는 등록 원료 검색 가능 공식 사이트 link 노출.
          예: CN IECIC, EU CosIng, JP PMDA, ASEAN Cosmetic Directive 등.
          미등재 원료는 사용 불가이므로 "공식 등록 목록" 출처 명확화가 필수. */}
      {result.registry_url && (result.regulation_type === "positive_list" || result.regulation_type === "hybrid") && (
        <div className="mb-2 -mt-1 text-[11px]">
          <a
            href={result.registry_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded bg-emerald-50 px-2 py-0.5 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-950/60"
            title="해당국 공식 등록 원료 목록"
          >
            📋 등록 원료 목록 — {result.registry_name ?? "공식 사이트"} ↗
          </a>
        </div>
      )}

      {result.source === "verified" && (
        <div className="space-y-2 text-sm">
          {result.status && (
            <span
              className={`inline-block rounded-md px-2.5 py-1 text-sm font-semibold ${STATUS_STYLE[result.status]?.className ?? ""}`}
            >
              {STATUS_STYLE[result.status]?.label ?? result.status}
            </span>
          )}
          {/* 출처 상충 경고 — 더 엄격한 status 를 주장하는 출처가 있을 때. 자동결정하지 않고(오분류·
              과거한도 잔존 위험) 전문가가 원문 확인하도록 표면화. 컴플라이언스 도구의 핵심 안전장치. */}
          {result.status_conflict && result.status_conflict.statuses.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
              ⚠ 출처 상충 — 다른 출처는{" "}
              <span className="font-semibold">
                {result.status_conflict.statuses.map((s) => STATUS_STYLE[s]?.label ?? s).join(" / ")}
              </span>
              (으)로 분류합니다. 아래 “추가 출처”와 원문을 반드시 확인하세요.
              <ul className="mt-1 space-y-0.5 pl-3">
                {result.status_conflict.sources.map((s, i) => (
                  <li key={i}>· {STATUS_STYLE[s.status]?.label ?? s.status}: {s.source_document ?? "(출처)"}</li>
                ))}
              </ul>
            </div>
          )}
          {/* status 교정 표기 — 자동 파이프라인이 '사용제한 자료' 오분류를 바로잡은 경우 근거 노출
              (무인 운용의 감사·투명성: 사용자가 표기 status 의 출처를 확인 가능). */}
          {result.override_note && /status 교정/.test(result.override_note) && (
            <div className="rounded-md border border-sky-300 bg-sky-50 px-2 py-1 text-xs text-sky-800 dark:border-sky-700/60 dark:bg-sky-950/40 dark:text-sky-200">
              ℹ 자동 교정: {result.override_note}
            </div>
          )}
          {typeof result.max_concentration === "number" ? (
            <div className="text-zinc-700 dark:text-zinc-300">
              최대 배합한도:{" "}
              <span className="rounded-md bg-amber-100 px-1.5 py-0.5 font-bold tabular-nums text-amber-900 dark:bg-amber-950/50 dark:text-amber-100">
                {result.max_concentration}
                {result.concentration_unit ?? "%"}
              </span>
            </div>
          ) : result.conditions && /최대\s*농도|배합\s*한도|\d+(\.\d+)?\s*%/.test(result.conditions) ? (
            // 한도 숫자 필드는 비었지만 사용조건 텍스트에 한도가 있는 경우(제품 유형별로 달라
            // 단일 숫자로 못 담는 케이스 등) — "없음"으로 오인하지 않도록 조건 참조 안내.
            <div className="text-zinc-700 dark:text-zinc-300">
              최대 배합한도:{" "}
              <span className="font-medium text-amber-700 dark:text-amber-300">아래 사용조건 참조 ↓</span>
              <span className="ml-1 text-xs text-zinc-500">(제품 유형·부위별로 상이)</span>
            </div>
          ) : result.adopted_limit ? (
            // EU 채택국(ASEAN/Andean): 자국 한도 없음 → 채택 원천 EU 한도 표시(출처 명시).
            <div className="text-zinc-700 dark:text-zinc-300">
              최대 배합한도:{" "}
              {typeof result.adopted_limit.max_concentration === "number" ? (
                <span className="font-semibold">{result.adopted_limit.max_concentration}{result.adopted_limit.concentration_unit ?? "%"}</span>
              ) : (
                <span className="font-medium text-amber-700 dark:text-amber-300">아래 사용조건 참조 ↓</span>
              )}
              <span className="ml-1 text-xs text-zinc-500">(EU 채택 기준)</span>
            </div>
          ) : null}
          {result.product_categories && result.product_categories.length > 0 && (
            <div className="text-xs text-zinc-500">적용 제품: {result.product_categories.join(", ")}</div>
          )}
          {result.conditions && (
            <details
              open={result.status === "restricted" || result.status === "banned"}
              className="text-xs text-zinc-600 dark:text-zinc-400"
            >
              <summary className="cursor-pointer text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
                조건·비고 보기
              </summary>
              <ConditionBlocks text={result.conditions} />
            </details>
          )}
          {!result.conditions && result.adopted_limit?.conditions && (
            <details open className="text-xs text-zinc-600 dark:text-zinc-400">
              <summary className="cursor-pointer text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
                조건·비고 보기 (EU 채택 기준)
              </summary>
              <ConditionBlocks text={result.adopted_limit.conditions} />
            </details>
          )}
          {result.source_document && (
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
              <span className="text-zinc-400">출처</span>{" "}
              <SourceTier priority={result.source_priority ?? null} />
              {result.source_url ? (
                <a
                  href={result.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-1 underline decoration-dotted hover:text-zinc-900 dark:hover:text-zinc-100"
                >
                  {result.source_document}
                </a>
              ) : (
                <span className="ml-1">{result.source_document}</span>
              )}
            </div>
          )}
          {/* 다른 출처·용도별 규제 — 같은 국가에 용도(제품 유형·사용 부위)별로 다른 한도/제한/금지가
              존재하면 전부 동등하게 펼쳐 표기(헤드라인 하나로 축약 금지). 같은 사실의 보조 출처도
              투명하게 노출(SourceTier 로 신뢰도 구분). 기본 펼침. */}
          {result.all_sources && result.all_sources.length > 1 && (
            <details open className="text-xs text-zinc-600 dark:text-zinc-400">
              <summary className="cursor-pointer text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
                다른 출처·용도별 규제 {result.all_sources.length - 1}건
              </summary>
              <ul className="mt-1.5 space-y-2.5 pl-1">
                {result.all_sources.slice(1).map((s, i) => (
                  <li key={i} className={`space-y-1 rounded-r border-l-[3px] py-1.5 pl-2.5 pr-2 ${accentFor(s.status)}`}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {s.status && (
                        <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[s.status]?.className ?? ""}`}>
                          {STATUS_STYLE[s.status]?.label ?? s.status}
                        </span>
                      )}
                      {typeof s.max_concentration === "number" && (
                        <span className="text-zinc-700 dark:text-zinc-300">최대 배합한도: <span className="rounded bg-amber-100 px-1.5 py-0.5 font-bold tabular-nums text-amber-900 dark:bg-amber-950/50 dark:text-amber-100">{s.max_concentration}{s.concentration_unit ?? "%"}</span></span>
                      )}
                    </div>
                    {s.product_categories && s.product_categories.length > 0 && (
                      <div className="text-xs text-zinc-600 dark:text-zinc-400">적용 제품: <span className="font-medium text-zinc-800 dark:text-zinc-200">{s.product_categories.join(", ")}</span></div>
                    )}
                    {s.conditions && <ConditionBlocks text={s.conditions} />}
                    <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
                      <span className="text-zinc-400">출처</span> <SourceTier priority={s.source_priority} />
                      {s.source_url ? (
                        <a href={s.source_url} target="_blank" rel="noopener noreferrer" className="ml-1 underline decoration-dotted hover:text-zinc-900 dark:hover:text-zinc-100">
                          {s.source_document ?? "(출처)"}
                        </a>
                      ) : (
                        <span className="ml-1">{s.source_document ?? "(출처)"}</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {result.source === "pending" && (
        <div className="space-y-1.5">
          <span className="inline-block rounded-md bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-800 dark:bg-orange-950/60 dark:text-orange-200">
            검토 중
          </span>
          <p className="text-xs text-zinc-500">{humanizeReason(result.pending_reason)}</p>
        </div>
      )}

      {result.source === "not_found" && <NotFoundByRegType result={result} bannedElsewhere={bannedElsewhere} />}

      {result.source_pdfs && result.source_pdfs.length > 0 && (
        <details className="mt-3 text-[11px] text-zinc-600 dark:text-zinc-400">
          <summary className="cursor-pointer text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
            1차 소스 PDF (자동 갱신) {result.source_pdfs.length}건
          </summary>
          <ul className="mt-1.5 space-y-1">
            {result.source_pdfs.map((p) => (
              <li key={p.key} className="flex items-baseline gap-1.5">
                <span className="text-zinc-400 tabular-nums">{p.lang === "en" ? "EN" : p.lang === "ja" ? "JA" : p.lang.toUpperCase()}</span>
                <a
                  href={p.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 text-zinc-700 underline decoration-dotted hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-50"
                >
                  {p.title}
                </a>
                <span className="text-[10px] text-zinc-400">{(p.size_bytes / 1024).toFixed(0)}KB</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {result.kcia_articles && result.kcia_articles.length > 0 && (
        <details className="mt-3 text-[11px] text-zinc-600 dark:text-zinc-400">
          <summary className="cursor-pointer text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
            관련 협회 자료 (KCIA) {result.kcia_articles.length}건
          </summary>
          <ul className="mt-1.5 space-y-2">
            {result.kcia_articles.map((a) => (
              <li key={a.no} className="border-l-2 border-zinc-200 pl-2 dark:border-zinc-800">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-zinc-400 tabular-nums">{a.date}</span>
                  <a
                    href={a.detail_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 text-zinc-700 underline decoration-dotted hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-50"
                  >
                    {a.title}
                  </a>
                </div>
                {a.body_excerpt && (
                  <p className="mt-0.5 text-[10px] text-zinc-500 leading-relaxed line-clamp-3 dark:text-zinc-500">
                    {a.body_excerpt}
                  </p>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[10px] text-zinc-400">
            * 본문 발췌만 표시 — 첨부 PDF 다운로드는 대한화장품협회 회원 로그인 필요
          </p>
        </details>
      )}
    </article>
  );
}

// 조건문 내 한도 수치(%, "1,0 %" 등)를 하이라이트 — 용도별 핵심 제한값이 텍스트에 묻히지 않게.
function highlightLimits(text: string) {
  const parts = text.split(/(\d+(?:[.,]\d+)?\s*%)/g);
  return parts.map((p, i) =>
    /^\d+(?:[.,]\d+)?\s*%$/.test(p) ? (
      <mark
        key={i}
        className="rounded bg-amber-200/80 px-1 font-semibold tabular-nums text-amber-900 dark:bg-amber-500/30 dark:text-amber-100"
      >
        {p}
      </mark>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

function ConditionBlocks({ text }: { text: string }) {
  // 단락 단위(\n\n)로 split. 각 단락 내부 줄바꿈은 whitespace-pre-line 로 보존하되
  // 연속 공백은 압축. "[...]" 로 시작하는 단락은 경고 강조 (banned 일부 조건 등).
  const blocks = text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  return (
    <div className="mt-2 space-y-1.5 text-xs leading-relaxed text-zinc-700 dark:text-zinc-300">
      {blocks.map((b, i) => {
        const isWarning = /^\[/.test(b);
        return (
          <div
            key={i}
            className={
              isWarning
                ? "rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1 text-amber-900 dark:border-amber-600 dark:bg-amber-950/40 dark:text-amber-100 whitespace-pre-line"
                : "whitespace-pre-line"
            }
          >
            {highlightLimits(b)}
          </div>
        );
      })}
    </div>
  );
}

function NotFoundByRegType({ result, bannedElsewhere = [] }: { result: CountryLookupResult; bannedElsewhere?: string[] }) {
  if (result.regulation_type === "positive_list") {
    const listName = result.country_code === "CN" ? "IECIC" : "Positive List";
    return (
      <div className="space-y-1">
        <span className="inline-block rounded-md bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-950/60 dark:text-red-200">
          ⚠ {listName} 등록 여부 확인 필요
        </span>
        <p className="text-[11px] leading-relaxed text-red-700 dark:text-red-300">
          {result.country_name_ko}은(는) <b>positive list</b> 규제 — 목록에 없는 원료는 사용 불가.
          금지 목록 미수록이 곧 사용 가능을 의미하지 않음. 공식 {listName} 등재 여부 반드시 확인.
        </p>
      </div>
    );
  }

  if (result.regulation_type === "hybrid") {
    return (
      <div className="space-y-1">
        <span className="inline-block rounded-md bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950/60 dark:text-amber-200">
          Annex 미수록 (조건부 허용)
        </span>
        <p className="text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-400">
          일반 원료는 허용되지만 <b>보존제·색소·자외선차단제</b> 등 특정 카테고리는 Annex positive
          list 등재가 필요. 해당 카테고리라면 공식 Annex 원문을 확인해야 함.
        </p>
      </div>
    );
  }

  // 이 국가엔 미수록이지만 *여러 국가에서 금지*된 성분이면 — "일반 사용 가능" 안내는 오해를 부른다
  // (소스 커버리지 한계로 미수록일 뿐 실제론 규제 대상일 수 있음). 교차국가 신호로 경고를 표면화.
  // 임계값 ≥3국 — 단일/이중국 금지(niche·단일출처 분류·예: 1국만의 헴프씨드오일 제한)는 흔한 안전
  // 성분에 과다경보가 되므로 제외. EU+ASEAN+Andean 공유 금지목록 등 *다관할* 금지만 경고(분별력).
  if (bannedElsewhere.length >= 3) {
    return (
      <div className="space-y-1">
        <span className="inline-block rounded-md bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950/60 dark:text-amber-200">
          ⚠ 미수록 — 단, 타 국가 금지 성분
        </span>
        <p className="text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
          이 국가의 수집 데이터엔 없으나 <b>{bannedElsewhere.slice(0, 5).join(", ")}{bannedElsewhere.length > 5 ? " 등" : ""}</b>에서 배합금지된 성분입니다.
          미수록이 곧 사용 가능을 의미하지 않으며(소스 커버리지 한계 가능), 공식 원문 확인이 반드시 필요합니다.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <span className="inline-block rounded-md bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200">
        금지·제한 목록 미수록
      </span>
      <p className="text-[11px] text-zinc-500">
        사용제한·금지 데이터에 없음 — 일반 사용 가능 가능성이 높으나, 최종 확인은 공식 원문 권장
      </p>
    </div>
  );
}

function daysAgo(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86400_000);
  if (days === 0) return "오늘 자동 업데이트";
  if (days === 1) return "1일 전 자동 업데이트";
  return `${days}일 전 자동 업데이트`;
}

function humanizeReason(reason?: string): string {
  if (!reason) return "자동 검증 중";
  if (reason.startsWith("model_disagreement:")) return "AI 모델 간 해석이 달라 검증 대기 중";
  if (reason.startsWith("one_model_only_")) return "한 AI 모델만 감지 — 검증 대기 중";
  if (reason.startsWith("outlier_concentration")) return "기존 값 대비 이상 감지 — 검증 대기 중";
  return "검증 대기";
}
