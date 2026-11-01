/* ============================================================
   sw.js — Service Worker Pencatatan Pameran (PWA)
   Strategi:
   - Navigasi & file aplikasi (html/css/js): NETWORK-FIRST, lalu cache
     bila offline. Perubahan kode langsung terpakai tanpa menaikkan
     nomor cache; offline tetap bisa dibuka dari cache terakhir.
   - vendor/ (library besar & tidak berubah): cache-first.
   - POST ke Apps Script selalu langsung ke jaringan.
   Instalasi toleran: satu file gagal di-cache tidak membatalkan SW.
   ============================================================ */
const CACHE = 'pameran-v6';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/tokens.css',
  './css/pameran.css',
  './js/gas.js',
  './js/store.js',
  './js/sync.js',
  './js/scanner.js',
  './js/app.js',
  './vendor/html5-qrcode.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(ASSETS.map((a) =>
        c.add(new Request(a, { cache: 'reload' })).catch(() => console.warn('SW: tidak bisa menyimpan', a)))))
      .then(() => self.skipWaiting())
  );
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
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Library vendor: cache-first
  if (url.pathname.includes('/vendor/')) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const k = res.clone(); caches.open(CACHE).then((c) => c.put(req, k)); }
        return res;
      }))
    );
    return;
  }

  // Lainnya: network-first (selalu validasi ke server), cache sebagai cadangan offline
  e.respondWith(
    (req.mode === 'navigate' ? fetch(req) : fetch(req, { cache: 'no-cache' }))
      .then((res) => {
        if (res.ok) { const k = res.clone(); caches.open(CACHE).then((c) => c.put(req, k)); return res; }
        return caches.match(req).then((hit) => hit || res);
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});
