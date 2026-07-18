/* ===================== Configuración de idiomas ===================== */
const LANGUAGES = {
  es: { label:'Español',              file:'es-words.json',    tts:'es-ES', script:'latin' },
  de: { label:'Alemán',              file:'de-words.json',    tts:'de-DE', script:'latin' },
  fr: { label:'Francés',             file:'fr-words.json',    tts:'fr-FR', script:'latin' },
  it: { label:'Italiano',            file:'it-words.json',    tts:'it-IT', script:'latin' },
  pt: { label:'Portugués (Brasil)',  file:'pt_br-words.json', tts:'pt-BR', script:'latin' },
  nl: { label:'Holandés',            file:'nl-words.json',    tts:'nl-NL', script:'latin' },
  ru: { label:'Ruso',                file:'ru-words.json',    tts:'ru-RU', script:'cyrillic' },
  ko: { label:'Coreano',             file:'ko-words.json',    tts:'ko-KR', script:'hangul' },
  he: { label:'Hebreo',              file:'he-words.json',    tts:'he-IL', script:'hebrew', rtl:true },
  fa: { label:'Persa (Farsi)',       file:'fa-words.json',    tts:'fa-IR', script:'persian', rtl:true },
  zh: { label:'Chino',               file:'zh-words.json',    tts:'zh-CN', script:'cjk' },
  ja: { label:'Japonés',             file:'ja-words.json',    tts:'ja-JP', script:'cjk' }
};

const SCRIPT_RANGES = {
  latin:    'A-Za-zÀ-ÖØ-öø-ÿ',
  cyrillic: 'А-Яа-яЁё',
  hangul:   '\\uAC00-\\uD7A3',
  hebrew:   '\\u0590-\\u05FF',
  persian:  '\\u0600-\\u06FF\\u0750-\\u077F'
};
const CJK_RUN_RE = /[\u4E00-\u9FFF\u3040-\u30FF]+/g;

/* ===================== Almacenamiento chico (localStorage) ===================== */
const DB = {
  get(key, fallback){
    try{ const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch(e){ return fallback; }
  },
  set(key, val){
    try{ localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch(e){ console.error('Error guardando', key, e); return false; }
  }
};

let wordCounts = DB.get('wordCounts', {});
(function migrateOldCounts(){
  let changed = false;
  Object.keys(wordCounts).forEach(k=>{
    if (!k.includes(':')){
      wordCounts['de:' + k] = (wordCounts['de:' + k] || 0) + wordCounts[k];
      delete wordCounts[k];
      changed = true;
    }
  });
  if (changed) DB.set('wordCounts', wordCounts);
})();

// booksMeta: datos LIVIANOS por libro -> { id: {title, lang, addedAt, wordCount, scrollPos, bookmarks:[]} }
// El contenido HTML pesado vive en IndexedDB, no aquí.
let booksMeta = DB.get('booksMeta', {});
let translationCache = DB.get('translationCache', {});
let favorites = DB.get('favorites', {});     // { "lang:word": true }
let wordNotes = DB.get('wordNotes', {});     // { "lang:word": "texto de la nota" }

function isFavorite(lang, word){ return !!favorites[lang + ':' + word]; }
function toggleFavorite(lang, word){
  const k = lang + ':' + word;
  if (favorites[k]) delete favorites[k]; else favorites[k] = true;
  DB.set('favorites', favorites);
}
function getNote(lang, word){ return wordNotes[lang + ':' + word] || ''; }
function setNote(lang, word, text){
  const k = lang + ':' + word;
  if (text && text.trim()) wordNotes[k] = text.trim(); else delete wordNotes[k];
  DB.set('wordNotes', wordNotes);
}

function saveMeta(){ DB.set('booksMeta', booksMeta); }
function saveCounts(){ DB.set('wordCounts', wordCounts); }
function saveTranslations(){ DB.set('translationCache', translationCache); }

/* ===================== Almacenamiento grande (IndexedDB) para el contenido de los libros ===================== */
const IDB_NAME = 'lector-idiomas-content';
const IDB_STORE = 'chunks';
let _idbPromise = null;
function openContentDB(){
  if (_idbPromise) return _idbPromise;
  _idbPromise = new Promise((resolve, reject)=>{
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = ()=>{ req.result.createObjectStore(IDB_STORE, { keyPath:'id' }); };
    req.onsuccess = ()=> resolve(req.result);
    req.onerror = ()=> reject(req.error);
  });
  return _idbPromise;
}
async function idbPutContent(id, htmlChunks){
  const db = await openContentDB();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put({ id, htmlChunks });
    tx.oncomplete = ()=> resolve();
    tx.onerror = ()=> reject(tx.error);
  });
}
async function idbGetContent(id){
  const db = await openContentDB();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(id);
    req.onsuccess = ()=> resolve(req.result ? req.result.htmlChunks : null);
    req.onerror = ()=> reject(req.error);
  });
}
async function idbDeleteContent(id){
  const db = await openContentDB();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(id);
    tx.oncomplete = ()=> resolve();
    tx.onerror = ()=> reject(tx.error);
  });
}
async function idbGetAllContent(){
  const db = await openContentDB();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).getAll();
    req.onsuccess = ()=> resolve(req.result || []);
    req.onerror = ()=> reject(req.error);
  });
}

// Migración: versiones viejas de la app guardaban TODO (incluido el contenido pesado) en localStorage bajo 'books'.
// Eso llenaba la cuota rápido. Migramos lo liviano a booksMeta y lo pesado a IndexedDB, y liberamos el espacio viejo.
async function migrateLegacyBooks(){
  const legacy = DB.get('books', null);
  if (!legacy) return;
  for (const [id, b] of Object.entries(legacy)){
    try{
      if (!booksMeta[id]){
        booksMeta[id] = {
          title: b.title || 'Libro sin título', lang: b.lang || 'de', addedAt: b.addedAt || Date.now(),
          wordCount: b.wordCount || 0, scrollPos: b.scrollPos || 0, bookmarks: b.bookmarks || []
        };
      }
      if (b.htmlChunks && b.htmlChunks.length) await idbPutContent(id, b.htmlChunks);
    } catch(e){ console.warn('No se pudo migrar el libro', id, e); }
  }
  saveMeta();
  localStorage.removeItem('books');
}

/* ===================== Selector de idioma (importar + practicar) ===================== */
const langSelect = document.getElementById('langSelect');
langSelect.innerHTML = Object.entries(LANGUAGES).map(([code,l])=>
  `<option value="${code}">${l.label}</option>`).join('');
langSelect.value = DB.get('targetLang', 'de');
langSelect.addEventListener('change', ()=> DB.set('targetLang', langSelect.value));

const reviewLangFilter = document.getElementById('reviewLangFilter');
reviewLangFilter.innerHTML = `<option value="">Todos los idiomas</option>` +
  Object.entries(LANGUAGES).map(([code,l])=>`<option value="${code}">${l.label}</option>`).join('');

// El repaso tipo Anki solo existe para los idiomas donde tenemos tu diccionario propio
// (o, en su defecto, mientras tanto cae en la lista de frecuencia como respaldo).
const SRS_LANGS = ['de','fr','it','pt','zh','ja'];
const srsLangSelect = document.getElementById('srsLangSelect');
srsLangSelect.innerHTML = SRS_LANGS.map(code=>`<option value="${code}">${LANGUAGES[code].label}</option>`).join('');
srsLangSelect.value = SRS_LANGS.includes(langSelect.value) ? langSelect.value : 'de';

// Verbos y expresiones solo existen para estos 5 idiomas (los de mayor confianza)
const VOCAB_LANGS = ['de','fr','it','pt','nl'];
const vocabLangSelect = document.getElementById('vocabLangSelect');
vocabLangSelect.innerHTML = VOCAB_LANGS.map(code=>`<option value="${code}">${LANGUAGES[code].label}</option>`).join('');
vocabLangSelect.value = VOCAB_LANGS.includes(langSelect.value) ? langSelect.value : 'de';

const dictadoLangSelect = document.getElementById('dictadoLangSelect');
dictadoLangSelect.innerHTML = Object.entries(LANGUAGES).map(([code,l])=>`<option value="${code}">${l.label}</option>`).join('');
dictadoLangSelect.value = langSelect.value;

/* ===================== Diccionarios de idioma ===================== */
let esSet = null; // ya no se usa para filtrar, se deja por compatibilidad si se necesita en el futuro
const dictCache = {};
// Las palabras MÁS comunes de cualquier idioma (artículos, pronombres, conjunciones, verbos
// auxiliares...) casi seguro ya las conoces — resaltarlas solo ensucia la pantalla. Las excluimos.
// Todo lo demás se asume del idioma seleccionado (ya no comparamos contra español).
const SKIP_TOP_N = 300;

async function loadTargetDict(langCode){
  if (dictCache[langCode]) return dictCache[langCode];
  const arr = await fetch('data/' + LANGUAGES[langCode].file).then(r=>r.json());
  const set = new Set(arr);               // vocabulario completo (para segmentar chino/japonés)
  const commonSet = new Set(arr.slice(0, SKIP_TOP_N)); // palabras comunes a NO resaltar
  const maxLen = arr.reduce((m,w)=>Math.max(m,w.length), 1);
  dictCache[langCode] = { arr, set, commonSet, maxLen };
  return dictCache[langCode];
}

function normalize(word){ return word.toLowerCase().replace(/[’'‘]/g,"'"); }

// Palabras "comunes" (azul) necesitan 20 toques para dejar de resaltarse.
// Palabras normales siguen la escala naranja(0-1)/amarillo(2-6)/crema(7-12)/sin color(13+).
function levelClassFor(count, isCommon){
  if (isCommon) return count >= 20 ? null : 'lvl-blue';
  if (count >= 13) return null;
  if (count >= 7) return 'lvl-3';
  if (count >= 2) return 'lvl-2';
  return 'lvl-1';
}

// Para saber si una palabra es "común" fuera del libro (en Progreso/Practicar) necesitamos
// su diccionario cargado; se carga bajo demanda y se cachea en dictCache.
function isCommonWord(lang, word){
  const d = dictCache[lang];
  return !!(d && d.commonSet && d.commonSet.has(word));
}
async function ensureDictsFor(langs){
  await Promise.all(Array.from(langs).map(l => LANGUAGES[l] ? loadTargetDict(l).catch(()=>null) : null));
}
function escapeHtml(s){ return s.replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/* ===================== Parseo del EPUB ===================== */
const IMG_MIME = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', svg:'image/svg+xml', webp:'image/webp', bmp:'image/bmp' };

function resolveRelPath(baseDir, relPath){
  relPath = relPath.split('#')[0]; // quitar ancla si la hay
  if (/^https?:\/\//.test(relPath) || relPath.startsWith('data:')) return null;
  if (relPath.startsWith('/')) relPath = relPath.slice(1);
  const parts = (baseDir + relPath).split('/');
  const stack = [];
  for (const p of parts){
    if (p === '..') stack.pop();
    else if (p === '' || p === '.') continue;
    else stack.push(p);
  }
  return stack.join('/');
}

// Convierte cada <img>/<image> del capítulo a data-uri base64, para que las imágenes
// del epub se vean sin depender de archivos externos.
async function inlineImages(doc, zip, baseDir){
  const nodes = Array.from(doc.querySelectorAll('img, image'));
  for (const node of nodes){
    const isSvgImage = node.tagName.toLowerCase() === 'image';
    const srcAttr = isSvgImage ? (node.getAttribute('xlink:href') || node.getAttribute('href')) : node.getAttribute('src');
    if (!srcAttr || srcAttr.startsWith('data:')) continue;
    const path = resolveRelPath(baseDir, srcAttr);
    if (!path) continue;
    const zf = zip.file(path) || zip.file(decodeURIComponent(path));
    if (!zf) continue;
    try{
      const ext = (path.split('.').pop() || '').toLowerCase();
      const mime = IMG_MIME[ext] || 'image/jpeg';
      const base64 = await zf.async('base64');
      const dataUri = `data:${mime};base64,${base64}`;
      if (isSvgImage){ node.setAttribute('xlink:href', dataUri); node.setAttribute('href', dataUri); }
      else node.setAttribute('src', dataUri);
    } catch(e){ /* si una imagen falla, seguimos sin ella */ }
  }
}

// Extrae la tabla de contenidos real del epub (EPUB3 <nav epub:type="toc"> o EPUB2 toc.ncx),
// y la asocia al índice del capítulo (archivo) del spine al que apunta cada entrada.
async function parseEpubToc(opfDoc, opfDir, zip, fullHrefs){
  const entries = [];

  // EPUB3: buscar el item del manifest marcado con properties="nav"
  let navItem = null;
  opfDoc.querySelectorAll('manifest > item').forEach(item=>{
    const props = (item.getAttribute('properties') || '').split(/\s+/);
    if (props.includes('nav')) navItem = item;
  });

  if (navItem){
    try{
      const navFullPath = opfDir + navItem.getAttribute('href');
      const navBaseDir = navFullPath.includes('/') ? navFullPath.slice(0, navFullPath.lastIndexOf('/')+1) : '';
      const zf = zip.file(navFullPath) || zip.file(decodeURIComponent(navFullPath));
      if (zf){
        const raw = await zf.async('string');
        const navDoc = new DOMParser().parseFromString(raw, 'text/html');
        const navEl = Array.from(navDoc.querySelectorAll('nav')).find(n=>{
          const t = n.getAttribute('epub:type') || n.getAttribute('type') || '';
          return t.includes('toc');
        }) || navDoc.querySelector('nav');
        if (navEl){
          navEl.querySelectorAll('a[href]').forEach(a=>{
            const t = a.textContent.replace(/\s+/g,' ').trim();
            const href = a.getAttribute('href');
            if (t && href) entries.push({ title: t, path: resolveRelPath(navBaseDir, href) });
          });
        }
      }
    } catch(e){ /* seguir sin índice si algo falla */ }
  }

  // EPUB2: si no encontramos nada, intentar toc.ncx
  if (entries.length === 0){
    try{
      const spineEl = opfDoc.querySelector('spine');
      const tocId = spineEl ? spineEl.getAttribute('toc') : null;
      let ncxHref = null;
      opfDoc.querySelectorAll('manifest > item').forEach(item=>{
        if (tocId && item.getAttribute('id') === tocId) ncxHref = opfDir + item.getAttribute('href');
        if (!ncxHref && (item.getAttribute('media-type')||'').includes('ncx')) ncxHref = opfDir + item.getAttribute('href');
      });
      if (ncxHref){
        const zf = zip.file(ncxHref) || zip.file(decodeURIComponent(ncxHref));
        if (zf){
          const raw = await zf.async('string');
          const ncxDoc = new DOMParser().parseFromString(raw, 'application/xml');
          const baseDir = ncxHref.includes('/') ? ncxHref.slice(0, ncxHref.lastIndexOf('/')+1) : '';
          ncxDoc.querySelectorAll('navPoint').forEach(np=>{
            const label = np.querySelector('navLabel > text');
            const content = np.querySelector('content');
            if (label && content){
              const src = content.getAttribute('src');
              entries.push({ title: label.textContent.replace(/\s+/g,' ').trim(), path: resolveRelPath(baseDir, src) });
            }
          });
        }
      }
    } catch(e){ /* seguir sin índice si algo falla */ }
  }

  // Asociar cada entrada al índice del capítulo (archivo) correspondiente en el spine
  const seen = new Set();
  return entries.map(e=>{
    const filePart = e.path ? e.path.split('#')[0] : null;
    const chunkIndex = fullHrefs.indexOf(filePart);
    return { title: e.title, chunkIndex };
  }).filter(e=>{
    if (e.chunkIndex === -1) return false;
    if (seen.has(e.chunkIndex)) return false; // solo la primera entrada por capítulo
    seen.add(e.chunkIndex);
    return true;
  });
}

async function parseEpub(file){
  const zip = await JSZip.loadAsync(file);
  const containerXml = await zip.file('META-INF/container.xml').async('string');
  const containerDoc = new DOMParser().parseFromString(containerXml, 'application/xml');
  const opfPath = containerDoc.querySelector('rootfile').getAttribute('full-path');
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')+1) : '';

  const opfXml = await zip.file(opfPath).async('string');
  const opfDoc = new DOMParser().parseFromString(opfXml, 'application/xml');

  let title = opfDoc.querySelector('metadata > *|title, metadata title');
  title = title ? title.textContent : file.name.replace(/\.epub$/i,'');

  const manifest = {};
  opfDoc.querySelectorAll('manifest > item').forEach(item=>{
    manifest[item.getAttribute('id')] = item.getAttribute('href');
  });
  const spineIds = Array.from(opfDoc.querySelectorAll('spine > itemref')).map(el=>el.getAttribute('idref'));
  const hrefs = spineIds.map(id=>manifest[id]).filter(Boolean);
  const fullHrefs = hrefs.map(h => opfDir + h);

  const htmlChunks = [];
  for (const href of hrefs){
    const fullPath = opfDir + href;
    const zf = zip.file(fullPath) || zip.file(decodeURIComponent(fullPath));
    if (!zf) continue;
    const raw = await zf.async('string');
    const doc = new DOMParser().parseFromString(raw, 'text/html');
    const baseDir = fullPath.includes('/') ? fullPath.slice(0, fullPath.lastIndexOf('/')+1) : '';
    await inlineImages(doc, zip, baseDir);
    const body = doc.body ? doc.body.innerHTML : raw;
    htmlChunks.push(body);
  }

  const toc = await parseEpubToc(opfDoc, opfDir, zip, fullHrefs);
  return { title, htmlChunks, toc };
}

/* ===================== Tokenización, oraciones, segmentación CJK y resaltado ===================== */
const BLOCK_SELECTOR = 'p, li, blockquote, h1, h2, h3, h4, h5, h6, td, dd, dt';

function splitSentences(text){
  const parts = text.match(/[^.!?…。！？]+[.!?…。！？]*(\s+|$)/g);
  return parts && parts.length ? parts : [text];
}

// Segmentación por "maximum matching hacia adelante" para chino/japonés (sin espacios entre palabras)
function segmentCJKRun(run, dict){
  const tokens = [];
  let i = 0;
  while (i < run.length){
    let matchedLen = 0;
    const maxTry = Math.min(dict.maxLen, run.length - i);
    for (let len = maxTry; len >= 1; len--){
      if (dict.set.has(run.substr(i, len))){ matchedLen = len; break; }
    }
    if (matchedLen === 0) matchedLen = 1;
    tokens.push(run.substr(i, matchedLen));
    i += matchedLen;
  }
  return tokens;
}

// Nota: el color NO se guarda fijo en el HTML — se recalcula cada vez que abres el libro,
// según cuántas veces HAS TOCADO esa palabra (ver applyHighlighting()). La marca "w-common"
// sí se guarda al importar, porque no cambia (depende del idioma, no de tu progreso).
function wordHtml(word, key, sessionCounts, isCommon){
  sessionCounts[key] = (sessionCounts[key] || 0) + 1;
  return `<span class="w-de${isCommon ? ' w-common' : ''}" data-w="${escapeHtml(key)}">${escapeHtml(word)}</span>`;
}

function buildSentenceHtml(sentence, sessionCounts, commonHits, dict, langCode, script){
  let html = '';
  if (script === 'cjk'){
    let lastIndex = 0, m;
    CJK_RUN_RE.lastIndex = 0;
    while ((m = CJK_RUN_RE.exec(sentence))){
      if (m.index > lastIndex) html += escapeHtml(sentence.slice(lastIndex, m.index));
      const tokens = segmentCJKRun(m[0], dict);
      tokens.forEach(tok=>{
        const isCommon = dict.commonSet.has(tok);
        if (isCommon) commonHits.add(tok);
        html += wordHtml(tok, tok, sessionCounts, isCommon);
      });
      lastIndex = m.index + m[0].length;
    }
    if (lastIndex < sentence.length) html += escapeHtml(sentence.slice(lastIndex));
    return html;
  }

  const wordRe = new RegExp('[' + SCRIPT_RANGES[script] + ']+', 'g');
  let lastIndex = 0, m;
  wordRe.lastIndex = 0;
  while ((m = wordRe.exec(sentence))){
    const word = m[0];
    const start = m.index, end = start + word.length;
    if (start > lastIndex) html += escapeHtml(sentence.slice(lastIndex, start));
    const key = normalize(word);
    if (key.length >= 2){
      const isCommon = dict.commonSet.has(key);
      if (isCommon) commonHits.add(key);
      html += wordHtml(word, key, sessionCounts, isCommon);
    } else {
      html += escapeHtml(word);
    }
    lastIndex = end;
  }
  if (lastIndex < sentence.length) html += escapeHtml(sentence.slice(lastIndex));
  return html;
}

function highlightHtmlChunk(html, sessionCounts, commonHits, dict, langCode, script, sentenceCounter){
  const container = document.createElement('div');
  container.innerHTML = html;
  let blocks = Array.from(container.querySelectorAll(BLOCK_SELECTOR));
  if (blocks.length === 0) blocks = [container];

  blocks.forEach(el=>{
    const text = el.textContent;
    if (!text || !text.trim()) return;
    const sentences = splitSentences(text);
    el.innerHTML = sentences.map(s=>{
      const inner = buildSentenceHtml(s, sessionCounts, commonHits, dict, langCode, script);
      const sidx = sentenceCounter.n++;
      return `<span class="sentence" data-sidx="${sidx}">${inner}</span>`;
    }).join('');
  });
  return container.innerHTML;
}

/* ===================== Flujo principal: importar libro ===================== */
async function importEpub(file){
  const langCode = langSelect.value;
  const script = LANGUAGES[langCode].script;
  showLoading('Leyendo el EPUB…');
  try{
    const dict = await loadTargetDict(langCode);
    const { title, htmlChunks, toc } = await parseEpub(file);
    showLoading('Detectando palabras en ' + LANGUAGES[langCode].label + '…');

    const sessionCounts = {};
    const commonHits = new Set();
    const sentenceCounter = { n: 0 };
    const chunkStartSidx = [];
    const processedChunks = htmlChunks.map(chunk => {
      chunkStartSidx.push(sentenceCounter.n);
      return highlightHtmlChunk(chunk, sessionCounts, commonHits, dict, langCode, script, sentenceCounter);
    });
    // Ya NO sumamos estas ocurrencias al progreso automáticamente: el conteo (y el color)
    // solo sube cuando TÚ tocas la palabra mientras lees (ver el listener de clic más abajo).

    const chapterToc = (toc || []).map(t => ({ title: t.title, startSidx: chunkStartSidx[t.chunkIndex] }));

    const id = 'b_' + Date.now();
    showLoading('Guardando el libro…');
    await idbPutContent(id, processedChunks);
    booksMeta[id] = {
      title, addedAt: Date.now(), lang: langCode, scrollPos: 0, bookmarks: [], toc: chapterToc,
      uniqueWords: Object.keys(sessionCounts),      // todas las palabras distintas del libro
      commonWords: Array.from(commonHits)            // cuáles de esas son "comunes" (umbral 20)
    };
    saveMeta();

    renderBookList();
    hideLoading();
    openReader(id);
  } catch(err){
    hideLoading();
    alert('No se pudo procesar el archivo. Verifica que sea un .epub válido.\n\n' + err.message);
    console.error(err);
  }
}

/* ===================== UI: navegación entre pantallas ===================== */
const screens = {
  home: document.getElementById('home'),
  reader: document.getElementById('readerScreen'),
  stats: document.getElementById('statsScreen'),
  review: document.getElementById('reviewScreen'),
  srs: document.getElementById('srsScreen'),
  srsStats: document.getElementById('srsStatsScreen'),
  verbs: document.getElementById('verbsScreen'),
  expr: document.getElementById('exprScreen'),
  dictado: document.getElementById('dictadoScreen')
};
const headerTitle = document.getElementById('headerTitle');
const backBtn = document.getElementById('backBtn');
const statsBtn = document.getElementById('statsBtn');
const readerEl = document.getElementById('reader');

function showScreen(name, title){
  Object.values(screens).forEach(s=>s.classList.remove('active'));
  screens[name].classList.add('active');
  headerTitle.textContent = title;
  backBtn.style.visibility = name === 'home' ? 'hidden' : 'visible';
  statsBtn.style.visibility = name === 'home' ? 'visible' : 'hidden';
  if (name !== 'reader') stopPointer();
  screens[name].scrollTop = 0;
}
backBtn.addEventListener('click', ()=> { saveCurrentScroll(); showScreen('home', 'Mis libros'); });
statsBtn.addEventListener('click', renderStats);

// Calcula, en vivo, cuántas palabras del libro ya "sabes" (según tu progreso actual)
function bookProgress(meta){
  const words = meta.uniqueWords || [];
  const total = words.length;
  if (!total) return null;
  const commonSet = new Set(meta.commonWords || []);
  let known = 0;
  words.forEach(k=>{
    const count = wordCounts[meta.lang + ':' + k] || 0;
    const threshold = commonSet.has(k) ? 20 : 13;
    if (count >= threshold) known++;
  });
  const unknownPct = Math.round(100 * (total - known) / total);
  return { total, known, unknownPct };
}

function renderBookList(){
  const list = document.getElementById('bookList');
  const ids = Object.keys(booksMeta).sort((a,b)=> booksMeta[b].addedAt - booksMeta[a].addedAt);
  if (ids.length === 0){
    list.innerHTML = '<div class="empty">Aún no has agregado ningún libro.</div>';
    return;
  }
  list.innerHTML = ids.map(id=>{
    const b = booksMeta[id];
    const date = new Date(b.addedAt).toLocaleDateString('es-MX', {day:'numeric', month:'short'});
    const langLabel = (LANGUAGES[b.lang] || {label:'?'}).label;
    const prog = bookProgress(b);
    const progText = prog ? ` · ${prog.total} palabras · ${prog.known} conocidas · ${prog.unknownPct}% por aprender` : '';
    return `<div class="booklist-item">
      <div class="open-book" data-id="${id}" style="flex:1;cursor:pointer;">
        <div class="title">${escapeHtml(b.title)}<span class="book-lang-tag">${langLabel}</span></div>
        <div class="meta">${date}${progText}${b.scrollPos ? ' · en progreso' : ''}</div>
      </div>
      <button class="del-book btn-danger" data-id="${id}" style="background:none;border:none;font-size:18px;padding:6px 10px;">🗑</button>
    </div>`;
  }).join('');
  list.querySelectorAll('.open-book').forEach(el=> el.addEventListener('click', ()=> openReader(el.dataset.id)));
  list.querySelectorAll('.del-book').forEach(el=> el.addEventListener('click', async (e)=>{
    e.stopPropagation();
    if (confirm('¿Eliminar este libro de tu biblioteca? (tu progreso de palabras NO se pierde)')){
      delete booksMeta[el.dataset.id];
      saveMeta();
      await idbDeleteContent(el.dataset.id);
      renderBookList();
    }
  }));
}

let currentBookId = null, currentBookLang = 'de';

// Recorre las palabras del libro abierto y les pone el color según cuántas veces
// las has TOCADO hasta ahora (no según cuántas veces aparecen en el texto).
function applyHighlighting(){
  readerEl.querySelectorAll('.w-de').forEach(span=>{
    const key = span.dataset.w;
    const isCommon = span.classList.contains('w-common');
    const count = wordCounts[currentBookLang + ':' + key] || 0;
    const cls = levelClassFor(count, isCommon);
    span.className = 'w-de' + (isCommon ? ' w-common' : '') + (cls ? ' ' + cls : '');
  });
}

async function openReader(id){
  const meta = booksMeta[id];
  if (!meta){ alert('No se encontró ese libro.'); return; }
  showLoading('Abriendo libro…');
  const chunks = await idbGetContent(id);
  hideLoading();
  if (!chunks){ alert('El contenido de este libro no se encontró (puede haberse perdido en una versión anterior). Intenta volver a importarlo.'); return; }

  currentBookId = id;
  currentBookLang = meta.lang || 'de';
  readerEl.innerHTML = chunks.join('<hr style="border:none;border-top:1px solid var(--border);margin:2em 0;">');
  readerEl.setAttribute('dir', (LANGUAGES[currentBookLang]||{}).rtl ? 'rtl' : 'ltr');
  applyHighlighting();
  renderBookmarkFlags();
  pointerWrapped = false;
  pointerAllUnits = [];
  showScreen('reader', meta.title);
  requestAnimationFrame(()=>{
    setReaderScrollPos(meta.scrollPos || 0);
  });
}

/* ===================== Modo de lectura: vertical (scroll) ===================== */
function getReaderScrollPos(){
  return readerEl.scrollTop;
}
function setReaderScrollPos(v){
  readerEl.scrollTop = v;
}

let scrollSaveTimer = null;
function onReaderScroll(){
  if (!currentBookId) return;
  clearTimeout(scrollSaveTimer);
  scrollSaveTimer = setTimeout(saveCurrentScroll, 400);
}
// (el scroll ahora ocurre siempre dentro de #reader, no en el contenedor externo)
readerEl.addEventListener('scroll', onReaderScroll);
function saveCurrentScroll(){
  if (!currentBookId || !booksMeta[currentBookId]) return;
  booksMeta[currentBookId].scrollPos = getReaderScrollPos();
  saveMeta();
}


/* ===================== Estadísticas ===================== */
async function renderStats(){
  showLoading('Calculando tu progreso…');
  const langsInUse = Array.from(new Set(Object.keys(wordCounts).map(k=>k.split(':')[0]))).sort();
  await ensureDictsFor(langsInUse);

  // Agrupar por idioma en vez de mezclarlo todo
  const byLang = {};
  langsInUse.forEach(l=> byLang[l] = { entries: [], blueProgress:0, blueMastered:0, regNew:0, regLearn:0, regReview:0, regMastered:0 });
  Object.entries(wordCounts).forEach(([k,c])=>{
    const [lang, w] = k.split(':');
    if (!byLang[lang]) return;
    byLang[lang].entries.push([w,c]);
    if (isCommonWord(lang, w)){
      if (c >= 20) byLang[lang].blueMastered++; else byLang[lang].blueProgress++;
    } else {
      if (c >= 13) byLang[lang].regMastered++;
      else if (c >= 7) byLang[lang].regReview++;
      else if (c >= 2) byLang[lang].regLearn++;
      else byLang[lang].regNew++;
    }
  });

  const el = document.getElementById('stats');
  const resetBtnHtml = `
    <div style="margin:16px;">
      <button class="btn-secondary btn-danger" id="resetProgressBtn" style="width:100%;">🗑 Reiniciar todo el progreso</button>
    </div>`;

  if (langsInUse.length === 0){
    el.innerHTML = resetBtnHtml + '<div class="empty">Todavía no has tocado palabras en ningún idioma.</div>';
  } else {
    const langBlocks = langsInUse.map(lang=>{
      const d = byLang[lang];
      const langLabel = (LANGUAGES[lang]||{label:lang}).label;
      const sorted = d.entries.sort((a,b)=> b[1]-a[1]);
      return `
        <div class="section-title" style="display:flex;justify-content:space-between;align-items:center;margin-right:16px;">
          <span>${langLabel}</span>
          <button class="btn-danger reset-lang-btn" data-lang="${lang}" style="background:none;border:1px solid var(--border);border-radius:14px;padding:4px 10px;font-size:11px;">🗑 Reiniciar solo ${langLabel}</button>
        </div>
        <div class="card" style="background:var(--panel);border-radius:14px;padding:16px;margin:0 16px 10px;">
          <div class="statrow"><span>🔵 Comunes en progreso (&lt;20 toques)</span><b>${d.blueProgress}</b></div>
          <div class="statrow"><span>✅ Comunes dominadas (20+)</span><b>${d.blueMastered}</b></div>
          <div class="statrow"><span>🟠 Nuevas / vistas 1 vez</span><b>${d.regNew}</b></div>
          <div class="statrow"><span>🟡 En aprendizaje (2-6)</span><b>${d.regLearn}</b></div>
          <div class="statrow"><span>⬜ Repaso (7-12)</span><b>${d.regReview}</b></div>
          <div class="statrow"><span>✅ Dominadas (13+)</span><b>${d.regMastered}</b></div>
        </div>
        <div class="card" style="margin:0 16px 16px;">
          ${sorted.map(([w,c])=>{
            const common = isCommonWord(lang, w);
            const fav = isFavorite(lang, w);
            const note = getNote(lang, w);
            return `<div class="statrow"><span>${fav?'⭐ ':''}${escapeHtml(w)}${common?' <span style="color:var(--accent);font-size:11px">· común</span>':''}${note?` <span style="color:var(--sub);font-size:11px">· 📝 ${escapeHtml(note)}</span>`:''}</span><span style="color:var(--sub)">${c}×</span></div>`;
          }).join('')}
        </div>`;
    }).join('');
    el.innerHTML = resetBtnHtml + langBlocks;
  }

  document.querySelectorAll('.reset-lang-btn').forEach(btn=>{
    btn.addEventListener('click', (e)=>{
      e.stopPropagation();
      const lang = btn.dataset.lang;
      const langLabel = (LANGUAGES[lang]||{label:lang}).label;
      if (confirm(`Esto borra el progreso SOLO de ${langLabel} (naranja/amarillo/crema/azul). Tus libros y otros idiomas no se tocan. ¿Continuar?`)){
        Object.keys(wordCounts).forEach(k=>{ if (k.startsWith(lang+':')) delete wordCounts[k]; });
        saveCounts();
        renderStats();
      }
    });
  });

  document.getElementById('resetProgressBtn').addEventListener('click', ()=>{
    if (confirm('Esto borra el conteo de todas tus palabras vistas (naranja/amarillo/crema/azul) en todos los idiomas. Tus libros no se borran. ¿Continuar?')){
      wordCounts = {};
      saveCounts();
      renderStats();
    }
  });
  hideLoading();
  showScreen('stats', 'Tu progreso');
}

/* ===================== Modo repaso / practicar ===================== */
document.getElementById('openReviewBtn').addEventListener('click', renderReview);
async function renderReview(){
  showLoading('Cargando…');
  const filterLang = reviewLangFilter.value;
  const langsInUse = filterLang ? [filterLang] : Array.from(new Set(Object.keys(wordCounts).map(k=>k.split(':')[0])));
  await ensureDictsFor(langsInUse);

  const entries = Object.entries(wordCounts).filter(([k,c])=>{
    const [lang, w] = k.split(':');
    if (filterLang && lang !== filterLang) return false;
    if (isCommonWord(lang, w)) return c >= 1 && c < 20;   // comunes: en progreso hasta 20
    return c >= 2 && c <= 12;                              // normales: amarillo/crema
  }).sort((a,b)=> b[1]-a[1]);
  hideLoading();

  const el = document.getElementById('reviewList');
  if (entries.length === 0){
    el.innerHTML = '<div class="empty">No tienes palabras en progreso todavía para este filtro. ¡Sigue leyendo y tocando palabras!</div>';
  } else {
    el.innerHTML = entries.map(([k,c])=>{
      const [lang, w] = k.split(':');
      const langLabel = (LANGUAGES[lang]||{label:lang}).label;
      const common = isCommonWord(lang, w);
      const goal = common ? 20 : 13;
      return `<div class="review-item" data-lang="${lang}" data-word="${escapeHtml(w)}">
        <div>
          <div class="rw">${escapeHtml(w)}${common ? ' <span style="color:var(--accent);font-size:11px">● común</span>' : ''}</div>
          <div class="rmeta">${langLabel} · consultada ${c} de ${goal} · <span class="rtrans">toca 🔊 para traducir</span></div>
        </div>
        <button class="rspeak" style="background:var(--accent);color:#fff;border:none;border-radius:20px;padding:8px 14px;">🔊</button>
      </div>`;
    }).join('');
    el.querySelectorAll('.review-item').forEach(item=>{
      item.querySelector('.rspeak').addEventListener('click', async ()=>{
        const lang = item.dataset.lang, w = item.dataset.word;
        speak(w, lang, 0.85);
        const transEl = item.querySelector('.rtrans');
        transEl.textContent = 'traduciendo…';
        const t = await fetchTranslationRaw(w, lang);
        transEl.textContent = t ? ('➜ ' + t) : 'sin traducción';
      });
    });
  }
  showScreen('review', 'Practicar');
}

/* ===================== Repetición espaciada (top 3000 palabras, estilo Anki) ===================== */
// Guardamos, por "lang:palabra", el estado de repaso: {interval (días), ease, due (timestamp), reps}
let srsCards = DB.get('srsCards', {});
function saveSrs(){ DB.set('srsCards', srsCards); }

function srsSchedule(card, rating){ // rating: 0=otra vez,1=difícil,2=bien,3=fácil
  if (rating === 0){
    card.reps = 0;
    card.interval = 0;
    card.ease = Math.max(1.3, card.ease - 0.2);
    card.due = Date.now() + 10*60*1000; // vuelve a aparecer en 10 minutos
    return;
  }
  card.reps = (card.reps || 0) + 1;
  if (card.reps === 1) card.interval = 1;
  else if (card.reps === 2) card.interval = 3;
  else card.interval = Math.max(1, Math.round(card.interval * card.ease));

  if (rating === 1){ card.ease = Math.max(1.3, card.ease - 0.15); card.interval = Math.max(1, Math.round(card.interval*0.8)); }
  if (rating === 3){ card.ease = card.ease + 0.15; card.interval = Math.round(card.interval*1.3); }
  card.due = Date.now() + card.interval*24*60*60*1000;
}

let srsSession = { lang: 'de', queue: [], idx: 0, revealed: false };

document.getElementById('openSrsBtn').addEventListener('click', startSrsSession);

// Progreso del repaso tipo Anki — usa SOLO srsCards, nunca wordCounts (el de los libros).
// "Madura" (dominada) = intervalo de 21+ días, como el criterio estándar de Anki.
const SRS_MATURE_DAYS = 21;
document.getElementById('openSrsStatsBtn').addEventListener('click', async ()=>{
  const lang = srsLangSelect.value;
  showLoading('Calculando progreso de ' + LANGUAGES[lang].label + '…');
  try{
    const deck = await loadSrsDeckWords(lang);
    hideLoading();
    renderSrsStats(lang, deck.words);
  } catch(err){
    hideLoading();
    alert('No se pudo cargar el diccionario de ' + LANGUAGES[lang].label + '.');
    console.error(err);
  }
});

function renderSrsStats(lang, top3000){
  const now = Date.now();
  let notStarted=0, learning=0, mature=0, dueNow=0;
  top3000.forEach(w=>{
    const c = srsCards[lang + ':' + w];
    if (!c){ notStarted++; return; }
    if (c.interval >= SRS_MATURE_DAYS) mature++; else learning++;
    if (c.due <= now) dueNow++;
  });

  const el = document.getElementById('srsStatsContent');
  el.innerHTML = `
    <div class="card" style="background:var(--panel);border-radius:14px;padding:16px;margin-bottom:14px;">
      <div class="statrow"><span>⚪ Sin empezar</span><b>${notStarted}</b></div>
      <div class="statrow"><span>🟡 En aprendizaje</span><b>${learning}</b></div>
      <div class="statrow"><span>✅ Maduras (21+ días)</span><b>${mature}</b></div>
      <div class="statrow"><span>📌 Pendientes hoy</span><b>${dueNow}</b></div>
      <div class="statrow" style="border-bottom:none;"><span>Total del mazo</span><b>${top3000.length}</b></div>
    </div>
    <div style="font-size:12px;color:var(--sub);">Este progreso es solo de las tarjetas de repaso (estilo Anki) — es independiente de las palabras que resaltas al leer tus libros.</div>`;
  showScreen('srsStats', '📊 Progreso Anki · ' + LANGUAGES[lang].label);
}

// Devuelve la lista de palabras del mazo: prioriza TU diccionario (más rico y con traducción
// confiable); si no existe para ese idioma, cae de vuelta a las 3000 más frecuentes.
async function loadSrsDeckWords(lang){
  const gloss = await loadGloss(lang);
  if (gloss && Object.keys(gloss).length > 0){
    return { words: Object.keys(gloss), source: 'gloss' };
  }
  const dict = await loadTargetDict(lang);
  return { words: dict.arr.slice(0, 3000), source: 'freq' };
}

async function startSrsSession(){
  const lang = srsLangSelect.value;
  showLoading('Preparando repaso de ' + LANGUAGES[lang].label + '…');
  let deck;
  try{
    deck = await loadSrsDeckWords(lang);
  } catch(err){
    hideLoading();
    alert('No se pudo cargar el diccionario de ' + LANGUAGES[lang].label + '.');
    console.error(err);
    return;
  }
  const top3000 = deck.words;

  const now = Date.now();
  const due = top3000.filter(w=>{
    const c = srsCards[lang + ':' + w];
    return !c || c.due <= now;
  });
  // Nuevas primero pocas por sesión para no abrumar; máximo 30 tarjetas por sesión
  due.sort((a,b)=>{
    const ca = srsCards[lang+':'+a], cb = srsCards[lang+':'+b];
    return (ca?1:0) - (cb?1:0); // las que ya tienen historial primero (repasos pendientes), nuevas al final
  });
  const session = due.slice(0, 30);
  hideLoading();

  if (session.length === 0){
    alert('¡No tienes tarjetas pendientes de ' + LANGUAGES[lang].label + ' por ahora! Vuelve más tarde.');
    return;
  }
  srsSession = { lang, queue: session, idx: 0, revealed: false };
  renderSrsCard();
  showScreen('srs', '📇 Repaso · ' + LANGUAGES[lang].label);
}

async function renderSrsCard(){
  const el = document.getElementById('srsContent');
  if (srsSession.idx >= srsSession.queue.length){
    el.innerHTML = `<div class="empty">🎉 Terminaste esta sesión de repaso.</div>
      <button class="btn" style="width:100%" onclick="showScreen('home','Mis libros')">Volver a Libros</button>`;
    return;
  }
  const word = srsSession.queue[srsSession.idx];
  const lang = srsSession.lang;
  srsSession.revealed = false;

  el.innerHTML = `
    <div class="srs-progress">Tarjeta ${srsSession.idx + 1} de ${srsSession.queue.length}</div>
    <div class="srs-card">
      <div class="srs-word">${escapeHtml(word)}</div>
      <div id="srsAnswerArea"></div>
    </div>
    <button class="srs-show" id="srsShowBtn">👁 Mostrar respuesta</button>
    <div class="srs-rate-row" id="srsRateRow" style="display:none;margin-top:10px;">
      <button class="srs-again" data-r="0">Otra vez</button>
      <button class="srs-hard" data-r="1">Difícil</button>
      <button class="srs-good" data-r="2">Bien</button>
      <button class="srs-easy" data-r="3">Fácil</button>
    </div>`;

  speak(word, lang, 0.85);

  document.getElementById('srsShowBtn').addEventListener('click', async ()=>{
    srsSession.revealed = true;
    document.getElementById('srsShowBtn').style.display = 'none';
    document.getElementById('srsRateRow').style.display = 'flex';
    const answerArea = document.getElementById('srsAnswerArea');
    answerArea.innerHTML = '<div class="srs-answer">Traduciendo…</div>';
    const t = await fetchSrsTranslation(word, lang);
    answerArea.innerHTML = `<div class="srs-answer">➜ ${t ? escapeHtml(t) : 'sin traducción disponible'}</div>`;
  });

  document.getElementById('srsRateRow').querySelectorAll('button').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const rating = parseInt(btn.dataset.r, 10);
      const key = lang + ':' + word;
      const card = srsCards[key] || { interval:0, ease:2.5, due:Date.now(), reps:0 };
      srsSchedule(card, rating);
      srsCards[key] = card;
      saveSrs();
      srsSession.idx++;
      renderSrsCard();
    });
  });
}

/* ===================== Verbos conjugados ===================== */
const TENSE_LABELS = { presente:'Presente', pasado:'Pasado', futuro:'Futuro' };
const verbDataCache = {};
async function loadVerbData(lang){
  if (verbDataCache[lang]) return verbDataCache[lang];
  const data = await fetch(`data/verbs-${lang}.json`).then(r=>r.json());
  verbDataCache[lang] = data;
  return data;
}

document.getElementById('openVerbsBtn').addEventListener('click', async ()=>{
  const lang = vocabLangSelect.value;
  showLoading('Cargando verbos…');
  try{
    const data = await loadVerbData(lang);
    hideLoading();
    renderVerbList(lang, data);
    showScreen('verbs', '📖 Verbos · ' + LANGUAGES[lang].label);
  } catch(err){
    hideLoading();
    alert('No se pudieron cargar los verbos de ' + LANGUAGES[lang].label + '.\n\nFalta el archivo data/verbs-' + lang + '.json en tu sitio — revisa que lo hayas subido a GitHub.\n\nDetalle técnico: ' + err.message);
    console.error(err);
  }
});

function renderVerbList(lang, data){
  const el = document.getElementById('verbsContent');
  const infinitives = Object.keys(data.verbs).sort();
  el.innerHTML = `
    <input type="text" id="verbSearch" class="dict-input" style="margin-top:0;min-height:auto;padding:10px;" placeholder="🔍 Buscar verbo o traducción…">
    <div style="font-size:12px;color:var(--sub);margin:8px 0 4px;">${infinitives.length} verbos</div>
    <div id="verbListBody"></div>`;

  const renderRows = (filter='')=>{
    const f = filter.trim().toLowerCase();
    const filtered = infinitives.filter(inf=>{
      if (!f) return true;
      const es = (data.verbs[inf].es || '').toLowerCase();
      return inf.toLowerCase().includes(f) || es.includes(f);
    });
    const body = document.getElementById('verbListBody');
    body.innerHTML = filtered.length ? filtered.map(inf=>{
      const es = data.verbs[inf].es || '';
      return `<div class="verb-item" data-inf="${escapeHtml(inf)}">
        <span class="vw">${escapeHtml(inf)}</span>${es ? `<span class="vt"> — ${escapeHtml(es)}</span>` : ''}
      </div>`;
    }).join('') : '<div class="empty">Sin resultados.</div>';
    body.querySelectorAll('.verb-item').forEach(item=>{
      item.addEventListener('click', ()=> renderVerbDetail(lang, data, item.dataset.inf));
    });
  };
  renderRows();
  document.getElementById('verbSearch').addEventListener('input', (e)=> renderRows(e.target.value));
}

function renderVerbDetail(lang, data, inf){
  const el = document.getElementById('verbsContent');
  const persons = data.persons;
  const conj = data.verbs[inf];
  const es = conj.es || '';
  const tenseBlocks = Object.keys(TENSE_LABELS).map(tense=>{
    const forms = conj[tense];
    const rows = persons.map((p,i)=> `<tr>
        <td class="pcell">${escapeHtml(p)}</td>
        <td>${escapeHtml(forms[i])} <button data-say="${escapeHtml(forms[i])}">🔊</button></td>
      </tr>`).join('');
    return `<div class="biglabel" style="margin-top:18px;">${TENSE_LABELS[tense]}</div>
      <table class="conj-table"><tbody>${rows}</tbody></table>`;
  }).join('');

  el.innerHTML = `
    <a class="back-link" id="verbBackLink">‹ Todos los verbos</a>
    <div class="verb-detail-head">
      <div class="srs-word" style="text-align:left;margin:0;">${escapeHtml(inf)}</div>
      ${es ? `<div class="verb-detail-es">${escapeHtml(es)}</div>` : ''}
      <button data-say="${escapeHtml(inf)}" class="verb-detail-play">🔊 Escuchar infinitivo</button>
    </div>
    ${tenseBlocks}`;
  document.getElementById('verbBackLink').addEventListener('click', ()=> renderVerbList(lang, data));
  el.querySelectorAll('button[data-say]').forEach(btn=>{
    btn.addEventListener('click', ()=> speak(btn.dataset.say, lang, 0.8));
  });
}

/* ===================== Expresiones comunes ===================== */
const exprDataCache = {};
async function loadExprData(lang){
  if (exprDataCache[lang]) return exprDataCache[lang];
  const data = await fetch(`data/expr-${lang}.json`).then(r=>r.json());
  exprDataCache[lang] = data;
  return data;
}

document.getElementById('openExprBtn').addEventListener('click', async ()=>{
  const lang = vocabLangSelect.value;
  showLoading('Cargando expresiones…');
  try{
    const data = await loadExprData(lang);
    hideLoading();
    renderExprList(lang, data);
    showScreen('expr', '💬 Expresiones · ' + LANGUAGES[lang].label);
  } catch(err){
    hideLoading();
    alert('No se pudieron cargar las expresiones de ' + LANGUAGES[lang].label + '.\n\nFalta el archivo data/expr-' + lang + '.json en tu sitio — revisa que lo hayas subido a GitHub.\n\nDetalle técnico: ' + err.message);
    console.error(err);
  }
});

function renderExprList(lang, data){
  const el = document.getElementById('exprContent');
  el.innerHTML = `
    <input type="text" id="exprSearch" class="dict-input" style="margin-top:0;min-height:auto;padding:10px;" placeholder="🔍 Buscar frase o traducción…">
    <div id="exprListBody"></div>`;

  const renderRows = (filter='')=>{
    const f = filter.trim().toLowerCase();
    const filtered = data.filter(item=> !f ||
      item.phrase.toLowerCase().includes(f) || item.translation.toLowerCase().includes(f));
    const body = document.getElementById('exprListBody');
    body.innerHTML = filtered.length ? filtered.map(item=>`
      <div class="expr-item">
        <div>
          <div class="ep">${escapeHtml(item.phrase)}</div>
          <div class="et">${escapeHtml(item.translation)}</div>
        </div>
        <button data-say="${escapeHtml(item.phrase)}">🔊</button>
      </div>`).join('') : '<div class="empty">Sin resultados.</div>';
    body.querySelectorAll('button[data-say]').forEach(btn=>{
      btn.addEventListener('click', ()=> speak(btn.dataset.say, lang, 0.8));
    });
  };
  renderRows();
  document.getElementById('exprSearch').addEventListener('input', (e)=> renderRows(e.target.value));
}

/* ===================== Dictado ===================== */
// Junta oraciones "razonables" (ni muy cortas ni kilométricas) de todos los libros
// que tengas en ese idioma, para usarlas como ejercicio de dictado.
async function collectDictadoSentences(lang){
  const ids = Object.keys(booksMeta).filter(id => booksMeta[id].lang === lang);
  const SKIP_WORDS = 1000; // se salta portada/prólogo/presentación de cada libro

  async function gather(skipWords){
    const seen = new Set();
    const sentences = [];
    for (const id of ids){
      const chunks = await idbGetContent(id);
      if (!chunks) continue;
      const container = document.createElement('div');
      container.innerHTML = chunks.join(' ');
      let wordCount = 0;
      container.querySelectorAll('.sentence').forEach(sEl=>{
        const text = sEl.textContent.replace(/\s+/g, ' ').trim();
        wordCount += text.split(' ').filter(Boolean).length;
        if (wordCount < skipWords) return;
        const len = text.length;
        if (len < 20 || len > 160) return;
        if (seen.has(text)) return;
        seen.add(text);
        sentences.push(text);
      });
    }
    return sentences;
  }

  let sentences = await gather(SKIP_WORDS);
  // Si ningún libro llega a 1000 palabras (libros cortos), no saltamos nada en vez de quedarnos sin frases
  if (sentences.length === 0) sentences = await gather(0);

  // barajar (Fisher-Yates) y tomar 10
  for (let i = sentences.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [sentences[i], sentences[j]] = [sentences[j], sentences[i]];
  }
  return sentences.slice(0, 10);
}

let dictadoSession = { lang:'de', sentences:[], idx:0, correctCount:0 };

document.getElementById('openDictadoBtn').addEventListener('click', async ()=>{
  const lang = dictadoLangSelect.value;
  showLoading('Buscando frases de tus libros…');
  const sentences = await collectDictadoSentences(lang);
  hideLoading();
  if (sentences.length === 0){
    alert('No encontré frases utilizables en tus libros de ' + LANGUAGES[lang].label + '. Necesitas al menos un libro importado en ese idioma con oraciones de largo normal.');
    return;
  }
  dictadoSession = { lang, sentences, idx:0, correctCount:0 };
  renderDictadoQuestion();
  showScreen('dictado', '✍️ Dictado · ' + LANGUAGES[lang].label);
});

function normDictWord(w){ return w.toLowerCase().replace(/[.,;:!?¿¡"'«»()]/g, ''); }

function diffDictado(userText, correctText){
  const userWords = userText.trim().split(/\s+/).filter(Boolean);
  const correctWords = correctText.trim().split(/\s+/).filter(Boolean);
  const maxLen = Math.max(userWords.length, correctWords.length);
  let html = '';
  let allOk = userWords.length === correctWords.length;
  for (let i = 0; i < maxLen; i++){
    const uw = userWords[i];
    const cw = correctWords[i];
    const ok = uw !== undefined && cw !== undefined && normDictWord(uw) === normDictWord(cw);
    if (!ok) allOk = false;
    if (uw !== undefined) html += `<span class="${ok?'dict-ok':'dict-wrong'}">${escapeHtml(uw)}</span> `;
  }
  return { html, allOk };
}

function renderDictadoQuestion(){
  const s = dictadoSession;
  const el = document.getElementById('dictadoContent');
  if (s.idx >= s.sentences.length){
    el.innerHTML = `
      <div class="empty">🎉 Terminaste: ${s.correctCount} de ${s.sentences.length} correctas.</div>
      <button class="btn" style="width:100%" onclick="showScreen('home','Mis libros')">Volver a Libros</button>`;
    return;
  }
  const sentence = s.sentences[s.idx];
  el.innerHTML = `
    <div class="srs-progress">Frase ${s.idx + 1} de ${s.sentences.length}</div>
    <div class="srs-card">
      <button class="dict-play" id="dictPlayBtn">🔊</button>
    </div>
    <textarea class="dict-input" id="dictInput" placeholder="Escribe lo que escuchaste…"></textarea>
    <button class="srs-show" id="dictCheckBtn" style="margin-top:12px;">Comprobar</button>
    <div id="dictResult" style="margin-top:16px;font-size:16px;line-height:1.6;"></div>`;

  const playSentence = ()=> speak(sentence, s.lang, 0.8);
  document.getElementById('dictPlayBtn').addEventListener('click', playSentence);
  playSentence();

  document.getElementById('dictCheckBtn').addEventListener('click', ()=>{
    const userText = document.getElementById('dictInput').value;
    const { html, allOk } = diffDictado(userText, sentence);
    if (allOk) s.correctCount++;
    document.getElementById('dictResult').innerHTML = `
      <div style="margin-bottom:10px;">${allOk ? '✅ ¡Correcto!' : '❌ Tu respuesta:'} <br>${html}</div>
      ${allOk ? '' : `<div style="color:var(--sub);">Frase correcta:<br><b style="color:var(--text);">${escapeHtml(sentence)}</b></div>`}
      <button class="srs-show" id="dictNextBtn" style="margin-top:14px;">Siguiente ›</button>`;
    document.getElementById('dictCheckBtn').style.display = 'none';
    document.getElementById('dictInput').disabled = true;
    document.getElementById('dictNextBtn').addEventListener('click', ()=>{
      s.idx++;
      renderDictadoQuestion();
    });
  });
}

/* ===================== Popup de palabra: traducción + pronunciación ===================== */
const popup = document.getElementById('popup');
let lastSpokenText = '', lastSpokenLang = 'de';

readerEl.addEventListener('click', (e)=>{
  const span = e.target.closest('.w-de');
  if (!span) return;
  const key = span.dataset.w;
  const display = span.textContent;

  // Tocar la palabra = "no la reconocí, la consulté". Esto es lo único que suma al progreso.
  const langKey = currentBookLang + ':' + key;
  wordCounts[langKey] = (wordCounts[langKey] || 0) + 1;
  saveCounts();
  applyHighlighting(); // el color de TODAS las apariciones de esta palabra se actualiza al instante

  const c = wordCounts[langKey];
  document.getElementById('popWord').textContent = display;
  document.getElementById('popCount').textContent = `Consultada ${c} ${c===1?'vez':'veces'} en total`;
  document.getElementById('popTranslation').textContent = 'Traduciendo…';
  popup.classList.add('show');
  speak(display, currentBookLang, 0.85);
  lastSpokenText = display; lastSpokenLang = currentBookLang;
  popup._word = key; popup._lang = currentBookLang;

  const favBtn = document.getElementById('popFav');
  favBtn.classList.toggle('fav-on', isFavorite(currentBookLang, key));
  document.getElementById('popNote').value = getNote(currentBookLang, key);

  fetchTranslationRaw(key, currentBookLang).then(t=>{
    if (document.getElementById('popWord').textContent === display){
      document.getElementById('popTranslation').textContent = t ? ('➜ ' + t) : 'Sin traducción disponible';
    }
  });

  const sentenceEl = span.closest('.sentence');
  popup._sentenceText = sentenceEl ? sentenceEl.textContent.trim() : display;
});
document.getElementById('popClose').addEventListener('click', ()=> popup.classList.remove('show'));
document.getElementById('popFav').addEventListener('click', ()=>{
  if (!popup._word) return;
  toggleFavorite(popup._lang, popup._word);
  document.getElementById('popFav').classList.toggle('fav-on', isFavorite(popup._lang, popup._word));
});
document.getElementById('popNoteSave').addEventListener('click', ()=>{
  if (!popup._word) return;
  setNote(popup._lang, popup._word, document.getElementById('popNote').value);
  const btn = document.getElementById('popNoteSave');
  const original = btn.textContent;
  btn.textContent = '✓';
  setTimeout(()=> btn.textContent = original, 900);
});
document.getElementById('popSpeak').addEventListener('click', ()=>{
  const w = document.getElementById('popWord').textContent;
  speak(w, currentBookLang, 0.85);
  lastSpokenText = w; lastSpokenLang = currentBookLang;
});
document.getElementById('popSpeakSlow').addEventListener('click', ()=>{
  speak(lastSpokenText, lastSpokenLang, 0.4);
});
document.getElementById('popSpeakSentence').addEventListener('click', ()=>{
  if (popup._sentenceText){
    speak(popup._sentenceText, currentBookLang, 0.85);
    lastSpokenText = popup._sentenceText; lastSpokenLang = currentBookLang;
  }
});

// Diccionarios de glosa en inglés (de las hojas de cálculo que me pasaste) — SOLO se usan en la
// sección de repetición espaciada (Anki), no en la traducción de lecturas ni en modo práctica.
const GLOSS_LANGS = ['de','fr','ja','zh','pt','it'];
const glossCache = {};
async function loadGloss(langCode){
  if (!GLOSS_LANGS.includes(langCode)) return null;
  if (glossCache[langCode]) return glossCache[langCode];
  try{
    const data = await fetch(`data/gloss-${langCode}.json`).then(r=>r.json());
    glossCache[langCode] = data;
    return data;
  } catch(e){ return null; }
}

// Traducción normal (lecturas, modo práctica) — SIN CAMBIOS respecto a como estaba.
async function fetchTranslationRaw(key, langCode){
  const cacheKey = langCode + ':' + key;
  if (translationCache[cacheKey]) return translationCache[cacheKey];
  try{
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(key)}&langpair=${langCode}|es`;
    const res = await fetch(url);
    const data = await res.json();
    let translated = data && data.responseData && data.responseData.translatedText;
    if (translated){
      translated = translated.charAt(0).toLowerCase() + translated.slice(1);
      translationCache[cacheKey] = translated;
      saveTranslations();
      return translated;
    }
  } catch(e){ /* sin conexión */ }
  return null;
}

// Traducción SOLO para las tarjetas de Anki: usa tu diccionario de glosa en inglés cuando existe
// (mucho más confiable), y si no hay glosa para esa palabra, cae de vuelta al traductor directo.
async function fetchSrsTranslation(key, langCode){
  const cacheKey = 'srs:' + langCode + ':' + key;
  if (translationCache[cacheKey]) return translationCache[cacheKey];

  const gloss = await loadGloss(langCode);
  let queryText = key, queryLang = langCode, glossEntry = null;
  if (gloss){
    glossEntry = gloss[key] || gloss[key.charAt(0).toUpperCase()+key.slice(1)] || null; // alemán capitaliza sustantivos
    if (glossEntry && glossEntry.en){
      queryText = glossEntry.en;
      queryLang = 'en';
    }
  }
  try{
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(queryText)}&langpair=${queryLang}|es`;
    const res = await fetch(url);
    const data = await res.json();
    let translated = data && data.responseData && data.responseData.translatedText;
    if (translated){
      translated = translated.charAt(0).toLowerCase() + translated.slice(1);
      if (queryLang === 'en' && glossEntry) translated = `${translated} (${glossEntry.en})`;
      translationCache[cacheKey] = translated;
      saveTranslations();
      return translated;
    }
  } catch(e){ /* sin conexión */ }
  return null;
}

/* ===================== Voz (pronunciación) ===================== */
function speak(text, langCode, rate){
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const ttsLang = (LANGUAGES[langCode] || LANGUAGES.de).tts;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = ttsLang;
  const voices = window.speechSynthesis.getVoices();
  const match = voices.find(v=>v.lang === ttsLang) || voices.find(v=>v.lang && v.lang.startsWith(langCode));
  if (match) u.voice = match;
  u.rate = rate || 0.85;
  window.speechSynthesis.speak(u);
  return u;
}
if ('speechSynthesis' in window){ window.speechSynthesis.onvoiceschanged = ()=>{}; }

/* ===================== Marcadores ===================== */
const bookmarksPanel = document.getElementById('bookmarksPanel');
document.getElementById('bookmarkBtn').addEventListener('click', ()=>{
  if (!currentBookId) return;
  const b = booksMeta[currentBookId];
  b.bookmarks = b.bookmarks || [];

  // Buscar la primera oración visible en pantalla para "anclar" el marcador ahí
  const readerRect = screens.reader.getBoundingClientRect();
  const visibleSentence = Array.from(readerEl.querySelectorAll('.sentence[data-sidx]')).find(el=>{
    const r = el.getBoundingClientRect();
    return r.bottom > readerRect.top;
  });
  const sidx = visibleSentence ? visibleSentence.dataset.sidx : null;

  b.bookmarks.push({ id: 'm_'+Date.now(), sidx, scrollPos: getReaderScrollPos(), createdAt: Date.now() });
  saveMeta();
  renderBookmarkFlags();
  const btn = document.getElementById('bookmarkBtn');
  const original = btn.textContent;
  btn.textContent = '✅ Marcado';
  setTimeout(()=> btn.textContent = original, 1200);
});

// Dibuja el 🔖 justo antes de la oración marcada, para verla al pasar por ahí leyendo
function renderBookmarkFlags(){
  readerEl.querySelectorAll('.bookmark-flag').forEach(f=> f.remove());
  const b = booksMeta[currentBookId];
  if (!b || !b.bookmarks) return;
  b.bookmarks.forEach(m=>{
    if (m.sidx === null || m.sidx === undefined) return;
    const target = readerEl.querySelector(`.sentence[data-sidx="${m.sidx}"]`);
    if (target && !target.previousElementSibling?.classList?.contains('bookmark-flag')){
      const flag = document.createElement('span');
      flag.className = 'bookmark-flag';
      flag.textContent = '🔖';
      flag.title = 'Marcador';
      target.parentNode.insertBefore(flag, target);
    }
  });
}

document.getElementById('showBookmarksBtn').addEventListener('click', ()=>{
  renderBookmarksList();
  bookmarksPanel.classList.add('show');
});
document.getElementById('bookmarksClose').addEventListener('click', ()=> bookmarksPanel.classList.remove('show'));

/* ===================== Índice de capítulos (sacado del propio epub) ===================== */
const tocPanel = document.getElementById('tocPanel');
document.getElementById('tocBtn').addEventListener('click', ()=>{
  renderTocList();
  tocPanel.classList.add('show');
});
document.getElementById('tocClose').addEventListener('click', ()=> tocPanel.classList.remove('show'));

function renderTocList(){
  const meta = booksMeta[currentBookId];
  const list = document.getElementById('tocList');
  const toc = meta && meta.toc;
  if (!toc || toc.length === 0){
    list.innerHTML = '<div class="empty">Este libro no trae un índice utilizable, o se importó antes de que agregara esta función (vuelve a importarlo para intentar de nuevo).</div>';
    return;
  }
  list.innerHTML = toc.map((t,i)=>
    `<div class="toc-item" data-sidx="${t.startSidx}">${escapeHtml(t.title)}</div>`).join('');
  list.querySelectorAll('.toc-item').forEach(item=>{
    item.addEventListener('click', ()=>{
      const target = readerEl.querySelector(`.sentence[data-sidx="${item.dataset.sidx}"]`);
      if (target) target.scrollIntoView({ block:'start', inline:'center' });
      tocPanel.classList.remove('show');
    });
  });
}

function renderBookmarksList(){
  const b = booksMeta[currentBookId];
  const list = document.getElementById('bookmarksList');
  const marks = (b && b.bookmarks) || [];
  if (marks.length === 0){
    list.innerHTML = '<div class="empty">No tienes marcadores en este libro. Usa "🔖 Marcar" mientras lees.</div>';
    return;
  }
  list.innerHTML = marks.slice().reverse().map(m=>{
    const date = new Date(m.createdAt).toLocaleString('es-MX', {day:'numeric', month:'short', hour:'2-digit', minute:'2-digit'});
    return `<div class="bookmark-item">
      <span class="go-mark" data-pos="${m.scrollPos}" data-sidx="${m.sidx ?? ''}" style="cursor:pointer;">📍 ${date}</span>
      <button class="del-mark" data-id="${m.id}">Eliminar</button>
    </div>`;
  }).join('');
  list.querySelectorAll('.go-mark').forEach(el=> el.addEventListener('click', ()=>{
    const sidx = el.dataset.sidx;
    const target = sidx ? readerEl.querySelector(`.sentence[data-sidx="${sidx}"]`) : null;
    if (target) target.scrollIntoView({ block:'center', inline:'center', behavior:'smooth' });
    else readerEl.scrollTop = parseInt(el.dataset.pos, 10) || 0;
    bookmarksPanel.classList.remove('show');
  }));
  list.querySelectorAll('.del-mark').forEach(el=> el.addEventListener('click', ()=>{
    b.bookmarks = b.bookmarks.filter(m=>m.id !== el.dataset.id);
    saveMeta();
    renderBookmarksList();
    renderBookmarkFlags();
  }));
}

/* ===================== Puntero de lectura guiada (opcional) ===================== */
const pointerBar = document.getElementById('pointerBar');
const pointerBtn = document.getElementById('pointerBtn');
const pointerSpeed = document.getElementById('pointerSpeed');
const pointerSpeedLabel = document.getElementById('pointerSpeedLabel');
let pointerActive = false, pointerTimer = null, pointerIdx = 0, pointerCurrentEl = null;
let pointerAllUnits = []; // TODAS las palabras del libro (resaltadas o no), en orden, listas para tocar y saltar ahí
let pointerWrapped = false;

pointerSpeed.addEventListener('input', ()=> pointerSpeedLabel.textContent = pointerSpeed.value + ' ppm');
pointerBtn.addEventListener('click', ()=>{
  const willShow = !pointerBar.classList.contains('show');
  pointerBar.classList.toggle('show');
  if (willShow) ensurePointerWrapped();
});
document.getElementById('pointerStop').addEventListener('click', stopPointer);
document.getElementById('pointerPlayPause').addEventListener('click', ()=>{
  if (pointerActive) pausePointer();
  else startPointerFromView();
});

// Coincide con letras de casi cualquier alfabeto
const GENERIC_WORD_RE = /[\p{L}\p{M}]+/gu;

// Envuelve TODAS las palabras del libro abierto en spans tocables (una sola vez por libro),
// para poder tocar cualquiera y que el puntero empiece justo ahí.
function ensurePointerWrapped(){
  if (pointerWrapped) return;
  wrapWordsForPointer(readerEl);
  pointerAllUnits = Array.from(readerEl.querySelectorAll('.w-de, .ptr-word'));
  pointerWrapped = true;
}

function wrapWordsForPointer(root){
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const textNodes = [];
  let n;
  while ((n = walker.nextNode())){
    if (n.parentElement && n.parentElement.classList.contains('w-de')) continue;
    if (!n.nodeValue || !n.nodeValue.trim()) continue;
    textNodes.push(n);
  }
  textNodes.forEach(node=>{
    const text = node.nodeValue;
    GENERIC_WORD_RE.lastIndex = 0;
    if (!GENERIC_WORD_RE.test(text)) return;
    GENERIC_WORD_RE.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let lastIndex = 0, m;
    while ((m = GENERIC_WORD_RE.exec(text))){
      if (m.index > lastIndex) frag.appendChild(document.createTextNode(text.slice(lastIndex, m.index)));
      const span = document.createElement('span');
      span.className = 'ptr-word';
      span.textContent = m[0];
      frag.appendChild(span);
      lastIndex = m.index + m[0].length;
    }
    if (lastIndex < text.length) frag.appendChild(document.createTextNode(text.slice(lastIndex)));
    node.parentNode.replaceChild(frag, node);
  });
}
function unwrapPointerWords(){
  readerEl.querySelectorAll('.ptr-word').forEach(span=>{
    span.replaceWith(document.createTextNode(span.textContent));
  });
  readerEl.normalize();
  pointerWrapped = false;
  pointerAllUnits = [];
}

// Toca cualquier palabra del libro (con el puntero abierto) para empezar a leer justo desde ahí.
readerEl.addEventListener('click', (e)=>{
  if (!pointerBar.classList.contains('show')) return;
  const unit = e.target.closest('.w-de, .ptr-word');
  if (!unit) return;
  e.stopPropagation();
  jumpPointerTo(unit);
}, true); // captura: se evalúa antes que el listener de traducción, para no abrir el popup también

function jumpPointerTo(unit){
  const idx = pointerAllUnits.indexOf(unit);
  if (idx === -1) return;
  clearTimeout(pointerTimer);
  if (pointerCurrentEl) pointerCurrentEl.classList.remove('pointer-current');
  pointerIdx = idx;
  pointerActive = true;
  document.getElementById('pointerPlayPause').textContent = '⏸️ Pausar';
  stepPointer();
}

function startPointerFromView(){
  ensurePointerWrapped();
  if (pointerAllUnits.length === 0){
    alert('No encontré texto en este libro para leer con el puntero.');
    return;
  }
  const readerRect = screens.reader.getBoundingClientRect();
  // Empieza en la primera palabra visible desde arriba (o desde la izquierda, en modo horizontal)
  let startIdx = pointerAllUnits.findIndex(el=>{
    const r = el.getBoundingClientRect();
    return r.bottom > readerRect.top;
  });
  if (startIdx === -1) startIdx = 0;

  pointerIdx = startIdx;
  pointerActive = true;
  document.getElementById('pointerPlayPause').textContent = '⏸️ Pausar';
  stepPointer();
}

function stepPointer(){
  if (!pointerActive) return;
  if (pointerCurrentEl) pointerCurrentEl.classList.remove('pointer-current');
  if (pointerIdx >= pointerAllUnits.length){ stopPointer(); return; }
  const el = pointerAllUnits[pointerIdx];
  el.classList.add('pointer-current');
  pointerCurrentEl = el;
  el.scrollIntoView({ block:'center', inline:'center', behavior:'smooth' });
  pointerIdx += 1;

  const ppm = parseInt(pointerSpeed.value, 10) || 220;
  const msPerWord = 60000 / ppm;
  pointerTimer = setTimeout(stepPointer, msPerWord);
}
function pausePointer(){
  pointerActive = false;
  clearTimeout(pointerTimer);
  document.getElementById('pointerPlayPause').textContent = '▶️ Continuar';
}
function stopPointer(){
  pointerActive = false;
  clearTimeout(pointerTimer);
  if (pointerCurrentEl) pointerCurrentEl.classList.remove('pointer-current');
  pointerCurrentEl = null;
  pointerIdx = 0;
  pointerBar.classList.remove('show');
  document.getElementById('pointerPlayPause').textContent = '▶️ Iniciar en esta página';
}

/* ===================== Exportar / importar respaldo completo ===================== */
document.getElementById('exportBtn').addEventListener('click', async ()=>{
  showLoading('Preparando respaldo…');
  const allContent = await idbGetAllContent(); // [{id, htmlChunks}, ...]
  const bookContents = {};
  allContent.forEach(rec=> bookContents[rec.id] = rec.htmlChunks);
  const payload = { version:3, exportedAt: Date.now(), wordCounts, booksMeta, translationCache, bookContents, favorites, wordNotes, srsCards };
  const blob = new Blob([JSON.stringify(payload)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'lector-idiomas-respaldo-' + new Date().toISOString().slice(0,10) + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  hideLoading();
});

document.getElementById('importInput').addEventListener('change', (e)=>{
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async ()=>{
    try{
      const data = JSON.parse(reader.result);
      if (!confirm('Esto reemplaza tu progreso, libros y traducciones actuales por los del archivo. ¿Continuar?')) return;
      showLoading('Restaurando respaldo…');
      wordCounts = data.wordCounts || {};
      booksMeta = data.booksMeta || {};
      translationCache = data.translationCache || {};
      favorites = data.favorites || {};
      wordNotes = data.wordNotes || {};
      srsCards = data.srsCards || {};
      saveCounts(); saveMeta(); saveTranslations(); saveSrs();
      DB.set('favorites', favorites); DB.set('wordNotes', wordNotes);
      const bookContents = data.bookContents || {};
      for (const [id, chunks] of Object.entries(bookContents)){
        await idbPutContent(id, chunks);
      }
      hideLoading();
      renderBookList();
      alert('Respaldo importado correctamente.');
    } catch(err){
      hideLoading();
      alert('No se pudo leer el archivo de respaldo.');
      console.error(err);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

/* ===================== Carga de archivo EPUB ===================== */
const fileInput = document.getElementById('fileInput');
const dropzone = document.getElementById('dropzone');
fileInput.addEventListener('change', (e)=>{
  const file = e.target.files[0];
  if (file) importEpub(file);
  fileInput.value = '';
});
['dragover','dragenter'].forEach(ev=> dropzone.addEventListener(ev, e=>{ e.preventDefault(); dropzone.classList.add('drag'); }));
['dragleave','drop'].forEach(ev=> dropzone.addEventListener(ev, e=>{ e.preventDefault(); dropzone.classList.remove('drag'); }));
dropzone.addEventListener('drop', e=>{
  const file = e.dataTransfer.files[0];
  if (file) importEpub(file);
});

/* ===================== Loading overlay ===================== */
const loadingEl = document.getElementById('loading');
function showLoading(text){ document.getElementById('loadingText').textContent = text; loadingEl.classList.add('show'); }
function hideLoading(){ loadingEl.classList.remove('show'); }

/* ===================== Inicio ===================== */
(async function init(){
  try{ await migrateLegacyBooks(); } catch(e){ console.warn('Migración omitida:', e); }
  renderBookList();
})();

if ('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('service-worker.js').catch(()=>{});
  });
}
