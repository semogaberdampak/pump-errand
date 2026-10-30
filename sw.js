/* ============================================================
   sw.js — Service Worker Pencatatan Pemeran (PWA)
   Strategi: network-first untuk navigasi & API, cache-first
   untuk aset statis. Saat offline, halaman tetap terbuka dari
   cache; panggilan Apps Script gagal dengan pesan jelas.
   ============================================================ */
const CACHE = 'pemeran-v1';
const ASSETS = [
  './',
  './pameran.html',
  './manifest.webmanifest',
  './css/tokens.css',
  './css/pameran.css',
  './js/gas.js',
  './js/store.js',
  './js/app.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // POST ke Apps Script selalu langsung jaringan
  const url = new URL(req.url);

  // Navigasi: network-first, fallback cache (offline tetap bisa buka)
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(() => caches.match('./pameran.html'))
    );
    return;
  }

  // Aset sama-origin: cache-first lalu isi cache
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(req).then((hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(req, clone));
          }
          return res;
        }).catch(() => caches.match('./pameran.html'))
      )
    );
  }
});
