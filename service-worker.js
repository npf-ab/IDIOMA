const CACHE = 'lector-de-v17';
const ASSETS = [
  './', './index.html', './app.js', './manifest.json',
  './data/de-words.json', './data/fr-words.json', './data/it-words.json',
  './data/pt_br-words.json', './data/nl-words.json', './data/ru-words.json',
  './data/ko-words.json', './data/he-words.json', './data/fa-words.json',
  './data/zh-words.json', './data/ja-words.json',
  './data/gloss-de.json', './data/gloss-fr.json', './data/gloss-ja.json', './data/gloss-zh.json', './data/gloss-pt.json',
  './data/verbs-de.json', './data/verbs-fr.json', './data/verbs-it.json',
  './data/verbs-pt.json', './data/verbs-nl.json',
  './data/expr-de.json', './data/expr-fr.json', './data/expr-it.json',
  './data/expr-pt.json', './data/expr-nl.json',
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
