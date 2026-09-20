/* =====================================================
   lo-fi radio · офлайн
   Радио не тянет аудио из сети вообще: движок и шрифты — это
   всё, что нужно. Поэтому после первого захода страница работает
   без интернета, а установленная — как обычное приложение.

   Стратегии:
   - переход по адресу — сеть, при офлайне отдаём кэш;
   - код движка и таблица шрифтов — отдаём из кэша и тихо обновляем;
   - шрифты, иконки, энкодер — только из кэша (это неизменяемое).
   ===================================================== */
const CACHE = 'lofi-v2';

const CORE = [
  './radio.html',
  './lofi-processor.js',
  './plugins/mastering.js',
  './fonts/fonts.css',
  './fonts/nunito-latin.woff2',
  './fonts/nunito-cyrillic.woff2',
  './fonts/baloo-2-latin.woff2',
  './fonts/caveat-latin.woff2',
  './fonts/caveat-cyrillic.woff2',
  './manifest.webmanifest',
  './og.png',
  './stations/index.html',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

// Живой код: важно не застрять на старой версии, поэтому обновляем в фоне
const FRESH = ['/lofi-processor.js', '/plugins/mastering.js', '/fonts/fonts.css'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(CORE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Переход по адресу: свежая страница, а без сети — из кэша
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./radio.html', copy));
          return res;
        })
        .catch(() => caches.match('./radio.html')),
    );
    return;
  }

  // Код движка: кэш сразу, обновление — параллельно
  if (FRESH.some((f) => url.pathname.endsWith(f))) {
    e.respondWith(
      caches.match(req).then((hit) => {
        const net = fetch(req)
          .then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
            return res;
          })
          .catch(() => hit);
        return hit || net;
      }),
    );
    return;
  }

  // Всё остальное неизменяемое: шрифты, иконки, энкодер
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    })),
  );
});
