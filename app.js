/* ===================== Almacenamiento local ===================== */
const DB = {
  get(key, fallback){
    try{ const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch(e){ return fallback; }
  },
  set(key, val){ localStorage.setItem(key, JSON.stringify(val)); }
};

// counts: { "wort": 5, ... }  -> veces vista ANTES de la sesión actual (histórico acumulado)
let wordCounts = DB.get('wordCounts', {});
// books: { id: { title, addedAt, htmlChunks: [...] } }
let books = DB.get('books', {});

function saveCounts(){ DB.set('wordCounts', wordCounts); }
function saveBooks(){ DB.set('books', books); }

/* ===================== Diccionarios de idioma ===================== */
let deSet = null, esSet = null, dictReady = null;

function loadDictionaries(){
  if (dictReady) return dictReady;
  dictReady = Promise.all([
    fetch('data/de-words.json').then(r=>r.json()),
    fetch('data/es-words.json').then(r=>r.json())
  ]).then(([de, es])=>{
    deSet = new Set(de);
    esSet = new Set(es);
  });
  return dictReady;
}

// Normaliza para comparar contra el diccionario (minúsculas, sin comillas raras)
function normalize(word){
  return word.toLowerCase()
    .replace(/[’'‘]/g,"'");
}

// Heurística: es palabra alemana relevante si está en el diccionario alemán
// y NO está en el diccionario español (evita marcar cognados tipo "hotel", "no", "de").
function isGermanWord(raw){
  const w = normalize(raw);
  if (w.length < 2) return false;
  if (esSet.has(w)) return false;
  if (deSet.has(w)) return true;
  // probar también sin mayúscula inicial alemana ya cubierto por lowercase
  return false;
}

function levelFor(count){
  // 0-1 veces vista antes = nueva (naranja), 2-6 = amarillo, 7-12 = crema, 13+ = sin resaltar
  if (count >= 13) return -1;
  if (count >= 7) return 3;
  if (count >= 2) return 2;
  return 1; // 0 o 1 veces
}
function levelClass(count){
  const lvl = levelFor(count);
  return lvl === -1 ? null : ('lvl-' + lvl);
}

/* ===================== Parseo del EPUB ===================== */
async function parseEpub(file){
  const zip = await JSZip.loadAsync(file);

  // 1. Encontrar el OPF vía container.xml
  const containerXml = await zip.file('META-INF/container.xml').async('string');
  const containerDoc = new DOMParser().parseFromString(containerXml, 'application/xml');
  const opfPath = containerDoc.querySelector('rootfile').getAttribute('full-path');
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')+1) : '';

  const opfXml = await zip.file(opfPath).async('string');
  const opfDoc = new DOMParser().parseFromString(opfXml, 'application/xml');

  // Título
  let title = opfDoc.querySelector('metadata > *|title, metadata title');
  title = title ? title.textContent : file.name.replace(/\.epub$/i,'');

  // 2. manifest: id -> href
  const manifest = {};
  opfDoc.querySelectorAll('manifest > item').forEach(item=>{
    manifest[item.getAttribute('id')] = item.getAttribute('href');
  });

  // 3. spine: orden de lectura
  const spineIds = Array.from(opfDoc.querySelectorAll('spine > itemref')).map(el=>el.getAttribute('idref'));
  const hrefs = spineIds.map(id=>manifest[id]).filter(Boolean);

  // 4. Leer cada archivo de contenido en orden
  const htmlChunks = [];
  for (const href of hrefs){
    const fullPath = opfDir + href;
    const zf = zip.file(fullPath) || zip.file(decodeURIComponent(fullPath));
    if (!zf) continue;
    const raw = await zf.async('string');
    // extraer solo el body
    const doc = new DOMParser().parseFromString(raw, 'text/html');
    const body = doc.body ? doc.body.innerHTML : raw;
    htmlChunks.push(body);
  }

  return { title, htmlChunks };
}

/* ===================== Tokenización y resaltado ===================== */
// Recorre nodos de texto de un fragmento HTML y envuelve palabras alemanas conocidas en <span>
const WORD_RE = /[A-Za-zÄÖÜäöüßÁÉÍÓÚáéíóúñÑ]+/g;

function highlightHtmlChunk(html, sessionCounts){
  const container = document.createElement('div');
  container.innerHTML = html;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  const textNodes = [];
  let n;
  while ((n = walker.nextNode())) textNodes.push(n);

  textNodes.forEach(node=>{
    const text = node.nodeValue;
    if (!WORD_RE.test(text)) return;
    WORD_RE.lastIndex = 0;

    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    let m;
    while ((m = WORD_RE.exec(text))){
      const word = m[0];
      const start = m.index, end = start + word.length;
      if (start > lastIndex) frag.appendChild(document.createTextNode(text.slice(lastIndex, start)));

      if (isGermanWord(word)){
        const key = normalize(word);
        const priorCount = wordCounts[key] || 0;
        const cls = levelClass(priorCount);
        // registrar ocurrencia en esta sesión de lectura (se guarda al terminar de procesar el libro)
        sessionCounts[key] = (sessionCounts[key] || 0) + 1;

        if (cls){
          const span = document.createElement('span');
          span.className = 'w-de ' + cls;
          span.textContent = word;
          span.dataset.word = key;
          span.dataset.display = word;
          frag.appendChild(span);
        } else {
          frag.appendChild(document.createTextNode(word));
        }
      } else {
        frag.appendChild(document.createTextNode(word));
      }
      lastIndex = end;
    }
    if (lastIndex < text.length) frag.appendChild(document.createTextNode(text.slice(lastIndex)));
    node.parentNode.replaceChild(frag, node);
  });

  return container.innerHTML;
}

/* ===================== Flujo principal: importar libro ===================== */
async function importEpub(file){
  showLoading('Leyendo el EPUB…');
  await loadDictionaries();
  try{
    const { title, htmlChunks } = await parseEpub(file);
    showLoading('Detectando palabras en alemán…');

    const sessionCounts = {}; // ocurrencias encontradas en ESTE libro (para sumar al historial)
    const processedChunks = htmlChunks.map(chunk => highlightHtmlChunk(chunk, sessionCounts));

    // Sumar las ocurrencias de esta lectura al historial persistente
    for (const [w, c] of Object.entries(sessionCounts)){
      wordCounts[w] = (wordCounts[w] || 0) + c;
    }
    saveCounts();

    const id = 'b_' + Date.now();
    books[id] = { title, addedAt: Date.now(), htmlChunks: processedChunks, wordCount: Object.keys(sessionCounts).length };
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
    return `<div class="booklist-item" data-id="${id}">
      <div><div class="title">${escapeHtml(b.title)}</div><div class="meta">${date} · ${b.wordCount || 0} palabras en alemán</div></div>
      <div style="color:var(--sub)">›</div>
    </div>`;
  }).join('');
  list.querySelectorAll('.booklist-item').forEach(el=>{
    el.addEventListener('click', ()=> openReader(el.dataset.id));
  });
}

function openReader(id){
  const b = books[id];
  const readerEl = document.getElementById('reader');
  readerEl.innerHTML = b.htmlChunks.join('<hr style="border:none;border-top:1px solid var(--border);margin:2em 0;">');
  showScreen('reader', b.title);
}

function renderStats(){
  const entries = Object.entries(wordCounts).sort((a,b)=> b[1]-a[1]);
  const el = document.getElementById('stats');
  if (entries.length === 0){
    el.innerHTML = '<div class="empty">Todavía no has leído palabras en alemán.</div>';
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
        ${entries.map(([w,c])=>`<div class="statrow"><span>${escapeHtml(w)}</span><span style="color:var(--sub)">${c}×</span></div>`).join('')}
      </div>`;
  }
  showScreen('stats', 'Tu progreso');
}

function escapeHtml(s){ return s.replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/* ===================== Popup de palabra + pronunciación ===================== */
const popup = document.getElementById('popup');
let currentPopWord = null;

document.getElementById('reader').addEventListener('click', (e)=>{
  const span = e.target.closest('.w-de');
  if (!span) return;
  currentPopWord = span.dataset.word;
  document.getElementById('popWord').textContent = span.dataset.display;
  const c = wordCounts[currentPopWord] || 0;
  document.getElementById('popCount').textContent = `Vista ${c} ${c===1?'vez':'veces'} en total`;
  popup.classList.add('show');
  speak(span.dataset.display);
});
document.getElementById('popClose').addEventListener('click', ()=> popup.classList.remove('show'));
document.getElementById('popSpeak').addEventListener('click', ()=>{
  const w = document.getElementById('popWord').textContent;
  speak(w);
});

function speak(text){
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'de-DE';
  const voices = window.speechSynthesis.getVoices();
  const deVoice = voices.find(v=>v.lang && v.lang.startsWith('de'));
  if (deVoice) u.voice = deVoice;
  u.rate = 0.85;
  window.speechSynthesis.speak(u);
}
// iOS a veces carga las voces de forma asíncrona
if ('speechSynthesis' in window){
  window.speechSynthesis.onvoiceschanged = ()=>{};
}

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

/* Service worker para uso offline (opcional, falla silenciosamente si no aplica) */
if ('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('service-worker.js').catch(()=>{});
  });
}
