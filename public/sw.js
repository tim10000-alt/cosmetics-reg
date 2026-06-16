// 서비스워커 — 첫 사용 후 오프라인 동작.
// 전략:
//   - 네비게이션(HTML): network-first → 실패 시 캐시 → 그래도 없으면 캐시된 시작 페이지.
//   - /_next/static/·/icons/ (해시·불변): cache-first.
//   - /data/*.json (대용량 데이터): stale-while-revalidate (캐시 즉시 + 백그라운드 갱신).
//   - 기타 동일 출처 GET: stale-while-revalidate.
// raw-pdf/docx/zip 등 원문서는 런타임에 안 받으므로 자연히 캐시 안 됨(캐시 비대화 방지).
//
// 캐시 버전을 올리면(아래 CACHE) 구버전 캐시는 activate 에서 정리된다.
const CACHE = "cosmetics-reg-v1";
// SW 가 서빙되는 위치 기준 scope (하위경로 배포 시 "/cosmetics-reg/" 가 됨).
const SCOPE = new URL(self.registration.scope).pathname;

self.addEventListener("install", (event) => {
  // 시작 페이지는 미리 받아 둬서 첫 오프라인 진입 보장.
  event.waitUntil(
    caches.open(CACHE).then((c) => c.add(new Request(SCOPE, { cache: "reload" })).catch(() => {})),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

function isStatic(url) {
  return url.pathname.includes("/_next/static/") || url.pathname.includes("/icons/");
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res && res.ok && res.type === "basic") cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || (await network) || new Response("offline", { status: 503 });
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone());
  return res;
}

async function networkFirstNav(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req)) || (await cache.match(SCOPE)) || new Response("offline", { status: 503 });
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 외부 출처는 SW 가 손대지 않음

  if (req.mode === "navigate") {
    event.respondWith(networkFirstNav(req));
  } else if (isStatic(url)) {
    event.respondWith(cacheFirst(req));
  } else {
    event.respondWith(staleWhileRevalidate(req));
  }
});
