/* ===================== Configuración de idiomas ===================== */
const LANGUAGES = {
  de: { label: 'Alemán',    file: 'de-words.json', tts: 'de-DE' },
  en: { label: 'Inglés',    file: 'en-words.json', tts: 'en-US' },
  fr: { label: 'Francés',   file: 'fr-words.json', tts: 'fr-FR' },
  it: { label: 'Italiano',  file: 'it-words.json', tts: 'it-IT' },
  pt: { label: 'Portugués', file: 'pt-words.json', tts: 'pt-PT' }
};

/* ===================== Almacenamiento local ===================== */
const DB = {
  get(key, fallback){
    try{ const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch(e){ return fallback; }
  },
  set(key, val){ localStorage.setItem(key, JSON.stringify(val)); }
};

// counts: { "de:blicken": 5, "en:however": 2, ... } -> veces vista ANTES de la sesión actual
let wordCounts = DB.get('wordCounts', {});
// Migración: versiones viejas de la app guardaban solo "blicken" (siempre alemán)
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

// books: { id: { title, addedAt, lang, htmlChunks: [...] } }
let books = DB.get('books', {});
// caché de traducciones: { "de:blicken": "mirar" }
let translationCache = DB.get('translationCache', {});

function saveCounts(){ DB.set('wordCounts', wordCounts); }
function saveBooks(){ DB.set('books', books); }
function saveTranslations(){ DB.set('translationCache', translationCache); }

/* ===================== Selector de idioma ===================== */
const langSelect = document.getElementById('langSelect');
langSelect.innerHTML = Object.entries(LANGUAGES).map(([code,l])=>
  `<option value="${code}">${l.label}</option>`).join('');
langSelect.value = DB.get('targetLang', 'de');
langSelect.addEventListener('change', ()=> DB.set('targetLang', langSelect.value));

/* ===================== Diccionarios de idioma ===================== */
let esSet = null;
const dictCache = {}; // langCode -> Set

async function loadEsDict(){
  if (esSet) return esSet;
  esSet = new Set(await fetch('data/es-words.json').then(r=>r.json()));
  return esSet;
}
async function loadTargetDict(langCode){
  if (dictCache[langCode]) return dictCache[langCode];
  const file = LANGUAGES[langCode].file;
  const arr = await fetch('data/' + file).then(r=>r.json());
  dictCache[langCode] = new Set(arr);
  return dictCache[langCode];
}

function normalize(word){ return word.toLowerCase().replace(/[’'‘]/g,"'"); }

// ¿Es una palabra relevante del idioma objetivo? (está en su diccionario y no es también española)
function isTargetWord(raw, targetSet, esWords){
  const w = normalize(raw);
  if (w.length < 2) return false;
  if (esWords.has(w)) return false;
  return targetSet.has(w);
}

function levelFor(count){
  if (count >= 13) return -1;   // dominada, sin resaltar
  if (count >= 7) return 3;     // crema
  if (count >= 2) return 2;     // amarillo
  return 1;                     // naranja (0-1 veces)
}
function levelClass(count){
  const lvl = levelFor(count);
  return lvl === -1 ? null : ('lvl-' + lvl);
}

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

/* ===================== Tokenización, oraciones y resaltado ===================== */
const WORD_RE = /[A-Za-zÀ-ÖØ-öø-ÿ]+/g;
const BLOCK_SELECTOR = 'p, li, blockquote, h1, h2, h3, h4, h5, h6, td, dd, dt';

function splitSentences(text){
  const parts = text.match(/[^.!?…]+[.!?…]*(\s+|$)/g);
  return parts && parts.length ? parts : [text];
}

function buildSentenceHtml(sentence, sessionCounts, targetSet, esWords){
  let html = '';
  let lastIndex = 0;
  let m;
  WORD_RE.lastIndex = 0;
  while ((m = WORD_RE.exec(sentence))){
    const word = m[0];
    const start = m.index, end = start + word.length;
    if (start > lastIndex) html += escapeHtml(sentence.slice(lastIndex, start));

    if (isTargetWord(word, targetSet, esWords)){
      const key = normalize(word);
      const priorCount = wordCounts[currentImportLang + ':' + key] || 0;
      const cls = levelClass(priorCount);
      sessionCounts[key] = (sessionCounts[key] || 0) + 1;
      if (cls){
        html += `<span class="w-de ${cls}" data-word="${escapeHtml(key)}" data-display="${escapeHtml(word)}">${escapeHtml(word)}</span>`;
      } else {
        html += escapeHtml(word);
      }
    } else {
      html += escapeHtml(word);
    }
    lastIndex = end;
  }
  if (lastIndex < sentence.length) html += escapeHtml(sentence.slice(lastIndex));
  return html;
}

function highlightHtmlChunk(html, sessionCounts, targetSet, esWords){
  const container = document.createElement('div');
  container.innerHTML = html;

  let blocks = Array.from(container.querySelectorAll(BLOCK_SELECTOR));
  if (blocks.length === 0){
    // Sin etiquetas de bloque reconocibles: tratar el contenedor completo como un bloque
    blocks = [container];
  }

  blocks.forEach(el=>{
    const text = el.textContent;
    if (!text || !text.trim()) return;
    const sentences = splitSentences(text);
    const html2 = sentences.map(s=>{
      const inner = buildSentenceHtml(s, sessionCounts, targetSet, esWords);
      return `<span class="sentence">${inner}</span>`;
    }).join('');
    el.innerHTML = html2;
  });

  return container.innerHTML;
}

function escapeHtml(s){ return s.replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/* ===================== Flujo principal: importar libro ===================== */
let currentImportLang = 'de';

async function importEpub(file){
  const langCode = langSelect.value;
  currentImportLang = langCode;
  showLoading('Leyendo el EPUB…');
  try{
    const [targetSet, esWords] = await Promise.all([loadTargetDict(langCode), loadEsDict()]);
    const { title, htmlChunks } = await parseEpub(file);
    showLoading('Detectando palabras en ' + LANGUAGES[langCode].label + '…');

    const sessionCounts = {};
    const processedChunks = htmlChunks.map(chunk => highlightHtmlChunk(chunk, sessionCounts, targetSet, esWords));

    for (const [w, c] of Object.entries(sessionCounts)){
      const key = langCode + ':' + w;
      wordCounts[key] = (wordCounts[key] || 0) + c;
    }
    saveCounts();

    const id = 'b_' + Date.now();
    books[id] = { title, addedAt: Date.now(), lang: langCode, htmlChunks: processedChunks, wordCount: Object.keys(sessionCounts).length };
    saveBooks();

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
const screens = { home: document.getElementById('home'), reader: document.getElementById('readerScreen'), stats: document.getElementById('statsScreen') };
const headerTitle = document.getElementById('headerTitle');
const backBtn = document.getElementById('backBtn');
const statsBtn = document.getElementById('statsBtn');

function showScreen(name, title){
  Object.values(screens).forEach(s=>s.classList.remove('active'));
  screens[name].classList.add('active');
  headerTitle.textContent = title;
  backBtn.style.visibility = name === 'home' ? 'hidden' : 'visible';
  statsBtn.style.visibility = name === 'home' ? 'visible' : 'hidden';
  screens[name].scrollTop = 0;
}
backBtn.addEventListener('click', ()=> showScreen('home', 'Mis libros'));
statsBtn.addEventListener('click', renderStats);

function renderBookList(){
  const list = document.getElementById('bookList');
  const ids = Object.keys(books).sort((a,b)=> books[b].addedAt - books[a].addedAt);
  if (ids.length === 0){
    list.innerHTML = '<div class="empty">Aún no has agregado ningún libro.</div>';
    return;
  }
  list.innerHTML = ids.map(id=>{
    const b = books[id];
    const date = new Date(b.addedAt).toLocaleDateString('es-MX', {day:'numeric', month:'short'});
    const langLabel = (LANGUAGES[b.lang] || {label:'?'}).label;
    return `<div class="booklist-item" data-id="${id}">
      <div><div class="title">${escapeHtml(b.title)}<span class="book-lang-tag">${langLabel}</span></div>
      <div class="meta">${date} · ${b.wordCount || 0} palabras</div></div>
      <div style="color:var(--sub)">›</div>
    </div>`;
  }).join('');
  list.querySelectorAll('.booklist-item').forEach(el=>{
    el.addEventListener('click', ()=> openReader(el.dataset.id));
  });
}

let currentBookLang = 'de';
function openReader(id){
  const b = books[id];
  currentBookLang = b.lang || 'de';
  const readerEl = document.getElementById('reader');
  readerEl.innerHTML = b.htmlChunks.join('<hr style="border:none;border-top:1px solid var(--border);margin:2em 0;">');
  showScreen('reader', b.title);
}

function renderStats(){
  const entries = Object.entries(wordCounts).sort((a,b)=> b[1]-a[1]);
  const el = document.getElementById('stats');
  if (entries.length === 0){
    el.innerHTML = '<div class="empty">Todavía no has leído palabras en ningún idioma.</div>';
  } else {
    const totalNew = entries.filter(([,c])=>c<=1).length;
    const totalLearning = entries.filter(([,c])=>c>=2&&c<=6).length;
    const totalReview = entries.filter(([,c])=>c>=7&&c<=12).length;
    const totalMastered = entries.filter(([,c])=>c>=13).length;
    el.innerHTML = `
      <div class="card" style="background:var(--panel);border-radius:14px;padding:16px;margin-bottom:14px;">
        <div class="statrow"><span>🟠 Nuevas / vistas 1 vez</span><b>${totalNew}</b></div>
        <div class="statrow"><span>🟡 En aprendizaje (2-6)</span><b>${totalLearning}</b></div>
        <div class="statrow"><span>⬜ Repaso (7-12)</span><b>${totalReview}</b></div>
        <div class="statrow"><span>✅ Dominadas (13+)</span><b>${totalMastered}</b></div>
      </div>
      <div class="card" style="background:var(--panel);border-radius:14px;padding:6px 16px;">
        ${entries.map(([k,c])=>{
          const [lang, w] = k.split(':');
          const langLabel = (LANGUAGES[lang]||{label:lang}).label;
          return `<div class="statrow"><span>${escapeHtml(w)} <span style="color:var(--sub);font-size:11px">(${langLabel})</span></span><span style="color:var(--sub)">${c}×</span></div>`;
        }).join('')}
      </div>`;
  }
  showScreen('stats', 'Tu progreso');
}

/* ===================== Popup de palabra: traducción + pronunciación ===================== */
const popup = document.getElementById('popup');

document.getElementById('reader').addEventListener('click', (e)=>{
  const span = e.target.closest('.w-de');
  if (!span) return;
  const word = span.dataset.word;
  const display = span.dataset.display;

  document.getElementById('popWord').textContent = display;
  const c = wordCounts[currentBookLang + ':' + word] || 0;
  document.getElementById('popCount').textContent = `Vista ${c} ${c===1?'vez':'veces'} en total`;
  document.getElementById('popTranslation').textContent = 'Traduciendo…';
  popup.classList.add('show');
  speak(display, currentBookLang);
  fetchTranslation(word, display, currentBookLang);

  const sentenceEl = span.closest('.sentence');
  popup._sentenceText = sentenceEl ? sentenceEl.textContent.trim() : display;
});
document.getElementById('popClose').addEventListener('click', ()=> popup.classList.remove('show'));
document.getElementById('popSpeak').addEventListener('click', ()=>{
  speak(document.getElementById('popWord').textContent, currentBookLang);
});
document.getElementById('popSpeakSentence').addEventListener('click', ()=>{
  if (popup._sentenceText) speak(popup._sentenceText, currentBookLang);
});

async function fetchTranslation(key, display, langCode){
  const cacheKey = langCode + ':' + key;
  if (translationCache[cacheKey]){
    document.getElementById('popTranslation').textContent = '➜ ' + translationCache[cacheKey];
    return;
  }
  try{
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(display)}&langpair=${langCode}|es`;
    const res = await fetch(url);
    const data = await res.json();
    let translated = data && data.responseData && data.responseData.translatedText;
    if (translated){
      translated = translated.charAt(0).toLowerCase() + translated.slice(1);
      translationCache[cacheKey] = translated;
      saveTranslations();
      // Solo actualizar si el popup sigue mostrando esta misma palabra
      if (document.getElementById('popWord').textContent === display){
        document.getElementById('popTranslation').textContent = '➜ ' + translated;
      }
    } else {
      document.getElementById('popTranslation').textContent = 'Sin traducción disponible';
    }
  } catch(e){
    document.getElementById('popTranslation').textContent = 'Sin conexión para traducir';
  }
}

/* ===================== Voz (pronunciación) ===================== */
function speak(text, langCode){
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const ttsLang = (LANGUAGES[langCode] || LANGUAGES.de).tts;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = ttsLang;
  const voices = window.speechSynthesis.getVoices();
  const match = voices.find(v=>v.lang === ttsLang) || voices.find(v=>v.lang && v.lang.startsWith(langCode));
  if (match) u.voice = match;
  u.rate = 0.85;
  window.speechSynthesis.speak(u);
}
if ('speechSynthesis' in window){ window.speechSynthesis.onvoiceschanged = ()=>{}; }

/* ===================== Carga de archivo ===================== */
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
renderBookList();

if ('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('service-worker.js').catch(()=>{});
  });
}
