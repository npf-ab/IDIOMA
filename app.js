/* ===================== Configuración de idiomas ===================== */
const LANGUAGES = {
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
  dictCache[langCode] = { set, commonSet, maxLen };
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

  const htmlChunks = [];
  for (const href of hrefs){
    const fullPath = opfDir + href;
    const zf = zip.file(fullPath) || zip.file(decodeURIComponent(fullPath));
    if (!zf) continue;
    const raw = await zf.async('string');
    const doc = new DOMParser().parseFromString(raw, 'text/html');
    const body = doc.body ? doc.body.innerHTML : raw;
    htmlChunks.push(body);
  }
  return { title, htmlChunks };
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

function highlightHtmlChunk(html, sessionCounts, commonHits, dict, langCode, script){
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
      return `<span class="sentence">${inner}</span>`;
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
    const { title, htmlChunks } = await parseEpub(file);
    showLoading('Detectando palabras en ' + LANGUAGES[langCode].label + '…');

    const sessionCounts = {};
    const commonHits = new Set();
    const processedChunks = htmlChunks.map(chunk => highlightHtmlChunk(chunk, sessionCounts, commonHits, dict, langCode, script));
    // Ya NO sumamos estas ocurrencias al progreso automáticamente: el conteo (y el color)
    // solo sube cuando TÚ tocas la palabra mientras lees (ver el listener de clic más abajo).

    const id = 'b_' + Date.now();
    showLoading('Guardando el libro…');
    await idbPutContent(id, processedChunks);
    booksMeta[id] = {
      title, addedAt: Date.now(), lang: langCode, scrollPos: 0, bookmarks: [],
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
  review: document.getElementById('reviewScreen')
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
  pointerWrapped = false;
  pointerAllUnits = [];
  showScreen('reader', meta.title);
  requestAnimationFrame(()=>{ screens.reader.scrollTop = meta.scrollPos || 0; });
}

let scrollSaveTimer = null;
screens.reader.addEventListener('scroll', ()=>{
  if (!currentBookId) return;
  clearTimeout(scrollSaveTimer);
  scrollSaveTimer = setTimeout(saveCurrentScroll, 400);
});
function saveCurrentScroll(){
  if (!currentBookId || !booksMeta[currentBookId]) return;
  booksMeta[currentBookId].scrollPos = screens.reader.scrollTop;
  saveMeta();
}

/* ===================== Estadísticas ===================== */
async function renderStats(){
  showLoading('Calculando tu progreso…');
  const langsInUse = new Set(Object.keys(wordCounts).map(k=>k.split(':')[0]));
  await ensureDictsFor(langsInUse);

  const entries = Object.entries(wordCounts).sort((a,b)=> b[1]-a[1]);
  let blueProgress=0, blueMastered=0, regNew=0, regLearn=0, regReview=0, regMastered=0;
  entries.forEach(([k,c])=>{
    const [lang, w] = k.split(':');
    if (isCommonWord(lang, w)){
      if (c >= 20) blueMastered++; else blueProgress++;
    } else {
      if (c >= 13) regMastered++;
      else if (c >= 7) regReview++;
      else if (c >= 2) regLearn++;
      else regNew++;
    }
  });

  const el = document.getElementById('stats');
  el.innerHTML = `
    <div class="card" style="background:var(--panel);border-radius:14px;padding:16px;margin:16px;">
      <div class="statrow"><span>🔵 Comunes en progreso (&lt;20 toques)</span><b>${blueProgress}</b></div>
      <div class="statrow"><span>✅ Comunes dominadas (20+)</span><b>${blueMastered}</b></div>
      <div class="statrow"><span>🟠 Nuevas / vistas 1 vez</span><b>${regNew}</b></div>
      <div class="statrow"><span>🟡 En aprendizaje (2-6)</span><b>${regLearn}</b></div>
      <div class="statrow"><span>⬜ Repaso (7-12)</span><b>${regReview}</b></div>
      <div class="statrow"><span>✅ Dominadas (13+)</span><b>${regMastered}</b></div>
    </div>
    <div class="card" style="margin:0 16px 16px;">
      ${entries.length === 0 ? '<div class="empty">Todavía no has tocado palabras en ningún idioma.</div>' :
        entries.map(([k,c])=>{
          const [lang, w] = k.split(':');
          const langLabel = (LANGUAGES[lang]||{label:lang}).label;
          const common = isCommonWord(lang, w);
          return `<div class="statrow"><span>${escapeHtml(w)} <span style="color:var(--sub);font-size:11px">(${langLabel}${common?' · común':''})</span></span><span style="color:var(--sub)">${c}×</span></div>`;
        }).join('')}
    </div>
    <div style="margin:0 16px 16px;">
      <button class="btn-secondary btn-danger" id="resetProgressBtn" style="width:100%;">🗑 Reiniciar todo el progreso</button>
    </div>`;
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

  fetchTranslationRaw(key, currentBookLang).then(t=>{
    if (document.getElementById('popWord').textContent === display){
      document.getElementById('popTranslation').textContent = t ? ('➜ ' + t) : 'Sin traducción disponible';
    }
  });

  const sentenceEl = span.closest('.sentence');
  popup._sentenceText = sentenceEl ? sentenceEl.textContent.trim() : display;
});
document.getElementById('popClose').addEventListener('click', ()=> popup.classList.remove('show'));
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
  b.bookmarks.push({ id: 'm_'+Date.now(), scrollPos: screens.reader.scrollTop, createdAt: Date.now() });
  saveMeta();
  const btn = document.getElementById('bookmarkBtn');
  const original = btn.textContent;
  btn.textContent = '✅ Marcado';
  setTimeout(()=> btn.textContent = original, 1200);
});
document.getElementById('showBookmarksBtn').addEventListener('click', ()=>{
  renderBookmarksList();
  bookmarksPanel.classList.add('show');
});
document.getElementById('bookmarksClose').addEventListener('click', ()=> bookmarksPanel.classList.remove('show'));

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
      <span class="go-mark" data-pos="${m.scrollPos}" style="cursor:pointer;">📍 ${date}</span>
      <button class="del-mark" data-id="${m.id}">Eliminar</button>
    </div>`;
  }).join('');
  list.querySelectorAll('.go-mark').forEach(el=> el.addEventListener('click', ()=>{
    screens.reader.scrollTop = parseInt(el.dataset.pos, 10) || 0;
    bookmarksPanel.classList.remove('show');
  }));
  list.querySelectorAll('.del-mark').forEach(el=> el.addEventListener('click', ()=>{
    b.bookmarks = b.bookmarks.filter(m=>m.id !== el.dataset.id);
    saveMeta();
    renderBookmarksList();
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
  // Empieza en la primera palabra visible desde arriba de la pantalla actual
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
  el.scrollIntoView({ block:'center', behavior:'smooth' });
  speak(el.textContent, currentBookLang, 0.85);

  const ppm = parseInt(pointerSpeed.value, 10) || 110;
  const msPerWord = 60000 / ppm;
  pointerIdx += 1;
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
  const payload = { version:2, exportedAt: Date.now(), wordCounts, booksMeta, translationCache, bookContents };
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
      saveCounts(); saveMeta(); saveTranslations();
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
