// Simple client-side Q app that loads questions.json (supports single, multi, and free-text)
let questions = [];
let orderedPool = [];
let sessionPool = [];
let sessionQs = [];
let sequentialMode = false;
let seqIndex = 0; // deprecated in favor of paging, kept for compatibility
let currentQuestionIdx = 0; // page-local index
let sessionSize = 0;
const PAGE_SIZE = 10;
let pageIndex = 0; // page 0-based
let allMode = false; // true when user selected 'all'

function shuffle(arr){
  for(let i=arr.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [arr[i],arr[j]] = [arr[j],arr[i]];
  }
  return arr;
}

function stripLetterPrefix(text){
  if(typeof text !== 'string') return text;
  // remove common prefixes like "a.", "A)", "(a)" with optional spaces
  return text.replace(/^\s*\(?[a-zA-Z]\)?[\.\):\-]\s+/,'').trim();
}

function normalizeAnswers(rawAns){
  if(rawAns == null) return [];
  if(Array.isArray(rawAns)) return rawAns.map(a => (a+"").trim());
  if(typeof rawAns === 'number') return [String(rawAns)];
  return [(rawAns+"").trim()];
}

function pickAnswerField(q){
  if(q.answer != null) return q.answer;
  if(q.correct_answers != null) return q.correct_answers;
  if(q.correct_answer != null) return q.correct_answer;
  return null;
}

function normalizeOne(raw){
  const questionText = (raw.question || raw.prompt || '').toString();
  const explanation = (raw.explanation || '').toString();
  const ansField = pickAnswerField(raw);
  const answersRaw = normalizeAnswers(ansField);

  // Build options list
  let optList = [];
  let optKeys = [];
  if(Array.isArray(raw.options)){
    optList = raw.options.map(o => typeof o === 'string' ? stripLetterPrefix(o) : String(o));
  } else if(raw.options && typeof raw.options === 'object'){
    optKeys = Object.keys(raw.options).sort((a,b)=>a.localeCompare(b, undefined, {sensitivity:'base'}));
    optList = optKeys.map(k => stripLetterPrefix(String(raw.options[k])));
  }

  // Determine which options are correct
  let correctByIndex = new Set();
  let expectedText = [];

  if(optList.length > 0){
    // Try interpret answers as letters (A/B/...) or keys from object form
    const letterToIndex = (letter)=>{
      const L = (letter||'').toString().trim().charAt(0).toUpperCase();
      const idx = L.charCodeAt(0) - 65;
      return (idx >= 0 && idx < optList.length) ? idx : -1;
    };

    answersRaw.forEach(rawA => {
      if(rawA == null) return;
      // As letter
      const idxFromLetter = letterToIndex(rawA);
      if(idxFromLetter !== -1){
        correctByIndex.add(idxFromLetter);
        return;
      }
      // As object key (a/b/c) when options provided as object
      if(optKeys.length){
        const keyIdx = optKeys.findIndex(k => k.toLowerCase() === String(rawA).toLowerCase());
        if(keyIdx !== -1){ correctByIndex.add(keyIdx); return; }
      }
      // As exact option text match (case-insensitive, prefix-stripped)
      const cleaned = stripLetterPrefix(String(rawA));
      const textIdx = optList.findIndex(t => t.toLowerCase() === cleaned.toLowerCase());
      if(textIdx !== -1){ correctByIndex.add(textIdx); return; }
    });
  } else {
    // Free text answers
    expectedText = answersRaw.map(a => String(a));
  }

  const normalizedOptions = optList.map((t, i) => ({ id: 'o_'+i, text: t, isCorrect: correctByIndex.has(i) }));
  let type = 'text';
  if(normalizedOptions.length > 0){
    const numCorrect = Array.from(correctByIndex).length;
    type = numCorrect > 1 ? 'multiple' : 'single';
  }

  return {
    question: questionText,
    explanation,
    type,
    options: normalizedOptions,
    expectedText
  };
}

async function loadQuestions(){
  try{
    const res = await fetch('./questions.json', { cache: 'no-store' });
    const data = await res.json();
    if(!Array.isArray(data)){
      console.error('questions.json is not an array');
      questions = [];
      return;
    }
    questions = data.map(normalizeOne).filter(q => q.question);
  }catch(e){
    console.error('Failed to load questions.json', e);
    questions = [];
  }
}

function renderQuestions(){
  const area = document.getElementById('qarea');
  area.innerHTML = '';
  sessionQs.forEach((q, idx) => {
    const card = document.createElement('div');
    card.className = 'card';
    const qdiv = document.createElement('div');
    qdiv.className = 'question';
    qdiv.textContent = (idx+1)+'. '+q.question;
    card.appendChild(qdiv);

    const opts = document.createElement('div');
    opts.className = 'options';

    if(q.type === 'single' || q.type === 'multiple'){
      // shuffle options per render while preserving correctness unless sequential mode
      const list = sequentialMode ? q.options.map(o => ({...o})) : shuffle(q.options.map(o => ({...o})));
      list.forEach((op, i) => {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = (q.type === 'multiple') ? 'checkbox' : 'radio';
        input.name = 'q'+idx;
        input.value = op.id;
        input.dataset.correct = op.isCorrect ? '1' : '0';
        label.appendChild(input);
        const span = document.createElement('span');
        const letter = String.fromCharCode(65+i);
        span.textContent = ' '+letter+'. '+op.text;
        label.appendChild(span);
        opts.appendChild(label);
      });
    } else {
      const ta = document.createElement('input');
      ta.type = 'text';
      ta.name = 'q'+idx;
      ta.placeholder = 'Type your answer';
      ta.style.width = '100%';
      ta.autocomplete = 'off';
      opts.appendChild(ta);
    }
    card.appendChild(opts);
    area.appendChild(card);
  });

  const submit = document.createElement('button');
  submit.textContent = 'Submit Answers';
  submit.onclick = evaluate;
  submit.style.marginTop = '12px';
  document.getElementById('qarea').appendChild(submit);

  buildNavigator();
}

function setsEqual(a, b){
  if(a.size !== b.size) return false;
  for(const v of a){ if(!b.has(v)) return false; }
  return true;
}

function evaluate(){
  let score = 0;
  const area = document.getElementById('qarea');
  const cards = area.querySelectorAll('.card');

  cards.forEach((card, idx) => {
    const q = sessionQs[idx];
    const labels = card.querySelectorAll('.options label');

    if(q.type === 'single' || q.type === 'multiple'){
      const selectedIds = new Set();
      labels.forEach(l => {
        const inp = l.querySelector('input');
        if(inp && inp.checked){ selectedIds.add(inp.value); }
      });

      // Mark UI
      labels.forEach(l => {
        const inp = l.querySelector('input');
        l.classList.remove('correct','wrong');
        if(inp){
          if(inp.dataset.correct === '1') l.classList.add('correct');
          if(inp.checked && inp.dataset.correct !== '1') l.classList.add('wrong');
        }
      });

      const correctIds = new Set((q.options||[]).filter(o=>o.isCorrect).map(o=>o.id));
      if(q.type === 'single'){
        if(selectedIds.size === 1){
          const only = Array.from(selectedIds)[0];
          if(correctIds.has(only)) score += 1;
        }
      } else {
        if(setsEqual(selectedIds, correctIds)) score += 1;
      }
    } else {
      // text
      const inp = card.querySelector('.options input[type="text"]');
      const user = (inp ? inp.value : '').trim();
      let isCorrect = false;
      if(q.expectedText && q.expectedText.length){
        const norm = (s)=>s.toString().trim().toLowerCase();
        const candidates = q.expectedText.map(norm);
        const userNorm = norm(user);
        // numeric tolerant match
        const userNum = Number(user);
        const anyNumeric = q.expectedText.some(v => !Number.isNaN(Number(v)));
        if(anyNumeric && !Number.isNaN(userNum)){
          isCorrect = q.expectedText.some(v => Number(v) === userNum);
        }
        if(!isCorrect){
          isCorrect = candidates.includes(userNorm);
        }
      }
      if(isCorrect) score += 1;
    }

    // show explanation or correct answer
    let msg = q.explanation || '';
    if(!msg){
      if(q.type === 'single' || q.type === 'multiple'){
        const correctTexts = (q.options||[]).filter(o=>o.isCorrect).map(o=>o.text);
        if(correctTexts.length){ msg = 'Correct: '+correctTexts.join(', '); }
      } else if(q.expectedText && q.expectedText.length){
        msg = 'Correct: '+q.expectedText.join(' / ');
      }
    }
    if(msg){
      let expl = card.querySelector('.expl');
      if(!expl){
        expl = document.createElement('div');
        expl.className = 'expl';
        card.appendChild(expl);
      }
      expl.textContent = msg.startsWith('Explanation:') ? msg : ('Explanation: '+msg);
    }
  });

  document.getElementById('results').hidden = false;
  document.getElementById('score').textContent = 'Score: ' + score + ' / ' + sessionQs.length;

  // Show or hide Next/Prev buttons for paging (also available in navigator)
  const res = document.getElementById('results');
  let nextBtn = document.getElementById('nextPageBtn');
  if(!nextBtn){
    nextBtn = document.createElement('button');
    nextBtn.id = 'nextPageBtn';
    nextBtn.textContent = 'Next 10';
    nextBtn.style.marginLeft = '8px';
    res.appendChild(nextBtn);
    nextBtn.addEventListener('click', goToNextPage);
  }
  const canNext = ((pageIndex + 1) * PAGE_SIZE) < sessionSize;
  nextBtn.hidden = !canNext;

  // Prev 10 button
  let prevBtn = document.getElementById('prevPageBtn');
  if(!prevBtn){
    prevBtn = document.createElement('button');
    prevBtn.id = 'prevPageBtn';
    prevBtn.textContent = 'Prev 10';
    prevBtn.style.marginLeft = '8px';
    res.appendChild(prevBtn);
    prevBtn.addEventListener('click', goToPrevPage);
  }
  const canPrev = pageIndex > 0;
  prevBtn.hidden = !canPrev;
}

function startSession(){
  const sel = document.getElementById('count').value;
  sequentialMode = !!(document.getElementById('sequential') && document.getElementById('sequential').checked);
  // reset paging when starting fresh
  seqIndex = 0;
  pageIndex = 0;
  currentQuestionIdx = 0;
  orderedPool = [...questions];
  if(orderedPool.length === 0){
    alert('No questions found. If opening index.html directly, please serve via a local server (e.g., VS Code Live Server) so the browser can fetch questions.json.');
    return;
  }
  // shuffle questions only if not in sequential mode
  if(!sequentialMode){
    shuffle(orderedPool);
  }
  // determine session size
  allMode = (sel === 'all');
  sessionSize = allMode ? orderedPool.length : Math.min(parseInt(sel,10) || 10, orderedPool.length);
  sessionPool = orderedPool.slice(0, sessionSize);
  recalcPageSlice();
  renderQuestions();
  document.getElementById('results').hidden = true;
}

function recalcPageSlice(){
  const start = pageIndex * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, sessionSize);
  sessionQs = sessionPool.slice(start, end).map(q => ({...q, options: q.options ? q.options.map(o=>({...o})) : []}));
}

function goToNextPage(){
  if(((pageIndex + 1) * PAGE_SIZE) >= sessionSize) return;
  pageIndex += 1;
  currentQuestionIdx = 0;
  recalcPageSlice();
  renderQuestions();
  document.getElementById('results').hidden = true;
}

function goToPrevPage(){
  if(pageIndex === 0) return;
  pageIndex -= 1;
  currentQuestionIdx = 0;
  recalcPageSlice();
  renderQuestions();
  document.getElementById('results').hidden = true;
}

function buildNavigator(){
  const nav = document.getElementById('navigator');
  if(!nav) return;
  nav.innerHTML = '';

  // Paging controls
  const prevPageBtn = document.createElement('button');
  prevPageBtn.className = 'nav-btn';
  prevPageBtn.textContent = 'Prev 10';
  prevPageBtn.onclick = goToPrevPage;
  prevPageBtn.disabled = (pageIndex === 0);
  nav.appendChild(prevPageBtn);

  const prevQ = document.createElement('button');
  prevQ.className = 'nav-btn';
  prevQ.textContent = 'Prev Q';
  prevQ.onclick = () => gotoGlobalIndex(Math.max(0, pageIndex*PAGE_SIZE + currentQuestionIdx - 1));
  nav.appendChild(prevQ);

  const totalButtons = allMode ? sessionSize : sessionQs.length;
  for(let i=0;i<totalButtons;i++){
    const globalIdx = allMode ? i : (pageIndex*PAGE_SIZE + i);
    const pageLocalIdx = allMode ? (globalIdx % PAGE_SIZE) : i;
    const b = document.createElement('button');
    const isActive = (globalIdx === (pageIndex*PAGE_SIZE + currentQuestionIdx));
    b.className = 'nav-btn' + (isActive ? ' active' : '');
    b.textContent = String(globalIdx + 1);
    b.onclick = () => gotoGlobalIndex(globalIdx);
    nav.appendChild(b);
  }

  const nextQ = document.createElement('button');
  nextQ.className = 'nav-btn';
  nextQ.textContent = 'Next Q';
  nextQ.onclick = () => gotoGlobalIndex(Math.min(sessionSize - 1, pageIndex*PAGE_SIZE + currentQuestionIdx + 1));
  nav.appendChild(nextQ);

  const nextPageBtn = document.createElement('button');
  nextPageBtn.className = 'nav-btn';
  nextPageBtn.textContent = 'Next 10';
  nextPageBtn.onclick = goToNextPage;
  nextPageBtn.disabled = (((pageIndex + 1) * PAGE_SIZE) >= sessionSize);
  nav.appendChild(nextPageBtn);

  // Jump input
  const jumpWrap = document.createElement('div');
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '1';
  input.max = String(sessionSize);
  input.placeholder = 'Go to #';
  input.style.marginLeft = '8px';
  input.style.width = '90px';
  input.id = 'jumpInput';
  const goBtn = document.createElement('button');
  goBtn.className = 'nav-btn';
  goBtn.textContent = 'Go';
  goBtn.style.marginLeft = '6px';
  goBtn.onclick = () => {
    const val = parseInt(input.value, 10);
    if(Number.isFinite(val)){
      gotoGlobalIndex(Math.max(0, Math.min(sessionSize-1, val-1)));
    }
  };
  jumpWrap.appendChild(input);
  jumpWrap.appendChild(goBtn);
  nav.appendChild(jumpWrap);
}

function gotoGlobalIndex(gIdx){
  const clamped = Math.max(0, Math.min(sessionSize - 1, gIdx));
  pageIndex = Math.floor(clamped / PAGE_SIZE);
  currentQuestionIdx = clamped % PAGE_SIZE;
  recalcPageSlice();
  renderQuestions();
  // Scroll after render
  const cards = document.querySelectorAll('#qarea .card');
  if(cards[currentQuestionIdx]){
    cards[currentQuestionIdx].scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

document.getElementById('startBtn').addEventListener('click', startSession);
document.getElementById('reshuffle').addEventListener('click', startSession);
document.getElementById('tryAgain').addEventListener('click', startSession);

window.addEventListener('load', async () => {
  await loadQuestions();
});