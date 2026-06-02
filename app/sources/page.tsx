"use client";

import { useEffect, useState } from "react";
import { dataset, type Meta } from "@/lib/data-loader";

// 데이터 갱신 상태 표시. Supabase regulation_sources 테이블 의존 제거 —
// public/data/meta.json 의 generated_at 만 노출. 변경 감지·승인 흐름은
// 인제스트 (scripts/*) 시점에서 처리되며 결과는 정적 데이터에 반영.

export default function SourcesPage() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    dataset()
      .then((ds) => setMeta(ds.meta))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
          데이터 상태
        </h1>
        <p className="mt-1 text-sm text-zinc-500">
          정적 데이터 번들 — 사용자 브라우저는 public/data/*.json 만 읽고 검색은 인메모리.
          데이터 갱신은 빌드 시점.
        </p>
      </header>

      {error && (
        <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </div>
      )}

      {loading && <p className="text-sm text-zinc-500">로딩 중…</p>}

      {meta && (
        <section className="space-y-4">
          <div className="rounded-lg border border-zinc-200 bg-white px-5 py-4 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="text-sm text-zinc-500">데이터 빌드 시점 (generated_at)</div>
            <div className="text-lg font-mono text-zinc-900 dark:text-zinc-50">
              {new Date(meta.generated_at).toLocaleString("ko-KR")}
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              브라우저는 ETag/Last-Modified 로 자동 비교 — 데이터 파일이 변경된 경우에만 다운로드.
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Card label="원료 (ingredients)" value={meta.counts.ingredients} />
            <Card label="규제 (regulations, active)" value={meta.counts.regulations} />
            <Card label="국가 (countries)" value={meta.counts.countries} />
            <Card label="검토 대기 (quarantine pending)" value={meta.counts.quarantine_pending} />
          </div>
        </section>
      )}

      <footer className="mt-12 border-t border-zinc-200 pt-6 text-xs text-zinc-500 dark:border-zinc-800">
        Phase 5b — 검색 path·데이터 갱신 path 모두 100% 로컬 (Supabase·서버 의존 0). 데이터 갱신은
        운영자가 인제스트 파이프라인(<code className="mx-1">npm run mfds:ingest</code> 등)으로 수행.
      </footer>
    </main>
  );
}

function Card({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-5 py-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50 tabular-nums">
        {value.toLocaleString("ko-KR")}
      </div>
    </div>
  );
}
