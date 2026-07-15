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

/* ===================== Almacenamiento local ===================== */
const DB = {
  get(key, fallback){
    try{ const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch(e){ return fallback; }
  },
  set(key, val){ localStorage.setItem(key, JSON.stringify(val)); }
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

// books: { id: { title, addedAt, lang, htmlChunks:[...], scrollPos, bookmarks:[{id,scrollPos,label,createdAt}] } }
let books = DB.get('books', {});
let translationCache = DB.get('translationCache', {});

function saveCounts(){ DB.set('wordCounts', wordCounts); }
function saveBooks(){ DB.set('books', books); }
function saveTranslations(){ DB.set('translationCache', translationCache); }

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
let esSet = null;
const dictCache = {};
async function loadEsDict(){
  if (esSet) return esSet;
  esSet = new Set(await fetch('data/es-words.json').then(r=>r.json()));
  return esSet;
}
async function loadTargetDict(langCode){
  if (dictCache[langCode]) return dictCache[langCode];
  const arr = await fetch('data/' + LANGUAGES[langCode].file).then(r=>r.json());
  const set = new Set(arr);
  const maxLen = arr.reduce((m,w)=>Math.max(m,w.length), 1);
  dictCache[langCode] = { set, maxLen };
  return dictCache[langCode];
}

function normalize(word){ return word.toLowerCase().replace(/[’'‘]/g,"'"); }

function levelFor(count){
  if (count >= 13) return -1;
  if (count >= 7) return 3;
  if (count >= 2) return 2;
  return 1;
}
function levelClass(count){ const lvl = levelFor(count); return lvl === -1 ? null : ('lvl-' + lvl); }
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

// Segmentación por "maximum matching hacia adelante" para chino/japonés (sin espacios)
function segmentCJKRun(run, dict){
  const tokens = [];
  let i = 0;
  while (i < run.length){
    let matchedLen = 0;
    const maxTry = Math.min(dict.maxLen, run.length - i);
    for (let len = maxTry; len >= 1; len--){
      if (dict.set.has(run.substr(i, len))){ matchedLen = len; break; }
    }
    if (matchedLen === 0) matchedLen = 1; // carácter suelto, no reconocido
    tokens.push(run.substr(i, matchedLen));
    i += matchedLen;
  }
  return tokens;
}

function wordHtml(word, key, langCode, sessionCounts){
  const priorCount = wordCounts[langCode + ':' + key] || 0;
  const cls = levelClass(priorCount);
  sessionCounts[key] = (sessionCounts[key] || 0) + 1;
  if (cls) return `<span class="w-de ${cls}" data-word="${escapeHtml(key)}" data-display="${escapeHtml(word)}">${escapeHtml(word)}</span>`;
  return escapeHtml(word);
}

function buildSentenceHtml(sentence, sessionCounts, dict, esWords, langCode, script){
  let html = '';
  if (script === 'cjk'){
    let lastIndex = 0, m;
    CJK_RUN_RE.lastIndex = 0;
    while ((m = CJK_RUN_RE.exec(sentence))){
      if (m.index > lastIndex) html += escapeHtml(sentence.slice(lastIndex, m.index));
      const tokens = segmentCJKRun(m[0], dict);
      tokens.forEach(tok=>{
        if (dict.set.has(tok)) html += wordHtml(tok, tok, langCode, sessionCounts);
        else html += escapeHtml(tok);
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
    if (key.length >= 2 && !esWords.has(key) && dict.set.has(key)){
      html += wordHtml(word, key, langCode, sessionCounts);
    } else {
      html += escapeHtml(word);
    }
    lastIndex = end;
  }
  if (lastIndex < sentence.length) html += escapeHtml(sentence.slice(lastIndex));
  return html;
}

function highlightHtmlChunk(html, sessionCounts, dict, esWords, langCode, script){
  const container = document.createElement('div');
  container.innerHTML = html;
  let blocks = Array.from(container.querySelectorAll(BLOCK_SELECTOR));
  if (blocks.length === 0) blocks = [container];

  blocks.forEach(el=>{
    const text = el.textContent;
    if (!text || !text.trim()) return;
    const sentences = splitSentences(text);
    el.innerHTML = sentences.map(s=>{
      const inner = buildSentenceHtml(s, sessionCounts, dict, esWords, langCode, script);
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
    const [dict, esWords] = await Promise.all([loadTargetDict(langCode), loadEsDict()]);
    const { title, htmlChunks } = await parseEpub(file);
    showLoading('Detectando palabras en ' + LANGUAGES[langCode].label + '…');

    const sessionCounts = {};
    const processedChunks = htmlChunks.map(chunk => highlightHtmlChunk(chunk, sessionCounts, dict, esWords, langCode, script));

    for (const [w, c] of Object.entries(sessionCounts)){
      const key = langCode + ':' + w;
      wordCounts[key] = (wordCounts[key] || 0) + c;
    }
    saveCounts();

    const id = 'b_' + Date.now();
    books[id] = { title, addedAt: Date.now(), lang: langCode, htmlChunks: processedChunks,
      wordCount: Object.keys(sessionCounts).length, scrollPos: 0, bookmarks: [] };
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
    const pct = b.htmlChunks && b.htmlChunks.length ? '' : '';
    return `<div class="booklist-item">
      <div class="open-book" data-id="${id}" style="flex:1;cursor:pointer;">
        <div class="title">${escapeHtml(b.title)}<span class="book-lang-tag">${langLabel}</span></div>
        <div class="meta">${date} · ${b.wordCount || 0} palabras${b.scrollPos ? ' · en progreso' : ''}</div>
      </div>
      <button class="del-book btn-danger" data-id="${id}" style="background:none;border:none;font-size:18px;padding:6px 10px;">🗑</button>
    </div>`;
  }).join('');
  list.querySelectorAll('.open-book').forEach(el=> el.addEventListener('click', ()=> openReader(el.dataset.id)));
  list.querySelectorAll('.del-book').forEach(el=> el.addEventListener('click', (e)=>{
    e.stopPropagation();
    if (confirm('¿Eliminar este libro de tu biblioteca? (tu progreso de palabras NO se pierde)')){
      delete books[el.dataset.id];
      saveBooks();
      renderBookList();
    }
  }));
}

let currentBookId = null, currentBookLang = 'de';
function openReader(id){
  const b = books[id];
  currentBookId = id;
  currentBookLang = b.lang || 'de';
  readerEl.innerHTML = b.htmlChunks.join('<hr style="border:none;border-top:1px solid var(--border);margin:2em 0;">');
  readerEl.setAttribute('dir', LANGUAGES[currentBookLang].rtl ? 'rtl' : 'ltr');
  showScreen('reader', b.title);
  requestAnimationFrame(()=>{ screens.reader.scrollTop = b.scrollPos || 0; });
}

let scrollSaveTimer = null;
screens.reader.addEventListener('scroll', ()=>{
  if (!currentBookId) return;
  clearTimeout(scrollSaveTimer);
  scrollSaveTimer = setTimeout(saveCurrentScroll, 400);
});
function saveCurrentScroll(){
  if (!currentBookId || !books[currentBookId]) return;
  books[currentBookId].scrollPos = screens.reader.scrollTop;
  saveBooks();
}

/* ===================== Estadísticas ===================== */
function renderStats(){
  const entries = Object.entries(wordCounts).sort((a,b)=> b[1]-a[1]);
  const el = document.getElementById('stats');
  const totalNew = entries.filter(([,c])=>c<=1).length;
  const totalLearning = entries.filter(([,c])=>c>=2&&c<=6).length;
  const totalReview = entries.filter(([,c])=>c>=7&&c<=12).length;
  const totalMastered = entries.filter(([,c])=>c>=13).length;

  el.innerHTML = `
    <div class="card" style="background:var(--panel);border-radius:14px;padding:16px;margin:16px;">
      <div class="statrow"><span>🟠 Nuevas / vistas 1 vez</span><b>${totalNew}</b></div>
      <div class="statrow"><span>🟡 En aprendizaje (2-6)</span><b>${totalLearning}</b></div>
      <div class="statrow"><span>⬜ Repaso (7-12)</span><b>${totalReview}</b></div>
      <div class="statrow"><span>✅ Dominadas (13+)</span><b>${totalMastered}</b></div>
    </div>
    <div class="card" style="margin:0 16px 16px;">
      ${entries.length === 0 ? '<div class="empty">Todavía no has leído palabras en ningún idioma.</div>' :
        entries.map(([k,c])=>{
          const [lang, w] = k.split(':');
          const langLabel = (LANGUAGES[lang]||{label:lang}).label;
          return `<div class="statrow"><span>${escapeHtml(w)} <span style="color:var(--sub);font-size:11px">(${langLabel})</span></span><span style="color:var(--sub)">${c}×</span></div>`;
        }).join('')}
    </div>
    <div style="margin:0 16px 16px;">
      <button class="btn-secondary btn-danger" id="resetProgressBtn" style="width:100%;">🗑 Reiniciar todo el progreso</button>
    </div>`;
  document.getElementById('resetProgressBtn').addEventListener('click', ()=>{
    if (confirm('Esto borra el conteo de todas tus palabras vistas (naranja/amarillo/crema) en todos los idiomas. Tus libros no se borran. ¿Continuar?')){
      wordCounts = {};
      saveCounts();
      renderStats();
    }
  });
  showScreen('stats', 'Tu progreso');
}

/* ===================== Modo repaso / practicar ===================== */
document.getElementById('openReviewBtn').addEventListener('click', renderReview);
function renderReview(){
  const filterLang = reviewLangFilter.value;
  const entries = Object.entries(wordCounts).filter(([k,c])=>{
    const [lang] = k.split(':');
    if (filterLang && lang !== filterLang) return false;
    return c >= 2 && c <= 12; // amarillo + crema: en aprendizaje / repaso
  }).sort((a,b)=> b[1]-a[1]);

  const el = document.getElementById('reviewList');
  if (entries.length === 0){
    el.innerHTML = '<div class="empty">No tienes palabras en amarillo o crema todavía para este filtro. ¡Sigue leyendo!</div>';
  } else {
    el.innerHTML = entries.map(([k,c])=>{
      const [lang, w] = k.split(':');
      const langLabel = (LANGUAGES[lang]||{label:lang}).label;
      return `<div class="review-item" data-lang="${lang}" data-word="${escapeHtml(w)}">
        <div>
          <div class="rw">${escapeHtml(w)}</div>
          <div class="rmeta">${langLabel} · vista ${c} veces · <span class="rtrans">toca 🔊 para traducir</span></div>
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
  const word = span.dataset.word;
  const display = span.dataset.display;

  document.getElementById('popWord').textContent = display;
  const c = wordCounts[currentBookLang + ':' + word] || 0;
  document.getElementById('popCount').textContent = `Vista ${c} ${c===1?'vez':'veces'} en total`;
  document.getElementById('popTranslation').textContent = 'Traduciendo…';
  popup.classList.add('show');
  speak(display, currentBookLang, 0.85);
  lastSpokenText = display; lastSpokenLang = currentBookLang;

  fetchTranslationRaw(word, currentBookLang).then(t=>{
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
  const b = books[currentBookId];
  b.bookmarks = b.bookmarks || [];
  b.bookmarks.push({ id: 'm_'+Date.now(), scrollPos: screens.reader.scrollTop, createdAt: Date.now() });
  saveBooks();
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
  const b = books[currentBookId];
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
    saveBooks();
    renderBookmarksList();
  }));
}

/* ===================== Puntero de lectura guiada (opcional) ===================== */
const pointerBar = document.getElementById('pointerBar');
const pointerBtn = document.getElementById('pointerBtn');
const pointerSpeed = document.getElementById('pointerSpeed');
const pointerSpeedLabel = document.getElementById('pointerSpeedLabel');
let pointerActive = false, pointerTimer = null, pointerWords = [], pointerIdx = 0, pointerCurrentEl = null;

pointerSpeed.addEventListener('input', ()=> pointerSpeedLabel.textContent = pointerSpeed.value + ' ppm');

pointerBtn.addEventListener('click', ()=>{
  pointerBar.classList.toggle('show');
});
document.getElementById('pointerStop').addEventListener('click', stopPointer);
document.getElementById('pointerPlayPause').addEventListener('click', ()=>{
  if (pointerActive) pausePointer();
  else startPointerFromView();
});

function startPointerFromView(){
  // recolectar los nodos de texto/spans visibles a partir de la parte superior visible
  const readerRect = screens.reader.getBoundingClientRect();
  const allSentences = Array.from(readerEl.querySelectorAll('.sentence'));
  const visible = allSentences.filter(s=>{
    const r = s.getBoundingClientRect();
    return r.bottom > readerRect.top && r.top < readerRect.bottom;
  });
  const startFrom = visible.length ? visible : allSentences;

  // construir lista plana de "palabras" a resaltar (nodos de texto y spans) preservando orden
  pointerWords = [];
  startFrom.forEach(sentEl=>{
    Array.from(sentEl.childNodes).forEach(node=>{
      if (node.nodeType === 3 && node.textContent.trim()){
        node.textContent.split(/(\s+)/).filter(t=>t.trim()).forEach(()=>{});
        pointerWords.push({ type:'text', el: sentEl, text: node.textContent });
      } else if (node.nodeType === 1){
        pointerWords.push({ type:'el', el: node });
      }
    });
  });
  // Nos quedamos solo con los elementos <span> (resaltados o no) para simplificar el resaltado visual;
  // usamos únicamente los <span class="w-de"> como "anclas" de avance, moviendo el indicador palabra por palabra.
  pointerWords = [];
  startFrom.forEach(sentEl=> pointerWords.push(...Array.from(sentEl.querySelectorAll('.w-de'))));
  if (pointerWords.length === 0){
    alert('No encontré palabras resaltadas visibles en esta pantalla para seguir con el puntero.');
    return;
  }
  pointerIdx = 0;
  pointerActive = true;
  document.getElementById('pointerPlayPause').textContent = '⏸️ Pausar';
  stepPointer();
}

function stepPointer(){
  if (!pointerActive) return;
  if (pointerCurrentEl) pointerCurrentEl.classList.remove('pointer-current');
  if (pointerIdx >= pointerWords.length){ stopPointer(); return; }
  const el = pointerWords[pointerIdx];
  el.classList.add('pointer-current');
  pointerCurrentEl = el;
  el.scrollIntoView({ block:'center', behavior:'smooth' });
  speak(el.dataset.display, currentBookLang, 0.85);

  const ppm = parseInt(pointerSpeed.value, 10) || 110; // palabras por minuto
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
  pointerWords = []; pointerIdx = 0;
  pointerBar.classList.remove('show');
  document.getElementById('pointerPlayPause').textContent = '▶️ Iniciar en esta página';
}

/* ===================== Exportar / importar respaldo completo ===================== */
document.getElementById('exportBtn').addEventListener('click', ()=>{
  const payload = { version:1, exportedAt: Date.now(), wordCounts, books, translationCache };
  const blob = new Blob([JSON.stringify(payload)], { type:'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'lector-idiomas-respaldo-' + new Date().toISOString().slice(0,10) + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

document.getElementById('importInput').addEventListener('change', (e)=>{
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ()=>{
    try{
      const data = JSON.parse(reader.result);
      if (!confirm('Esto reemplaza tu progreso, libros y traducciones actuales por los del archivo. ¿Continuar?')) return;
      wordCounts = data.wordCounts || {};
      books = data.books || {};
      translationCache = data.translationCache || {};
      saveCounts(); saveBooks(); saveTranslations();
      renderBookList();
      alert('Respaldo importado correctamente.');
    } catch(err){
      alert('No se pudo leer el archivo de respaldo.');
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
renderBookList();

if ('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('service-worker.js').catch(()=>{});
  });
}
