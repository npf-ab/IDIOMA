const CACHE = 'lector-de-v11';
const ASSETS = [
  './', './index.html', './app.js', './manifest.json',
  './data/de-words.json', './data/fr-words.json', './data/it-words.json',
  './data/pt_br-words.json', './data/nl-words.json', './data/ru-words.json',
  './data/ko-words.json', './data/he-words.json', './data/fa-words.json',
  './data/zh-words.json', './data/ja-words.json',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'
];

self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).catch(()=>{}));
  self.skipWaiting();
});

self.addEventListener('activate', e=>{
  e.waitUntil(
    caches.keys().then(keys=> Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e=>{
  e.respondWith(
    caches.match(e.request).then(cached=> cached || fetch(e.request).then(res=>{
      const copy = res.clone();
      caches.open(CACHE).then(c=>c.put(e.request, copy)).catch(()=>{});
      return res;
    }).catch(()=> cached))
  );
});
