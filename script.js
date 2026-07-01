(function(){
"use strict";

/* ============================================================
   INTEGRITY CHECK — DISABLED
   ============================================================ */
// (disabled)

/* ============================================================
   DOMAIN LOCK + COPY PROTECTION
   ============================================================ */
(function(){
  // Allowed origins — add localhost for your own dev use
  var _a = ['mladder.vercel.app'];
  var _h = location.hostname;
  var _ok = _a.some(function(d){ return _h === d || _h.endsWith('.'+d); });
  if(!_ok){
    document.documentElement.innerHTML =
      '<style>*{margin:0;padding:0;box-sizing:border-box;}body{background:#11151A;color:#D7F23D;'+
      'font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;'+
      'height:100vh;text-align:center;padding:32px;}h1{font-size:2rem;margin-bottom:12px;}'+
      'p{color:#888;font-size:1rem;max-width:340px;}</style>'+
      '<body><div><h1>⛔ Unauthorized</h1>'+
      '<p>This app is only licensed to run on<br><strong style="color:#D7F23D">mladder.vercel.app</strong></p></div></body>';
    throw new Error('Unauthorized domain: ' + _h);
  }
})();

(function(){
  // Disable right-click context menu
  document.addEventListener('contextmenu', function(e){ e.preventDefault(); });

  // Block common view-source / inspect shortcuts
  document.addEventListener('keydown', function(e){
    var k = e.key, c = e.ctrlKey||e.metaKey, s = e.shiftKey;
    // Ctrl+U (view source), Ctrl+S (save), Ctrl+Shift+I/J/C (devtools), F12
    if(
      (c && k==='u') ||
      (c && k==='s') ||
      (c && s && (k==='I'||k==='i')) ||
      (c && s && (k==='J'||k==='j')) ||
      (c && s && (k==='C'||k==='c')) ||
      k==='F12'
    ){ e.preventDefault(); e.stopPropagation(); return false; }
  });

  // DevTools size-change detection
  var _dt = {open:false};
  var _threshold = 160;
  setInterval(function(){
    var w = window.outerWidth - window.innerWidth;
    var h = window.outerHeight - window.innerHeight;
    var isOpen = w > _threshold || h > _threshold;
    if(isOpen && !_dt.open){
      _dt.open = true;
      var el = document.getElementById('ml-devtools-warning');
      if(el) el.classList.add('show');
    } else if(!isOpen && _dt.open){
      _dt.open = false;
      var el2 = document.getElementById('ml-devtools-warning');
      if(el2) el2.classList.remove('show');
    }
  }, 1000);
})();

/* ============================================================
   STORAGE KEYS
   ============================================================ */
const KEYS = {
  players:'kl_players', matches:'kl_matches', current:'kl_current',
  currentGeneration:'kl_currentGeneration', // stored separately so mode-switch never drops either
  settings:'kl_settings', round:'kl_round', undo:'kl_undo', tab:'kl_tab',
  fixedDuos:'kl_fixedDuos', sitOutQueue:'kl_sitOutQueue',
  rotationCourts:'kl_rotationCourts',  // Continuous Smart Open Play: per-court state array
  scheduledGenerations:'kl_scheduledGenerations', // Round Robin "one-time generation": every future round already built, waiting to be activated
  paddleStack:'kl_paddleStack'  // Paddle Stack Open Play queue state
};

const SESSIONS_KEY = 'kl_sessions'; // archived past sessions — stored separately, never wiped by reset

const DEFAULT_SETTINGS = {
  matchMode: 'Rotation', // 'Rotation' or 'RoundRobin'
  numCourts: 1,
  winnerVsWinner: true,
  maxRepeatTeammates: 2,
  maxRepeatOpponents: 3,
  audioScoring: true,    // play sound cues for +/- points, side-outs, and game wins
  voiceAnnounce: true,   // speak the score call (server's score first) and side-out announcements out loud
  winningScore: 11,      // first team to reach this score (win by 2) takes the match
  raceToTwo: true,        // when both teams reach 10-10 ("Love-Love"), offer a sudden-death Race to 2
  sessionPlan: null,      // { totalMatches, gamesPerPlayer, label, matchesAtStart } — active Round Robin session length plan, or null if none chosen yet
  generateFullSchedule: false // Round Robin "one-time generation": build every round of the chosen session length right away instead of one generation at a time
};

// Round Robin "session length" choices offered when starting a fresh session.
// totalMatches assumes a 4-players-per-match format; gamesPerPlayer is totalMatches
// scaled for a 12-player group (the reference size), used only as a label hint —
// the actual recommendation is computed live against the real active player count.
const SESSION_PLAN_OPTIONS = [
  { id:'quick',       totalMatches:9,  gamesPerPlayer:3, label:'Quick Session',               tag:'' },
  { id:'casual',      totalMatches:12, gamesPerPlayer:4, label:'Casual Tournament',            tag:'' },
  { id:'balanced',    totalMatches:15, gamesPerPlayer:5, label:'Balanced Tournament',          tag:'Recommended' },
  { id:'competitive', totalMatches:18, gamesPerPlayer:6, label:'Competitive Tournament',       tag:'' },
  { id:'full',        totalMatches:24, gamesPerPlayer:8, label:'Full Session',                 tag:'' }
];

/* ============================================================
   STATE — loaded once at boot, persisted after every mutation
   ============================================================ */
let state = {
  players: [],
  matches: [],
  current: null,         // Rotation legacy single-court: { round, teamA:[id,id], teamB:[id,id] }
  currentGeneration: null, // RoundRobin: { generation, courts:[ { court, teamA:[id,id], teamB:[id,id], scoreA:null, scoreB:null, winner:null } ] }
  settings: { ...DEFAULT_SETTINGS },
  round: 0,
  undo: null,
  tab: 'match',
  fixedDuos: [],
  sitOutQueue: [],
  rotationCourts: [],    // Continuous Smart Open Play: array of per-court match objects
  scheduledGenerations: [], // Round Robin "one-time generation": pre-built future rounds waiting their turn
  paddleStack: null      // Paddle Stack Open Play queue state
};

// In-memory session flags (not persisted — intentionally reset each page load)
let _courtCountNoticeDismissed = false;

/* ============================================================
   INDEXEDDB PERSISTENCE LAYER
   ------------------------------------------------------------
   All core app data (players, matches, current/currentGeneration,
   settings, round, undo, tab, fixedDuos) lives in a single IndexedDB
   object store, keyed the same way the old localStorage keys were.
   IndexedDB is asynchronous, so loadState() now returns a Promise —
   the boot sequence at the bottom of this file awaits it before the
   first renderAll(). saveAll() stays a fire-and-forget call at every
   existing call site (it kicks off the IndexedDB write but nothing
   in the app waits on it, since every caller already works purely
   off the in-memory `state` object afterward).
   ============================================================ */
const IDB_DB_NAME = 'kl_db';
const IDB_DB_VERSION = 1;
const IDB_STORE_NAME = 'kv';
const IDB_MIGRATION_FLAG_KEY = '_kl_legacy_migrated_v1';

let _idbConnectionPromise = null;
function openIDB(){
  if(_idbConnectionPromise) return _idbConnectionPromise;
  _idbConnectionPromise = new Promise((resolve, reject) => {
    if(!('indexedDB' in window)){ reject(new Error('IndexedDB is not available in this browser.')); return; }
    let req;
    try{ req = indexedDB.open(IDB_DB_NAME, IDB_DB_VERSION); }
    catch(e){ reject(e); return; }
    req.onupgradeneeded = function(e){
      const db = e.target.result;
      if(!db.objectStoreNames.contains(IDB_STORE_NAME)){
        db.createObjectStore(IDB_STORE_NAME);
      }
    };
    req.onsuccess = function(e){ resolve(e.target.result); };
    req.onerror = function(e){ reject(e.target.error || new Error('Failed to open IndexedDB.')); };
    req.onblocked = function(){ reject(new Error('IndexedDB open request was blocked.')); };
  });
  return _idbConnectionPromise;
}

function idbGet(key){
  return openIDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_NAME, 'readonly');
    const store = tx.objectStore(IDB_STORE_NAME);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

// Fetches every key in one shared transaction (cheaper than N separate ones)
// and returns a plain { key: value } map. Missing keys simply come back as
// `undefined` in the map, same as a single idbGet() miss would.
function idbGetMany(keys){
  return openIDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_NAME, 'readonly');
    const store = tx.objectStore(IDB_STORE_NAME);
    const out = {};
    let pending = keys.length;
    if(!pending){ resolve(out); return; }
    keys.forEach(key => {
      const req = store.get(key);
      req.onsuccess = () => { out[key] = req.result; pending--; if(pending===0) resolve(out); };
      req.onerror = () => reject(req.error);
    });
  }));
}

function idbSet(key, value){
  return openIDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
    const store = tx.objectStore(IDB_STORE_NAME);
    store.put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

// Writes every [key, value] pair in `entries` inside a single readwrite
// transaction — this is what saveAll() uses so one user action only costs
// one IndexedDB transaction no matter how many top-level keys changed.
function idbSetMany(entries){
  return openIDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
    const store = tx.objectStore(IDB_STORE_NAME);
    entries.forEach(([key, value]) => store.put(value, key));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

// One-time import of any data left over from a previous version of this app
// that used localStorage (kl_players, kl_matches, etc). Runs before the first
// loadState() call; once it's copied data over (or confirmed there's nothing
// to copy), it sets a flag in IndexedDB itself so it never runs again — and
// it removes the old localStorage keys so a stale copy can never shadow
// fresher IndexedDB writes on some future load.
async function migrateLegacyLocalStorageIfNeeded(){
  try{
    const already = await idbGet(IDB_MIGRATION_FLAG_KEY);
    if(already) return;
    const entries = [];
    let foundAny = false;
    Object.values(KEYS).forEach(key => {
      let raw;
      try{ raw = localStorage.getItem(key); }catch(e){ raw = null; }
      if(raw === null || raw === undefined) return;
      foundAny = true;
      if(key === KEYS.tab){ entries.push([key, raw]); return; } // plain string, not JSON
      if(key === KEYS.round){ entries.push([key, parseInt(raw,10)||0]); return; } // plain numeric string
      try{ entries.push([key, JSON.parse(raw)]); }
      catch(e){ entries.push([key, raw]); }
    });
    if(foundAny) await idbSetMany(entries);
    await idbSet(IDB_MIGRATION_FLAG_KEY, true);
    if(foundAny){
      Object.values(KEYS).forEach(key => { try{ localStorage.removeItem(key); }catch(e){} });
    }
  }catch(e){
    // Non-fatal — worst case an old localStorage snapshot just doesn't get
    // imported, the app still boots fine on an empty/fresh IndexedDB store.
    console.error('Legacy localStorage migration skipped due to an error.', e);
  }
}

async function loadState(){
  try{
    await migrateLegacyLocalStorageIfNeeded();
    const data = await idbGetMany(Object.values(KEYS));
    const p = data[KEYS.players];
    if(p) {
      state.players = p;
      state.players.forEach(pl => {
        if(typeof pl.isSub !== 'boolean') pl.isSub = false;
        if(!pl.condition) pl.condition = 'ok';
      });
    }
    const m = data[KEYS.matches];
    if(m) state.matches = m;
    // Load current (Rotation single match) and currentGeneration (RoundRobin) independently
    // so a mode-setting change never silently drops whichever one was last active.
    const c = data[KEYS.current];
    if(c !== undefined && c !== null){
      // Legacy: old saves stored currentGeneration under the same 'current' key —
      // detect by the presence of a .matches array and migrate transparently.
      if(c && c.matches){ state.currentGeneration = c; state.current = null; }
      else { state.current = c; }
    }
    const cg = data[KEYS.currentGeneration];
    if(cg !== undefined && cg !== null) state.currentGeneration = cg;
    const s = data[KEYS.settings];
    if(s) state.settings = { ...DEFAULT_SETTINGS, ...s };
    const r = data[KEYS.round];
    if(r !== undefined && r !== null) state.round = parseInt(r,10)||0;
    const u = data[KEYS.undo];
    if(u !== undefined) state.undo = u;
    const t = data[KEYS.tab];
    if(t) state.tab = t;
    const fd = data[KEYS.fixedDuos];
    if(fd) state.fixedDuos = fd;
    const soq = data[KEYS.sitOutQueue];
    if(Array.isArray(soq)) state.sitOutQueue = soq;
    const rc = data[KEYS.rotationCourts];
    if(Array.isArray(rc)) state.rotationCourts = rc;
    const sg = data[KEYS.scheduledGenerations];
    if(Array.isArray(sg)) state.scheduledGenerations = sg;
    const ps = data[KEYS.paddleStack];
    if(ps) state.paddleStack = ps;
  }catch(e){
    console.error('Failed to load saved data from IndexedDB, starting fresh.', e);
    toast("Couldn't open local storage — starting with a blank session. Your browser may be blocking IndexedDB (private/incognito mode, or storage disabled).", 'error');
  }
}

function saveAll(){
  try{
    // Save state.current and state.currentGeneration under separate keys so a
    // mid-session matchMode change in Settings never silently drops one of them.
    const entries = [
      [KEYS.players, state.players],
      [KEYS.matches, state.matches],
      [KEYS.current, state.current],
      [KEYS.currentGeneration, state.currentGeneration],
      [KEYS.settings, state.settings],
      [KEYS.round, state.round],
      [KEYS.undo, state.undo],
      [KEYS.tab, state.tab],
      [KEYS.fixedDuos, state.fixedDuos || []],
      [KEYS.sitOutQueue, state.sitOutQueue || []],
      [KEYS.rotationCourts, state.rotationCourts || []],
      [KEYS.scheduledGenerations, state.scheduledGenerations || []],
      [KEYS.paddleStack, state.paddleStack || null]
    ];
    idbSetMany(entries).catch(e => {
      console.error('IndexedDB save failed.', e);
      toast("Couldn't save your changes — storage may be full or unavailable.", 'error');
    });
  }catch(e){
    toast("Couldn't save your changes — storage may be full or unavailable.", 'error');
    console.error(e);
  }
}

/* ============================================================
   UTILITIES
   ============================================================ */
function uid(prefix){ return prefix+'_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,7); }
function clamp(n,min,max){ return Math.max(min, Math.min(max, n)); }
function esc(str){
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function initials(name){
  const parts = name.trim().split(/\s+/);
  if(parts.length===1) return parts[0].slice(0,2).toUpperCase();
  return (parts[0][0]+parts[parts.length-1][0]).toUpperCase();
}
function fmtDate(iso){
  const d = new Date(iso);
  return d.toLocaleDateString(undefined,{month:'short',day:'numeric'}) + ' · ' + d.toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
}
function getPlayer(id){ return state.players.find(p=>p.id===id); }
function playerName(id){ const p = getPlayer(id); return p ? p.name : '—'; }
function deepClone(o){ return JSON.parse(JSON.stringify(o)); }

/* ============================================================
   SESSION LENGTH PLANNING
   ------------------------------------------------------------
   The 5 named plans (Quick/Casual/Balanced/Competitive/Full) are
   defined for a 12-player reference group. Scaled to the real
   active player count so "games per player" stays the constant,
   meaningful number across any group size — a foursome-based
   match always uses 4 player-slots, so:
     totalMatches(playerCount) = gamesPerPlayer * playerCount / 4
   rounded to the nearest multiple of a single generation's match
   count (floor(playerCount/4)) so the plan divides evenly into
   whole generations with nobody short-changed.
   ============================================================ */
function matchesPerGeneration(playerCount){
  return Math.max(1, Math.floor(playerCount / 4));
}

// Scales a plan's reference gamesPerPlayer to the live active player count,
// rounding to the nearest whole generation so the session always ends on a
// completed generation (no partially-finished round left dangling).
function scaledPlanMatches(option, playerCount){
  const perGen = matchesPerGeneration(playerCount);
  const rawMatches = (option.gamesPerPlayer * playerCount) / 4;
  const generations = Math.max(1, Math.round(rawMatches / perGen));
  return generations * perGen;
}

// True games-per-player a player actually experiences for a given scaled
// match total — equal-play scheduling means every active player gets the
// same count each generation, so this is exact, not an average.
function actualGamesPerPlayer(totalMatches, playerCount){
  if(!playerCount) return 0;
  return Math.round((totalMatches * 4 / playerCount) * 10) / 10;
}

// Picks the plan whose scaled match total lands closest to giving each
// player their reference gamesPerPlayer count — i.e. the plan that best
// preserves "Balanced Tournament = 5 games/player" style intent for
// however many players actually showed up. Ties favor Balanced Tournament,
// since it's the sensible middle-ground default when several plans fit
// the player count equally well (e.g. clean multiples of 4 players).
function recommendedPlanId(playerCount){
  const balancedIdx = SESSION_PLAN_OPTIONS.findIndex(o => o.id === 'balanced');
  let best = SESSION_PLAN_OPTIONS[balancedIdx], bestDiff = Infinity;
  SESSION_PLAN_OPTIONS.forEach(opt => {
    const scaled = scaledPlanMatches(opt, playerCount);
    const actualGpp = actualGamesPerPlayer(scaled, playerCount);
    const diff = Math.abs(actualGpp - opt.gamesPerPlayer);
    const isBalanced = opt.id === 'balanced';
    // Strictly-better diff always wins; an equal diff only wins if it's
    // Balanced and the current best isn't already an equally-good Balanced.
    if(diff < bestDiff || (diff === bestDiff && isBalanced)){
      bestDiff = diff; best = opt;
    }
  });
  return best.id;
}


/* ============================================================
   AUDIO SCORING ENGINE
   ------------------------------------------------------------
   Lightweight synthesized sound cues (Web Audio API oscillators)
   for point changes, side-outs, and game wins. No external audio
   files needed — works fully offline. Respects the "Audio Scoring"
   toggle in Settings (state.settings.audioScoring).
   ============================================================ */
let _audioCtx = null;
function getAudioCtx(){
  if(!window.AudioContext && !window.webkitAudioContext) return null;
  try{
    if(!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if(_audioCtx.state === 'suspended') _audioCtx.resume();
    return _audioCtx;
  }catch(e){ return null; }
}

function playTone(freq, duration, type, startGain, delay){
  if(!state.settings.audioScoring) return;
  const ctx = getAudioCtx();
  if(!ctx) return;
  try{
    const t0 = ctx.currentTime + (delay || 0);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(startGain || 0.18, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.03);
  }catch(e){ /* audio not available — fail silently */ }
}

function playPointUpSound(){ playTone(880, 0.13, 'sine', 0.22, 0); }
function playPointDownSound(){ playTone(320, 0.12, 'sine', 0.16, 0); }
function playSideOutSound(){
  playTone(660, 0.09, 'square', 0.16, 0);
  playTone(415, 0.16, 'square', 0.16, 0.10);
}
function playGameWinSound(){
  [660, 880, 1100].forEach((f, i) => playTone(f, 0.18, 'triangle', 0.22, i * 0.11));
}

/* ============================================================
   VOICE SCORE ANNOUNCER
   ------------------------------------------------------------
   Speaks the score call out loud (Web Speech API) following the
   standard doubles pickleball calling order: the serving team's
   own score is always said first, then the receiving team's
   score, then the current server number — e.g. "2 1 1". Side-outs
   say the words "Side out" followed by the new server's call.
   Respects the "Voice Announce" toggle in Settings
   (state.settings.voiceAnnounce). Works on either a round-robin
   match object or the rotation-mode state.current object — both
   share the same { serving, scoreA, scoreB, serverNum } shape.
   ============================================================ */
function safeScore(n){ return (n === null || n === undefined || isNaN(n)) ? 0 : n; }

// Warm up the voice list as early as possible. On Chrome/Android the very
// first speak() call can be silently swallowed if speechSynthesis hasn't
// finished loading its voice list yet — calling getVoices() (and again once
// 'voiceschanged' fires) forces that to happen well before anyone scores.
if('speechSynthesis' in window){
  try{
    window.speechSynthesis.getVoices();
    window.speechSynthesis.addEventListener('voiceschanged', function(){
      window.speechSynthesis.getVoices();
    });
  }catch(e){}
}

function speakNow(text){
  try{
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = 1.05;
    utter.volume = 1;
    window.speechSynthesis.speak(utter);
  }catch(e){ /* speech not available — fail silently */ }
}

function speakUtterance(text, interrupt){
  if(!state.settings.voiceAnnounce) return;
  if(!('speechSynthesis' in window)) return;
  try{
    const synth = window.speechSynthesis;
    if(interrupt){
      // Always cancel + wait a beat before speaking, rather than only doing
      // so when synth.speaking/pending report true. Those flags are
      // unreliable on some browsers (can read stale/false when something is
      // actually still queued), and skipping the cancel+delay in that case
      // was causing repeat announcements — e.g. hitting "Match" again after
      // going back down and scoring up to 10 a second time — to be silently
      // dropped. cancel() on an already-idle engine is a harmless no-op, so
      // doing it unconditionally is safe.
      synth.cancel();
      setTimeout(function(){ speakNow(text); }, 50);
    } else {
      speakNow(text);
    }
  }catch(e){ /* speech not available — fail silently */ }
}

// Spells out numbers as words for the speech engine. Browser TTS reliably
// reads single digits (0-9) and "ten" on its own, but multi-digit numbers
// sitting next to another number in a score call (e.g. "12 1") are
// frequently misread digit-by-digit (e.g. "One Two One" instead of
// "Twelve One"). Spelling the number out ourselves sidesteps the engine's
// number-parsing entirely, so it's used for every score of 11 and above —
// covering custom winning scores well past the default of 11.
const NUMBER_WORDS_ONES = ['Zero','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
const NUMBER_WORDS_TENS = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
function numberToWords(n){
  n = Math.max(0, Math.round(n));
  if(n < 20) return NUMBER_WORDS_ONES[n];
  if(n < 100){
    const tens = Math.floor(n / 10), ones = n % 10;
    return NUMBER_WORDS_TENS[tens] + (ones ? ' ' + NUMBER_WORDS_ONES[ones] : '');
  }
  return String(n); // beyond realistic pickleball scores — fall back to digits
}

// Converts a single score value into its spoken form: bare digits for 0-9
// (these are read correctly by every speech engine), spelled-out words for
// 11+ (see numberToWords above), and the literal word "Love" for exactly 10.
function speakScoreNumber(n){
  if(n === 10) return 'Love';
  if(n >= 11) return numberToWords(n);
  return String(n);
}

function scoreCallText(m){
  const servingScore = m.serving === 'A' ? safeScore(m.scoreA) : safeScore(m.scoreB);
  const otherScore = m.serving === 'A' ? safeScore(m.scoreB) : safeScore(m.scoreA);

  // Real pickleball exception: the very first serve of a new game is the one
  // time the serving team only gets a single serve before side-out, and it's
  // called as server number "2" (not "1") to flag that exception — so a
  // brand-new game's first score call is "0-0-2", never "0-0-1". Every other
  // point in the game calls the actual m.serverNum (1 or 2) as normal.
  const callServerNum = m.firstServe ? 2 : m.serverNum;

  // 10 is always called "Love" instead of the bare digits, on EITHER side of
  // the score (the server's own score, the other team's score, or both if
  // tied at 10-10). Some speech engines misread a literal "10" sitting next
  // to another number as one merged digit string (e.g. "one zero" instead of
  // "ten"), so we never let a literal 10 reach the speech engine — no matter
  // how the score got there: scoring up, backing down via a correction, a
  // side-out (where the team that just lost serve can be the one sitting at
  // 10), or coming back up to 10 again.
  if(servingScore === 10 && otherScore === 10) return `All Love ${speakScoreNumber(callServerNum)}`;
  if(servingScore === 10) return `Love, ${speakScoreNumber(otherScore)} ${speakScoreNumber(callServerNum)}`;
  if(otherScore === 10) return `${speakScoreNumber(servingScore)} Love ${speakScoreNumber(callServerNum)}`;

  // Tied scores (not at 10) get the standard pickleball "All" call instead of
  // saying the same number twice — e.g. "All 3 1" rather than "3 3 1".
  if(servingScore === otherScore) return `All ${speakScoreNumber(servingScore)} ${speakScoreNumber(callServerNum)}`;

  return `${speakScoreNumber(servingScore)} ${speakScoreNumber(otherScore)} ${speakScoreNumber(callServerNum)}`;
}

// Special call for switching to serve 2 while the serving team is at 10 —
// scoreCallText already says "Match" for any 10 score, so this just funnels
// through the normal score call.
function speakServeSwitchCall(m){
  speakScoreCall(m);
}

function speakScoreCall(m){
  speakUtterance(scoreCallText(m), true);
}

function speakSideOut(m){
  if(!state.settings.voiceAnnounce) return;
  if(!('speechSynthesis' in window)) return;
  try{
    const synth = window.speechSynthesis;
    const text = scoreCallText(m);
    synth.cancel();
    // Two back-to-back speakNow() calls queue two separate utterances, and
    // several mobile browsers (notably iOS Safari and some Android WebViews)
    // drop or truncate whichever one is still pending when the next speak()
    // call fires — so "Side out" or the score call would intermittently go
    // silent. Combining both into a single utterance guarantees one speech
    // request, which mobile engines handle reliably.
    setTimeout(function(){ speakNow('Side out. ' + text); }, 50);
  }catch(e){ /* speech not available — fail silently */ }
}

// `type` is one of 'success' | 'warning' | 'error' | 'info' (default).
// Every call site now states its own type explicitly rather than relying on
// keyword-guessing against the message text — the old approach miscategorized
// near-identical messages (e.g. "No serve decision to undo." read as an error
// because it contained "no ", while "Nothing to undo." did not) and could
// misfire on any future wording change.
function toast(msg, type){
  const root = document.getElementById('toast-root');
  if(!root) return;
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' toast-' + type : '');

  const iconMap = {
    success: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    error:   `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
    warning: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    info:    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  };
  const colorMap = {
    success: 'var(--win)',
    error: 'var(--loss)',
    warning: 'var(--ball)',
    info: 'var(--court)',
  };
  const borderColor = type && colorMap[type] ? colorMap[type] : 'var(--ball)';
  el.style.borderLeftColor = borderColor;

  const icon = type && iconMap[type] ? iconMap[type] : iconMap.info;
  const iconColor = borderColor;
  el.innerHTML = `<span style="color:${iconColor};flex:none;display:flex;align-items:center;">${icon}</span><span style="flex:1;line-height:1.4;">${msg}</span>`;

  root.appendChild(el);
  // Limit toast stack to 4
  const toasts = root.querySelectorAll('.toast');
  if(toasts.length > 4) toasts[0].remove();

  const DURATION = 2800;
  setTimeout(()=>{ el.style.opacity='0'; el.style.transform='translateX(12px)'; el.style.transition='opacity .2s ease,transform .2s ease'; setTimeout(()=>el.remove(), 220); }, DURATION);
}

function closeModal(){
  const root = document.getElementById('modal-root');
  root.innerHTML = '';
}
// `dismissible` (default true) controls whether tapping the backdrop closes
// the modal. Pass false for modals that require an explicit answer (e.g.
// the "Race to 2?" prompt) so an accidental outside tap can't silently
// resolve the decision without the user actually choosing an option.
function openModal(html, dismissible){
  if(dismissible === undefined) dismissible = true;
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-bg" id="modal-bg-inner">
    <div class="modal-sheet">${html}</div>
  </div>`;
  // Close only when clicking the backdrop itself, not children
  const bg = root.querySelector('#modal-bg-inner');
  if(bg) bg.addEventListener('click', function(e){
    if(dismissible && e.target === bg) closeModal();
  });
}

/* ============================================================
   PLAYER MODEL HELPERS
   ============================================================ */
function newPlayer(name, isSub){
  return {
    id: uid('p'),
    name: name.trim(),
    active: true,
    isSub: !!isSub,        // Sub Players sit on the bench out of normal rotation —
                            // they're only eligible to sub in for a Tired/Injured player's slot.
    condition: 'ok',        // 'ok' | 'tired' | 'injured'
    gamesPlayed: 0,
    wins: 0,
    losses: 0,
    rating: 1000,
    duprRating: null,          // Optional DUPR rating (e.g. 3.067). null = NR (not rated).
    currentStreak: 0,     // signed: + win streak, - loss streak
    longestStreak: 0,
    sitOuts: 0,
    consecutiveSitOuts: 0,
    sitOutPriority: 0,    // RoundRobin support
    waitingRounds: 0,     // RoundRobin support
    results: [],          // chronological 'W'/'L'
    teammates: {},         // id -> count
    opponents: {},          // id -> count
    createdAt: new Date().toISOString()
  };
}

function winPct(p){
  if(p.gamesPlayed===0) return 0;
  return Math.round((p.wins/p.gamesPlayed)*1000)/10;
}

// Returns a short DUPR display string for a player: "3.067" or "NR"
function duprStr(p){ return (p && p.duprRating != null) ? p.duprRating.toFixed(3) : 'NR'; }
// Returns true if any player in array has a DUPR rating set
function anyDupr(players){ return players.some(p => p && p.duprRating != null); }
// Inline DUPR chip HTML for a single player inside a scoreboard
function duprChip(p){
  const val = p && p.duprRating != null ? p.duprRating.toFixed(3) : 'NR';
  const color = (p && p.duprRating != null) ? 'var(--court)' : 'var(--text-faint)';
  return `<span style="font-family:var(--font-mono);font-size:10.5px;color:${color};background:rgba(79,168,255,0.10);border:1px solid rgba(79,168,255,0.20);border-radius:999px;padding:1px 6px;white-space:nowrap;">DUPR ${val}</span>`;
}

// Average points scored/allowed/margin per game, computed straight from
// match history (so it's accurate regardless of which mode the games came from).
function playerScoreAverages(id){
  let scored = 0, allowed = 0, games = 0;
  state.matches.forEach(m => {
    if(m.teamA.includes(id)){ scored += m.scoreA; allowed += m.scoreB; games++; }
    else if(m.teamB.includes(id)){ scored += m.scoreB; allowed += m.scoreA; games++; }
  });
  if(!games) return { avgFor: 0, avgAgainst: 0, avgMargin: 0, games: 0 };
  const avgFor = scored / games, avgAgainst = allowed / games;
  return {
    avgFor: Math.round(avgFor * 10) / 10,
    avgAgainst: Math.round(avgAgainst * 10) / 10,
    avgMargin: Math.round((avgFor - avgAgainst) * 10) / 10,
    games
  };
}

function pairCount(map, id){ return map[id]||0; }
function bumpPair(map, id){ map[id] = (map[id]||0)+1; }

/* ============================================================
   FIXED DUO MANAGEMENT
   ============================================================ */
function addFixedDuo(id1, id2){
  if(!state.fixedDuos) state.fixedDuos = [];
  // Check if either player is already in a duo
  const existing = state.fixedDuos.find(d => d.includes(id1) || d.includes(id2));
  if(existing){
    toast('One of these players already has a fixed duo — remove it first.', 'warning');
    return;
  }
  if(id1 === id2){ toast('Select two different players.', 'warning'); return; }
  state.fixedDuos.push([id1, id2]);
  saveAll(); renderAll(); closeModal();
  toast(`Fixed duo created: ${playerName(id1)} & ${playerName(id2)}.`, 'success');
}

function removeFixedDuo(id1, id2){
  state.fixedDuos = (state.fixedDuos || []).filter(d => !(d.includes(id1) && d.includes(id2)));
  saveAll(); renderAll(); closeModal();
  toast('Fixed duo removed.', 'success');
}

function getFixedDuoPartner(playerId){
  const duo = (state.fixedDuos || []).find(d => d.includes(playerId));
  if(!duo) return null;
  return duo[0] === playerId ? duo[1] : duo[0];
}

function isFixedDuoValid(id1, id2){
  // Returns true if id1 and id2 are fixed duo partners
  return (state.fixedDuos || []).some(d => d.includes(id1) && d.includes(id2));
}

// Rearrange a group of 4 players to honor fixed duo constraints
// Returns reordered [p1,p2,p3,p4] where fixed duo pairs are together, or null if impossible
function honorFixedDuosInFour(four){
  const ids = four.map(p => p.id);
  // Find any fixed duos within this four
  const duoIdx = (state.fixedDuos || []).map(d => {
    const i0 = ids.indexOf(d[0]);
    const i1 = ids.indexOf(d[1]);
    if(i0 !== -1 && i1 !== -1) return [i0, i1];
    return null;
  }).filter(Boolean);

  if(!duoIdx.length) return four; // no fixed duos — pass through unchanged

  // With up to 2 fixed duos in a foursome, we need to arrange them as [duo1, duo2]
  const used = new Set();
  const orderedPairs = [];
  duoIdx.forEach(([i, j]) => {
    if(!used.has(i) && !used.has(j)){
      orderedPairs.push([four[i], four[j]]);
      used.add(i); used.add(j);
    }
  });
  // Fill any remaining spots
  four.forEach((p, i) => { if(!used.has(i)) orderedPairs.push([p]); });

  // Flatten pairs into [a,b,c,d] where a&b are forced together, c&d are forced together
  const result = orderedPairs.flat();
  return result;
}

/* ============================================================
   PLAYER MANAGEMENT ACTIONS
   ============================================================ */
// Instead of just warning that there aren't enough players to generate a
// match, jump the user straight to the Players tab and focus the "add
// player" input so they can fix it in one tap.
function goToAddPlayer(message){
  if(message) toast(message, 'warning');
  const tabNav = document.getElementById('tabNav');
  if(tabNav){
    const playersTab = tabNav.querySelector('[data-tab="players"]');
    if(playersTab) playersTab.click();
  }
  setTimeout(()=>{
    const nameInput = document.getElementById('newPlayerName') || document.querySelector('input[placeholder*="name"]') || document.querySelector('input[placeholder*="Name"]');
    if(nameInput){ nameInput.focus(); nameInput.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  }, 250);
}

function addPlayer(name, isSub, duprRating){
  name = (name||'').trim();
  if(!name){ toast('Enter a name first.', 'warning'); return; }
  if(state.players.some(p=>p.name.toLowerCase()===name.toLowerCase())){
    toast('A player with that name already exists.', 'warning'); return;
  }
  const p = newPlayer(name, isSub);
  if(duprRating){
    const parsed = parseFloat(duprRating);
    p.duprRating = isNaN(parsed) ? null : Math.round(parsed * 1000) / 1000;
  }
  state.players.push(p);
  saveAll(); renderAll();
  toast(isSub ? `Added ${name} as a Sub Player.` : `Added ${name}.`, 'success');
}

function bulkImport(text){
  const names = text.split(/[\n,]/).map(s=>s.trim()).filter(Boolean);
  if(!names.length){ toast('Paste at least one name.', 'warning'); return; }
  let added = 0, skipped = 0;
  names.forEach(name=>{
    if(state.players.some(p=>p.name.toLowerCase()===name.toLowerCase())){ skipped++; return; }
    state.players.push(newPlayer(name));
    added++;
  });
  saveAll(); renderAll(); closeModal();
  toast(`Imported ${added} player${added!==1?'s':''}${skipped?`, skipped ${skipped} duplicate${skipped!==1?'s':''}`:''}.`, 'success');
}

function editPlayerName(id, name, isSub, duprRating){
  name = (name||'').trim();
  if(!name){ toast('Name cannot be empty.', 'warning'); return; }
  const p = getPlayer(id);
  if(!p) return;
  if(typeof isSub === 'boolean' && isSub !== p.isSub){
    const inLiveMatch = (state.current && (state.current.teamA.includes(id) || state.current.teamB.includes(id)))
      || (state.currentGeneration && state.currentGeneration.matches.some(m => m.status !== 'done' && (m.teamA.includes(id) || m.teamB.includes(id))));
    if(inLiveMatch){
      toast(`${p.name} is in an unfinished match — finish or sub them out first, then change their Sub Player status.`, 'warning');
      return;
    }
  }
  p.name = name;
  if(typeof isSub === 'boolean') p.isSub = isSub;
  // DUPR rating: accept a number like "3.067" or blank = NR
  if(duprRating !== undefined){
    const parsed = parseFloat(duprRating);
    p.duprRating = (!duprRating || isNaN(parsed)) ? null : Math.round(parsed * 1000) / 1000;
  }
  saveAll(); renderAll(); closeModal();
  toast('Player updated.', 'success');
}

/* ============================================================
   CHECK-IN PRIORITY BALANCING (Round Robin "Up Next" queue)
   ------------------------------------------------------------
   A Round Robin generation pre-builds every match up front, so a
   player who checks in mid-generation normally can't join until
   the NEXT generation is built — even if that's several matches
   away on a single court. Newcomers already get top priority for
   that next generation automatically (gamesPlayed starts at 0,
   which always sorts first) — this section closes the other gap:
   getting them into the CURRENT generation's still-queued ("Up
   Next") matches right away, instead of making them wait out
   games that haven't even started yet.
   Only ever touches QUEUED matches — never one already active on
   a court — and only swaps when it actually improves balance: the
   checked-in player must have played strictly fewer games than
   whoever they'd be bumping.
   ============================================================ */

// Physically swaps `incomingId` into an already-queued match in place of
// `bumpedId`. Unlike the Replace/absence-sub feature, this is NOT a
// stand-in — the incoming player is genuinely playing this match, so no
// `substitutions` mapping is recorded and the match record/stats will go
// to them directly. The bumped player is treated exactly like anyone else
// who didn't fit a foursome this generation: same sit-out stat bump, same
// rotation to the back of the sit-out queue (so they're first in line to
// play again next generation, the normal sit-out trade-off).
function swapPlayerIntoQueuedMatch(m, team, bumpedId, incomingId){
  const gen = state.currentGeneration;
  if(!gen) return;
  const teamArr = team === 'A' ? m.teamA : m.teamB;
  const idx = teamArr.indexOf(bumpedId);
  if(idx === -1) return;
  teamArr[idx] = incomingId;

  const bumped = getPlayer(bumpedId);
  if(bumped){
    bumped.sitOuts = (bumped.sitOuts||0) + 1;
    bumped.consecutiveSitOuts = (bumped.consecutiveSitOuts||0) + 1;
    bumped.sitOutPriority = (bumped.sitOutPriority||0) + 5;
    bumped.waitingRounds = (bumped.waitingRounds||0) + 1;
  }
  const incoming = getPlayer(incomingId);
  if(incoming){
    incoming.consecutiveSitOuts = 0;
    incoming.sitOutPriority = 0;
    incoming.waitingRounds = 0;
  }

  if(!Array.isArray(gen.sittingOut)) gen.sittingOut = [];
  gen.sittingOut = gen.sittingOut.filter(id => id !== incomingId);
  if(!gen.sittingOut.includes(bumpedId)) gen.sittingOut.push(bumpedId);

  // The bumped player just earned a sit-out turn — move them to the back of
  // the rotating queue (next in line to play). The newcomer doesn't belong
  // in this queue yet; syncSitOutQueue() will slot them in correctly the
  // next time a generation is built.
  if(!Array.isArray(state.sitOutQueue)) state.sitOutQueue = [];
  state.sitOutQueue = state.sitOutQueue.filter(id => id !== bumpedId && id !== incomingId);
  state.sitOutQueue.push(bumpedId);

  saveAll();
}

// Call right after a player transitions from not-checked-in to checked-in.
// Returns true if a swap was made (so callers can skip their own generic
// "you're checked in" toast in favor of the more specific one below).
function maybeAutoBalanceCheckIn(player){
  if(!player || state.settings.matchMode !== 'RoundRobin') return false;
  const gen = state.currentGeneration;
  if(!gen) return false;
  const queued = gen.matches
    .filter(m => m.status === 'queued')
    .sort((a,b) => a.matchIndex - b.matchIndex);
  if(!queued.length) return false;

  // Find the single most-overplayed player across every queued match.
  let worst = null; // { match, team, playerId, gamesPlayed, queuePos }
  queued.forEach((m, queuePos) => {
    ['A','B'].forEach(team => {
      const ids = team === 'A' ? m.teamA : m.teamB;
      ids.forEach(id => {
        const p = getPlayer(id);
        if(!p) return;
        if(!worst || p.gamesPlayed > worst.gamesPlayed){
          worst = { match: m, team, playerId: id, gamesPlayed: p.gamesPlayed, queuePos };
        }
      });
    });
  });
  if(!worst) return false;

  // Only swap if it genuinely improves balance.
  if((player.gamesPlayed || 0) >= worst.gamesPlayed) return false;

  const bumpedPlayer = getPlayer(worst.playerId);
  swapPlayerIntoQueuedMatch(worst.match, worst.team, worst.playerId, player.id);
  toast(`${player.name} checked in with fewer games played — slotted into Up Next match #${worst.queuePos + 1} for ${bumpedPlayer ? bumpedPlayer.name : 'a player'}, who sits out this generation to keep things balanced.`, 'success');
  return true;
}

function togglePlayerActive(id){
  const p = getPlayer(id);
  if(!p) return;
  if(p.active && state.current && (state.current.teamA.includes(id) || state.current.teamB.includes(id))){
    toast(`${p.name} is in the current match — finish or skip it first.`, 'warning');
    return;
  }
  if(p.active && state.currentGeneration && state.currentGeneration.matches.some(m => m.status !== 'done' && (m.teamA.includes(id) || m.teamB.includes(id)))) {
    toast(`${p.name} is in an unfinished generation match — use \"Replace\" on that match instead, or finish it first.`, 'warning');
    return;
  }
  if(p.active && Array.isArray(state.rotationCourts) && state.rotationCourts.some(c => c && c.status === 'active' && (c.teamA.includes(id) || c.teamB.includes(id)))) {
    toast(`${p.name} is live on a court — use the swap icon to sub them out, or finish/close that court first.`, 'warning');
    return;
  }
  const wasInactive = !p.active;
  p.active = !p.active;
  if(!p.active) {
    p.consecutiveSitOuts = 0;
    p.sitOutPriority = 0;
    p.waitingRounds = 0;
  }

  // Paddle Stack: priority check-in
  // New arrivals go to the FRONT of the queue so they play immediately
  // in the next open court rather than waiting at the back.
  if (p.active && wasInactive && state.paddleStack) {
    const ps = state.paddleStack;
    const onCourt = ps.courts.some(c => c.teamA.includes(p.id) || c.teamB.includes(p.id));
    const inQueue = ps.queue.some(e => e.id === p.id);
    const inWBlock = ps.wBlock.some(e => e.id === p.id);
    const inLBlock = ps.lBlock.some(e => e.id === p.id);
    if (!onCourt && !inQueue && !inWBlock && !inLBlock) {
      ps.queue.unshift({ id: p.id, tag: 'N' });
      psFillCourts();
      saveAll(); renderAll();
      toast(p.name + ' checked in — moved to front of queue! 🆕', 'success');
      return;
    }
  }

  saveAll();
  if(p.active && wasInactive) maybeAutoBalanceCheckIn(p);
  refreshAllNextMatchPreviews();
  renderAll();
}

/* ============================================================
   CHECK-IN
   ------------------------------------------------------------
   A fast tap-to-arrive checklist over the whole roster. Reuses
   the existing `active` flag (active = checked-in / in the
   selection pool, inactive = not arrived / paused). Newly
   arrived players naturally jump to the front of the next match
   because the matchmaking pool is sorted by fewest games played
   first — a player with 0 games always outranks anyone who has
   already played, so they catch up automatically.
   ============================================================ */
function renderCheckInBody(){
  const total = state.players.length;
  const arrivedCount = state.players.filter(p=>p.active).length;
  const sorted = state.players.slice().sort((a,b)=> a.name.localeCompare(b.name));
  const chips = sorted.map(p => `
    <button class="checkin-chip ${p.active?'arrived':''}" data-action="toggle-checkin" data-id="${p.id}" data-search-string="${esc(p.name.toLowerCase())}">
      <span class="dot"></span>${esc(p.name)}
    </button>
  `).join('');

  return `
    <div class="modal-title">🚪 Check-In</div>
    <div class="modal-sub">Tap a name as they arrive. New arrivals jump to the front of the next match so they catch up on games.</div>
    <div class="checkin-summary">
      <span><b>${arrivedCount}</b> / ${total} arrived</span>
      ${total ? `<button class="btn btn-ghost btn-sm" data-action="checkin-reset-all">Start New Session</button>` : ''}
    </div>
    ${total > 8 ? `<input type="text" id="checkinSearch" placeholder="🔍 Search name…" style="font-size:13.5px; padding:7px 10px; margin-bottom:10px;">` : ''}
    ${total ? `<div class="checkin-grid" id="checkinGrid">${chips}</div>` : `<p class="helper-text">No players yet — add some in the Players tab first.</p>`}
    <div class="modal-actions">
      <button class="btn btn-primary btn-block" data-action="modal-close">Done</button>
    </div>
  `;
}

function openCheckInModal(){
  openModal(renderCheckInBody());
  bindCheckInSearch();
}

function bindCheckInSearch(){
  const input = document.getElementById('checkinSearch');
  if(!input) return;
  input.addEventListener('input', function(e){
    const q = e.target.value.toLowerCase().trim();
    document.querySelectorAll('#checkinGrid .checkin-chip').forEach(c=>{
      const str = c.dataset.searchString || '';
      c.style.display = (!q || str.includes(q)) ? 'inline-flex' : 'none';
    });
  });
}

// Re-renders just the check-in modal body in place (if open) so tapping
// a chip doesn't lose your scroll position or search text.
function refreshCheckInModal(){
  const root = document.getElementById('modal-root');
  const sheet = root && root.querySelector('.modal-sheet');
  if(!sheet) return;
  const isCheckInModalOpen = sheet.querySelector('#checkinGrid, #checkinSearch, .checkin-summary');
  if(!isCheckInModalOpen) return;
  const searchVal = document.getElementById('checkinSearch') ? document.getElementById('checkinSearch').value : '';
  sheet.innerHTML = renderCheckInBody();
  bindCheckInSearch();
  if(searchVal){
    const input = document.getElementById('checkinSearch');
    if(input){ input.value = searchVal; input.dispatchEvent(new Event('input')); }
  }
}

function toggleCheckIn(id){
  togglePlayerActive(id);
  refreshCheckInModal();
}

function confirmCheckInResetAll(){
  const hasLiveMatch = !!state.current || !!state.currentGeneration;
  openModal(`
    <div class="modal-title">⚠️ Start New Session?</div>
    <div class="modal-sub" style="line-height:1.6;">
      This marks every player as "not arrived" so you can check people in fresh as they walk in.
      ${hasLiveMatch ? `<strong style="color:var(--loss);">It will also end the match/generation currently in progress — any unsaved score on it will be lost.</strong>` : `There's no match in progress right now, so nothing live will be affected.`}
      Completed match history and player stats are kept.
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-action="modal-close">Cancel</button>
      <button class="btn btn-primary" data-action="do-checkin-reset-all">Yes, Start New Session</button>
    </div>
  `);
}

function checkInResetAll(){
  const hadLiveMatch = !!state.current || !!state.currentGeneration;
  // Wipe whatever's currently in progress — a new session means a clean slate,
  // not a half-finished match hanging around from before everyone reset.
  state.current = null;
  state.currentGeneration = null;
  state.rotationCourts = [];
  state.paddleStack = null;
  state.undo = null;
  state.settings.sessionPlan = null; // a fresh session means choosing session length again
  state.sitOutQueue = []; // fresh session — rebuilt from scratch as players check in

  let reset = 0;
  state.players.forEach(p=>{
    if(p.active) reset++;
    p.active = false;
    p.consecutiveSitOuts = 0; p.sitOutPriority = 0; p.waitingRounds = 0;
    p.streakGames = 0; p.lastSatOut = 0; p.waitingSince = 0;
  });

  saveAll(); renderAll();
  openCheckInModal();
  toast(`${reset} player${reset!==1?'s':''} marked not-arrived${hadLiveMatch ? ' · in-progress match cleared' : ''}.`, 'success');
}

function removePlayer(id){
  if(state.current && (state.current.teamA.includes(id) || state.current.teamB.includes(id))){
    toast('Cannot remove a player who is in the current match.', 'warning'); return;
  }
  if(state.currentGeneration && state.currentGeneration.matches.some(m => m.status !== 'done' && (m.teamA.includes(id) || m.teamB.includes(id)))) {
    toast('Cannot remove a player who is in an unfinished generation match.', 'warning'); return;
  }
  if(Array.isArray(state.rotationCourts) && state.rotationCourts.some(c => c && c.status === 'active' && (c.teamA.includes(id) || c.teamB.includes(id)))) {
    toast('Cannot remove a player who is currently on a live court.', 'warning'); return;
  }
  const p = getPlayer(id);
  state.players = state.players.filter(pl=>pl.id!==id);
  state.players.forEach(pl=>{ delete pl.teammates[id]; delete pl.opponents[id]; });
  state.sitOutQueue = (state.sitOutQueue || []).filter(qid => qid !== id);
  // Clean up any fixed duo that referenced this player — otherwise their old
  // partner is left "stuck" thinking they still have a duo partner.
  state.fixedDuos = (state.fixedDuos || []).filter(d => !d.includes(id));
  refreshAllNextMatchPreviews();
  saveAll(); renderAll(); closeModal();
  if(p) toast(`Removed ${p.name}.`, 'success');
}

function resetPlayersAndStats(){
  state.players.forEach(p=>{
    p.gamesPlayed=0; p.wins=0; p.losses=0; p.rating=1000; p.currentStreak=0; p.longestStreak=0; p.sitOuts=0; p.consecutiveSitOuts=0; p.sitOutPriority=0; p.waitingRounds=0; p.results=[]; p.teammates={}; p.opponents={};
    p.streakGames=0; p.lastSatOut=0; p.waitingSince=0; // fatigue/consecutive-play tracking (CSOP)
  });
  state.matches = [];
  state.current = null;
  state.currentGeneration = null;
  state.rotationCourts = [];
  state.paddleStack = null;
  state.round = 0;
  state.undo = null;
  state.settings.sessionPlan = null;
  state.sitOutQueue = [];
  saveAll(); renderAll(); closeModal();
  toast('Player stats and history have been reset.', 'success');
}

function resetEverything(){
  state = { players:[], matches:[], current:null, currentGeneration:null, rotationCourts:[], paddleStack:null, settings:{...DEFAULT_SETTINGS}, round:0, undo:null, tab:'match', fixedDuos:[], sitOutQueue:[] };
  saveAll(); renderAll(); closeModal();
  toast('All data has been cleared.', 'success');
}

/* ============================================================
   MATCHMAKING ALGORITHM
   ============================================================ */
function activePlayers(){
  // Sub Players and anyone currently Tired/Injured sit out of the normal
  // rotation pool. Subs only enter play when manually subbed into a slot
  // whose regular owner is Tired/Injured (see openReplacePlayerModal).
  return state.players.filter(p=>p.active && !p.isSub && (p.condition||'ok')==='ok');
}

// Active Sub Players who are present and fit to play right now.
function availableSubPlayers(){
  return state.players.filter(p=>p.isSub && p.active && (p.condition||'ok')==='ok');
}

// Locates where a player currently has a live (unfinished) slot, across
// both Rotation mode's single current match and Round Robin generation
// matches, so the UI can offer a quick "sub them out" shortcut.
function findLivePlayerSlot(id){
  const gen = state.currentGeneration;
  if(gen){
    const m = gen.matches.find(x => x.status !== 'done' && (x.teamA.includes(id) || x.teamB.includes(id)));
    if(m){
      const team = m.teamA.includes(id) ? 'A' : 'B';
      return { mode:'rr', matchId: m.id, team, label: `Court ${m.court}` };
    }
  }
  if(state.current && (state.current.teamA.includes(id) || state.current.teamB.includes(id))){
    const team = state.current.teamA.includes(id) ? 'A' : 'B';
    return { mode:'rotation', matchId: null, team, label: 'the current match' };
  }
  return null;
}

/* ============================================================
   PLAYER STATUS — unified picker
   ------------------------------------------------------------
   Replaces the old pair of "Active/Paused" + "OK/Tired/Injured"
   tap-to-cycle pills with a single status pill that opens a
   choice list. Internally it still drives the same two flags
   (p.active, p.condition) so the matchmaking pool logic below
   doesn't need to change — only the player-facing control does.
   ============================================================ */
const STATUS_DEFS = {
  ok:         { label:'🟢 Active',     desc:'Ready to play, in the rotation.',          pillClass:'pill-cond-ok' },
  tired:      { label:'😴 Tired',       desc:'Sits out of new matches until cleared.',   pillClass:'pill-cond-tired' },
  injured:    { label:'🤕 Injured',     desc:'Sits out of new matches until cleared.',   pillClass:'pill-cond-injured' },
  cant_play:  { label:'🙅 Can\u2019t Play', desc:'Sits out of new matches until cleared.', pillClass:'pill-cond-cantplay' },
  not_coming: { label:'🚫 Not Coming',  desc:'Removed from today\u2019s rotation entirely.', pillClass:'pill-paused' },
};

function playerStatusKey(p){
  if(!p.active) return 'not_coming';
  const c = p.condition || 'ok';
  if(c === 'tired' || c === 'injured' || c === 'cant_play') return c;
  return 'ok';
}

function openPlayerStatusModal(id){
  const p = getPlayer(id);
  if(!p) return;
  const current = playerStatusKey(p);
  openModal(`
    <div class="modal-title">Set Status</div>
    <div class="modal-sub">${esc(p.name)} — choose what's going on with them right now.</div>
    <div class="status-choice-list">
      ${Object.keys(STATUS_DEFS).map(key => {
        const d = STATUS_DEFS[key];
        return `
        <button class="status-choice-btn ${key===current?'is-current':''}" data-action="set-player-status" data-id="${p.id}" data-status="${key}">
          <span class="scb-text">
            <span class="scb-label">${d.label}</span>
            <span class="scb-desc">${d.desc}</span>
          </span>
          ${key===current ? '<span class="scb-check">✓</span>' : ''}
        </button>`;
      }).join('')}
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost btn-block" data-action="modal-close">Cancel</button>
    </div>
  `);
}

function setPlayerStatus(id, status){
  const p = getPlayer(id);
  if(!p || !STATUS_DEFS[status]) return;
  const prevKey = playerStatusKey(p);
  if(prevKey === status){ closeModal(); return; }

  const inLiveMatch = (state.current && (state.current.teamA.includes(id) || state.current.teamB.includes(id)))
    || (state.currentGeneration && state.currentGeneration.matches.some(m => m.status !== 'done' && (m.teamA.includes(id) || m.teamB.includes(id))));

  if(status === 'not_coming'){
    if(p.active && inLiveMatch){
      closeModal();
      toast(`${p.name} is in an unfinished match — finish, skip, or replace them first.`, 'warning');
      return;
    }
    p.active = false;
    p.condition = 'ok';
    p.consecutiveSitOuts = 0; p.sitOutPriority = 0; p.waitingRounds = 0;
    saveAll(); renderAll(); closeModal();
    toast(`${p.name} marked Not Coming.`, 'success');
    return;
  }

  if(status === 'ok'){
    const wasNotComing = prevKey === 'not_coming'; // clearing tired/injured/cant_play isn't a "check-in" — they were already active
    p.active = true;
    p.condition = 'ok';
    saveAll();
    closeModal();
    const balanced = wasNotComing ? maybeAutoBalanceCheckIn(p) : false;
    if(!balanced) toast(`${p.name} is back to OK.`, 'success');
    renderAll();
    return;
  }

  // tired / injured / cant_play — stays active (may return later this session),
  // just excluded from the rotation pool until cleared back to OK.
  p.active = true;
  p.condition = status;
  saveAll(); renderAll();

  const label = STATUS_DEFS[status].label;
  const slot = findLivePlayerSlot(id);
  if(slot){
    openModal(`
      <div class="modal-title">${label}</div>
      <div class="modal-sub">${esc(p.name)} is marked ${label.replace(/^\S+\s/, '').toLowerCase()} and currently playing on ${esc(slot.label)}. Want to sub them out now?</div>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-action="modal-close">Not yet</button>
        ${slot.mode === 'rr'
          ? `<button class="btn btn-primary" data-action="open-replace-player" data-match="${slot.matchId}" data-team="${slot.team}" data-player="${id}">Sub Out Now</button>`
          : `<button class="btn btn-primary" data-action="open-replace-current-player" data-team="${slot.team}" data-player="${id}">Sub Out Now</button>`}
      </div>
    `);
  } else {
    closeModal();
    toast(`${p.name} marked ${label} — they'll sit out of new matches until cleared.`, 'warning');
  }
}

function selectionPool(){
  const pool = activePlayers().slice();
  pool.forEach(p=>{ p._jitter = Math.random(); });
  pool.sort((a,b)=>{
    if(a.gamesPlayed !== b.gamesPlayed) return a.gamesPlayed - b.gamesPlayed;
    if(a.consecutiveSitOuts !== b.consecutiveSitOuts) return b.consecutiveSitOuts - a.consecutiveSitOuts;
    if(a.sitOuts !== b.sitOuts) return b.sitOuts - a.sitOuts;
    return a._jitter - b._jitter;
  });
  return pool;
}

function combinations(arr, k){
  const out = [];
  function go(start, chosen){
    if(chosen.length===k){ out.push(chosen.slice()); return; }
    for(let i=start;i<arr.length;i++){ chosen.push(arr[i]); go(i+1, chosen); chosen.pop(); }
  }
  go(0, []);
  return out;
}

// Returns a Set of opponent id pairs that appeared in the last completed match,
// used by rematch prevention to add a heavy penalty to re-facing the same players.
function lastMatchOpponentPairs(){
  const last = state.matches[state.matches.length - 1];
  if(!last) return new Set();
  const pairs = new Set();
  last.teamA.forEach(idA => last.teamB.forEach(idB => {
    pairs.add(idA + '|' + idB);
    pairs.add(idB + '|' + idA);
  }));
  return pairs;
}

function scoreSplit(four, settings){
  const [a,b,c,d] = four;
  const allSplits = [ [[a,b],[c,d]], [[a,c],[b,d]], [[a,d],[b,c]] ];

  // Filter splits to only those that honor fixed duos
  const filteredSplits = allSplits.filter(([t1, t2]) => {
    for(const duo of (state.fixedDuos || [])){
      const [id1, id2] = duo;
      const t1ids = [t1[0].id, t1[1].id];
      const t2ids = [t2[0].id, t2[1].id];
      const bothInFour = four.some(p=>p.id===id1) && four.some(p=>p.id===id2);
      if(!bothInFour) continue;
      // Both duo members are in this four — ensure they're on the same team
      const togetherInT1 = t1ids.includes(id1) && t1ids.includes(id2);
      const togetherInT2 = t2ids.includes(id1) && t2ids.includes(id2);
      if(!togetherInT1 && !togetherInT2) return false;
    }
    return true;
  });

  const splits = filteredSplits.length ? filteredSplits : allSplits;

  // Rematch prevention: heavy penalty for opponent pairs that just faced each other
  const recentOpponents = lastMatchOpponentPairs();

  let best = null;
  splits.forEach(([t1,t2])=>{
    const teammatePenalty = pairCount(t1[0].teammates, t1[1].id) + pairCount(t2[0].teammates, t2[1].id);
    const opponentPenalty = pairCount(t1[0].opponents, t2[0].id) + pairCount(t1[0].opponents, t2[1].id) + pairCount(t1[1].opponents, t2[0].id) + pairCount(t1[1].opponents, t2[1].id);
    const skillDiff = Math.abs((t1[0].rating + t1[1].rating) - (t2[0].rating + t2[1].rating));
    // Count how many cross-team pairs just played each other last match
    let rematchPenalty = 0;
    if(recentOpponents.size){
      [t1[0].id, t1[1].id].forEach(idA => [t2[0].id, t2[1].id].forEach(idB => {
        if(recentOpponents.has(idA + '|' + idB)) rematchPenalty++;
      }));
    }
    const score = (teammatePenalty * 300) + (opponentPenalty * 100) + (skillDiff * 0.5) + (rematchPenalty * 800);
    if(best===null || score < best.score){ best = { split:[t1,t2], score }; }
  });
  return best;
}

// Builds the eligible "fairness tier" for the next match: every active
// player tied at the lowest gamesPlayed count in `pool`. Nobody outside this
// tier may enter a match while tier members are still waiting — that's what
// guarantees an exact game-count match across the whole group instead of
// letting the queue heuristic drift.
function fairnessTierFrom(pool, startIdx){
  if(startIdx >= pool.length) return pool.slice(pool.length);
  const gp = pool[startIdx].gamesPlayed;
  let end = startIdx;
  while(end < pool.length && pool[end].gamesPlayed === gp) end++;
  return pool.slice(startIdx, end);
}

// Resolves Fixed Duo eligibility against a tier-aware id set: a duo may only
// be used in this match if BOTH partners are already inside `eligibleIds`.
// If only one partner is due to play, the whole pair sits out together —
// pulling the not-yet-due partner in early would hand them an extra game
// ahead of someone else who has played strictly fewer games, which is
// exactly the imbalance this rewrite exists to prevent.
function partitionDuoBlocked(tierPlayers, eligibleIds){
  const blocked = new Set();
  tierPlayers.forEach(p => {
    const partnerId = getFixedDuoPartner(p.id);
    if(partnerId && !eligibleIds.has(partnerId)) blocked.add(p.id);
  });
  return blocked;
}

/* ============================================================
   CONTINUOUS SMART OPEN PLAY ENGINE (Rotation Mode)
   ------------------------------------------------------------
   Each court operates independently. When a court finishes its
   match, it immediately generates a new one without waiting for
   other courts. Uses weighted scoring to fairly select players
   and produce high-quality matchups.
   ============================================================ */

// --- Player tracking fields used by CSOP ---
function ensureCSOP(p) {
  if (typeof p.streakGames !== 'number') p.streakGames = 0;  // consecutive games played
  if (typeof p.lastSatOut !== 'number') p.lastSatOut = 0;    // round# of last sit-out
  if (typeof p.waitingSince !== 'number') p.waitingSince = state.round; // round when player started waiting
}

function csoActivePlayers() {
  return state.players.filter(p =>
    p.active && !p.isSub &&
    (p.condition || 'ok') === 'ok' &&
    !['injured','tired','cant_play'].includes(p.condition)
  );
}

// Weighted priority score — higher = more urgent to play
function csoPlayerPriority(p, now) {
  ensureCSOP(p);
  let score = 0;

  // 1. Fewest games played first (most weight)
  const maxGames = Math.max(...csoActivePlayers().map(x => x.gamesPlayed), 0);
  score += (maxGames - p.gamesPlayed) * 100;

  // 2. Longest waiting first
  const waitingRounds = now - (p.waitingSince || now);
  score += waitingRounds * 20;

  // 3. Sat out last round — high priority bonus
  const roundsSinceLastSitOut = now - (p.lastSatOut || 0);
  if (p.lastSatOut > 0 && roundsSinceLastSitOut <= 2) {
    score += 80;
  }

  // 4. Starvation prevention: avoid anyone sitting twice before everyone sits once
  score += (p.sitOuts || 0) <= 1 ? 30 : 0;

  // 5. Streak penalty: lower priority after 3+ consecutive games
  if (p.streakGames >= 3) score -= (p.streakGames - 2) * 40;

  return score;
}

// Match quality score for a candidate split
function csoMatchScore(teamA, teamB, now) {
  let score = 0;
  const allFour = [...teamA, ...teamB];

  // Waiting priority: reward getting high-priority players on court
  allFour.forEach(p => { score += csoPlayerPriority(p, now) * 0.5; });

  // Sit-out priority: bonus if someone just sat out is getting back in
  allFour.forEach(p => {
    ensureCSOP(p);
    if (p.lastSatOut > 0 && (now - p.lastSatOut) <= 2) score += 30;
  });

  // Fairness bonus: reward even games-played spread
  const gps = allFour.map(p => p.gamesPlayed);
  const spread = Math.max(...gps) - Math.min(...gps);
  score -= spread * 30;

  // Winner vs Winner bonus (optional preference, not hard rule)
  if (state.settings.winnerVsWinner && state.matches.length > 0) {
    const recent = state.matches.slice(-4);
    const recentWinners = new Set(recent.flatMap(m => m.winners || []));
    const aWinners = teamA.filter(p => recentWinners.has(p.id)).length;
    const bWinners = teamB.filter(p => recentWinners.has(p.id)).length;
    if (aWinners >= 1 && bWinners >= 1) score += 20;
  }

  // Win/loss similarity bonus: teams with similar records
  const winPctA = teamA.reduce((s,p)=> s + (p.gamesPlayed>0 ? p.wins/p.gamesPlayed : 0.5), 0) / 2;
  const winPctB = teamB.reduce((s,p)=> s + (p.gamesPlayed>0 ? p.wins/p.gamesPlayed : 0.5), 0) / 2;
  score -= Math.abs(winPctA - winPctB) * 40;

  // Games played difference penalty
  const avgA = teamA.reduce((s,p)=>s+p.gamesPlayed,0)/2;
  const avgB = teamB.reduce((s,p)=>s+p.gamesPlayed,0)/2;
  score -= Math.abs(avgA - avgB) * 15;

  // Same partner penalty (weighted, not absolute)
  const tmA = pairCount(teamA[0].teammates, teamA[1].id);
  const tmB = pairCount(teamB[0].teammates, teamB[1].id);
  score -= (tmA + tmB) * 25;

  // Same opponent penalty (weighted)
  [[teamA[0],teamB[0]], [teamA[0],teamB[1]], [teamA[1],teamB[0]], [teamA[1],teamB[1]]].forEach(([pa,pb]) => {
    score -= pairCount(pa.opponents, pb.id) * 12;
  });

  // Streak penalty (consecutive game protection)
  allFour.forEach(p => {
    ensureCSOP(p);
    if (p.streakGames >= 3) score -= (p.streakGames - 2) * 20;
    if (p.streakGames >= 4) score -= 50; // force rest warning
  });

  // Rematch prevention
  const recentOpponents = lastMatchOpponentPairs();
  if (recentOpponents.size) {
    teamA.forEach(pa => teamB.forEach(pb => {
      if (recentOpponents.has(pa.id + '|' + pb.id)) score -= 150;
    }));
  }

  return score;
}

// Builds the STRICT fairness-tier candidate set for CSOP match generation:
// every player tied at the lowest gamesPlayed count in `pool` is admitted
// first; only if that tier alone can't fill a foursome does the next-lowest
// tier get pulled in WHOLESALE — exactly mirroring fairnessTierFrom() in the
// legacy single-court Rotation engine and PASS 1 of the Round Robin
// generator. This is a HARD gate: csoMatchScore()/csoGenerateMatchForCourt
// only ever decide how the admitted tier(s) split into teams, never which
// players are eligible — so a player who has already played can never be
// picked ahead of someone on zero games just because a "better quality"
// foursome scored higher.
function csoFairTierCandidates(pool, now){
  const sorted = pool.slice().sort((a,b) => a.gamesPlayed - b.gamesPlayed);
  let candidates = [];
  let cursor = 0;
  while(candidates.length < 4 && cursor < sorted.length){
    const gp = sorted[cursor].gamesPlayed;
    let end = cursor;
    while(end < sorted.length && sorted[end].gamesPlayed === gp) end++;
    candidates = candidates.concat(sorted.slice(cursor, end));
    cursor = end;
  }
  // A very large tied tier (everyone on the same gamesPlayed count) is
  // trimmed to a sane search window using the secondary fairness signals —
  // never by gamesPlayed, since everyone left here is already tied on that.
  if(candidates.length > 12){
    candidates = candidates
      .slice()
      .sort((a,b) => csoPlayerPriority(b, now) - csoPlayerPriority(a, now))
      .slice(0, 12);
  }
  return candidates;
}

// Generate the best match for a specific court from the eligible pool
// `excludeIds` = players already assigned to OTHER courts right now
function csoGenerateMatchForCourt(courtNum, excludeIds) {
  const now = state.round;
  const pool = csoActivePlayers().filter(p => !excludeIds.has(p.id));
  pool.forEach(ensureCSOP);

  if (pool.length < 4) return null;

  // Strict fairness tier — see csoFairTierCandidates() above. Quality
  // scoring below only decides HOW these candidates split into teams.
  const candidates = csoFairTierCandidates(pool, now);

  // Evaluate all foursomes + all team splits, pick best by csoMatchScore
  let bestMatch = null;
  let bestScore = -Infinity;

  // Collapse fixed duos into units
  const units = [];
  const claimed = new Set();
  candidates.forEach(p => {
    if (claimed.has(p.id)) return;
    const partnerId = getFixedDuoPartner(p.id);
    const partner = partnerId ? candidates.find(c => c.id === partnerId) : null;
    if (partner) {
      units.push([p, partner]);
      claimed.add(p.id); claimed.add(partner.id);
    } else {
      units.push([p]);
      claimed.add(p.id);
    }
  });

  // Enumerate foursomes
  (function exploreCSOP(startIdx, chosen, count) {
    if (count === 4) {
      const four = chosen.flat();
      // Try all 3 splits
      const allSplits = [
        [[four[0],four[1]], [four[2],four[3]]],
        [[four[0],four[2]], [four[1],four[3]]],
        [[four[0],four[3]], [four[1],four[2]]]
      ];
      // Filter splits that honor fixed duos
      const validSplits = allSplits.filter(([t1,t2]) => {
        for (const duo of (state.fixedDuos || [])) {
          const [d1, d2] = duo;
          const bothInFour = four.some(p=>p.id===d1) && four.some(p=>p.id===d2);
          if (!bothInFour) continue;
          const t1ids = [t1[0].id, t1[1].id];
          const t2ids = [t2[0].id, t2[1].id];
          if (!((t1ids.includes(d1) && t1ids.includes(d2)) || (t2ids.includes(d1) && t2ids.includes(d2)))) return false;
        }
        return true;
      });
      const splitsToTry = validSplits.length ? validSplits : allSplits;
      splitsToTry.forEach(([tA, tB]) => {
        const sc = csoMatchScore(tA, tB, now);
        if (sc > bestScore) {
          bestScore = sc;
          bestMatch = { teamA: tA, teamB: tB };
        }
      });
      return;
    }
    if (count > 4) return;
    for (let i = startIdx; i < units.length; i++) {
      if (count + units[i].length > 4) continue;
      exploreCSOP(i + 1, chosen.concat([units[i]]), count + units[i].length);
    }
  })(0, [], 0);

  if (!bestMatch) return null;

  const { teamA, teamB } = bestMatch;

  // Mark all four as "on court" — streak tracking, waiting reset
  [...teamA, ...teamB].forEach(p => {
    ensureCSOP(p);
    p.streakGames = (p.streakGames || 0) + 1;
    p.waitingSince = now + 1; // reset waiting clock; they'll start waiting again after this match
    p.consecutiveSitOuts = 0;
  });

  // Everyone NOT in this match who is active is "waiting" — update their waiting clock
  pool.filter(p => !teamA.includes(p) && !teamB.includes(p)).forEach(p => {
    ensureCSOP(p);
    if (p.waitingSince === undefined || p.waitingSince > now) p.waitingSince = now;
  });

  state.round++;

  const matchObj = {
    id: uid('rc'),
    courtNum,
    round: state.round,
    teamA: teamA.map(p=>p.id),
    teamB: teamB.map(p=>p.id),
    scoreA: null, scoreB: null,
    winner: null,
    serving: 'A', serverNum: 1, firstServe: true,
    status: 'active',
    substitutions: {}
  };

  // Sit-out tracking for the pool members not playing
  pool.filter(p => !teamA.includes(p) && !teamB.includes(p)).forEach(p => {
    p.sitOuts = (p.sitOuts || 0);
    p.lastSatOut = now + 1;
    p.streakGames = 0; // sitting out breaks the consecutive-games-played streak
  });

  return matchObj;
}

// Generates a lightweight PREVIEW of who would play next on a given court,
// without mutating any player state (no streak bumps, no round counter bump,
// no waitingSince writes). Used purely for the "Up Next" display — the real
// match object is only materialised when the current one is confirmed.
// Returns { teamA:[id,id], teamB:[id,id] } or null if not enough free players.
// Pass excludeIds (Set or array) to force those players out of the pool —
// used by re-shuffle so it can't just return the same optimal result again.
function csoPreviewNextMatch(courtId, excludeIds) {
  // IDs already committed to ANY live match, including this court's current
  // players — they are still playing and won't be free until this match is
  // confirmed, so they must not appear in the Up Next preview.
  const usedIds = new Set();
  (state.rotationCourts || []).forEach(c => {
    c.teamA.forEach(id => usedIds.add(id));
    c.teamB.forEach(id => usedIds.add(id));
  });
  // Also reserve IDs that are already sitting in a nextMatch on OTHER courts
  // so the same person isn't queued up on two courts at once.
  (state.rotationCourts || []).forEach(c => {
    if (c.id === courtId || !c.nextMatch) return;
    c.nextMatch.teamA.forEach(id => usedIds.add(id));
    c.nextMatch.teamB.forEach(id => usedIds.add(id));
  });

  const excludeSet = excludeIds ? new Set(excludeIds) : new Set();
  const pool = csoActivePlayers().filter(p => !usedIds.has(p.id) && !excludeSet.has(p.id));
  if (pool.length < 4) return null;

  // Reuse the same priority + scoring logic but operate on a snapshot so
  // nothing in state is modified.
  const now = Date.now();
  const candidates = csoFairTierCandidates(pool, now);

  // Collapse fixed duos into units (same logic as csoGenerateMatchForCourt)
  const units = [];
  const claimed = new Set();
  candidates.forEach(p => {
    if (claimed.has(p.id)) return;
    const partnerId = getFixedDuoPartner(p.id);
    const partner = partnerId ? candidates.find(c => c.id === partnerId) : null;
    if (partner) {
      units.push([p, partner]);
      claimed.add(p.id); claimed.add(partner.id);
    } else {
      units.push([p]);
      claimed.add(p.id);
    }
  });

  let bestMatch = null;
  let bestScore = -Infinity;
  (function explore(startIdx, chosen, count) {
    if (count === 4) {
      const four = chosen.flat();
      const allSplits = [
        [[four[0],four[1]], [four[2],four[3]]],
        [[four[0],four[2]], [four[1],four[3]]],
        [[four[0],four[3]], [four[1],four[2]]]
      ];
      const validSplits = allSplits.filter(([t1,t2]) => {
        for (const duo of (state.fixedDuos || [])) {
          const [d1, d2] = duo;
          const bothInFour = four.some(p=>p.id===d1) && four.some(p=>p.id===d2);
          if (!bothInFour) continue;
          const t1ids = [t1[0].id, t1[1].id];
          const t2ids = [t2[0].id, t2[1].id];
          if (!((t1ids.includes(d1) && t1ids.includes(d2)) || (t2ids.includes(d1) && t2ids.includes(d2)))) return false;
        }
        return true;
      });
      const splitsToTry = validSplits.length ? validSplits : allSplits;
      splitsToTry.forEach(([tA, tB]) => {
        const sc = csoMatchScore(tA, tB, now);
        if (sc > bestScore) { bestScore = sc; bestMatch = { teamA: tA, teamB: tB }; }
      });
      return;
    }
    if (count > 4) return;
    for (let i = startIdx; i < units.length; i++) {
      if (count + units[i].length > 4) continue;
      explore(i + 1, chosen.concat([units[i]]), count + units[i].length);
    }
  })(0, [], 0);

  if (!bestMatch) return null;
  return {
    teamA: bestMatch.teamA.map(p => p.id),
    teamB: bestMatch.teamB.map(p => p.id)
  };
}

// Refresh the nextMatch preview on every court that doesn't already have one,
// or when player availability has changed (new check-in, player removed, etc).
// Call after any event that changes who's free: session start, confirm match,
// skip match, check-in toggle, player add/remove.
// When onlyMissing=true (used at boot), courts that already have a persisted
// nextMatch are left untouched so a manual re-shuffle survives a page reload.
function refreshAllNextMatchPreviews(onlyMissing) {
  if (!Array.isArray(state.rotationCourts)) return;
  state.rotationCourts.forEach(c => {
    if (c.status !== 'active') return;
    if (onlyMissing && c.nextMatch) return; // already have a saved preview — keep it
    c.nextMatch = csoPreviewNextMatch(c.id);
  });
}
function initRotationCourts() {
  const pool = csoActivePlayers();
  if (pool.length < 4) { goToAddPlayer('Add a few more players to start — you need at least 4.'); return; }

  // If courts are already live, skip the modal and just fill empty slots
  if (!Array.isArray(state.rotationCourts)) state.rotationCourts = [];
  const existingActive = state.rotationCourts.filter(c => c && c.status === 'active').length;
  if (existingActive > 0) {
    fillEmptyRotationCourts();
    return;
  }

  // Show setup modal before starting
  openCSOPSetupModal(pool.length);
}

function openCSOPSetupModal(activeCount) {
  const maxPossible = Math.floor(activeCount / 4);
  const currentCourts = clamp(parseInt(state.settings.numCourts, 10) || 1, 1, 10);
  const currentScore  = state.settings.winningScore || 11;

  // Build court count option buttons (1 up to the max possible given player count)
  const maxShow = Math.min(maxPossible, 6);
  const courtBtns = Array.from({length: maxShow}, (_, i) => i + 1).map(n => {
    const playersNeeded = n * 4;
    const sitOut = activeCount - playersNeeded;
    const recommended = n === Math.min(Math.floor(activeCount / 4), Math.max(1, Math.round(activeCount / 6)));
    return `
      <button type="button" class="session-opt ${n === currentCourts ? 'recommended' : ''}"
        data-action="csop-pick-courts" data-courts="${n}"
        style="cursor:pointer;">
        <div class="session-opt-count">
          <span class="n">${n}</span>
          <span class="u">court${n>1?'s':''}</span>
        </div>
        <div class="session-opt-body">
          <div class="session-opt-name">
            ${n === 1 ? 'Single Court' : n === 2 ? 'Two Courts' : n === 3 ? 'Three Courts' : n + ' Courts'}
            ${n === currentCourts ? '<span class="session-opt-tag">Current</span>' : ''}
          </div>
          <div class="session-opt-sub">
            ${playersNeeded} players on court${sitOut > 0 ? ` · ${sitOut} waiting/rotating` : ' · everyone plays at once'}
          </div>
        </div>
        <div class="session-opt-check" id="csop-court-check-${n}" style="${n === currentCourts ? 'border-color:var(--ball); background:var(--ball);' : ''}"></div>
      </button>`;
  }).join('');

  openModal(`
    <div class="modal-title">🏓 Start Open Play</div>
    <div class="modal-sub" style="line-height:1.6;">
      <strong style="color:var(--text);">${activeCount} active player${activeCount!==1?'s':''}</strong> ready.
      Set up your courts before we start — each court runs independently and auto-generates its next match the moment it finishes.
    </div>

    <div class="eyebrow" style="margin:14px 2px 8px;">How many courts are available?</div>
    <div class="session-opt-list" id="csoCourtsList">
      ${courtBtns}
      ${maxPossible < 1 ? '<p class="helper-text" style="color:var(--loss);">Not enough active players — need at least 4.</p>' : ''}
    </div>

    <div class="eyebrow" style="margin:16px 2px 8px;">Winning Score</div>
    <div class="card" style="margin:0 0 4px;">
      <div class="field" style="margin:0;">
        <input type="number" id="csoWinScoreInput" min="1" max="99" value="${currentScore}"
          style="font-size:18px; font-weight:700; text-align:center;">
        <p class="helper-text" style="margin:6px 2px 0;">First team to reach this score (win by 2) wins the match.</p>
      </div>
    </div>

    <div class="eyebrow" style="margin:16px 2px 8px;">Balancing Options</div>
    <div class="card" style="margin:0; padding:4px 14px;">
      <div class="toggle-row">
        <div>
          <div class="t-label">🏆 Winner vs Winner</div>
          <div class="t-hint">Prefer grouping recent winners vs winners (soft bonus, not forced).</div>
        </div>
        <label class="switch">
          <input type="checkbox" id="csoWvWToggle" ${state.settings.winnerVsWinner ? 'checked' : ''}>
          <div class="track"></div><div class="thumb"></div>
        </label>
      </div>
      <div class="toggle-row">
        <div>
          <div class="t-label">🏁 Race to 2</div>
          <div class="t-hint">Offer a sudden-death Race to 2 when both teams hit 10–10.</div>
        </div>
        <label class="switch">
          <input type="checkbox" id="csoRaceToggle" ${state.settings.raceToTwo ? 'checked' : ''}>
          <div class="track"></div><div class="thumb"></div>
        </label>
      </div>
    </div>

    <div class="modal-actions" style="margin-top:16px;">
      <button class="btn btn-ghost" data-action="modal-close">Cancel</button>
      <button class="btn btn-primary" id="csoStartBtn" data-action="csop-confirm-start">🚀 Start Open Play</button>
    </div>
  `, false);
}

function doInitRotationCourts() {
  // Read settings from the modal
  const scoreEl = document.getElementById('csoWinScoreInput');
  const wvwEl   = document.getElementById('csoWvWToggle');
  const raceEl  = document.getElementById('csoRaceToggle');

  if (scoreEl) {
    const v = parseInt(scoreEl.value, 10);
    state.settings.winningScore = (isNaN(v) || v < 1) ? 11 : v;
  }
  if (wvwEl)  state.settings.winnerVsWinner   = wvwEl.checked;
  if (raceEl) state.settings.raceToTwo        = raceEl.checked;

  closeModal();

  const pool = csoActivePlayers();
  if (pool.length < 4) { goToAddPlayer('Add a few more players to start — you need at least 4.'); return; }

  const numCourts = clamp(parseInt(state.settings.numCourts, 10) || 1, 1, 10);
  state.rotationCourts = [];
  const usedIds = new Set();

  for (let c = 1; c <= numCourts; c++) {
    if (pool.filter(p => !usedIds.has(p.id)).length < 4) break;
    const match = csoGenerateMatchForCourt(c, usedIds);
    if (match) {
      state.rotationCourts.push(match);
      match.teamA.forEach(id => usedIds.add(id));
      match.teamB.forEach(id => usedIds.add(id));
    }
  }

  if (!state.rotationCourts.length) {
    toast('Could not generate any matches. Need at least 4 active players.', 'warning');
    return;
  }

  refreshAllNextMatchPreviews();
  saveAll(); renderAll();
  toast(`${state.rotationCourts.length} court${state.rotationCourts.length>1?'s':''} now live — Open Play started!`, 'success');
}

// Fill any courts that have finished (or are empty) without touching active ones
function fillEmptyRotationCourts() {
  const numCourts = clamp(parseInt(state.settings.numCourts, 10) || 1, 1, 10);
  if (!Array.isArray(state.rotationCourts)) state.rotationCourts = [];

  // Remove "done" courts and track which are still active
  state.rotationCourts = state.rotationCourts.filter(c => c && c.status === 'active');

  const usedIds = new Set();
  state.rotationCourts.forEach(c => {
    c.teamA.forEach(id => usedIds.add(id));
    c.teamB.forEach(id => usedIds.add(id));
  });

  let filled = 0;
  const pool = csoActivePlayers();
  for (let c = state.rotationCourts.length + 1; c <= numCourts; c++) {
    if (pool.filter(p => !usedIds.has(p.id)).length < 4) break;
    const match = csoGenerateMatchForCourt(c, usedIds);
    if (match) {
      state.rotationCourts.push(match);
      match.teamA.forEach(id => usedIds.add(id));
      match.teamB.forEach(id => usedIds.add(id));
      filled++;
    }
  }
  return filled;
}

// When a specific rotation court finishes, record result and immediately
// generate the next match for that court (event-driven, independent of other courts)
function confirmRotationCourtMatch(courtId) {
  if (!Array.isArray(state.rotationCourts)) return;
  const m = state.rotationCourts.find(c => c.id === courtId);
  if (!m || m.status !== 'active') return;
  if (m.winner === null) { toast('Select the winning team before confirming.', 'warning'); return; }

  state.undo = {
    players: deepClone(state.players),
    matches: deepClone(state.matches),
    current: null,
    currentGeneration: null,
    rotationCourts: deepClone(state.rotationCourts),
    round: state.round,
    sitOutQueue: deepClone(state.sitOutQueue || [])
  };

  const sA = parseInt(m.scoreA, 10) || 0;
  const sB = parseInt(m.scoreB, 10) || 0;
  const tA_win = m.winner === 'A';

  const subs = m.substitutions || {};
  function resolveOrig(id) { return Object.keys(subs).find(orig => subs[orig] === id) || id; }
  const recordTeamA = m.teamA.map(resolveOrig);
  const recordTeamB = m.teamB.map(resolveOrig);

  const matchRecord = {
    id: uid('m'),
    round: m.round,
    court: m.courtNum,
    teamA: recordTeamA, teamB: recordTeamB,
    scoreA: sA, scoreB: sB,
    winners: tA_win ? recordTeamA : recordTeamB,
    losers: tA_win ? recordTeamB : recordTeamA,
    substitutions: Object.keys(subs).length ? subs : undefined,
    date: new Date().toISOString()
  };
  state.matches.push(matchRecord);

  // Update stats for all four (original IDs)
  [...recordTeamA, ...recordTeamB].forEach(id => {
    const p = getPlayer(id);
    if (!p) return;
    p.gamesPlayed++;
    if (matchRecord.winners.includes(id)) {
      p.wins++; p.results.push('W');
      p.currentStreak = p.currentStreak > 0 ? p.currentStreak + 1 : 1;
    } else {
      p.losses++; p.results.push('L');
      p.currentStreak = p.currentStreak < 0 ? p.currentStreak - 1 : -1;
    }
    if (Math.abs(p.currentStreak) > p.longestStreak) p.longestStreak = Math.abs(p.currentStreak);
  });
  // Streak games reset for the four players (they just played)
  [...m.teamA, ...m.teamB].forEach(id => {
    const p = getPlayer(id); if (!p) return;
    ensureCSOP(p);
  });

  [[recordTeamA[0], recordTeamA[1]], [recordTeamB[0], recordTeamB[1]]].forEach(([p1,p2]) => {
    const pl1 = getPlayer(p1), pl2 = getPlayer(p2);
    if (pl1 && pl2) { bumpPair(pl1.teammates, p2); bumpPair(pl2.teammates, p1); }
  });
  recordTeamA.forEach(idA => recordTeamB.forEach(idB => {
    const plA = getPlayer(idA), plB = getPlayer(idB);
    if (plA && plB) { bumpPair(plA.opponents, idB); bumpPair(plB.opponents, idA); }
  }));

  const rA = (getPlayer(recordTeamA[0])?.rating||1000) + (getPlayer(recordTeamA[1])?.rating||1000);
  const rB = (getPlayer(recordTeamB[0])?.rating||1000) + (getPlayer(recordTeamB[1])?.rating||1000);
  const expA = 1 / (1 + Math.pow(10, (rB-rA)/400));
  const change = Math.round(32 * ((tA_win?1:0) - expA));
  recordTeamA.forEach(id => { const p=getPlayer(id); if(p) p.rating+=change; });
  recordTeamB.forEach(id => { const p=getPlayer(id); if(p) p.rating-=change; });

  // Sit-out priority: the four who just played lower priority, waiting players rise
  const justPlayedIds = new Set([...m.teamA, ...m.teamB]);
  csoActivePlayers().forEach(p => {
    ensureCSOP(p);
    if (justPlayedIds.has(p.id)) {
      p.lastSatOut = 0; // played this match, not sitting out
    }
  });

  // Mark this court slot as done and immediately spin up next match for it
  m.status = 'done';
  const courtNum = m.courtNum;
  const previewedNext = m.nextMatch || null; // grab before we filter it away
  // Remove the done match from active courts
  state.rotationCourts = state.rotationCourts.filter(c => c.status === 'active');

  // Find IDs still active on other courts
  const usedIds = new Set();
  state.rotationCourts.forEach(c => {
    c.teamA.forEach(id => usedIds.add(id));
    c.teamB.forEach(id => usedIds.add(id));
  });

  // Use the already-previewed next match if still valid (all 4 players free),
  // otherwise fall back to generating one fresh right now.
  const pool = csoActivePlayers();
  let nextMatch = null;
  if (previewedNext &&
      previewedNext.teamA.every(id => !usedIds.has(id)) &&
      previewedNext.teamB.every(id => !usedIds.has(id)) &&
      pool.filter(p => !usedIds.has(p.id)).length >= 4) {
    // Materialise the previewed match into a real match object
    const allFour = [...previewedNext.teamA, ...previewedNext.teamB];
    allFour.forEach(id => {
      const p = getPlayer(id);
      if (!p) return;
      ensureCSOP(p);
      p.streakGames = (p.streakGames || 0) + 1;
      p.waitingSince = Date.now() + 1;
      p.consecutiveSitOuts = 0;
    });
    pool.filter(p => !allFour.includes(p.id)).forEach(p => {
      ensureCSOP(p);
      if (p.waitingSince === undefined || p.waitingSince > Date.now()) p.waitingSince = Date.now();
      p.lastSatOut = Date.now() + 1;
      p.streakGames = 0;
    });
    state.round++;
    nextMatch = {
      id: uid('rc'),
      courtNum,
      round: state.round,
      teamA: previewedNext.teamA,
      teamB: previewedNext.teamB,
      scoreA: null, scoreB: null,
      winner: null,
      serving: 'A', serverNum: 1, firstServe: true,
      status: 'active',
      substitutions: {}
    };
  } else if (pool.filter(p => !usedIds.has(p.id)).length >= 4) {
    nextMatch = csoGenerateMatchForCourt(courtNum, usedIds);
  }

  if (nextMatch) {
    state.rotationCourts.push(nextMatch);
    // Pre-compute the Up Next preview for the freshly-started court
    nextMatch.nextMatch = csoPreviewNextMatch(nextMatch.id);
    // Also refresh previews on all other courts since player availability changed
    refreshAllNextMatchPreviews();
    toast(`Court ${courtNum} match recorded ✓ — next match ready.`, 'success');
  } else {
    // Refresh other courts' previews anyway — someone just freed up
    refreshAllNextMatchPreviews();
    toast(`Court ${courtNum} match recorded ✓ — waiting for more players to free up.`, 'info');
  }

  playGameWinSound();
  saveAll(); renderAll();
}

// liveMatchCtx for rotation courts (event-driven)
function liveRotationCourtCtx(courtId) {
  return {
    mode: 'rotation-court',
    matchId: courtId,
    getMatch() { return Array.isArray(state.rotationCourts) ? state.rotationCourts.find(c => c.id === courtId) : null; },
    scoreInput(team) { return document.querySelector(`input[data-court-score="${courtId}-${team}"]`); },
    winBtn(team) { return document.querySelector(`.csop-win-btn[data-court="${courtId}"][data-team="${team}"]`); },
    render() { renderActiveView(); }
  };
}

function adjustRotationCourtScore(courtId, team, delta) {
  adjustMatchScore(liveRotationCourtCtx(courtId), team, delta);
}
function setRotationCourtWinner(courtId, team) {
  selectMatchWinner(liveRotationCourtCtx(courtId), team);
}
function updateRotationCourtScore(courtId, team, val) {
  updateMatchScore(liveRotationCourtCtx(courtId), team, val);
}
function setRotationCourtServer(courtId, team) {
  setServingTeam(liveRotationCourtCtx(courtId), team);
}
function rotationCourtAdvanceServer(courtId) {
  advanceServer(liveRotationCourtCtx(courtId));
}
function rotationCourtSideOut(courtId) {
  sideOutMatch(liveRotationCourtCtx(courtId));
}
function rotationCourtUndoServe(courtId) {
  confirmUndoServeModal(liveRotationCourtCtx(courtId));
}
function doRotationCourtUndoServe(courtId) {
  undoServeMatch(liveRotationCourtCtx(courtId));
}

// Replace a player on an active rotation court
function openReplaceRotationCourtPlayerModal(courtId, team, playerId) {
  const m = Array.isArray(state.rotationCourts) ? state.rotationCourts.find(c => c.id === courtId) : null;
  if (!m || m.status !== 'active') { toast('That court is not active.', 'warning'); return; }
  const p = getPlayer(playerId);
  const inMatchIds = new Set([...m.teamA, ...m.teamB]);

  const benchCandidates = csoActivePlayers()
    .filter(pl => pl.id !== playerId && !inMatchIds.has(pl.id))
    .sort((a,b) => a.gamesPlayed - b.gamesPlayed);
  const subCandidates = state.players
    .filter(pl => pl.isSub && pl.active && (pl.condition||'ok')==='ok' && pl.id !== playerId && !inMatchIds.has(pl.id))
    .sort((a,b) => a.gamesPlayed - b.gamesPlayed);

  const rowBtn = (b, badge) => `
    <button class="btn btn-secondary btn-block" style="margin-top:6px; justify-content:space-between;"
      data-action="do-replace-rotation-court-player" data-court="${courtId}" data-team="${team}"
      data-player="${playerId}" data-sub="${b.id}">
      <span>${esc(b.name)}</span>
      <span class="mono" style="color:var(--text-faint); font-size:11px;">${badge} · ${b.gamesPlayed} gms</span>
    </button>`;

  const benchHtml = benchCandidates.length
    ? benchCandidates.map(b => rowBtn(b, '🎮 Available')).join('') : '';
  const subsHtml = subCandidates.length
    ? `<div class="helper-text" style="margin:10px 2px 4px; color:var(--court);">🔁 Sub Players</div>` + subCandidates.map(b => rowBtn(b, '🔁 Sub')).join('') : '';
  const noneHtml = (!benchCandidates.length && !subCandidates.length)
    ? `<p class="helper-text">No other active players available right now.</p>` : '';

  openModal(`
    <div class="modal-title">Replace ${esc(p ? p.name : 'Player')}</div>
    <div class="modal-sub">Tap a player to sub in for ${esc(p ? p.name : 'this player')} on Court ${m.courtNum}.</div>
    ${benchHtml}${subsHtml}${noneHtml}
    <div class="modal-actions">
      <button class="btn btn-ghost btn-block" data-action="modal-close">Cancel</button>
    </div>
  `);
}

function doReplaceRotationCourtPlayer(courtId, team, oldId, newId) {
  if (!newId) { toast('No substitute selected.', 'warning'); return; }
  const m = Array.isArray(state.rotationCourts) ? state.rotationCourts.find(c => c.id === courtId) : null;
  if (!m || m.status !== 'active') { toast('That court is not active.', 'warning'); return; }
  const teamArr = team === 'A' ? m.teamA : m.teamB;
  const idx = teamArr.indexOf(oldId);
  if (idx === -1) return;
  if (!m.substitutions) m.substitutions = {};
  const realOrig = Object.keys(m.substitutions).find(orig => m.substitutions[orig] === oldId) || oldId;
  m.substitutions[realOrig] = newId;
  teamArr[idx] = newId;
  refreshAllNextMatchPreviews();
  saveAll(); renderAll(); closeModal();
  toast(`${playerName(realOrig)} subbed out — ${playerName(newId)} steps in.`, 'success');
}

// Skip a rotation court match (clear without recording)
function skipRotationCourtMatch(courtId) {
  if (!Array.isArray(state.rotationCourts)) return;
  const m = state.rotationCourts.find(c => c.id === courtId);
  if (!m) return;
  const courtNum = m.courtNum;
  state.rotationCourts = state.rotationCourts.filter(c => c.id !== courtId);
  refreshAllNextMatchPreviews();
  saveAll(); renderAll(); closeModal();
  toast(`Court ${courtNum} match cleared.`, 'success');
}

// Permanently close a single court — used when you're down a court (time, space,
// players leaving) but want the rest of Open Play to keep running. Unlike
// skipRotationCourtMatch (which clears one match but the court itself stays
// configured and gets refilled), this also lowers the target court count so
// fillEmptyRotationCourts / Add Court won't immediately spin it back up.
function closeRotationCourt(courtId) {
  if (!Array.isArray(state.rotationCourts)) return;
  const m = state.rotationCourts.find(c => c.id === courtId);
  if (!m) { closeModal(); return; }
  const courtNum = m.courtNum;
  state.rotationCourts = state.rotationCourts.filter(c => c.id !== courtId);
  const cur = clamp(parseInt(state.settings.numCourts, 10) || 1, 1, 10);
  state.settings.numCourts = Math.max(1, cur - 1);
  saveAll(); renderAll(); closeModal();
  toast(`Court ${courtNum} closed — session continues on the remaining court${state.rotationCourts.length!==1?'s':''}.`, 'success');
}

/* ============================================================
   ROTATION COURT MATCH VIEW RENDERER
   ============================================================ */
function renderRotationCourtScoreboard(m) {
  const pA1 = getPlayer(m.teamA[0]), pA2 = getPlayer(m.teamA[1]);
  const pB1 = getPlayer(m.teamB[0]), pB2 = getPlayer(m.teamB[1]);
  if (m.serving === undefined) m.serving = 'A';
  if (m.serverNum === undefined) m.serverNum = 1;
  if (m.firstServe === undefined) m.firstServe = true;
  const servingA = m.serving === 'A', servingB = m.serving === 'B';
  const serveLabel = m.firstServe ? '1st Serve' : `Serve ${m.serverNum}`;
  const activeA = m.winner === 'A', activeB = m.winner === 'B';
  const winTarget = getMatchWinTarget(m);

  function nameTag(team, playerId) {
    const p = getPlayer(playerId);
    const justify = team === 'A' ? 'flex-end' : 'flex-start';
    const cond = p ? (p.condition || 'ok') : 'ok';
    const condBadge = cond === 'tired' ? ' 😴' : cond === 'injured' ? ' 🤕' : cond === 'cant_play' ? ' 🙅' : '';
    ensureCSOP(p || {});
    const streakWarn = p && p.streakGames >= 4 ? ` <span style="color:var(--loss); font-size:10px; font-weight:700;">🔥${p.streakGames}</span>` : p && p.streakGames >= 3 ? ` <span style="color:var(--ball); font-size:10px; font-weight:700;">🔥${p.streakGames}</span>` : '';
    return `<span style="display:inline-flex; align-items:center; flex-wrap:wrap; justify-content:${justify}; gap:4px; max-width:100%;">
      ${esc(p?.name || '—')}${condBadge}${streakWarn}
      <button class="icon-btn-tiny" data-action="open-replace-rc-player"
        data-court="${m.id}" data-team="${team}" data-player="${playerId}"
        aria-label="Replace player" title="Replace this player">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
      </button>
    </span>`;
  }

  return `
    <div class="scoreboard" style="margin-bottom:14px;">
      <div class="sb-head">
        <span class="sb-round">COURT <b>${m.courtNum}</b> · Match <b>#${m.round}</b></span>
        <div style="display:flex; align-items:center; gap:10px;">
          ${m.raceActive ? `<span class="race-badge">🏁 Race to 2</span>` : ''}
          <div class="live-dot"><div class="d"></div>Live</div>
          <button class="icon-btn-tiny" data-action="close-rc-court" data-court="${m.id}" aria-label="Close this court" title="Close this court">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
      </div>
      <div class="sb-body">
        <div class="sb-team team-a">
          <span class="sb-tag">Team A</span>
          <div class="sb-names">${nameTag('A', m.teamA[0])}<br>${duprChip(pA1)}<br>${nameTag('A', m.teamA[1])}<br>${duprChip(pA2)}</div>
          <div class="sb-rating">Avg ELO: ${Math.round(((pA1?.rating||1000)+(pA2?.rating||1000))/2)}</div>
          ${servingA ? `<span class="serve-badge">🎾 ${serveLabel}</span>` : (m.firstServe && !(m.scoreA||0) && !(m.scoreB||0) ? `<button type="button" class="serve-set-btn" data-action="rc-set-server" data-court="${m.id}" data-team="A">Make 1st server</button>` : '')}
          <button class="btn btn-sm ${activeA ? 'btn-primary' : 'btn-secondary'} sb-winbtn csop-win-btn"
            data-action="rc-set-winner" data-court="${m.id}" data-team="A">
            ${activeA ? '✓ Winner Selected' : 'Team A Wins'}
          </button>
        </div>
        <div class="sb-divider"></div>
        <div class="sb-team team-b">
          <span class="sb-tag">Team B</span>
          <div class="sb-names">${nameTag('B', m.teamB[0])}<br>${duprChip(pB1)}<br>${nameTag('B', m.teamB[1])}<br>${duprChip(pB2)}</div>
          <div class="sb-rating">Avg ELO: ${Math.round(((pB1?.rating||1000)+(pB2?.rating||1000))/2)}</div>
          ${servingB ? `<span class="serve-badge">🎾 ${serveLabel}</span>` : (m.firstServe && !(m.scoreA||0) && !(m.scoreB||0) ? `<button type="button" class="serve-set-btn" data-action="rc-set-server" data-court="${m.id}" data-team="B">Make 1st server</button>` : '')}
          <button class="btn btn-sm ${activeB ? 'btn-primary' : 'btn-secondary'} sb-winbtn csop-win-btn"
            data-action="rc-set-winner" data-court="${m.id}" data-team="B">
            ${activeB ? '✓ Winner Selected' : 'Team B Wins'}
          </button>
        </div>
      </div>
      <div class="sb-foot rr-score-foot">
        <div class="score-stepper">
          <button type="button" class="score-btn score-btn-minus rr-score-btn"
            data-action="rc-score-adjust" data-court="${m.id}" data-team="A" data-delta="-1"
            ${(m.winner || !servingA || (m.scoreA === null || m.scoreA <= 0)) ? 'disabled' : ''}>−</button>
          <input type="number" inputmode="numeric" pattern="[0-9]*" placeholder="A"
            class="cb-score-input rr-score-input"
            data-court-score="${m.id}-A"
            min="0" max="${winTarget}"
            value="${m.scoreA !== null ? m.scoreA : ''}"
            oninput="window.updateRCScore('${m.id}', 'A', this.value)">
          <button type="button" class="score-btn score-btn-plus rr-score-btn"
            data-action="rc-score-adjust" data-court="${m.id}" data-team="A" data-delta="1"
            ${(m.winner || !servingA || (m.scoreA !== null && m.scoreA >= winTarget)) ? 'disabled' : ''}>+</button>
        </div>
        <span class="rr-score-vs-sm">vs</span>
        <div class="score-stepper">
          <button type="button" class="score-btn score-btn-minus rr-score-btn"
            data-action="rc-score-adjust" data-court="${m.id}" data-team="B" data-delta="-1"
            ${(m.winner || !servingB || (m.scoreB === null || m.scoreB <= 0)) ? 'disabled' : ''}>−</button>
          <input type="number" inputmode="numeric" pattern="[0-9]*" placeholder="B"
            class="cb-score-input rr-score-input"
            data-court-score="${m.id}-B"
            min="0" max="${winTarget}"
            value="${m.scoreB !== null ? m.scoreB : ''}"
            oninput="window.updateRCScore('${m.id}', 'B', this.value)">
          <button type="button" class="score-btn score-btn-plus rr-score-btn"
            data-action="rc-score-adjust" data-court="${m.id}" data-team="B" data-delta="1"
            ${(m.winner || !servingB || (m.scoreB !== null && m.scoreB >= winTarget)) ? 'disabled' : ''}>+</button>
        </div>
      </div>
      <div style="padding:0 14px 14px;">
        <div style="display:flex; gap:8px; margin-bottom:10px;">
          <button class="btn btn-secondary btn-sm" style="flex:1;"
            data-action="rc-advance-server" data-court="${m.id}"
            ${(m.firstServe || m.serverNum===2) ? 'disabled' : ''}>🎾 Serve 2</button>
          <button class="btn btn-secondary btn-sm sideout-btn" style="flex:1;"
            data-action="rc-side-out" data-court="${m.id}"
            ${(m.winner || (!m.firstServe && m.serverNum===1)) ? 'disabled' : ''}>🔁 Side Out</button>
          <button class="btn btn-ghost btn-sm undo-serve-btn"
            data-action="rc-undo-serve" data-court="${m.id}"
            title="Undo serve decision"
            ${(!m._serveUndoStack || !m._serveUndoStack.length) ? 'disabled' : ''}>↩️${(m._serveUndoStack && m._serveUndoStack.length) ? ' '+m._serveUndoStack.length : ''}</button>
        </div>
        <button class="btn btn-primary btn-block"
          data-action="confirm-rc-match" data-court="${m.id}">
          ✅ Confirm Result &amp; Auto-Generate Next
        </button>
        <div style="display:flex; gap:8px; margin-top:8px;">
          <button class="btn btn-ghost btn-sm" style="flex:1;"
            data-action="skip-rc-match" data-court="${m.id}"
            ${hasMatchStarted(m) ? 'disabled title="Scoring started — finish or undo first"' : ''}>⏭️ Skip</button>
          <button class="btn btn-danger btn-sm" style="flex:1;"
            data-action="undo-match"
            ${!state.undo ? 'disabled' : ''}>↩ Undo Last</button>
        </div>
      </div>
    </div>
    ${renderUpNextCard(m)}
  `;
}


// Renders the "Up Next" preview card shown below each live court scoreboard.
// m = the live court match object (which carries m.nextMatch if available).
function renderUpNextCard(m) {
  const nx = m.nextMatch;
  if (!nx) {
    // Check if there are enough free players at all
    const usedIds = new Set();
    (state.rotationCourts || []).forEach(c => {
      c.teamA.forEach(id => usedIds.add(id));
      c.teamB.forEach(id => usedIds.add(id));
    });
    const freeCount = csoActivePlayers().filter(p => !usedIds.has(p.id)).length;
    const msg = freeCount < 4
      ? `Waiting for ${4 - freeCount} more player${4 - freeCount !== 1 ? 's' : ''} to free up`
      : 'Generating…';
    return `
      <div class="up-next-card" style="opacity:.55;">
        <div class="up-next-label"><span class="dot"></span>Up Next</div>
        <div style="font-size:12px; color:var(--text-faint);">${msg}</div>
      </div>`;
  }

  const nA1 = getPlayer(nx.teamA[0]), nA2 = getPlayer(nx.teamA[1]);
  const nB1 = getPlayer(nx.teamB[0]), nB2 = getPlayer(nx.teamB[1]);
  const avgA = Math.round(((nA1?.rating||1000)+(nA2?.rating||1000))/2);
  const avgB = Math.round(((nB1?.rating||1000)+(nB2?.rating||1000))/2);

  // Reshuffle is only allowed on the very first match of this court —
  // once at least one result has been recorded, WvW / loss-vs-loss
  // logic owns the pairing and manual reshuffling would break that.
  const courtHasHistory = state.matches.some(r => r.court === m.courtNum);
  const regenDisabled = courtHasHistory;
  const regenTitle = courtHasHistory
    ? 'Re-shuffle is disabled after the first match — Win vs Win / Loss vs Loss balancing now controls the lineup'
    : 'Re-shuffle the Up Next lineup';

  return `
    <div class="up-next-card">
      <div class="up-next-label">
        <span class="dot"></span>Up Next on Court ${m.courtNum}
      </div>
      <div class="up-next-teams">
        <div class="up-next-team side-a">
          <div class="up-next-name">${esc(nA1?.name || '—')}</div>
          <div class="up-next-name">${esc(nA2?.name || '—')}</div>
          <div class="up-next-sub">avg ${avgA}</div>
        </div>
        <div class="up-next-vs">vs</div>
        <div class="up-next-team side-b">
          <div class="up-next-name">${esc(nB1?.name || '—')}</div>
          <div class="up-next-name">${esc(nB2?.name || '—')}</div>
          <div class="up-next-sub">avg ${avgB}</div>
        </div>
      </div>
      <button class="up-next-regen" data-action="confirm-regen-next-match" data-court="${m.id}"
        title="${regenTitle}" ${regenDisabled ? 'disabled style="opacity:.35; cursor:not-allowed;"' : ''}>
        🔀 Re-shuffle Up Next${regenDisabled ? ' (locked after 1st match)' : ''}
      </button>
    </div>`;
}

function nextRotationMatch(){
  const pool = selectionPool();
  if(pool.length < 4){ goToAddPlayer('Add a few more players to start — you need at least 4.'); return; }

  // --- STEP 1: strict fairness tier --------------------------------------
  // Start with everyone tied at the minimum gamesPlayed. Resolve fixed-duo
  // blocking against that tier; if too few usable players remain, widen by
  // pulling in the next-lowest tier WHOLESALE (never a partial slice of a
  // tier) so the sit-out remainder stays as mathematically uniform as the
  // group size allows.
  const eligibleIds = new Set();
  let usable = [];
  let cursor = 0;
  while(usable.length < 4 && cursor < pool.length){
    const tier = fairnessTierFrom(pool, cursor);
    if(!tier.length) break;
    tier.forEach(p => eligibleIds.add(p.id));
    const blocked = partitionDuoBlocked(tier, eligibleIds);
    usable = usable.concat(tier.filter(p => !blocked.has(p.id)));
    cursor += tier.length;
  }

  if(usable.length < 4){
    toast('Not enough players available — some are waiting on a fixed-duo partner who isn\'t due yet.', 'warning');
    return;
  }

  // --- STEP 2: look-ahead candidate window -------------------------------
  // Include ALL players tied at the minimum gamesPlayed so nobody gets
  // skipped just because they happened to sort later within the tier.
  // Only cap to a window once we've gone past the first tier boundary.
  const minGames = usable[0] ? usable[0].gamesPlayed : 0;
  const sameTierCount = usable.filter(p => p.gamesPlayed === minGames).length;
  const windowSize = Math.max(sameTierCount, Math.min(8, usable.length));
  const candidates = usable.slice(0, windowSize);

  // Fixed duos fully inside the window must stay paired — collapse each duo
  // into a single 2-player "unit" so the combination search below can never
  // split them apart.
  const units = [];
  const claimed = new Set();
  candidates.forEach(p => {
    if(claimed.has(p.id)) return;
    const partnerId = getFixedDuoPartner(p.id);
    const partner = partnerId ? candidates.find(c => c.id === partnerId) : null;
    if(partner){
      units.push([p, partner]);
      claimed.add(p.id); claimed.add(partner.id);
    } else {
      units.push([p]);
      claimed.add(p.id);
    }
  });

  // --- STEP 3: evaluate every foursome + team-split combination ----------
  // Instead of locking in a rigid top-4 and only arranging teams afterward,
  // walk every combination of units that sums to exactly 4 players, run each
  // through scoreSplit() (teammate/opponent penalty matrix + rematch
  // prevention + skill balance), and keep the global minimum. This is what
  // stops the engine from being forced into an immediate rematch whenever
  // the literal next 4 in queue order just played each other.
  let best = null;
  (function explore(startIdx, chosen, count){
    if(count === 4){
      const four = chosen.flat();
      const result = scoreSplit(four, state.settings);
      if(result && (!best || result.score < best.score)){
        best = { four, split: result.split, score: result.score };
      }
      return;
    }
    if(count > 4) return;
    for(let i = startIdx; i < units.length; i++){
      explore(i + 1, chosen.concat([units[i]]), count + units[i].length);
    }
  })(0, [], 0);

  if(!best){
    toast('Could not assemble a valid foursome from the active pool.', 'warning');
    return;
  }

  const [[p1,p2],[p3,p4]] = best.split;
  state.current = { round: state.round + 1, teamA: [p1.id, p2.id], teamB: [p3.id, p4.id], scoreA: null, scoreB: null, winner: null, serving: 'A', serverNum: 1, firstServe: true };
  state.players.forEach(p=>{
    if(p.active){
      if(state.current.teamA.includes(p.id) || state.current.teamB.includes(p.id)){ p.consecutiveSitOuts = 0; }
      else { p.sitOuts++; p.consecutiveSitOuts++; }
    }
  });
  saveAll(); renderAll();
}

/* ============================================================
   ROUND ROBIN MODE ALGORITHM & LOGIC (full-round queue engine)
   ------------------------------------------------------------
   A "generation" always schedules every match needed to play
   every active player exactly once that round (floor(active/4)
   matches) — regardless of how many physical courts you have.
   With 1 court, those matches simply queue up as "Up Next" and
   feed onto the court one at a time as each one finishes, so
   you can always see who's playing next. Once every match in a
   generation is finished, the next generation is auto-built:
   winners are grouped with winners and losers with losers
   (when that setting is on), while still balancing total games
   played and avoiding repeat teammates/opponents wherever the
   pool allows. Players who didn't fit a foursome sit out for
   exactly one generation and get top priority next time.
   ============================================================ */

function buildBalancedMatchups(group){
  // group.length should be a multiple of 4; any remainder is left unmatched by the caller.
  const matches = [];
  for(let i=0; i + 4 <= group.length; i += 4){
    const four = group.slice(i, i + 4);
    const best = scoreSplit(four, state.settings);
    const [[a,b],[c,d]] = best.split;
    matches.push({ teamA:[a.id,b.id], teamB:[c.id,d.id] });
  }
  return matches;
}

// Pull players from `donor` (lowest scheduling priority first, since donor is
// already fairness-sorted) until `group`'s length is a clean multiple of 4.
function topUpToMultipleOf4(group, donor){
  while(group.length % 4 !== 0 && donor.length){
    group.push(donor.shift());
  }
  return group;
}

/* ----------------------------------------------------------------
   ROTATING SIT-OUT QUEUE (Round Robin fairness)
   ------------------------------------------------------------------
   state.sitOutQueue is an ordered array of player IDs. The FRONT of
   the array (index 0) is the player who is most overdue to sit out
   next; the BACK is whoever just sat out (or just joined/returned),
   meaning they're last in line to sit again. Every time a generation
   is built, syncSitOutQueue() keeps membership current — Sub Players
   and anyone Tired/Injured/Can't-Play/Not-Coming never occupy a slot
   in this queue, exactly mirroring activePlayers(). Whoever sits out
   is then rotated to the back so nobody sits twice before everyone
   else eligible has had a turn. The queue is persisted via saveAll()
   so refreshing the page never resets the rotation.
   ---------------------------------------------------------------- */
function sitOutQueueEligible(p){
  return !!p && p.active && !p.isSub && (p.condition||'ok')==='ok';
}

function syncSitOutQueue(){
  if(!Array.isArray(state.sitOutQueue)) state.sitOutQueue = [];
  // Drop anyone no longer eligible — left, paused, tired, injured, became a
  // Sub, or was removed entirely. They simply leave the line; if they come
  // back later they re-enter at the end, never ahead of where they left off.
  state.sitOutQueue = state.sitOutQueue.filter(id => sitOutQueueEligible(getPlayer(id)));
  // Anyone eligible who isn't already queued (brand new, or just returned to
  // Active/OK) joins at the very END — they play first and only rotate into
  // a sit-out turn once they've naturally worked their way to the front.
  const inQueue = new Set(state.sitOutQueue);
  activePlayers().forEach(p => {
    if(!inQueue.has(p.id)){
      state.sitOutQueue.push(p.id);
      inQueue.add(p.id);
    }
  });
}

function generateRoundRobinGeneration() {
  const activeList = activePlayers().slice();
  if(activeList.length < 4) { goToAddPlayer('Add a few more players to start — you need at least 4.'); return; }

  const plan = state.settings.sessionPlan;
  const planIsFinished = plan && (state.matches.length - plan.matchesAtStart) >= plan.totalMatches;
  if(planIsFinished){
    state.settings.sessionPlan = null;
    saveAll();
  }

  // Always show Session Setup so the user can pick the mode every time
  openSessionSetupModal();
}

// Mode picker — shown every time the user starts fresh from the Match tab
function openModePickerModal(){
  openModal(`
    <div class="modal-title">🎾 Choose Match Mode</div>
    <div class="modal-sub" style="line-height:1.6;">How do you want to run today's session?</div>
    <div style="display:flex; flex-direction:column; gap:12px; margin-top:8px;">
      <button class="btn btn-primary" style="padding:18px 16px; font-size:15px; text-align:left; display:flex; flex-direction:column; gap:4px;" data-action="pick-mode-openplay">
        <span style="font-size:18px;">🏓 Open Play</span>
        <span style="font-weight:400; font-size:12px; opacity:0.85;">Courts run independently. New match auto-generates the moment each court finishes.</span>
      </button>
      <button class="btn btn-secondary" style="padding:18px 16px; font-size:15px; text-align:left; display:flex; flex-direction:column; gap:4px;" data-action="pick-mode-roundrobin">
        <span style="font-size:18px;">🔀 Round Robin</span>
        <span style="font-weight:400; font-size:12px; opacity:0.85;">Everyone is scheduled each generation. Choose session length and courts up front.</span>
      </button>
    </div>
    <div class="modal-actions" style="margin-top:16px;">
      <button class="btn btn-ghost" data-action="modal-close">Cancel</button>
    </div>
  `, false);
}

// Step 1 of starting a new session: courts + winning score, asked up front
// before the match-count picker so the organizer sets the table once.
function openSessionSetupModal(){
  const numCourts = clamp(parseInt(state.settings.numCourts,10)||1, 1, 10);
  const winningScore = state.settings.winningScore || 11;
  const isRotation = state.settings.matchMode === 'Rotation';
  openModal(`
    <div class="modal-title">🎾 Session Setup</div>
    <div class="modal-sub" style="line-height:1.6;">Courts and winning score for your <b style="color:var(--text);">${isRotation ? 'Open Play' : 'Round Robin'}</b> session.</div>
    <div class="card" style="margin:0;">
      <div class="field">
        <label>Number of Available Courts</label>
        <input type="number" id="setupNumCourtsInput" min="1" max="10" value="${numCourts}">
        <p class="helper-text">Every active player is still scheduled each generation — courts just control how many matches play at once.</p>
      </div>
      <div class="field" style="margin-bottom:0;">
        <label>Winning Score</label>
        <input type="number" id="setupWinningScoreInput" min="1" max="99" value="${winningScore}">
        <p class="helper-text">First team to reach this score (win by 2) takes the match.</p>
      </div>
    </div>
    <div class="modal-actions" style="margin-top:16px;">
      <button class="btn btn-ghost" data-action="modal-close">Cancel</button>
      <button class="btn btn-primary" id="sessionSetupNextBtn" data-action="confirm-session-setup">${isRotation ? 'Next: Balancing' : 'Next: Session Length'}</button>
    </div>
  `, false);
}

function confirmSessionSetup(){
  const courtsEl = document.getElementById('setupNumCourtsInput');
  const scoreEl = document.getElementById('setupWinningScoreInput');
  if(courtsEl){
    const v = parseInt(courtsEl.value, 10);
    state.settings.numCourts = clamp(isNaN(v) ? 1 : v, 1, 10);
  }
  if(scoreEl){
    const v = parseInt(scoreEl.value, 10);
    state.settings.winningScore = (isNaN(v) || v < 1) ? 11 : v;
  }
  saveAll();
  if(state.settings.matchMode === 'Rotation'){
    openRotationConfirmModal();
  } else {
    openSessionLengthPicker();
  }
}

function openRotationConfirmModal(){
  const winningScore = state.settings.winningScore || 11;

  openModal(`
    <div class="modal-title">Confirm &amp; Generate</div>
    <div class="modal-sub" style="line-height:1.6;">Review settings before generating the match.</div>

    <div class="card" style="margin:0;">
      <div class="session-confirm-row"><span class="k">Match Mode</span><span class="v" style="font-family:inherit; color:var(--court);">Rotation</span></div>
      <div class="session-confirm-row"><span class="k">Winning Score</span><span class="v">${winningScore}</span></div>
      <div class="session-confirm-row"><span class="k">Active Players</span><span class="v">${activePlayers().length}</span></div>
    </div>

    <div class="modal-actions" style="margin-top:16px;">
      <button class="btn btn-ghost" data-action="back-to-session-setup">Back</button>
      <button class="btn btn-primary" data-action="confirm-rotation-generate">Confirm &amp; Generate</button>
    </div>
  `, false);
}

function confirmRotationGenerate(){
  saveAll();
  closeModal();
  nextRotationMatch();
}

// Runs the existing court-count sanity check, then generates. Split out so
// the session-length picker's confirm step can call straight into it.
function proceedToGenerateGeneration(activeList){
  // Warn if the number of courts exceeds the number of possible matches
  const numCourts = clamp(parseInt(state.settings.numCourts,10)||1, 1, 10);
  const possibleMatches = Math.floor(activeList.length / 4);
  if(possibleMatches < numCourts && !_courtCountNoticeDismissed){
    const excess = numCourts - possibleMatches;
    const needed = numCourts * 4;
    const msg = possibleMatches === 1
      ? `⚠️ Only 1 match can be generated with ${activeList.length} active players — you need at least ${needed} players to fill ${numCourts} courts simultaneously. ${excess} court${excess>1?'s':''} will sit empty this generation.`
      : `⚠️ Only ${possibleMatches} match${possibleMatches!==1?'es':''} can be generated with ${activeList.length} active players — ${numCourts} courts set but only ${possibleMatches} team${possibleMatches!==1?'s':'s'} formed. Need ${needed} players for full ${numCourts}-court play.`;
    // Show once per session, then proceed silently on subsequent generations
    _courtCountNoticeDismissed = true;
    openModal(`
      <div class="modal-title" style="color:var(--ball);">⚠️ Court Count Notice</div>
      <div class="modal-sub" style="line-height:1.7; font-size:13.5px;">${msg}</div>
      <div class="modal-actions" style="margin-top:16px;">
        <button class="btn btn-ghost" data-action="modal-close">Cancel</button>
        <button class="btn btn-primary" data-action="do-generate-rr">Generate Anyway</button>
      </div>
    `);
    return;
  }

  _doGenerateRoundRobinGeneration(activeList);
}

/* ---------- Session length picker + confirm modals ---------- */
function openSessionLengthPicker(){
  const activeList = activePlayers();
  const playerCount = activeList.length;
  const recId = recommendedPlanId(playerCount);

  const optsHtml = SESSION_PLAN_OPTIONS.map(opt => {
    const scaled = scaledPlanMatches(opt, playerCount);
    const gpp = actualGamesPerPlayer(scaled, playerCount);
    const isRec = opt.id === recId;
    const gens = Math.ceil(scaled / matchesPerGeneration(playerCount));
    return `
      <button type="button" class="session-opt ${isRec ? 'recommended' : ''}" data-action="pick-session-plan" data-plan="${opt.id}">
        <div class="session-opt-count"><span class="n">${scaled}</span><span class="u">matches</span></div>
        <div class="session-opt-body">
          <div class="session-opt-name">${opt.label}${isRec ? `<span class="session-opt-tag">Recommended</span>` : ''}</div>
          <div class="session-opt-sub">${gpp} game${gpp!==1?'s':''} per player · ${gens} generation${gens!==1?'s':''} with ${playerCount} active player${playerCount!==1?'s':''}</div>
        </div>
        <div class="session-opt-check"></div>
      </button>
    `;
  }).join('');

  openModal(`
    <div class="modal-title">🏆 Choose Session Length</div>
    <div class="modal-sub" style="line-height:1.6;">With <b style="color:var(--text);">${playerCount} active player${playerCount!==1?'s':''}</b>, here's how each option breaks down so games stay equally played.</div>
    <div class="session-opt-list">
      ${optsHtml}
      <button type="button" class="session-opt custom-opt" data-action="pick-session-plan-custom">
        <div class="session-opt-count"><span class="n">✏️</span></div>
        <div class="session-opt-body">
          <div class="session-opt-name">Custom</div>
          <div class="session-opt-sub">Type in your own total match count</div>
        </div>
        <div class="session-opt-check"></div>
      </button>
    </div>
    <button class="btn btn-ghost" style="margin-top:10px; width:100%;" data-action="back-to-session-setup">Back to Courts &amp; Scoring</button>
  `, false);
}

function pickSessionPlan(planId){
  const opt = SESSION_PLAN_OPTIONS.find(o => o.id === planId);
  if(!opt) return;
  const playerCount = activePlayers().length;
  const scaled = scaledPlanMatches(opt, playerCount);
  const gpp = actualGamesPerPlayer(scaled, playerCount);
  openSessionConfirmModal(opt, scaled, gpp, playerCount);
}

// Custom session length: lets the organizer type in their own total match
// count instead of picking one of the 5 named plans. Still rounds to the
// nearest full generation (matchesPerGeneration) so the equal-play guarantee
// that every other plan relies on — nobody left mid-rotation when the
// session ends — holds for custom lengths too.
function openCustomSessionLengthModal(){
  const playerCount = activePlayers().length;
  const perGen = matchesPerGeneration(playerCount);
  const balancedOpt = SESSION_PLAN_OPTIONS.find(o => o.id === 'balanced');
  const suggested = balancedOpt ? scaledPlanMatches(balancedOpt, playerCount) : perGen;

  openModal(`
    <div class="modal-title">✏️ Custom Session Length</div>
    <div class="modal-sub" style="line-height:1.6;">With <b style="color:var(--text);">${playerCount} active player${playerCount!==1?'s':''}</b>, matches run ${perGen} at a time per generation — whatever you enter rounds to the nearest full generation so everyone keeps getting equal play.</div>
    <div class="field">
      <label>Total Matches</label>
      <input type="number" id="customSessionMatchesInput" inputmode="numeric" pattern="[0-9]*" min="${perGen}" max="300" step="1" value="${suggested}" oninput="window.updateCustomSessionPreview(this.value)">
    </div>
    <p class="helper-text" id="customSessionPreview" style="text-align:center;"></p>
    <div class="modal-actions" style="margin-top:14px;">
      <button class="btn btn-ghost" data-action="back-to-session-picker">Back</button>
      <button class="btn btn-primary" data-action="confirm-custom-session-length">Continue</button>
    </div>
  `, false);

  window.updateCustomSessionPreview = function(val){
    const previewEl = document.getElementById('customSessionPreview');
    if(!previewEl) return;
    const raw = parseInt(val, 10);
    if(isNaN(raw) || raw < 1){ previewEl.textContent = 'Enter a number to see how it breaks down.'; return; }
    const rounded = Math.max(perGen, Math.round(raw / perGen) * perGen);
    const gpp = actualGamesPerPlayer(rounded, playerCount);
    const gens = Math.round(rounded / perGen);
    previewEl.textContent = `Rounds to ${rounded} match${rounded!==1?'es':''} · ${gpp} game${gpp!==1?'s':''} per player · ${gens} generation${gens!==1?'s':''}`;
  };
  window.updateCustomSessionPreview(suggested);
}

function confirmCustomSessionLength(){
  const input = document.getElementById('customSessionMatchesInput');
  const playerCount = activePlayers().length;
  const perGen = matchesPerGeneration(playerCount);
  const raw = parseInt(input ? input.value : '', 10);

  if(isNaN(raw) || raw < 1){
    toast('Enter a valid number of matches.', 'warning');
    return;
  }

  const totalMatches = Math.max(perGen, Math.round(raw / perGen) * perGen);
  const gpp = actualGamesPerPlayer(totalMatches, playerCount);
  const customOpt = { id: 'custom', label: 'Custom Session', gamesPerPlayer: gpp, tag: '' };
  openSessionConfirmModal(customOpt, totalMatches, gpp, playerCount);
}

function openSessionConfirmModal(opt, totalMatches, gpp, playerCount){
  const numCourts = clamp(parseInt(state.settings.numCourts,10)||1, 1, 10);
  const winningScore = state.settings.winningScore || 11;
  const modeLabel = state.settings.matchMode === 'RoundRobin' ? 'Round Robin' : 'Rotation';

  function toggleRow(id, label, hint, checked){
    return `
      <div class="toggle-row">
        <div>
          <div class="t-label">${label}</div>
          <div class="t-hint">${hint}</div>
        </div>
        <label class="switch">
          <input type="checkbox" id="${id}" ${checked ? 'checked' : ''}>
          <div class="track"></div><div class="thumb"></div>
        </label>
      </div>
    `;
  }

  openModal(`
    <div class="modal-title">Confirm Session</div>
    <div class="modal-sub" style="line-height:1.6;">Review and adjust before generating the first round.</div>
    <div class="card" style="margin:0 0 10px; padding:4px 14px;">
      <div class="session-confirm-row"><span class="k">Plan</span><span class="v" style="font-family:inherit;">${opt.label}</span></div>
      <div class="session-confirm-row"><span class="k">Total Matches</span><span class="v">${totalMatches}</span></div>
      <div class="session-confirm-row"><span class="k">Games / Player</span><span class="v">${gpp}</span></div>
      <div class="session-confirm-row"><span class="k">Active Players</span><span class="v">${playerCount}</span></div>
      <div class="session-confirm-row"><span class="k">Match Mode</span><span class="v" style="font-family:inherit; color:var(--court);">${modeLabel}</span></div>
    </div>

    <div class="eyebrow" style="margin:0 2px 6px;">Courts &amp; Scoring</div>
    <div class="card" style="margin:0 0 10px;">
      <div class="field">
        <label>Number of Available Courts</label>
        <input type="number" id="sessionNumCourtsInput" min="1" max="10" value="${numCourts}">
      </div>
      <div class="field" style="margin-bottom:0;">
        <label>Winning Score</label>
        <input type="number" id="sessionWinningScoreInput" min="1" max="99" value="${winningScore}">
      </div>
    </div>

    <div class="eyebrow" style="margin:0 2px 6px;">Balancing &amp; Fairness</div>
    <div class="card" style="margin:0 0 ${state.settings.matchMode === 'RoundRobin' ? '10px' : '0'};">
      ${toggleRow('sessionWinnerVsWinnerToggle', 'Winner vs Winner / Loser vs Loser', "Next generation pairs last generation's winners together and losers together.", !!state.settings.winnerVsWinner)}
    </div>

    ${state.settings.matchMode === 'RoundRobin' ? `
    <div class="eyebrow" style="margin:0 2px 6px;">Schedule Generation</div>
    <div class="card" style="margin:0;">
      ${toggleRow('sessionFullScheduleToggle', 'Generate Full Schedule Now', `Builds every round for all ${totalMatches} matches right away and lists the whole session, instead of one round at a time as you play. Winner vs Winner has no effect on rounds beyond the first, since results for those rounds don't exist yet.`, !!state.settings.generateFullSchedule)}
    </div>
    ` : ''}

    <div class="modal-actions" style="margin-top:16px;">
      <button class="btn btn-ghost" data-action="back-to-session-picker">Back</button>
      <button class="btn btn-primary" data-action="confirm-session-plan" data-plan="${opt.id}" data-total="${totalMatches}" data-gpp="${gpp}">Confirm &amp; Generate</button>
    </div>
  `, false);
}



function confirmSessionPlanAndGenerate(planId, totalMatches, gpp){
  const opt = SESSION_PLAN_OPTIONS.find(o => o.id === planId);
  const hadGenerationInProgress = !!state.currentGeneration;

  // Pull the editable values straight out of the confirm form so courts,
  // winning score, and the balancing toggles all apply before the first
  // generation is built — not just shown read-only.
  const courtsEl = document.getElementById('sessionNumCourtsInput');
  const scoreEl = document.getElementById('sessionWinningScoreInput');
  const wvwEl = document.getElementById('sessionWinnerVsWinnerToggle');
  const fullScheduleEl = document.getElementById('sessionFullScheduleToggle');

  if(courtsEl){
    const v = parseInt(courtsEl.value, 10);
    state.settings.numCourts = clamp(isNaN(v) ? 1 : v, 1, 10);
  }
  if(scoreEl){
    const v = parseInt(scoreEl.value, 10);
    state.settings.winningScore = (isNaN(v) || v < 1) ? 11 : v;
  }
  if(wvwEl) state.settings.winnerVsWinner = wvwEl.checked;
  if(fullScheduleEl) state.settings.generateFullSchedule = fullScheduleEl.checked;

  state.settings.sessionPlan = {
    id: planId,
    label: opt ? opt.label : 'Custom Session',
    totalMatches: totalMatches,
    gamesPerPlayer: gpp,
    matchesAtStart: state.matches.length
  };
  saveAll();
  closeModal();

  // If a generation is already on the court (e.g. the organizer used "Change"
  // mid-session), just swap the tracked plan in — don't regenerate matches
  // that are already underway. Otherwise (fresh start), generate the first round.
  if(hadGenerationInProgress){
    if(state.currentGeneration) advanceRRQueue(); // pick up newly-freed courts right away if the count went up
    renderAll();
    toast(`Switched to ${opt ? opt.label : 'new session'} — tracking from here.`, 'success');
    return;
  }
  const activeList = activePlayers().slice();
  if(state.settings.generateFullSchedule){
    proceedToGenerateFullSchedule(activeList, totalMatches);
  } else {
    proceedToGenerateGeneration(activeList);
  }
}



// Builds ONE Round Robin generation (who plays, who sits, the matchups) for
// the given genId, applying all the same fairness/balancing rules whether
// it's being built live (one round at a time, the normal flow) or inside a
// dry-run loop that's pre-building every round of a full schedule upfront.
// Mutates state.sitOutQueue and each player's rotation bookkeeping fields
// (sitOutPriority/waitingRounds/consecutiveSitOuts/sitOuts) for real, since
// those represent the schedule itself — but never touches gamesPlayed,
// wins/losses, or rating, since this never fabricates a result.
// Pass opts.silent=true to suppress the "matchup history reset" toast
// (used by the full-schedule pre-builder so it doesn't fire several times
// in a row for rounds that haven't actually been played yet).
function buildOneGeneration(activeList, genId, opts) {
  opts = opts || {};

  activeList.forEach(p => {
    p._jitter = Math.random();
    if(p.sitOutPriority === undefined) p.sitOutPriority = 0;
    if(p.waitingRounds === undefined) p.waitingRounds = 0;
  });

  // Keep the rotating sit-out queue in sync with who's actually eligible right
  // now — Sub/Tired/Injured/Can't-Play/Not-Coming players never occupy a queue
  // slot — before it's used below to help decide who waits this generation.
  syncSitOutQueue();
  const queuePos = {};
  state.sitOutQueue.forEach((id, idx) => { queuePos[id] = idx; });

  // If every active player has already partnered or opposed every other active
  // player, the matchup matrix is exhausted — reset it so pairings can repeat fairly
  // instead of the algorithm getting stuck.
  let allExhausted = true;
  exhaustCheck:
  for(let i=0; i<activeList.length; i++){
    for(let j=i+1; j<activeList.length; j++){
      const pI = activeList[i], pJ = activeList[j];
      if((pI.teammates[pJ.id]||0) === 0 && (pI.opponents[pJ.id]||0) === 0){ allExhausted = false; break exhaustCheck; }
    }
  }
  if(allExhausted){
    state.players.forEach(p => { p.teammates = {}; p.opponents = {}; });
    if(!opts.silent) toast('All combinations played at least once — matchup history reset for a fresh rotation.', 'info');
  }

  // Schedule EVERY foursome the active roster supports this generation (not capped by court count).
  const matchCount = Math.floor(activeList.length / 4);
  const playersNeeded = matchCount * 4;

  // PASS 1 — decide exactly who plays and who sits this generation. Fewest
  // games played always plays first (equal games played stays the rule of
  // the road); when several players are tied on games played and there are
  // more of them than open slots, the rotating sit-out queue breaks the tie:
  // whoever is closest to the front of the queue (most overdue to sit) is
  // the one who waits, like a deli "take a number" line.
  const splitOrder = activeList.slice().sort((a,b) => {
    if(a.gamesPlayed !== b.gamesPlayed) return a.gamesPlayed - b.gamesPlayed;
    const qa = queuePos[a.id] !== undefined ? queuePos[a.id] : Infinity;
    const qb = queuePos[b.id] !== undefined ? queuePos[b.id] : Infinity;
    if(qa !== qb) return qb - qa; // farther from the queue's front plays; closer to the front waits
    return a._jitter - b._jitter;
  });
  const sittingPlayers = splitOrder.slice(playersNeeded);
  const playingIdSet = new Set(splitOrder.slice(0, playersNeeded).map(p => p.id));

  // A player who sits out is rotated to the very back of the queue, so nobody
  // sits twice before every other eligible player has had a turn — and since
  // their games-played count won't move while they wait, PASS 1 above will
  // automatically put them right back at the front of the line to PLAY next
  // generation, giving them top priority and preventing consecutive sit-outs
  // unless every other eligible player is already tied with them.
  if(sittingPlayers.length){
    const sittingIdSet = new Set(sittingPlayers.map(p => p.id));
    const movedToBack = state.sitOutQueue.filter(id => sittingIdSet.has(id)); // preserve relative order
    state.sitOutQueue = state.sitOutQueue.filter(id => !sittingIdSet.has(id)).concat(movedToBack);
  }

  // PASS 2 — among the players who ARE playing, reorder using the original
  // fairness heuristic (longest-waiting sit-outs, then lowest history of
  // repeat pairings against the rest of the active pool, then a coin-flip)
  // purely to decide which 4 players land in the same foursome together.
  // This keeps teammate/opponent variety exactly as before — only WHO sits
  // out changed above, not how the playing pool gets grouped into matches.
  const playingPlayers = activeList.filter(p => playingIdSet.has(p.id));
  playingPlayers.sort((a,b) => {
    if(a.gamesPlayed !== b.gamesPlayed) return a.gamesPlayed - b.gamesPlayed;
    if(a.sitOutPriority !== b.sitOutPriority) return b.sitOutPriority - a.sitOutPriority;
    if(a.waitingRounds !== b.waitingRounds) return b.waitingRounds - a.waitingRounds;
    let totalRepA = 0, totalRepB = 0;
    activeList.forEach(other => {
      if(other.id !== a.id) totalRepA += (a.teammates[other.id]||0) + (a.opponents[other.id]||0);
      if(other.id !== b.id) totalRepB += (b.teammates[other.id]||0) + (b.opponents[other.id]||0);
    });
    if(totalRepA !== totalRepB) return totalRepA - totalRepB;
    return a._jitter - b._jitter;
  });

  let matchups = [];
  let wvwApplied = false; // tracks whether winner/loser bucketing actually ran this build (not just whether the setting is on)

  // Winner-vs-winner / Loser-vs-loser bucketing, based on the generation that just finished.
  // Keyed off genId-1 (the generation immediately before this one) rather than
  // state.round directly, so this same logic works whether genId is being
  // built live (where state.round === genId-1 once the prior round is done)
  // or inside the full-schedule dry-run loop (where future rounds simply
  // won't find any real results yet and gracefully fall back to fairness-only).
  if(state.settings.winnerVsWinner && genId > 1){
    const lastGenMatches = state.matches.filter(m => m.generation === genId - 1);
    if(lastGenMatches.length){
      wvwApplied = true;
      const lastWinners = new Set(), lastLosers = new Set();
      lastGenMatches.forEach(m => {
        m.winners.forEach(id => lastWinners.add(id));
        m.losers.forEach(id => lastLosers.add(id));
      });

      // playingPlayers is already fairness-sorted; preserve that order within each bucket.
      const winnersGroup = playingPlayers.filter(p => lastWinners.has(p.id));
      const losersGroup  = playingPlayers.filter(p => lastLosers.has(p.id));
      const freshGroup   = playingPlayers.filter(p => !lastWinners.has(p.id) && !lastLosers.has(p.id)); // subbed in / previously sitting

      // Round each bucket up to a clean foursome multiple using the fairness-sorted "fresh" pool
      // (newcomers / former sit-outs) before resorting to splitting buckets apart.
      topUpToMultipleOf4(winnersGroup, freshGroup);
      topUpToMultipleOf4(losersGroup, freshGroup);

      matchups = matchups.concat(buildBalancedMatchups(winnersGroup));
      matchups = matchups.concat(buildBalancedMatchups(losersGroup));
      matchups = matchups.concat(buildBalancedMatchups(freshGroup));

      // Anyone left over (a bucket had an unresolvable remainder) gets matched directly.
      const consumed = new Set();
      matchups.forEach(m => { m.teamA.forEach(id=>consumed.add(id)); m.teamB.forEach(id=>consumed.add(id)); });
      const leftover = playingPlayers.filter(p => !consumed.has(p.id));
      matchups = matchups.concat(buildBalancedMatchups(leftover));
    }
  }

  if(!matchups.length){
    matchups = buildBalancedMatchups(playingPlayers);
  }

  const numCourts = clamp(parseInt(state.settings.numCourts,10)||1, 1, 10);
  const matches = matchups.map((m, idx) => ({
    id: uid('gm'),
    matchIndex: idx,
    teamA: m.teamA, teamB: m.teamB,
    scoreA: null, scoreB: null, winner: null, serving: 'A', serverNum: 1, firstServe: true,
    status: idx < numCourts ? 'active' : 'queued',
    court: idx < numCourts ? idx + 1 : null
  }));

  // Only players truly left out of every match this generation sit out / earn priority.
  // IMPORTANT: only players who were actually eligible for this generation's pool
  // (same filter as activePlayers()) should be touched here. Sub Players and anyone
  // Tired/Injured/Can't-Play were never in the running for a slot, so they must NOT
  // accrue sit-out priority while sidelined — otherwise they jump the queue with a
  // false head start the moment they're cleared back to Active, ahead of whoever
  // genuinely just sat out due to an odd-numbered headcount.
  const playingIds = new Set();
  matches.forEach(m => { m.teamA.forEach(id=>playingIds.add(id)); m.teamB.forEach(id=>playingIds.add(id)); });
  state.players.forEach(p => {
    if(!p.active || p.isSub || (p.condition||'ok')!=='ok') return;
    if(playingIds.has(p.id)){
      p.consecutiveSitOuts = 0; p.sitOutPriority = 0; p.waitingRounds = 0;
    } else {
      p.sitOuts++;
      p.consecutiveSitOuts = (p.consecutiveSitOuts||0) + 1;
      p.sitOutPriority = (p.sitOutPriority||0) + 5;
      p.waitingRounds = (p.waitingRounds||0) + 1;
    }
  });

  return {
    generation: genId,
    matches: matches,
    sittingOut: sittingPlayers.map(p => p.id),
    wvwApplied: wvwApplied // true only if winner/loser bucketing actually ran for this generation
  };
}

function _doGenerateRoundRobinGeneration(activeList) {
  if(!activeList) {
    activeList = activePlayers().slice();
    if(activeList.length < 4) { goToAddPlayer('Add a few more players to start — you need at least 4.'); return; }
  }

  const genId = state.round + 1;
  const gen = buildOneGeneration(activeList, genId);
  const numCourts = clamp(parseInt(state.settings.numCourts,10)||1, 1, 10);

  state.currentGeneration = gen;
  state.current = null;
  saveAll(); renderAll();
  toast(`Generation ${genId}: ${gen.matches.length} match${gen.matches.length===1?'':'es'} scheduled across ${Math.min(numCourts, gen.matches.length)} court${Math.min(numCourts, gen.matches.length)===1?'':'s'}.`, 'success');
}

// ============================================================
// ONE-TIME GENERATION — pre-builds EVERY round of the chosen session
// length right now, instead of one generation at a time. Each future
// round is built with the exact same fairness/balancing logic as the
// live flow (equal games played, sit-out rotation, smart balance), just
// run ahead of time in a dry-run loop. Winner-vs-winner bucketing can't
// apply to any round beyond the very next one, since there are no real
// results yet for rounds further out — buildOneGeneration() already
// degrades gracefully to fairness-only matchups in that case.
//
// Teammate/opponent VARIETY history is special-cased: while pre-building,
// each round's scheduled pairings are temporarily applied (as if played)
// so later rounds in the same schedule actually avoid repeating them —
// otherwise every dry-run round would look identical to the algorithm,
// since no real bumpPair() call happens until a match is truly confirmed.
// The real history is restored byte-for-byte once the loop finishes, so
// player profiles/stats only ever reflect games that have actually happened.
// ============================================================
function buildFullScheduleAndStart(activeList, totalMatches) {
  const perGen = matchesPerGeneration(activeList.length);
  const generationsNeeded = Math.max(1, Math.round(totalMatches / perGen));
  const startGenId = state.round + 1;

  const historySnapshot = new Map();
  state.players.forEach(p => historySnapshot.set(p.id, {
    teammates: deepClone(p.teammates || {}),
    opponents: deepClone(p.opponents || {})
  }));

  const allGenerations = [];
  for(let i = 0; i < generationsNeeded; i++){
    const genId = startGenId + i;
    const gen = buildOneGeneration(activeList, genId, { silent: true });
    allGenerations.push(gen);

    // Virtually "play" this round's pairings so the NEXT loop iteration's
    // variety scoring already knows about them — reverted after the loop.
    gen.matches.forEach(m => {
      const [a1, a2] = m.teamA, [b1, b2] = m.teamB;
      const pa1 = getPlayer(a1), pa2 = getPlayer(a2), pb1 = getPlayer(b1), pb2 = getPlayer(b2);
      if(pa1 && pa2){ bumpPair(pa1.teammates, a2); bumpPair(pa2.teammates, a1); }
      if(pb1 && pb2){ bumpPair(pb1.teammates, b2); bumpPair(pb2.teammates, b1); }
      [a1, a2].forEach(idA => [b1, b2].forEach(idB => {
        const plA = getPlayer(idA), plB = getPlayer(idB);
        if(plA && plB){ bumpPair(plA.opponents, idB); bumpPair(plB.opponents, idA); }
      }));
    });
  }

  // Restore real teammate/opponent history — none of the pairings above have
  // actually been played, so real history must stay exactly as it was; it
  // increments for real as each scheduled match is genuinely confirmed.
  state.players.forEach(p => {
    const snap = historySnapshot.get(p.id);
    if(snap){ p.teammates = snap.teammates; p.opponents = snap.opponents; }
  });

  state.currentGeneration = allGenerations.shift();
  state.scheduledGenerations = allGenerations;
  state.current = null;
  saveAll(); renderAll();
  toast(`Full schedule built: ${generationsNeeded} round${generationsNeeded!==1?'s':''}, ${totalMatches} matches total. Round 1 is up first.`, 'success');
}

// Court-count sanity check for the full-schedule path — mirrors
// proceedToGenerateGeneration()'s warning, but routes "Generate Anyway"
// into buildFullScheduleAndStart() instead of a single live generation.
function proceedToGenerateFullSchedule(activeList, totalMatches) {
  const numCourts = clamp(parseInt(state.settings.numCourts,10)||1, 1, 10);
  const possibleMatches = Math.floor(activeList.length / 4);
  if(possibleMatches < numCourts){
    const excess = numCourts - possibleMatches;
    const needed = numCourts * 4;
    const msg = possibleMatches === 1
      ? `⚠️ Only 1 match can be generated with ${activeList.length} active players — you need at least ${needed} players to fill ${numCourts} courts simultaneously. ${excess} court${excess>1?'s':''} will sit empty each generation.`
      : `⚠️ Only ${possibleMatches} match${possibleMatches!==1?'es':''} can be generated with ${activeList.length} active players — ${numCourts} courts set but only ${possibleMatches} team${possibleMatches!==1?'s':''} formed. Need ${needed} players for full ${numCourts}-court play.`;
    openModal(`
      <div class="modal-title" style="color:var(--ball);">⚠️ Court Count Notice</div>
      <div class="modal-sub" style="line-height:1.7; font-size:13.5px;">${msg}</div>
      <div class="modal-actions" style="margin-top:16px;">
        <button class="btn btn-ghost" data-action="modal-close">Cancel</button>
        <button class="btn btn-primary" data-action="do-generate-full-schedule" data-total="${totalMatches}">Generate Anyway</button>
      </div>
    `);
    return;
  }
  buildFullScheduleAndStart(activeList, totalMatches);
}

// Pulls the next pre-built generation off the schedule (if a full schedule
// was generated up front) and activates it as the live currentGeneration.
// Returns true if it advanced from the schedule, false if there's nothing
// pre-built and the caller should build the next generation live instead.
// Also guards against a stale schedule: if the active roster has changed
// since the schedule was built (someone added/removed/paused), the rest of
// the pre-built plan no longer matches who's actually here, so it's dropped
// and play falls back to building each remaining generation live.
function advanceToNextGeneration() {
  if(!Array.isArray(state.scheduledGenerations) || !state.scheduledGenerations.length) return false;
  const next = state.scheduledGenerations[0];
  const stillActiveIds = new Set(activePlayers().map(p => p.id));
  const rosterStillMatches = next.matches.every(m =>
    m.teamA.every(id => stillActiveIds.has(id)) && m.teamB.every(id => stillActiveIds.has(id))
  );
  if(!rosterStillMatches){
    state.scheduledGenerations = [];
    toast('Active roster changed since the full schedule was built — building the next round live instead.', 'info');
    return false;
  }
  state.scheduledGenerations = state.scheduledGenerations.slice(1);
  state.currentGeneration = next;
  saveAll(); renderAll();
  return true;
}

// Lists EVERY round of the current Round Robin session — the live one plus
// anything still pre-built and waiting — so the organizer can see the whole
// plan at a glance (courts, matchups, and who sits out each round).
function showFullScheduleModal(){
  const allGens = [state.currentGeneration].concat(state.scheduledGenerations || []).filter(Boolean);
  if(!allGens.length){ toast('No schedule to show yet.', 'info'); return; }

  const plan = state.settings.sessionPlan;
  const allMatches = allGens.flatMap(g => g.matches);
  const totalMatches = allMatches.length;
  const playedCount = allMatches.filter(m => m.status === 'done').length;
  const playerIds = new Set();
  allMatches.forEach(m => { m.teamA.forEach(id => playerIds.add(id)); m.teamB.forEach(id => playerIds.add(id)); });
  const pct = totalMatches ? Math.round((playedCount / totalMatches) * 100) : 0;

  function buildScheduleRows(){
    return allGens.map(gen => {
      const genMatches = gen.matches.slice().sort((a,b) => a.matchIndex - b.matchIndex);
      const genPlayed = genMatches.filter(m => m.status === 'done').length;
      const rows = genMatches.map(m => {
        const isQueued = m.status === 'queued';
        const isActive = m.status === 'active';
        const isDone   = m.status === 'done';

        // For queued or active (not-yet-started) matches: render each player as a tappable chip
        const canSwap = isQueued || (isActive && !hasMatchStarted(m));
        function playerChip(id, team, slot){
          const p = getPlayer(id);
          const name = p ? esc(p.name) : '—';
          if(canSwap){
            return `<button class="sched-player-chip" data-action="sched-replace-player"
              data-match-id="${m.id}" data-gen="${gen.generation}" data-team="${team}" data-slot="${slot}"
              title="Tap to replace ${p ? p.name : '?'}">${name} <span class="sched-chip-edit"><svg viewBox="0 0 12 12" width="10" height="10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8.5 1.5L10.5 3.5L4 10H2V8L8.5 1.5Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg></span></button>`;
          }
          return `<span>${name}</span>`;
        }

        const statusHtml = isDone
          ? `<span class="sched-pill sched-pill-played">✓ Played</span>${m.scoreA!=null ? `<span class="sched-score">${m.scoreA}–${m.scoreB}</span>` : ''}`
          : isActive
            ? `<span class="sched-pill sched-pill-live">🎾 Court ${m.court}</span>`
            : `<span class="sched-pill sched-pill-queued">⏳ Queued</span>`;

        return `
          <div class="sched-match">
            <div class="sched-match-num">#${m.matchIndex + 1}</div>
            <div class="sched-match-body">
              <div class="sched-match-teams">
                <div class="sched-team-row">
                  ${playerChip(m.teamA[0],'A',0)}
                  <span class="sched-team-amp">&amp;</span>
                  ${playerChip(m.teamA[1],'A',1)}
                </div>
                <div class="sched-vs-divider"><span class="sched-vs-label">vs</span></div>
                <div class="sched-team-row">
                  ${playerChip(m.teamB[0],'B',0)}
                  <span class="sched-team-amp">&amp;</span>
                  ${playerChip(m.teamB[1],'B',1)}
                </div>
              </div>
              ${canSwap ? `<div class="sched-match-hint">Tap a name to swap player</div>` : (isActive ? `<div class="sched-match-hint" style="color:var(--text-faint);">Scoring started — can't swap mid-match</div>` : '')}
            </div>
            <div class="sched-status">${statusHtml}</div>
          </div>`;
      }).join('');

      const sittingNames = (gen.sittingOut || []).map(id => esc(playerName(id))).join(', ');
      return `
        <div class="sched-round">
          <div class="sched-round-head">
            <span class="rt">Round ${gen.generation}</span>
            <span class="rc">${genPlayed}/${genMatches.length} played</span>
          </div>
          <div class="sched-card">
            ${rows}
            ${sittingNames ? `<div class="sched-sitting">🪑 <b>Sitting out:</b> ${sittingNames}</div>` : ''}
          </div>
        </div>`;
    }).join('');
  }

  openModal(`
    <div class="modal-title">📋 Full Session Schedule</div>
    <div class="modal-sub" style="line-height:1.6;">${plan ? esc(plan.label) : 'Custom schedule'} — every round, planned up front. Tap any player name in a <b style="color:var(--court); background:rgba(79,168,255,0.1); padding:1px 5px; border-radius:4px;">⏳ Queued</b> match to swap them out.</div>

    <div class="sched-summary">
      <div class="s-item"><div class="n">${totalMatches}</div><div class="l">Matches</div></div>
      <div class="s-item"><div class="n">${allGens.length}</div><div class="l">Round${allGens.length!==1?'s':''}</div></div>
      <div class="s-item"><div class="n">${playerIds.size}</div><div class="l">Player${playerIds.size!==1?'s':''}</div></div>
      <div class="s-item"><div class="n">${state.settings.numCourts||1}</div><div class="l">Court${(state.settings.numCourts||1)!==1?'s':''}</div></div>
    </div>

    <div class="session-progress-wrap">
      <div class="session-progress-track"><div class="session-progress-fill" style="width:${pct}%;"></div></div>
      <div class="session-progress-label"><span>${playedCount} of ${totalMatches} played</span><span>${pct}%</span></div>
    </div>

    <div id="schedBodyWrap" style="max-height:55vh; overflow-y:auto; margin-top:16px; padding-right:2px;">
      ${buildScheduleRows()}
    </div>
    <div class="modal-actions" style="margin-top:16px; flex-direction:column; gap:8px;">
      <button class="btn btn-secondary btn-block" data-action="download-full-schedule-poster">🖨️ Download / Print Schedule Poster</button>
      <button class="btn btn-primary btn-block" data-action="modal-close">Close</button>
    </div>
  `);
}

// Opens a second sheet to pick a replacement for a player in a queued scheduled match.
function openSchedReplaceModal(matchId, genNum, team, slot){
  // Remember how far down the schedule list we'd scrolled, so we can
  // restore it after the swap instead of snapping back to the top.
  const wrapEl = document.getElementById('schedBodyWrap');
  if(wrapEl) window._schedScrollTop = wrapEl.scrollTop;

  // Find the match across currentGeneration + scheduledGenerations
  const allGens = [state.currentGeneration].concat(state.scheduledGenerations || []).filter(Boolean);
  const gen = allGens.find(g => g.generation === parseInt(genNum, 10));
  if(!gen){ toast('Generation not found.', 'warning'); return; }
  const m = gen.matches.find(x => x.id === matchId);
  const canSwap = m && (m.status === 'queued' || (m.status === 'active' && !hasMatchStarted(m)));
  if(!m || !canSwap){ toast(m && m.status === 'active' ? "Can't swap players once scoring has started." : 'Can only swap players in queued or not-yet-started matches.', 'warning'); return; }

  const outId = team === 'A' ? m.teamA[parseInt(slot,10)] : m.teamB[parseInt(slot,10)];
  const outPlayer = getPlayer(outId);

  // All 4 players currently in this match (to exclude from picker)
  const inMatchIds = new Set([...m.teamA, ...m.teamB]);

  // Find anyone else already playing in *this same round* — not to exclude
  // them, but to flag them, since picking one will pull them out of their
  // other match (a straight position swap) to keep the round consistent.
  const busyThisRoundMap = new Map(); // playerId -> { match, team, slot }
  gen.matches.forEach(other => {
    if(other.id === m.id || other.status === 'done') return;
    other.teamA.forEach((id, i) => busyThisRoundMap.set(id, { match: other, team: 'A', slot: i }));
    other.teamB.forEach((id, i) => busyThisRoundMap.set(id, { match: other, team: 'B', slot: i }));
  });

  // Build candidate list: every checked-in player except the 3 already in
  // this match. Players busy elsewhere this round are included but flagged —
  // picking one swaps them out of their other slot automatically.
  const candidates = state.players
    .filter(p => p.active && !inMatchIds.has(p.id))
    .sort((a,b) => a.name.localeCompare(b.name));

  if(!candidates.length){
    toast('No other checked-in players available to swap in.', 'warning');
    return;
  }

  const listHtml = candidates.map(p => {
    const busy = busyThisRoundMap.get(p.id);
    const busyNote = busy
      ? `<span style="font-size:11px; color:var(--court);">Court ${busy.match.matchIndex + 1} this round — will swap</span>`
      : `<span style="font-size:11px; color:var(--text-faint);">DUPR ${duprStr(p)} · ELO ${p.rating}</span>`;
    return `
    <button class="btn btn-secondary btn-block" style="margin-top:6px; justify-content:space-between; text-align:left;"
      data-action="sched-do-replace" data-match-id="${matchId}" data-gen="${genNum}"
      data-team="${team}" data-slot="${slot}" data-new-id="${p.id}">
      <span>${esc(p.name)}</span>
      ${busyNote}
    </button>`;
  }).join('');

  openModal(`
    <div class="modal-title">Swap Player</div>
    <div class="modal-sub">Replacing <b style="color:var(--loss);">${esc(outPlayer?.name || '—')}</b> in Match #${m.matchIndex + 1} (${team === 'A' ? 'Team A' : 'Team B'}). Pick a replacement:</div>
    <div style="max-height:52vh; overflow-y:auto; padding-bottom:4px;">
      ${listHtml}
    </div>
    <div class="modal-actions" style="margin-top:12px;">
      <button class="btn btn-ghost btn-block" data-action="sched-back-to-schedule">← Back to Schedule</button>
    </div>
  `);
}

// Executes the swap in state, then refreshes the schedule view.
function schedDoReplace(matchId, genNum, team, slot, newId){
  const allGens = [state.currentGeneration].concat(state.scheduledGenerations || []).filter(Boolean);
  const gen = allGens.find(g => g.generation === parseInt(genNum, 10));
  if(!gen) return;
  const m = gen.matches.find(x => x.id === matchId);
  const canSwap = m && (m.status === 'queued' || (m.status === 'active' && !hasMatchStarted(m)));
  if(!m || !canSwap){ toast("Can only edit queued or not-yet-started matches.", 'warning'); return; }

  const slotIdx = parseInt(slot, 10);
  const oldId = team === 'A' ? m.teamA[slotIdx] : m.teamB[slotIdx];

  // If the incoming player is already playing in another match this same
  // round, pull them out of that slot and put the outgoing player there
  // instead — a clean position swap, so the round stays fully staffed
  // instead of leaving a hole.
  let displacedFrom = null;
  let displaceBlocked = false;
  gen.matches.forEach(other => {
    if(other.id === m.id || other.status === 'done' || displacedFrom || displaceBlocked) return;
    const idxA = other.teamA.indexOf(newId);
    const idxB = idxA === -1 ? other.teamB.indexOf(newId) : -1;
    if(idxA === -1 && idxB === -1) return;
    if(other.status === 'active' && hasMatchStarted(other)){
      // That match is already underway — can't pull a player out mid-score.
      displaceBlocked = true;
      return;
    }
    if(idxA !== -1){ other.teamA[idxA] = oldId; displacedFrom = other; }
    else { other.teamB[idxB] = oldId; displacedFrom = other; }
  });

  if(displaceBlocked){
    toast("That player's other match has already started scoring — can't swap them out of it.", 'warning');
    return;
  }

  if(team === 'A') m.teamA[slotIdx] = newId;
  else             m.teamB[slotIdx] = newId;

  // If this match is also the live "current" match (Rotation mode pointer),
  // keep that mirror in sync so the live scoreboard reflects the swap too.
  if(state.current && state.current.id === m.id){
    if(team === 'A') state.current.teamA[slotIdx] = newId;
    else             state.current.teamB[slotIdx] = newId;
  }

  saveAll();
  if(displacedFrom){
    toast(`${playerName(oldId)} ↔ ${playerName(newId)} swapped between Match #${m.matchIndex + 1} and Match #${displacedFrom.matchIndex + 1}.`, 'success');
  } else {
    toast(`${playerName(oldId)} → ${playerName(newId)} in Match #${m.matchIndex + 1}.`, 'success');
  }

  // The "Swap Player" sub-sheet replaced the schedule modal's DOM, so
  // reopen the schedule view and restore the scroll position we had before
  // the swap — keeps it from jumping back to the top after every edit.
  showFullScheduleModal();
  const savedTop = window._schedScrollTop;
  if(savedTop){
    requestAnimationFrame(() => {
      const wrap = document.getElementById('schedBodyWrap');
      if(wrap) wrap.scrollTop = savedTop;
    });
  }
}

// Builds a standalone, print-friendly HTML "poster" of the whole session
// schedule — light background (so it doesn't waste ink), large readable
// type, a blank line next to each match for writing the final score by
// hand, and a court board organizers can tape up at the venue. Opens in a
// new tab with a Print button (and auto-triggers the print dialog so
// "Save as PDF" is one tap away); falls back to a direct file download if
// the popup gets blocked by the browser.
function downloadFullSchedulePoster(customTitle, paperSize){
  const allGens = [state.currentGeneration].concat(state.scheduledGenerations || []).filter(Boolean);
  if(!allGens.length){ toast('No schedule to print yet.', 'info'); return; }

  // If no custom title passed yet, show a prompt modal first
  if(customTitle === undefined){
    const plan = state.settings.sessionPlan;
    const defaultTitle = (plan && plan.label) ? plan.label : 'Pickleball Session';
    openModal(`
      <div class="modal-title">Download Schedule</div>
      <div class="modal-sub">Set your tournament title and paper size before printing.</div>
      <div class="field" style="margin-bottom:10px;">
        <label>Tournament Title</label>
        <input type="text" id="tournamentTitleInput" value="${esc(defaultTitle)}" placeholder="e.g. Sunday Open Play">
      </div>
      <div class="field" style="margin-bottom:4px;">
        <label>Paper / Poster Size</label>
        <div style="display:flex; flex-direction:column; gap:7px; margin-top:2px;">
          <label style="display:flex; align-items:flex-start; gap:10px; cursor:pointer; background:var(--surface-2); border:1px solid var(--line); border-radius:var(--radius-sm); padding:10px 12px;">
            <input type="radio" name="ppSize" value="letter" checked style="margin-top:2px; accent-color:var(--court);">
            <span>
              <span style="font-weight:700; font-size:13.5px;">Letter (8.5×11 in)</span>
              <span style="display:block; font-size:11.5px; color:var(--text-faint); margin-top:1px;">Standard US paper — good for up to ~8 players</span>
            </span>
          </label>
          <label style="display:flex; align-items:flex-start; gap:10px; cursor:pointer; background:var(--surface-2); border:1px solid var(--line); border-radius:var(--radius-sm); padding:10px 12px;">
            <input type="radio" name="ppSize" value="legal" style="margin-top:2px; accent-color:var(--court);">
            <span>
              <span style="font-weight:700; font-size:13.5px;">Legal (8.5×14 in)</span>
              <span style="display:block; font-size:11.5px; color:var(--text-faint); margin-top:1px;">More rows per page — fits ~12 players comfortably</span>
            </span>
          </label>
          <label style="display:flex; align-items:flex-start; gap:10px; cursor:pointer; background:var(--surface-2); border:1px solid var(--line); border-radius:var(--radius-sm); padding:10px 12px;">
            <input type="radio" name="ppSize" value="A4" style="margin-top:2px; accent-color:var(--court);">
            <span>
              <span style="font-weight:700; font-size:13.5px;">A4 (210×297 mm)</span>
              <span style="display:block; font-size:11.5px; color:var(--text-faint); margin-top:1px;">International standard — similar to Letter</span>
            </span>
          </label>
          <label style="display:flex; align-items:flex-start; gap:10px; cursor:pointer; background:var(--surface-2); border:1px solid var(--line); border-radius:var(--radius-sm); padding:10px 12px;">
            <input type="radio" name="ppSize" value="tabloid" style="margin-top:2px; accent-color:var(--court);">
            <span>
              <span style="font-weight:700; font-size:13.5px;">Tabloid / Poster (11×17 in)</span>
              <span style="display:block; font-size:11.5px; color:var(--text-faint); margin-top:1px;">Large poster format — best for big tournaments, wall posting</span>
            </span>
          </label>
        </div>
      </div>
      <div class="modal-actions" style="margin-top:14px;">
        <button class="btn btn-ghost" data-action="modal-close">Cancel</button>
        <button class="btn btn-primary" data-action="do-download-schedule-poster">Download Schedule</button>
      </div>
    `);
    setTimeout(() => {
      const inp = document.getElementById('tournamentTitleInput');
      if(inp){
        inp.focus(); inp.select();
        inp.addEventListener('keydown', e => {
          if(e.key === 'Enter'){
            const title = inp.value.trim() || 'Pickleball Session';
            const sizeEl = document.querySelector('input[name="ppSize"]:checked');
            const size = sizeEl ? sizeEl.value : 'letter';
            closeModal();
            downloadFullSchedulePoster(title, size);
          }
        });
      }
    }, 80);
    return;
  }

  const plan = state.settings.sessionPlan;
  const allMatches = allGens.flatMap(g => g.matches);
  const totalMatches = allMatches.length;
  const playerIds = new Set();
  allMatches.forEach(m => { m.teamA.forEach(id => playerIds.add(id)); m.teamB.forEach(id => playerIds.add(id)); });
  const dateStr = new Date().toLocaleDateString(undefined, { year:'numeric', month:'long', day:'numeric' });

  const roundsHtml = allGens.map(gen => {
    const genMatches = gen.matches.slice().sort((a,b) => a.matchIndex - b.matchIndex);
    const rows = genMatches.map(m => {
      const a1 = esc(playerName(m.teamA[0])), a2 = esc(playerName(m.teamA[1]));
      const b1 = esc(playerName(m.teamB[0])), b2 = esc(playerName(m.teamB[1]));
      const courtLabel = m.court ? `Court ${m.court}` : '—';
      return `<tr>
        <td class="pp-num">${m.matchIndex + 1}</td>
        <td class="pp-court">${courtLabel}</td>
        <td class="pp-teams"><span class="pp-team">${a1} &amp; ${a2}</span><span class="pp-vs">vs</span><span class="pp-team">${b1} &amp; ${b2}</span></td>
        <td class="pp-score">
          <div class="pp-scorebox">
            <div class="pp-scorebox-side"><span class="lbl">A</span><span class="box"></span></div>
            <span class="dash">–</span>
            <div class="pp-scorebox-side"><span class="lbl">B</span><span class="box"></span></div>
          </div>
        </td>
      </tr>`;
    }).join('');
    const sittingNames = (gen.sittingOut || []).map(id => esc(playerName(id))).join(', ');
    return `
      <section class="pp-round">
        <h2>Round ${gen.generation}</h2>
        <table class="pp-table">
          <thead><tr><th>#</th><th>Court</th><th>Matchup</th><th>Score</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${sittingNames ? `<div class="pp-sitting">Sitting out: ${sittingNames}</div>` : ''}
      </section>`;
  }).join('');

  const pageSizeMap = {
    letter:  'letter portrait',
    legal:   'legal portrait',
    A4:      'A4 portrait',
    tabloid: 'tabloid portrait'
  };
  const pageSize = pageSizeMap[paperSize] || 'letter portrait';

  const posterHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<title>Maezku Ladder — Full Schedule</title>
<style>
  @page{ size:${pageSize}; margin:0.5in; }
  *{box-sizing:border-box;}
  body{font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#111; margin:0; padding:28px; background:#fff;}
  .pp-print-bar{ text-align:center; margin-bottom:22px; }
  .pp-print-bar button{ font-size:14px; font-weight:700; padding:10px 22px; border-radius:8px; border:none; background:#111; color:#fff; cursor:pointer; }
  .pp-header{ text-align:center; border-bottom:3px solid #111; padding-bottom:14px; margin-bottom:18px; }
  .pp-header h1{ font-size:30px; margin:0 0 4px; letter-spacing:0.02em; }
  .pp-header .sub{ font-size:13px; color:#555; }
  .pp-meta{ display:flex; justify-content:center; gap:28px; margin-top:12px; font-size:11px; color:#444; flex-wrap:wrap; text-transform:uppercase; letter-spacing:.04em; }
  .pp-meta b{ font-size:17px; display:block; color:#111; letter-spacing:0; text-transform:none; }
  .pp-round{ margin-bottom:24px; page-break-inside:avoid; }
  .pp-round h2{ font-size:16px; margin:0 0 8px; background:#111; color:#fff; display:inline-block; padding:4px 14px; border-radius:4px; }
  table.pp-table{ width:100%; border-collapse:collapse; font-size:13px; border-spacing:0; }
  table.pp-table th{ text-align:left; border-bottom:2px solid #111; padding:6px 8px; font-size:10.5px; text-transform:uppercase; letter-spacing:.04em; color:#444; }
  table.pp-table td{ padding:9px 8px; border-bottom:1px solid #ddd; vertical-align:middle; }
  table.pp-table tr{ page-break-inside:avoid; break-inside:avoid; }
  .pp-num{ font-weight:700; width:28px; color:#555; }
  .pp-court{ width:70px; color:#555; }
  .pp-teams{ font-weight:600; }
  .pp-team{ white-space:nowrap; }
  .pp-vs{ color:#aaa; margin:0 8px; font-weight:400; font-size:11px; text-transform:uppercase; }
  .pp-score{ width:110px; }
  .pp-scorebox{ display:flex; align-items:flex-end; justify-content:center; gap:7px; }
  .pp-scorebox-side{ display:flex; flex-direction:column; align-items:center; gap:3px; }
  .pp-scorebox-side .lbl{ font-size:8px; color:#999; text-transform:uppercase; letter-spacing:.06em; font-weight:700; }
  .pp-scorebox .box{ width:30px; height:26px; border:1.5px solid #111; border-radius:4px; background:#fff; }
  .pp-scorebox .dash{ color:#bbb; font-weight:700; padding-bottom:5px; }
  .pp-sitting{ font-size:11.5px; color:#777; margin-top:6px; padding-left:2px; }
  .pp-footer{ margin-top:30px; text-align:center; font-size:11px; color:#999; border-top:1px solid #ddd; padding-top:10px; }
  @media print{ .pp-print-bar{ display:none; } body{ padding:0; } .pp-scorebox .box{ border-color:#000; } }
</style>
</head>
<body>
  <div class="pp-print-bar"><button onclick="window.print()">🖨️ Print / Save as PDF</button></div>
  <div class="pp-header">
    <h1>🏆 ${esc(customTitle)}</h1>
    <div class="sub">Maezku Ladder — Generated ${dateStr} · ${paperSize ? paperSize.toUpperCase() : 'LETTER'}</div>
    <div class="pp-meta">
      <div><b>${totalMatches}</b>Matches</div>
      <div><b>${allGens.length}</b>Round${allGens.length!==1?'s':''}</div>
      <div><b>${playerIds.size}</b>Players</div>
      <div><b>${state.settings.numCourts||1}</b>Court${(state.settings.numCourts||1)!==1?'s':''}</div>
    </div>
  </div>
  ${roundsHtml}
  <div class="pp-footer">Maezku Ladder · Pickleball 2v2 Matchmaker</div>
</body></html>`;

  const blob = new Blob([posterHtml], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  if(!win){
    const a = document.createElement('a');
    a.href = url;
    a.download = `kitchen-ladder-schedule-${Date.now()}.html`;
    document.body.appendChild(a); a.click(); a.remove();
    toast('Pop-up blocked — downloaded the schedule as a file instead. Open it and tap Print.', 'info');
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Pulls the next queued match(es) onto any court that just freed up.
function advanceRRQueue(){
  const gen = state.currentGeneration;
  if(!gen) return;
  const numCourts = clamp(parseInt(state.settings.numCourts,10)||1, 1, 10);
  const usedCourts = new Set(gen.matches.filter(m => m.status === 'active').map(m => m.court));
  const queued = gen.matches.filter(m => m.status === 'queued').sort((a,b) => a.matchIndex - b.matchIndex);
  for(let c = 1; c <= numCourts && queued.length; c++){
    if(usedCourts.has(c)) continue;
    const next = queued.shift();
    next.status = 'active';
    next.court = c;
  }
}

// ============================================================
// LIVE-SCORING ENGINE — shared by Round Robin (one match per court,
// looked up by id out of gen.matches) and Rotation (the single
// state.current match). Both modes score a match identically —
// steppers, manual entry, winner buttons, serve tracking, Race to
// 2 — the only real difference is WHERE the match object lives and
// which DOM nodes represent it on screen. This tiny context object
// captures that difference so every rule below is written exactly
// once instead of twice.
// ============================================================
function liveMatchCtx(mode, matchId){
  if(mode === 'rotation-court'){
    const courtId = matchId;
    return {
      mode, matchId: courtId,
      getMatch(){ return Array.isArray(state.rotationCourts) ? state.rotationCourts.find(c => c.id === courtId) : null; },
      scoreInput(team){ return document.querySelector(`input[data-court-score="${courtId}-${team}"]`); },
      winBtn(team){ return document.querySelector(`.csop-win-btn[data-court="${courtId}"][data-team="${team}"]`); },
      render(){ renderActiveView(); }
    };
  }
  if(mode === 'rr'){
    return {
      mode, matchId,
      getMatch(){ const gen = state.currentGeneration; return gen && gen.matches.find(x => x.id === matchId); },
      scoreInput(team){ return document.querySelector(`input[data-match-score="${matchId}-${team}"]`); },
      winBtn(team){ return document.querySelector(`.sb-winbtn[data-match="${matchId}"][data-team="${team}"]`); },
      render(){ renderMatchView(document.getElementById('view')); }
    };
  }
  return {
    mode: 'rotation', matchId: null,
    getMatch(){ return state.current; },
    scoreInput(team){ return document.getElementById(team === 'A' ? 'scoreA' : 'scoreB'); },
    winBtn(team){ return document.getElementById(team === 'A' ? 'rotationWinBtnA' : 'rotationWinBtnB'); },
    render(){ renderMatchView(document.getElementById('view')); }
  };
}

// Holds the pending winner selection while the confirmation modal is open,
// since the modal's "Confirm" button is rendered as HTML (via data-action
// dispatch) and can't close over `ctx`/`winningTeam` directly.
let _pendingWinnerConfirm = null;

// Shows a confirmation modal before locking in a winner, to prevent mis-taps.
// Calls selectMatchWinner after user confirms (see 'do-confirm-winner' in the
// action dispatcher).
function confirmSelectWinner(ctx, winningTeam) {
  const m = ctx.getMatch();
  if (!m || m.status === 'done') return;

  // If flipping an existing winner selection just do it immediately — they
  // already confirmed once; this is a correction, not a first-time pick.
  if (m.winner && m.winner !== winningTeam) {
    selectMatchWinner(ctx, winningTeam);
    return;
  }

  // Build team display names for the modal
  const teamKey = winningTeam === 'A' ? 'teamA' : 'teamB';
  const ids = m[teamKey] || [];
  const names = ids.map(id => esc(playerName(id))).join(' &amp; ') || ('Team ' + winningTeam);
  const teamLabel = winningTeam === 'A' ? 'Team A' : 'Team B';
  const teamColor = winningTeam === 'A' ? 'var(--ball)' : 'var(--court)';

  _pendingWinnerConfirm = { ctx, winningTeam };

  openModal(`
    <div class="modal-title">Confirm Winner?</div>
    <div class="modal-sub" style="line-height:1.6;">
      <span style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${teamColor};">${teamLabel}</span><br>
      <strong style="color:var(--text);font-size:17px;">${names}</strong>
    </div>
    <div class="modal-actions" style="margin-top:16px;">
      <button class="btn btn-ghost" data-action="modal-close">Cancel</button>
      <button class="btn btn-primary" data-action="do-confirm-winner">🏆 Confirm Win</button>
    </div>
  `, false);
}

// Tapping a "Team X Wins" button: locks in the winner, and snaps the
// scoreline to a valid winning score if it hasn't gotten there yet (or
// swaps the scores back if the selection is being flipped to the other team).
function selectMatchWinner(ctx, winningTeam){
  const m = ctx.getMatch();
  if(!m || m.status === 'done') return;
  const previousWinner = m.winner;
  m.winner = winningTeam;

  if(previousWinner && previousWinner !== winningTeam){
    // Flipping the winner selection — swap the two scores too, so they stay
    // attached to the correct team instead of being left on the old winner.
    const tmp = m.scoreA;
    m.scoreA = m.scoreB;
    m.scoreB = tmp;
  } else {
    // Make sure the scoreline actually reflects the team just marked as the
    // winner. Covers both: no score entered yet (both null), AND marking a
    // winner directly while the score is still in progress and hasn't
    // reached the winning score (e.g. stepping to 5-3 with the +/- buttons,
    // then tapping "Team A Wins" directly instead of playing it out) —
    // previously the scores were left untouched in that case, even when they
    // didn't actually support the team that was just selected as the winner.
    let winScore = winningTeam === 'A' ? m.scoreA : m.scoreB;
    let loseScore = winningTeam === 'A' ? m.scoreB : m.scoreA;
    const target = getMatchWinTarget(m);
    const requireMargin = !m.raceActive; // Race to 2 is sudden-death — no win-by-2 margin
    if(loseScore === null || isNaN(loseScore)) loseScore = Math.max(0, target - 3);
    if(winScore === null || isNaN(winScore) || winScore < target){
      // The winning team hasn't actually reached the winning score yet —
      // award them exactly the configured winning score (e.g. 11), and cap
      // the opponent's score so the margin rule holds. Previously this fell
      // through to `loseScore + 2`, which meant a high opponent score (e.g.
      // 10 or 11) inflated the winner's score to 12 or 13 instead of the
      // winning score that was actually configured.
      winScore = target;
      if(requireMargin) loseScore = Math.min(loseScore, target - 2);
    } else if(requireMargin && winScore - loseScore < 2){
      // The winner's score already reached/passed the winning score, but the
      // margin isn't satisfied (a genuine deuce) — extend minimally from the
      // scores actually on the board, never below what's already there.
      winScore = Math.max(winScore, loseScore + 2);
    }
    if(winningTeam === 'A'){ m.scoreA = winScore; m.scoreB = loseScore; }
    else { m.scoreB = winScore; m.scoreA = loseScore; }
  }

  saveAll();
  ctx.render();
}

// Updates a scoreboard's "Team A/B Wins" buttons in place after an
// auto-detected winner, without a full re-render (which would yank focus
// away from whichever score input the user is still typing in).
function syncWinnerButtons(ctx){
  const m = ctx.getMatch();
  if(!m) return;
  const btnA = ctx.winBtn('A'), btnB = ctx.winBtn('B');
  if(!btnA || !btnB) return;
  const aWin = m.winner === 'A', bWin = m.winner === 'B';
  btnA.classList.toggle('btn-primary', aWin);
  btnA.classList.toggle('btn-secondary', !aWin);
  btnA.textContent = aWin ? '✓ Winner Selected' : 'Team A Wins';
  btnB.classList.toggle('btn-primary', bWin);
  btnB.classList.toggle('btn-secondary', !bWin);
  btnB.textContent = bWin ? '✓ Winner Selected' : 'Team B Wins';
}

// Recomputes the winner from scratch from whatever scores are currently on
// the board: first team to reach the winning score (with a 2-point margin)
// wins, or just first-to-2 once a Race to 2 is active. If neither side
// currently meets that — including a tie at the winning score — this
// returns null, so a stale winner selection can't linger once the scores
// no longer support it.
function detectWinner(m){
  const target = getMatchWinTarget(m);
  const winsIt = m.raceActive
    ? (s) => s !== null && s >= target
    : (s, o) => s !== null && s >= target && s - (o === null ? 0 : o) >= 2;
  if(winsIt(m.scoreA, m.scoreB)) return 'A';
  if(winsIt(m.scoreB, m.scoreA)) return 'B';
  return null;
}

// Manual score entry — typing directly into the score box.
function updateMatchScore(ctx, team, val){
  const m = ctx.getMatch();
  if(!m || m.status === 'done') return;
  let num = val === '' ? null : parseInt(val, 10);
  if(num !== null && !isNaN(num)){
    const maxScore = getMatchWinTarget(m);
    num = Math.min(maxScore, Math.max(0, num));
    // Reflect clamped value back and strip leading zeroes
    const el = ctx.scoreInput(team);
    if(el) el.value = num;
  }
  if(team === 'A') m.scoreA = (num === null || isNaN(num)) ? null : num;
  else m.scoreB = (num === null || isNaN(num)) ? null : num;

  const autoWinner = detectWinner(m);
  if(m.winner !== autoWinner){
    m.winner = autoWinner;
    syncWinnerButtons(ctx); // update buttons in place, keeps the score input focused
  }

  saveAll();
  maybeOfferRaceToTwo(m, ctx.mode, ctx.matchId);
}

// ============================================================
// SERVE-DECISION UNDO (separate from the match-level "Undo Last Match")
// ------------------------------------------------------------
// Captures who's serving / server number / first-serve flag right before
// each serve-changing action (picking the 1st server, switching to serve 2,
// side-out), pushing onto a per-match stack so ANY number of past serve
// decisions can be unwound, one at a time, oldest-last. Undoing always asks
// for confirmation first since it can't be redone. None of this touches the
// score or rolls back an entire confirmed match — that's the separate
// "Undo Last Match" button.
// ============================================================
function snapshotServe(obj){
  return { serving: obj.serving, serverNum: obj.serverNum, firstServe: obj.firstServe };
}
function restoreServe(obj, snap){
  obj.serving = snap.serving;
  obj.serverNum = snap.serverNum;
  obj.firstServe = snap.firstServe;
}
function pushServeUndo(obj){
  if(!Array.isArray(obj._serveUndoStack)) obj._serveUndoStack = [];
  obj._serveUndoStack.push(snapshotServe(obj));
}

// Determines the score a match needs to reach to win: 2 (sudden-death, no
// margin required) once a Race to 2 has been accepted for this match, or
// the configured winning score (default 11) otherwise.
function getMatchWinTarget(m){
  return (m && m.raceActive) ? 2 : (state.settings.winningScore || 11);
}

// True once any point has actually been scored on this match — used to lock
// out Skip/Forfeit so neither one can wipe a match that's already underway.
// raceActive counts as "started" too: scores reset to 0-0 when a Race to 2
// begins, but the teams already played a full game to get to 10-10 first.
function hasMatchStarted(m){
  if(!m) return false;
  if(m.raceActive) return true;
  return safeScore(m.scoreA) > 0 || safeScore(m.scoreB) > 0;
}

// Voice announcer for score milestones — called only when a point is
// actually scored (never on a manual correction). Reaching the match's win
// target calls out a win with congratulations; every other score (including
// 10, "Love") gets the normal score call, since scoreCallText already
// handles the "Love" wording for any score of 10.
function speakScoreOrMilestone(m, scoringTeamScore){
  if(scoringTeamScore === getMatchWinTarget(m)){
    speakUtterance('Congratulations!', true);
  } else {
    speakScoreCall(m);
  }
}

// ============================================================
// OPTIONAL "RACE TO 2" — when both teams reach 10-10 ("Love-Love"), and the
// feature is enabled in Settings, offer to settle the match with a sudden-
// death race to 2 instead of continuing to the configured winning score.
// Works for both Round Robin matches and the Rotation-mode current match —
// both share the same { scoreA, scoreB, raceOffered, raceActive } shape.
// Only ever offered once per match (raceOffered latches true on the first
// 10-10), regardless of which answer is given.
// ============================================================
function maybeOfferRaceToTwo(m, mode, matchId){
  if(!m || !state.settings.raceToTwo) return;
  if(m.raceOffered || m.raceActive) return;
  if(safeScore(m.scoreA) === 10 && safeScore(m.scoreB) === 10){
    // Latch raceOffered only after the user answers — if they dismiss via
    // Escape without choosing, the modal closes silently and the offer
    // should NOT re-appear on the very next point. But we still only want
    // to show it once per legitimate 10-10, so we set the flag here and let
    // both answer paths (accept / decline) keep it true.
    m.raceOffered = true;
    saveAll();
    const safeMode = mode || 'rotation';
    openModal(`
      <div class="modal-title">Race to 2?</div>
      <div class="modal-sub">Both teams have reached 10–10 (Love–Love). Would you like to play a Race to 2?</div>
      <div class="modal-actions" style="margin-top:16px;">
        <button class="btn btn-ghost" data-action="decline-race-to-two">No, Keep Playing</button>
        <button class="btn btn-primary" data-action="accept-race-to-two" data-mode="${safeMode}" data-match="${matchId || ''}">Yes, Race to 2</button>
      </div>
    `, true); // backdrop-dismissible: Escape / backdrop tap = "No, Keep Playing"
  }
}

function acceptRaceToTwo(mode, matchId){
  const ctx = (mode === 'rotation-court') ? liveRotationCourtCtx(matchId) : (mode === 'ps-court') ? liveMatchCtxPS(matchId) : liveMatchCtx(mode, matchId);
  const m = ctx.getMatch();
  if(!m){ closeModal(); return; }
  m.scoreA = 0;
  m.scoreB = 0;
  m.raceActive = true;
  m.winner = null; // clear any auto-detected winner from the 10-10 score
  saveAll();
  closeModal();
  toast('Race to 2 started — first to 2 wins!', 'success');
  ctx.render();
}

function declineRaceToTwo(){
  closeModal();
}

function adjustMatchScore(ctx, team, delta){
  const m = ctx.getMatch();
  if(!m || m.status === 'done') return;
  // Only the serving team can score in pickleball — the receiving team's
  // stepper is disabled in the UI, but this guard covers any stray click too.
  if(m.serving !== team){
    toast(`Only the serving team can score — Team ${m.serving} is serving.`, 'warning');
    return;
  }
  let cur = team === 'A' ? m.scoreA : m.scoreB;
  cur = (cur === null || isNaN(cur)) ? 0 : cur;
  const maxScore = getMatchWinTarget(m);
  cur = Math.min(maxScore, Math.max(0, cur + delta));
  if(team === 'A') m.scoreA = cur; else m.scoreB = cur;
  m.winner = detectWinner(m);

  saveAll();
  if(delta > 0){
    playPointUpSound();
    speakScoreOrMilestone(m, cur);
  } else {
    playPointDownSound();
    speakScoreCall(m);
  }
  maybeOfferRaceToTwo(m, ctx.mode, ctx.matchId);
  // Full re-render so winner-dependent UI (skip/forfeit disabled, + button cap) stays in sync
  ctx.render();
}

function setServingTeam(ctx, team){
  const m = ctx.getMatch();
  if(!m || m.status === 'done') return;
  if(!m.firstServe) return; // who serves first can only be set before the very first serve of the game
  pushServeUndo(m);
  m.serving = team;
  saveAll();
  ctx.render();
}

function advanceServer(ctx){
  const m = ctx.getMatch();
  if(!m || m.status === 'done') return;
  if(m.firstServe) return; // the very first serve of the game is a single serve — no serve 2 to switch to
  if(m.serverNum !== 1) return; // already on serve 2 — side out is the next move, not this
  pushServeUndo(m);
  m.serverNum = 2;
  saveAll();
  playSideOutSound();
  speakServeSwitchCall(m);
  ctx.render();
}

function sideOutMatch(ctx){
  const m = ctx.getMatch();
  if(!m || m.status === 'done' || m.winner) return;
  // Standard doubles side-out needs both servers to have served, EXCEPT the
  // very first serve of the game, which is just one serve before the first
  // side-out (per official pickleball rules).
  if(!m.firstServe && m.serverNum !== 2) return;
  pushServeUndo(m);
  m.serving = m.serving === 'A' ? 'B' : 'A';
  m.serverNum = 1;
  m.firstServe = false;
  saveAll();
  playSideOutSound();
  speakSideOut(m);
  ctx.render();
}

// Asks for confirmation before unwinding the most recent serve decision —
// undoing isn't itself undoable, so we make sure that's really what's wanted.
function confirmUndoServeModal(ctx){
  const m = ctx.getMatch();
  if(!m || !m._serveUndoStack || !m._serveUndoStack.length){ toast('No serve decision to undo.', 'info'); return; }
  const undoAction = ctx.mode === 'rr' ? 'do-rr-undo-serve' : ctx.mode === 'ps-court' ? 'do-ps-undo-serve' : 'do-rotation-undo-serve';
  openModal(`
    <div class="modal-title">Undo Serve Decision?</div>
    <div class="modal-sub">This reverts the most recent serve action (1st server / serve 2 / side out). The score is not affected. ${m._serveUndoStack.length > 1 ? `You can undo ${m._serveUndoStack.length} steps in total.` : ''}</div>
    <div class="modal-actions" style="margin-top:16px;">
      <button class="btn btn-ghost" data-action="modal-close">Cancel</button>
      <button class="btn btn-danger" data-action="${undoAction}" data-match="${ctx.matchId || ''}">Yes, Undo</button>
    </div>
  `);
}

function undoServeMatch(ctx){
  const m = ctx.getMatch();
  if(!m || !m._serveUndoStack || !m._serveUndoStack.length){ toast('No serve decision to undo.', 'info'); return; }
  const snap = m._serveUndoStack.pop();
  restoreServe(m, snap);
  saveAll();
  closeModal();
  toast('Serve decision undone.', 'success');
  ctx.render();
}

// Finalizes a single court's result immediately (stats, rating, history),
// frees its court, pulls the next queued match onto it, and — once every
// match in the generation is done — auto-builds the next generation.
function confirmRoundRobinMatch(matchId){
  const gen = state.currentGeneration;
  if(!gen) return;
  const m = gen.matches.find(x => x.id === matchId);
  if(!m || m.status === 'done') return;
  if(m.winner === null){ toast('Select the winning team before confirming.', 'warning'); return; }

  state.undo = {
    players: deepClone(state.players),
    matches: deepClone(state.matches),
    current: null,
    currentGeneration: deepClone(state.currentGeneration),
    round: state.round,
    sitOutQueue: deepClone(state.sitOutQueue || [])
  };

  const sA = parseInt(m.scoreA, 10) || 0;
  const sB = parseInt(m.scoreB, 10) || 0;
  const tA_win = m.winner === 'A';

  // Resolve original player IDs: if a substitution happened, the match record
  // and all stats go to the ORIGINAL player, not the sub.
  const subs = m.substitutions || {};
  function resolveOriginal(id){ return Object.keys(subs).find(orig => subs[orig] === id) || id; }
  const recordTeamA = m.teamA.map(resolveOriginal);
  const recordTeamB = m.teamB.map(resolveOriginal);

  const matchRecord = {
    id: uid('m'),
    round: gen.generation,
    generation: gen.generation,
    court: m.court || 0,
    teamA: recordTeamA, teamB: recordTeamB,
    scoreA: sA, scoreB: sB,
    winners: tA_win ? recordTeamA : recordTeamB,
    losers: tA_win ? recordTeamB : recordTeamA,
    forfeit: m.forfeit || null,
    substitutions: Object.keys(subs).length ? subs : undefined, // store sub notes for history
    date: new Date().toISOString()
  };
  state.matches.push(matchRecord);

  [...recordTeamA, ...recordTeamB].forEach(id => {
    const p = getPlayer(id);
    if(!p) return;
    p.gamesPlayed++;
    if(matchRecord.winners.includes(id)){
      p.wins++; p.results.push('W'); p.currentStreak = p.currentStreak > 0 ? p.currentStreak + 1 : 1;
    } else {
      p.losses++; p.results.push('L'); p.currentStreak = p.currentStreak < 0 ? p.currentStreak - 1 : -1;
    }
    if(Math.abs(p.currentStreak) > p.longestStreak) p.longestStreak = Math.abs(p.currentStreak);
  });

  [[recordTeamA[0], recordTeamA[1]], [recordTeamB[0], recordTeamB[1]]].forEach(([p1, p2]) => {
    const pl1 = getPlayer(p1), pl2 = getPlayer(p2);
    if(pl1 && pl2){ bumpPair(pl1.teammates, p2); bumpPair(pl2.teammates, p1); }
  });
  recordTeamA.forEach(idA => {
    recordTeamB.forEach(idB => {
      const plA = getPlayer(idA), plB = getPlayer(idB);
      if(plA && plB){ bumpPair(plA.opponents, idB); bumpPair(plB.opponents, idA); }
    });
  });

  const rA = (getPlayer(recordTeamA[0])?.rating || 1000) + (getPlayer(recordTeamA[1])?.rating || 1000);
  const rB = (getPlayer(recordTeamB[0])?.rating || 1000) + (getPlayer(recordTeamB[1])?.rating || 1000);
  const expA = 1 / (1 + Math.pow(10, (rB - rA) / 400));
  const ratingChange = Math.round(32 * ((tA_win ? 1 : 0) - expA));
  recordTeamA.forEach(id => { const p = getPlayer(id); if(p) p.rating += ratingChange; });
  recordTeamB.forEach(id => { const p = getPlayer(id); if(p) p.rating -= ratingChange; });

  m.status = 'done';
  m.court = null;
  if(!m.forfeit) playGameWinSound();

  advanceRRQueue();

  const allDone = gen.matches.every(x => x.status === 'done');
  if(allDone){
    const finishedGen = gen.generation;
    state.round = finishedGen;
    state.currentGeneration = null;
    saveAll(); renderAll();
    promptNextGeneration(finishedGen);
  } else {
    saveAll(); renderAll();
    toast('Match recorded — next match is up.', 'success');
  }
}

// ============================================================
// SKIP MATCH — sends an active match to the back of the queue instead of
// playing it now. The court it was on opens up for whichever queued match
// is next in line; the skipped match's score/serve state is cleared so it
// starts clean whenever it eventually comes back around.
// ============================================================
function confirmSkipRRMatch(matchId){
  const gen = state.currentGeneration;
  const m = gen && gen.matches.find(x => x.id === matchId);
  if(!m || m.status !== 'active') return;
  openModal(`
    <div class="modal-title">Skip This Match?</div>
    <div class="modal-sub">This sends the match to the back of the queue and frees up Court ${m.court} for the next match in line. You can come back to it later.</div>
    <div class="modal-actions" style="margin-top:16px;">
      <button class="btn btn-ghost" data-action="modal-close">Cancel</button>
      <button class="btn btn-primary" data-action="do-skip-rr-match" data-match="${matchId}">Skip Match</button>
    </div>
  `);
}

function skipRRMatchToBack(matchId){
  const gen = state.currentGeneration;
  if(!gen) return;
  const m = gen.matches.find(x => x.id === matchId);
  if(!m || m.status !== 'active') { closeModal(); return; }

  const maxIndex = Math.max(...gen.matches.map(x => x.matchIndex));
  m.status = 'queued';
  m.court = null;
  m.matchIndex = maxIndex + 1;
  // Clear in-progress score/serve state — it's going to the back of the
  // line, so it should start fresh whenever it's pulled up again.
  m.scoreA = null; m.scoreB = null; m.winner = null;
  m.serving = 'A'; m.serverNum = 1; m.firstServe = true;
  m.raceActive = false; m.raceOffered = false;
  m._serveUndoStack = [];

  advanceRRQueue();
  saveAll(); renderAll(); closeModal();
  toast(m.status === 'active' ? 'No other matches were queued — this one is still up.' : 'Match moved to the back of the queue.', m.status === 'active' ? 'info' : 'success');
}

// ============================================================
// FORFEIT MATCH — records a match as won by default because one team (or
// both) didn't play. A single-team forfeit awards the other team the
// configured winning score and finalizes through the normal confirmation
// path, so it's reflected in stats/ratings/history like any other result,
// just tagged as a forfeit. A double forfeit closes out the match with no
// winner and no stats impact — nobody played, so nobody's record changes.
// ============================================================
function confirmForfeitRRMatch(matchId){
  const gen = state.currentGeneration;
  const m = gen && gen.matches.find(x => x.id === matchId);
  if(!m || m.status !== 'active') return;
  const teamAName = `${esc(playerName(m.teamA[0]))} &amp; ${esc(playerName(m.teamA[1]))}`;
  const teamBName = `${esc(playerName(m.teamB[0]))} &amp; ${esc(playerName(m.teamB[1]))}`;
  openModal(`
    <div class="modal-title">Forfeit Match</div>
    <div class="modal-sub">Who's forfeiting Court ${m.court}?</div>
    <div class="modal-actions" style="margin-top:16px; flex-direction:column;">
      <button class="btn btn-secondary btn-block" data-action="do-forfeit-rr-match" data-match="${m.id}" data-who="A">Team A Forfeits — ${teamBName} Wins</button>
      <button class="btn btn-secondary btn-block" style="margin-top:8px;" data-action="do-forfeit-rr-match" data-match="${m.id}" data-who="B">Team B Forfeits — ${teamAName} Wins</button>
      <button class="btn btn-danger btn-block" style="margin-top:8px;" data-action="do-forfeit-rr-match" data-match="${m.id}" data-who="both">Both Teams Forfeit — No Winner</button>
      <button class="btn btn-ghost btn-block" style="margin-top:8px;" data-action="modal-close">Cancel</button>
    </div>
  `);
}

function forfeitRRMatch(matchId, who){
  const gen = state.currentGeneration;
  if(!gen) return;
  const m = gen.matches.find(x => x.id === matchId);
  if(!m || m.status !== 'active') { closeModal(); return; }

  if(who === 'both'){
    state.undo = {
      players: deepClone(state.players),
      matches: deepClone(state.matches),
      current: null,
      currentGeneration: deepClone(state.currentGeneration),
      round: state.round,
      sitOutQueue: deepClone(state.sitOutQueue || [])
    };
    // No-contest — log it in history for visibility, but don't touch any
    // player's wins/losses/streak/rating since neither team actually played.
    state.matches.push({
      id: uid('m'),
      round: gen.generation,
      generation: gen.generation,
      court: m.court || 0,
      teamA: m.teamA, teamB: m.teamB,
      scoreA: 0, scoreB: 0,
      winners: [], losers: [],
      forfeit: 'both',
      date: new Date().toISOString()
    });
    m.status = 'done';
    m.court = null;
    m.winner = null;
    advanceRRQueue();

    const allDone = gen.matches.every(x => x.status === 'done');
    closeModal();
    if(allDone){
      const finishedGen = gen.generation;
      state.round = finishedGen;
      state.currentGeneration = null;
      saveAll(); renderAll();
      promptNextGeneration(finishedGen);
    } else {
      saveAll(); renderAll();
      toast('Match recorded as a double forfeit — no winner.', 'success');
    }
    return;
  }

  const winningTeam = who === 'A' ? 'B' : 'A';
  const target = getMatchWinTarget(m);
  m.winner = winningTeam;
  m.forfeit = who;
  if(winningTeam === 'A'){ m.scoreA = target; m.scoreB = 0; }
  else { m.scoreB = target; m.scoreA = 0; }

  // Close the forfeit-picker modal first — confirmRoundRobinMatch may open
  // its own "Generation Complete" modal if this was the last match, and
  // that one should be left open rather than immediately closed after it.
  const willFinishGeneration = gen.matches.filter(x => x.id !== m.id).every(x => x.status === 'done');
  closeModal();
  confirmRoundRobinMatch(matchId);
  if(!willFinishGeneration){
    toast(`Team ${who} forfeited — Team ${winningTeam} wins by default.`, 'success');
  }
}

// Shown once every match in a generation has been played. Hands control
// back to the organizer instead of silently auto-building the next
// generation — they may want to let more players check in, swap settings,
// or just take a breather between rounds first.
function promptNextGeneration(finishedGen){
  // A full schedule was pre-built up front — just activate the next round
  // from it instead of building (or asking to build) anything new.
  if(advanceToNextGeneration()){
    toast(`Generation ${finishedGen} complete — Generation ${finishedGen + 1} from your full schedule is up.`, 'success');
    return;
  }

  const plan = state.settings.sessionPlan;

  if(!plan){
    // No active plan (legacy / cleared) — fall back to the simple per-generation prompt,
    // since without a plan there's no "session total" to auto-advance toward.
    openModal(`
      <div class="modal-title">🎉 Generation ${finishedGen} Complete!</div>
      <div class="modal-sub" style="line-height:1.6;">Every match in this round robin generation has been played. Ready to build Generation ${finishedGen + 1}?</div>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-action="modal-close">Not Yet</button>
        <button class="btn btn-primary" data-action="confirm-next-generation">Generate Generation ${finishedGen + 1}</button>
      </div>
    `);
    return;
  }

  const playedSoFar = state.matches.length - plan.matchesAtStart;

  if(playedSoFar >= plan.totalMatches){
    const pct = clamp(Math.round((playedSoFar / plan.totalMatches) * 100), 0, 100);
    const progressHtml = `
      <div class="session-progress-wrap">
        <div class="session-progress-track"><div class="session-progress-fill" style="width:${pct}%;"></div></div>
        <div class="session-progress-label"><span>${playedSoFar} / ${plan.totalMatches} matches</span><span>${plan.label}</span></div>
      </div>
    `;
    openModal(`
      <div class="modal-title">🏆 Session Complete!</div>
      <div class="modal-sub" style="line-height:1.6;">${plan.label} finished — all ${plan.totalMatches} matches have been played across ${finishedGen} generation${finishedGen!==1?'s':''}.</div>
      ${progressHtml}
      <div class="modal-actions" style="margin-top:16px; flex-direction:column;">
        <button class="btn btn-primary btn-block" data-action="continue-match-cycle">Continue Match Cycle &amp; Generate</button>
        <button class="btn btn-secondary btn-block" style="margin-top:8px;" data-action="start-new-session-plan">Choose Next Session</button>
        <button class="btn btn-ghost btn-block" style="margin-top:8px;" data-action="modal-close">Stay Here</button>
      </div>
    `, false);
    return;
  }

  // Session is still under its match target — keep play moving without an
  // extra "ready for the next generation?" stop. A toast marks the handoff
  // so it's still clear a new generation just got built automatically.
  toast(`Generation ${finishedGen} complete — building Generation ${finishedGen + 1}.`, 'success');
  const activeList = activePlayers().slice();
  proceedToGenerateGeneration(activeList);
}

// Lets the organizer keep playing past a finished session plan's match
// target without picking a brand-new plan from scratch — same group, same
// court/scoring settings, just one more generation right now. Clears the
// plan (rather than extending its totalMatches) so the session no longer
// reports itself as "finished": from here on, finishing a generation falls
// back to the simple "Generate Generation N+1?" prompt each time, instead
// of immediately re-showing this same Session Complete modal.
function continueMatchCycle(){
  state.settings.sessionPlan = null;
  saveAll();
  closeModal();
  toast('Continuing the match cycle — building the next generation.', 'success');
  const activeList = activePlayers().slice();
  proceedToGenerateGeneration(activeList);
}

// Clears the active session plan and re-opens the length picker so the
// organizer can choose what's next once a session's target match count
// has been reached.
function startNewSessionPlan(){
  state.settings.sessionPlan = null;
  state.scheduledGenerations = [];
  saveAll();
  closeModal();
  openSessionLengthPicker();
}

/* ---------- Replace / substitute a player mid-generation ---------- */
function openReplacePlayerPickerModal(matchId){
  const gen = state.currentGeneration;
  if(!gen) return;
  const m = gen.matches.find(x => x.id === matchId);
  if(!m || m.status === 'done'){ toast('That match is already finished.', 'warning'); return; }

  const rows = [
    { team:'A', id:m.teamA[0] }, { team:'A', id:m.teamA[1] },
    { team:'B', id:m.teamB[0] }, { team:'B', id:m.teamB[1] }
  ];

  openModal(`
    <div class="modal-title">Replace a Player</div>
    <div class="modal-sub">Tap whoever's not around for this upcoming match.</div>
    ${rows.map(r => `
      <button class="btn btn-secondary btn-block" style="margin-top:6px; justify-content:space-between;" data-action="open-replace-player" data-match="${matchId}" data-team="${r.team}" data-player="${r.id}">
        <span>${esc(playerName(r.id))}</span><span class="mono" style="color:var(--text-faint); font-size:11px;">Team ${r.team}</span>
      </button>
    `).join('')}
    <div class="modal-actions">
      <button class="btn btn-ghost btn-block" data-action="modal-close">Cancel</button>
    </div>
  `);
}

function openReplacePlayerModal(matchId, team, playerId){
  const gen = state.currentGeneration;
  if(!gen) return;
  const m = gen.matches.find(x => x.id === matchId);
  if(!m || m.status === 'done'){ toast('That match is already finished.', 'warning'); return; }
  const p = getPlayer(playerId);
  const condition = p ? (p.condition || 'ok') : 'ok';

  // All players in the current match (to exclude from picker)
  const inMatchIds = new Set([...m.teamA, ...m.teamB]);
  const sittingOutIds = new Set(gen.sittingOut || []);

  // Regular bench/active players — listed first.
  const benchCandidates = state.players
    .filter(pl => pl.active && !pl.isSub && (pl.condition||'ok')==='ok' && pl.id !== playerId && !inMatchIds.has(pl.id))
    .sort((a, b) => {
      const aOut = sittingOutIds.has(a.id) ? 0 : 1;
      const bOut = sittingOutIds.has(b.id) ? 0 : 1;
      if(aOut !== bOut) return aOut - bOut;
      return a.gamesPlayed - b.gamesPlayed;
    });

  // Sub Players — always listed too, below the regular bench.
  const subCandidates = state.players
    .filter(pl => pl.isSub && pl.active && (pl.condition||'ok')==='ok' && pl.id !== playerId && !inMatchIds.has(pl.id))
    .sort((a, b) => a.gamesPlayed - b.gamesPlayed);

  const rowBtn = (b, badge) => `
    <button class="btn btn-secondary btn-block" style="margin-top:6px; justify-content:space-between;" data-action="do-replace-manual" data-match="${matchId}" data-team="${team}" data-player="${playerId}" data-sub="${b.id}">
      <span>${esc(b.name)}</span>
      <span class="mono" style="color:var(--text-faint); font-size:11px;">${badge} · ${b.gamesPlayed} gms</span>
    </button>`;

  const benchHtml = benchCandidates.length
    ? `<div class="helper-text" style="margin-bottom:4px;">Or choose manually:</div>
       ${benchCandidates.map(b => rowBtn(b, sittingOutIds.has(b.id) ? '🪑 Sitting out' : '🎮 In queue')).join('')}`
    : '';

  const subsHtml = subCandidates.length
    ? `<div class="helper-text" style="margin:14px 2px 4px; color:var(--court);">🔁 Sub Players</div>
       ${subCandidates.map(b => rowBtn(b, '🔁 Sub')).join('')}`
    : '';

  const noneHtml = (!subCandidates.length && !benchCandidates.length)
    ? `<p class="helper-text">No other active players available to sub in.</p>` : '';

  openModal(`
    <div class="modal-title">Replace ${esc(p ? p.name : 'Player')}</div>
    <div class="modal-sub">${(condition === 'tired' || condition === 'injured' || condition === 'cant_play') ? `${esc(p.name)} is marked ${condition === 'tired' ? '😴 tired' : condition === 'injured' ? '🤕 injured' : '🙅 unable to play'}. ` : ''}Not around? Pick a player to sub in for this match — sitting-out players are shown first, Sub Players are listed below.</div>
    <button class="btn btn-danger btn-block" data-action="do-replace-absent" data-match="${matchId}" data-team="${team}" data-player="${playerId}">Mark Absent &amp; Auto-Sub Best Available</button>
    <div class="divider-thin"></div>
    ${benchHtml}
    ${subsHtml}
    ${noneHtml}
    <div class="modal-actions">
      <button class="btn btn-ghost btn-block" data-action="modal-close">Cancel</button>
    </div>
  `);
}

function replacePlayerInMatch(matchId, team, oldId, newId){
  if(!newId){ toast('No substitute selected.', 'warning'); return; }
  const gen = state.currentGeneration;
  if(!gen) return;
  const m = gen.matches.find(x => x.id === matchId);
  if(!m || m.status === 'done'){ toast('That match is already finished.', 'warning'); return; }
  const teamArr = team === 'A' ? m.teamA : m.teamB;
  const idx = teamArr.indexOf(oldId);
  if(idx === -1) return;

  // Track substitution: substitutions[originalPlayerId] = subPlayerId
  // The match record & stats stay attributed to the original player;
  // we just note who physically stepped in.
  if(!m.substitutions) m.substitutions = {};
  // If oldId is itself already a sub, find the real original
  const realOriginalId = Object.keys(m.substitutions).find(origId => m.substitutions[origId] === oldId) || oldId;
  m.substitutions[realOriginalId] = newId;

  // Physically swap the active playing slot
  teamArr[idx] = newId;

  gen.sittingOut = (gen.sittingOut || []).filter(id => id !== newId);
  const oldPlayer = getPlayer(oldId);
  if(oldPlayer && oldPlayer.active && !gen.sittingOut.includes(oldId)){
    gen.sittingOut.push(oldId);
  }
  const origPlayer = getPlayer(realOriginalId);
  const subPlayer = getPlayer(newId);
  saveAll(); renderAll(); closeModal();
  toast(`${origPlayer ? origPlayer.name : playerName(oldId)} subbed out — ${subPlayer ? subPlayer.name : playerName(newId)} steps in.`, 'success');
}

function markPlayerAbsentAndAutoReplace(matchId, team, oldId){
  const gen = state.currentGeneration;
  if(!gen) return;
  const oldPlayer = getPlayer(oldId);
  const condition = oldPlayer ? (oldPlayer.condition || 'ok') : 'ok';
  const slotNeedsSub = condition === 'tired' || condition === 'injured' || condition === 'cant_play';
  // Generic absence pauses their profile so they're not scheduled again.
  // Tired/Injured/Can't Play players stay active — they may be back next generation.
  if(oldPlayer && !slotNeedsSub) oldPlayer.active = false;
  gen.sittingOut = (gen.sittingOut || []).filter(id => id !== oldId);

  const m = gen.matches.find(x => x.id === matchId);
  const inMatchIds = m ? new Set([...m.teamA, ...m.teamB]) : new Set();

  // Prefer a regular bench player first, then fall back to Sub Players.
  let candidates = (gen.sittingOut || [])
    .map(id => getPlayer(id))
    .filter(pl => pl && !pl.isSub && (pl.condition||'ok')==='ok')
    .sort((a,b) => a.gamesPlayed - b.gamesPlayed);

  if(!candidates.length){
    candidates = state.players
      .filter(pl => pl.isSub && pl.active && (pl.condition||'ok')==='ok' && !inMatchIds.has(pl.id))
      .sort((a,b) => a.gamesPlayed - b.gamesPlayed);
  }
  if(!candidates.length){
    saveAll(); renderAll(); closeModal();
    toast(`${oldPlayer ? oldPlayer.name : 'Player'} marked absent — no bench player available, that slot is open until someone subs in.`, 'warning');
    return;
  }
  replacePlayerInMatch(matchId, team, oldId, candidates[0].id);
}

/* ---------- Replace / substitute a player in Rotation mode's single current match ---------- */
function openReplaceCurrentPlayerPickerModal(){
  if(!state.current) return;
  const c = state.current;
  const rows = [
    { team:'A', id:c.teamA[0] }, { team:'A', id:c.teamA[1] },
    { team:'B', id:c.teamB[0] }, { team:'B', id:c.teamB[1] }
  ];
  openModal(`
    <div class="modal-title">Replace a Player</div>
    <div class="modal-sub">Tap whoever's not around for this match.</div>
    ${rows.map(r => `
      <button class="btn btn-secondary btn-block" style="margin-top:6px; justify-content:space-between;" data-action="open-replace-current-player" data-team="${r.team}" data-player="${r.id}">
        <span>${esc(playerName(r.id))}</span><span class="mono" style="color:var(--text-faint); font-size:11px;">Team ${r.team}</span>
      </button>
    `).join('')}
    <div class="modal-actions">
      <button class="btn btn-ghost btn-block" data-action="modal-close">Cancel</button>
    </div>
  `);
}

function openReplaceCurrentPlayerModal(team, playerId){
  if(!state.current) return;
  const c = state.current;
  const p = getPlayer(playerId);
  const condition = p ? (p.condition || 'ok') : 'ok';
  const inMatchIds = new Set([...c.teamA, ...c.teamB]);

  const benchCandidates = state.players
    .filter(pl => pl.active && !pl.isSub && (pl.condition||'ok')==='ok' && pl.id !== playerId && !inMatchIds.has(pl.id))
    .sort((a,b) => a.gamesPlayed - b.gamesPlayed);

  // Sub Players are always listed too, below the regular candidates.
  const subCandidates = state.players
    .filter(pl => pl.isSub && pl.active && (pl.condition||'ok')==='ok' && pl.id !== playerId && !inMatchIds.has(pl.id))
    .sort((a,b) => a.gamesPlayed - b.gamesPlayed);

  const rowBtn = (b, badge) => `
    <button class="btn btn-secondary btn-block" style="margin-top:6px; justify-content:space-between;" data-action="do-replace-current-manual" data-team="${team}" data-player="${playerId}" data-sub="${b.id}">
      <span>${esc(b.name)}</span>
      <span class="mono" style="color:var(--text-faint); font-size:11px;">${badge} · ${b.gamesPlayed} gms</span>
    </button>`;

  const benchHtml = benchCandidates.length
    ? `<div class="helper-text" style="margin-bottom:4px;">Pick a player to sub in:</div>
       ${benchCandidates.map(b => rowBtn(b, '🎮 Available')).join('')}`
    : '';

  const subsHtml = subCandidates.length
    ? `<div class="helper-text" style="margin:14px 2px 4px; color:var(--court);">🔁 Sub Players</div>
       ${subCandidates.map(b => rowBtn(b, '🔁 Sub')).join('')}`
    : '';

  const noneHtml = (!subCandidates.length && !benchCandidates.length)
    ? `<p class="helper-text">No other active players available to sub in.</p>` : '';

  openModal(`
    <div class="modal-title">Replace ${esc(p ? p.name : 'Player')}</div>
    <div class="modal-sub">${(condition === 'tired' || condition === 'injured' || condition === 'cant_play') ? `${esc(p.name)} is marked ${condition === 'tired' ? '😴 tired' : condition === 'injured' ? '🤕 injured' : '🙅 unable to play'}. ` : ''}Not around? Pick a player to sub in for this match — Sub Players are listed below.</div>
    ${benchHtml}
    ${subsHtml}
    ${noneHtml}
    <div class="modal-actions">
      <button class="btn btn-ghost btn-block" data-action="modal-close">Cancel</button>
    </div>
  `);
}

function replaceCurrentPlayer(team, oldId, newId){
  if(!newId){ toast('No substitute selected.', 'warning'); return; }
  if(!state.current) return;
  const teamArr = team === 'A' ? state.current.teamA : state.current.teamB;
  const idx = teamArr.indexOf(oldId);
  if(idx === -1) return;

  // Track substitution so stats go to the original player
  if(!state.current.substitutions) state.current.substitutions = {};
  const realOriginalId = Object.keys(state.current.substitutions).find(orig => state.current.substitutions[orig] === oldId) || oldId;
  state.current.substitutions[realOriginalId] = newId;

  teamArr[idx] = newId;
  const origPlayer = getPlayer(realOriginalId);
  const subPlayer = getPlayer(newId);
  saveAll(); renderAll(); closeModal();
  toast(`${origPlayer ? origPlayer.name : playerName(oldId)} subbed out — ${subPlayer ? subPlayer.name : playerName(newId)} steps in.`, 'success');
}

/* ============================================================
   MATCH FINALIZATION (ROTATION ORIGINAL SYSTEM)
   ------------------------------------------------------------
   The live scoring itself (manual entry, +/- steppers, winner
   buttons, serve tracking) is handled by the shared engine above
   via liveMatchCtx('rotation', null) — see the action dispatcher
   and the window.updateRotationScoreInput hook for where it's
   wired in. recordRotationMatch() below is what's specific to
   Rotation: finalizing the single current match into history.
   ============================================================ */

function recordRotationMatch(scoreA, scoreB) {
  if(!state.current) return;
  const sA = parseInt(scoreA,10);
  const sB = parseInt(scoreB,10);
  if(isNaN(sA) || isNaN(sB)) { toast('Enter valid scores for both teams.', 'warning'); return; }
  if(sA === sB) { toast("Scores can't be tied — pickleball is won by 2. Pick the winning team or finish the game.", 'warning'); return; }

  state.undo = {
    players: deepClone(state.players),
    matches: deepClone(state.matches),
    current: deepClone(state.current),
    currentGeneration: null,
    round: state.round
  };

  const curr = state.current;
  state.round = curr.round;

  // Resolve original player IDs for stat attribution
  const subs = curr.substitutions || {};
  function resolveOriginalRot(id){ return Object.keys(subs).find(orig => subs[orig] === id) || id; }
  const recordTeamA = curr.teamA.map(resolveOriginalRot);
  const recordTeamB = curr.teamB.map(resolveOriginalRot);

  const matchRecord = {
    id: uid('m'),
    round: curr.round,
    teamA: recordTeamA,
    teamB: recordTeamB,
    scoreA: sA,
    scoreB: sB,
    winners: sA > sB ? recordTeamA : recordTeamB,
    losers: sA > sB ? recordTeamB : recordTeamA,
    substitutions: Object.keys(subs).length ? subs : undefined,
    date: new Date().toISOString()
  };

  state.matches.push(matchRecord);

  const allFour = [...recordTeamA, ...recordTeamB];
  allFour.forEach(id => {
    const p = getPlayer(id);
    if(!p) return;
    p.gamesPlayed++;
    if(matchRecord.winners.includes(id)) {
      p.wins++; p.results.push('W');
      p.currentStreak = p.currentStreak > 0 ? p.currentStreak + 1 : 1;
    } else {
      p.losses++; p.results.push('L');
      p.currentStreak = p.currentStreak < 0 ? p.currentStreak - 1 : -1;
    }
    if(Math.abs(p.currentStreak) > p.longestStreak) p.longestStreak = Math.abs(p.currentStreak);
  });

  const pairs = [[recordTeamA[0], recordTeamA[1]], [recordTeamB[0], recordTeamB[1]]];
  pairs.forEach(([p1, p2]) => {
    const pl1 = getPlayer(p1), pl2 = getPlayer(p2);
    if(pl1 && pl2) { bumpPair(pl1.teammates, p2); bumpPair(pl2.teammates, p1); }
  });

  recordTeamA.forEach(idA => {
    recordTeamB.forEach(idB => {
      const plA = getPlayer(idA), plB = getPlayer(idB);
      if(plA && plB) { bumpPair(plA.opponents, idB); bumpPair(plB.opponents, idA); }
    });
  });

  const rA = (getPlayer(recordTeamA[0])?.rating || 1000) + (getPlayer(recordTeamA[1])?.rating || 1000);
  const rB = (getPlayer(recordTeamB[0])?.rating || 1000) + (getPlayer(recordTeamB[1])?.rating || 1000);
  const expA = 1 / (1 + Math.pow(10, (rB - rA) / 400));
  const actualA = sA > sB ? 1 : 0;
  const ratingChange = Math.round(32 * (actualA - expA));

  recordTeamA.forEach(id => { const p = getPlayer(id); if(p) p.rating += ratingChange; });
  recordTeamB.forEach(id => { const p = getPlayer(id); if(p) p.rating -= ratingChange; });

  state.current = null;
  saveAll(); renderAll();
  playGameWinSound();
  toast('Match score recorded.', 'success');
  // Auto-generate the next match immediately in Rotation mode
  if(state.settings.matchMode === 'Rotation'){
    nextRotationMatch();
  }
}

function skipCurrentMatch() {
  if(!state.current && !state.currentGeneration && (!state.rotationCourts || !state.rotationCourts.length)) return;
  if(state.settings.matchMode === 'RoundRobin') {
    state.currentGeneration = null;
    state.scheduledGenerations = [];
  } else {
    state.current = null;
  }
  // Always clear rotation courts so no stale court lingers regardless of mode.
  state.rotationCourts = [];
  saveAll(); renderAll();
  toast('Current match cleared.', 'success');
}

function undoLastMatch() {
  if(!state.undo) { toast('Nothing to undo.', 'info'); return; }
  state.players = state.undo.players;
  state.matches = state.undo.matches;
  state.current = state.undo.current;
  state.currentGeneration = state.undo.currentGeneration;
  state.round = state.undo.round;
  if(state.undo.sitOutQueue) state.sitOutQueue = state.undo.sitOutQueue;
  if(state.undo.rotationCourts) state.rotationCourts = state.undo.rotationCourts;
  state.undo = null;
  saveAll(); renderAll();
  toast('Last match results undone.', 'success');
}

/* ============================================================
   EXPORT / IMPORT
   ============================================================ */
function defaultExportFileName(){
  const d = new Date();
  const pad = n => String(n).padStart(2,'0');
  return `kitchen_ladder_backup_${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

function openExportNameModal(){
  openModal(`
    <div class="modal-title">Export Backup</div>
    <div class="modal-sub">Name this backup so you can tell it apart later — ".json" will be added automatically.</div>
    <div class="field" style="margin-top:10px;">
      <label>File Name</label>
      <input type="text" id="exportFileName" value="${esc(defaultExportFileName())}">
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-action="modal-close">Cancel</button>
      <button class="btn btn-primary" data-action="do-export-data">Download JSON</button>
    </div>
  `);
}

function exportData(filename){
  const dump = {
    players: state.players,
    matches: state.matches,
    current: state.settings.matchMode === 'RoundRobin' ? state.currentGeneration : state.current,
    settings: state.settings,
    round: state.round,
    sitOutQueue: state.sitOutQueue || [],
    rotationCourts: state.rotationCourts || [],
    scheduledGenerations: state.scheduledGenerations || [],
    version: '3.0-csop'
  };
  const str = JSON.stringify(dump, null, 2);
  const blob = new Blob([str], {type: 'application/json'});
  const url = URL.createObjectURL(blob);

  let name = (filename || '').trim().replace(/[\\/:*?"<>|]/g, ''); // strip characters invalid in file names
  if(!name) name = defaultExportFileName();
  if(!/\.json$/i.test(name)) name += '.json';

  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  closeModal();
  toast(`Backup saved as "${name}".`, 'success');
}

function importDataFromText(txt){
  try{
    const dump = JSON.parse(txt);
    if(!dump || !Array.isArray(dump.players)) { toast("That file isn't a valid Maezku Ladder backup.", 'error'); return; }
    state.players = dump.players;
    state.players.forEach(pl => {
      if(typeof pl.isSub !== 'boolean') pl.isSub = false;
      if(!pl.condition) pl.condition = 'ok';
    });
    state.matches = dump.matches || [];
    state.settings = { ...DEFAULT_SETTINGS, ...dump.settings };
    state.round = parseInt(dump.round,10)||0;
    state.sitOutQueue = Array.isArray(dump.sitOutQueue) ? dump.sitOutQueue : [];
    state.rotationCourts = Array.isArray(dump.rotationCourts) ? dump.rotationCourts : [];
    state.scheduledGenerations = Array.isArray(dump.scheduledGenerations) ? dump.scheduledGenerations : [];
    
    const incomingC = dump.current;
    if (incomingC && incomingC.matches) {
      state.currentGeneration = incomingC;
      state.current = null;
    } else {
      state.current = incomingC;
      state.currentGeneration = null;
    }

    state.undo = null;
    saveAll(); renderAll(); closeModal();
    toast('Backup restored successfully.', 'success');
  }catch(e){
    toast("Couldn't read that data — check what you pasted and try again.", 'error');
  }
}

// Reads a user-selected backup .json file and drops its contents into the
// import textarea so it can be reviewed before the restore is confirmed.
window.handleImportFileSelect = function(input){
  const file = input.files && input.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = function(){
    const ta = document.getElementById('importText');
    if(ta) ta.value = typeof reader.result === 'string' ? reader.result : '';
    toast(`Loaded "${file.name}" — tap "Restore Backup" to confirm.`, 'info');
  };
  reader.onerror = function(){
    toast('Could not read that file.', 'error');
  };
  reader.readAsText(file);
  input.value = ''; // reset so picking the same file again still fires onchange
};

/* ============================================================
   SESSION ARCHIVE — auto-saved snapshots, browsable by date/time
   ------------------------------------------------------------
   Each time the user starts a fresh session, the current state
   is archived under SESSIONS_KEY as an array of session objects:
     { id, savedAt, label, players, matches, settings, round,
       sitOutQueue, rotationCourts, scheduledGenerations,
       current, currentGeneration }
   Sessions are stored newest-first. The archive itself is never
   wiped by reset/clear-all — it survives across sessions so the
   user can always load any past day back.
   ============================================================ */
async function archiveCurrentSession(){
  if(!state.matches.length) return; // nothing to archive — skip silently
  try{
    const existing = await idbGet(SESSIONS_KEY) || [];
    const d = new Date();
    const pad = n => String(n).padStart(2,'0');
    const label = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const snap = {
      id: 'sess_' + Date.now().toString(36),
      savedAt: d.toISOString(),
      label,
      matchCount: state.matches.length,
      playerCount: state.players.filter(p => p.gamesPlayed > 0).length,
      players: JSON.parse(JSON.stringify(state.players)),
      matches: JSON.parse(JSON.stringify(state.matches)),
      settings: JSON.parse(JSON.stringify(state.settings)),
      round: state.round,
      sitOutQueue: JSON.parse(JSON.stringify(state.sitOutQueue || [])),
      rotationCourts: JSON.parse(JSON.stringify(state.rotationCourts || [])),
      scheduledGenerations: JSON.parse(JSON.stringify(state.scheduledGenerations || [])),
      current: state.current ? JSON.parse(JSON.stringify(state.current)) : null,
      currentGeneration: state.currentGeneration ? JSON.parse(JSON.stringify(state.currentGeneration)) : null
    };
    // Newest first; cap at 30 sessions to avoid unbounded storage growth
    const updated = [snap, ...existing].slice(0, 30);
    await idbSet(SESSIONS_KEY, updated);
  }catch(e){
    console.error('Failed to archive session:', e);
  }
}

async function loadArchivedSessions(){
  try{
    return (await idbGet(SESSIONS_KEY)) || [];
  }catch(e){ return []; }
}

async function restoreArchivedSession(sessionId){
  try{
    const sessions = await idbGet(SESSIONS_KEY) || [];
    const snap = sessions.find(s => s.id === sessionId);
    if(!snap){ toast('Session not found.', 'error'); return; }
    state.players = snap.players;
    state.players.forEach(pl => {
      if(typeof pl.isSub !== 'boolean') pl.isSub = false;
      if(!pl.condition) pl.condition = 'ok';
    });
    state.matches = snap.matches || [];
    state.settings = { ...DEFAULT_SETTINGS, ...snap.settings };
    state.round = parseInt(snap.round, 10) || 0;
    state.sitOutQueue = Array.isArray(snap.sitOutQueue) ? snap.sitOutQueue : [];
    state.rotationCourts = Array.isArray(snap.rotationCourts) ? snap.rotationCourts : [];
    state.scheduledGenerations = Array.isArray(snap.scheduledGenerations) ? snap.scheduledGenerations : [];
    state.current = snap.current || null;
    state.currentGeneration = snap.currentGeneration || null;
    state.undo = null;
    saveAll(); renderAll(); closeModal();
    toast(`Session from ${snap.label} restored.`, 'success');
  }catch(e){
    toast("Couldn't restore that session.", 'error');
    console.error(e);
  }
}

async function deleteArchivedSession(sessionId){
  try{
    const sessions = await idbGet(SESSIONS_KEY) || [];
    const updated = sessions.filter(s => s.id !== sessionId);
    await idbSet(SESSIONS_KEY, updated);
    openSessionHistoryModal(); // refresh the list in-place
    toast('Session deleted.', 'success');
  }catch(e){
    toast("Couldn't delete that session.", 'error');
  }
}

async function openSessionHistoryModal(){
  const sessions = await loadArchivedSessions();
  if(!sessions.length){
    openModal(`
      <div class="modal-title">📋 Session History</div>
      <div class="modal-sub" style="color:var(--text-faint); text-align:center; padding:24px 0;">No saved sessions yet.<br>Sessions are auto-saved when you start a new one.</div>
      <div class="modal-actions"><button class="btn btn-ghost btn-block" data-action="modal-close">Close</button></div>
    `);
    return;
  }
  const rows = sessions.map(s => `
    <div style="display:flex; align-items:center; gap:10px; padding:10px 0; border-bottom:1px solid var(--line-soft);">
      <div style="flex:1; min-width:0;">
        <div style="font-weight:700; font-size:13.5px; color:var(--text);">${esc(s.label)}</div>
        <div style="font-size:11.5px; color:var(--text-faint); margin-top:2px;">${s.matchCount} match${s.matchCount!==1?'es':''} · ${s.playerCount} player${s.playerCount!==1?'s':''} active</div>
      </div>
      <button class="btn btn-secondary btn-sm" data-action="restore-session" data-id="${esc(s.id)}">Load</button>
      <button class="btn btn-ghost btn-sm" data-action="delete-session" data-id="${esc(s.id)}" style="color:var(--loss); border-color:var(--loss-dim);">✕</button>
    </div>
  `).join('');
  openModal(`
    <div class="modal-title">📋 Session History</div>
    <div class="modal-sub" style="line-height:1.6;">Auto-saved sessions — tap <strong style="color:var(--text);">Load</strong> to restore any past session.</div>
    <div style="margin-top:10px;">${rows}</div>
    <div class="modal-actions" style="margin-top:16px;"><button class="btn btn-ghost btn-block" data-action="modal-close">Close</button></div>
  `);
}


function renderAll(){
  updateDashStrip();
  updateCheckInBadge();
  renderTabsNav();
  renderActiveView();
}

function updateCheckInBadge(){
  const badge = document.getElementById('checkinBadge');
  if(!badge) return;
  const notArrived = state.players.filter(p=>!p.active).length;
  if(notArrived > 0){
    badge.textContent = notArrived > 99 ? '99+' : notArrived;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

function updateDashStrip(){
  const ds = document.getElementById('dashStrip');
  const total = state.players.length;
  const activeCount = activePlayers().length;
  const matchesCount = state.matches.length;
  const mode = state.settings.matchMode;
  // Each match mode keeps its live courts in a different place — Rotation in
  // state.rotationCourts, Round Robin in state.currentGeneration.matches, and
  // Paddle Stack in state.paddleStack.courts. The old version here only ever
  // checked Rotation vs. currentGeneration, so a live Paddle Stack session
  // (which uses neither) always fell through to 0.
  let activeCourts;
  if(mode === 'Rotation'){
    activeCourts = Array.isArray(state.rotationCourts) ? state.rotationCourts.filter(c=>c&&c.status==='active').length : 0;
  } else if(mode === 'PaddleStack'){
    activeCourts = (state.paddleStack && Array.isArray(state.paddleStack.courts)) ? state.paddleStack.courts.filter(c=>c&&c.status==='active').length : 0;
  } else {
    activeCourts = state.currentGeneration ? state.currentGeneration.matches.filter(m=>m.status==='active').length : 0;
  }
  ds.innerHTML = `
    <div class="d-item"><span class="eyebrow">Players:</span><span class="v">${total}</span></div>
    <div class="d-item"><span class="eyebrow">Active:</span><span class="v">${activeCount}</span></div>
    <div class="d-item"><span class="eyebrow">Matches:</span><span class="v">${matchesCount}</span></div>
    <div class="d-item"><span class="eyebrow">Courts:</span><span class="v" style="color:var(--win);">${activeCourts}</span></div>
    <div class="d-item"><span class="eyebrow">Mode:</span><span class="v" style="color:var(--court);">${state.settings.matchMode === 'RoundRobin' ? 'Round Robin' : 'Open Play'}</span></div>
  `;
}

/* ============================================================
   NAVIGATION CONFIG — single source of truth for tab strip + nav menu
   ============================================================ */
const NAV_SECTIONS = [
  { id: 'match', label: 'Match', desc: 'Live pairing & scoreboard', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12h12M12 6v12"/></svg>' },
  { id: 'queue', label: 'Queue', desc: "Who's up next on court", svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>' },
  { id: 'players', label: 'Players', desc: 'Roster & active status', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>' },
  { id: 'rankings', label: 'Rankings', desc: 'ELO leaderboard', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>' },
  { id: 'stats', label: 'Stats', desc: 'Session performance breakdown', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>' },
  { id: 'history', label: 'History', desc: 'Past match results', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>' },
  { id: 'settings', label: 'Settings', desc: 'Match mode & configuration', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>' }
];

function renderTabsNav(){
  const nav = document.getElementById('tabNav');
  nav.innerHTML = NAV_SECTIONS.map(t=>`
    <button class="tab-btn ${state.tab===t.id?'active':''}" data-action="tab" data-tab="${t.id}">
      ${t.svg}<span>${t.label}</span>
    </button>
  `).join('');
  requestAnimationFrame(updateTabsFade);
}

/* ---------- Scroll-edge fade hints on the tab strip ---------- */
function updateTabsFade(){
  const nav = document.getElementById('tabNav');
  const fl = document.getElementById('tabsFadeL');
  const fr = document.getElementById('tabsFadeR');
  if(!nav || !fl || !fr) return;
  const maxScroll = nav.scrollWidth - nav.clientWidth;
  fl.classList.toggle('show', nav.scrollLeft > 4);
  fr.classList.toggle('show', maxScroll > 4 && nav.scrollLeft < maxScroll - 4);
}

/* ---------- Nav menu: bottom-sheet listing every section ---------- */
function openNavMenu(){
  openModal(`
    <div class="modal-title">Navigate</div>
    <div class="modal-sub">Jump straight to any section of Maezku Ladder.</div>
    <div class="nav-menu-list">
      ${NAV_SECTIONS.map(it=>`
        <button class="nav-menu-item ${state.tab===it.id?'active':''}" data-action="nav-menu-go" data-tab="${it.id}">
          <span class="nmi-ico">${it.svg}</span>
          <span class="nmi-text">
            <span class="nmi-label">${it.label}</span>
            <span class="nmi-desc">${it.desc}</span>
          </span>
          ${state.tab===it.id ? '<span class="nmi-current">Current</span>' : ''}
        </button>
      `).join('')}
    </div>
  `);
}

/* ---------- First-run nav hint banner (shown once per device) ---------- */
function maybeShowNavHint(){
  const root = document.getElementById('onboardingBanner');
  if(!root) return;
  if(localStorage.getItem('kl_seen_nav_hint')){ root.innerHTML=''; return; }
  root.innerHTML = `
    <div class="nav-hint">
      <span class="nav-hint-text">👋 New here? Tap <b>☰ Menu</b> (top-left) anytime to jump to Settings, Rankings, History &amp; every other section.</span>
      <button class="nav-hint-close" data-action="dismiss-nav-hint" aria-label="Dismiss tip">✕</button>
    </div>`;
}

function nudgeTabsOnce(){
  if(localStorage.getItem('kl_seen_nav_hint')) return;
  const nav = document.getElementById('tabNav');
  if(!nav) return;
  const maxScroll = nav.scrollWidth - nav.clientWidth;
  if(maxScroll <= 4) return;
  setTimeout(()=>{ nav.scrollTo({left:36, behavior:'smooth'}); }, 700);
  setTimeout(()=>{ nav.scrollTo({left:0, behavior:'smooth'}); }, 1300);
}

function renderActiveView(){
  const target = document.getElementById('view');
  switch(state.tab){
    case 'match': renderMatchView(target); break;
    case 'queue': renderQueueView(target); break;
    case 'players': renderPlayersView(target); break;
    case 'rankings': renderRankingsView(target); break;
    case 'stats': renderStatsView(target); break;
    case 'history': renderHistoryView(target); break;
    case 'settings': renderSettingsView(target); break;
  }
}

/* ============================================================
   VIEW COMPONENT GENERATORS
   ============================================================ */
function renderMatchView(el){
  // Paddle Stack Open Play
  if (state.settings.matchMode === 'PaddleStack' && state.paddleStack) {
    renderPaddleStackView(el);
    return;
  }

  // No active session at all — show mode picker
  const hasRRSession = state.settings.matchMode === 'RoundRobin' && state.currentGeneration;
  const hasOpenPlaySession = state.settings.matchMode === 'Rotation' && Array.isArray(state.rotationCourts) && state.rotationCourts.some(c => c && c.status === 'active');

  if(!hasRRSession && !hasOpenPlaySession){
    el.innerHTML = `
      <div class="empty-state">
        <div class="big"><img src="./balls.png" style="width:140px;height:140px;object-fit:contain;display:block;margin:0 auto;" alt="Pickleball balls"></div>
        <div class="et">Choose Match Mode</div>
        <p>How do you want to run today's session?</p>
        <button class="btn btn-primary" style="margin-top:14px; width:100%; padding:16px; display:flex; flex-direction:column; gap:4px; text-align:left;" data-action="pick-mode-openplay">
          <span style="font-size:16px; font-weight:700;">🏓 Open Play</span>
          <span style="font-weight:400; font-size:12px; opacity:0.85;">Paddle Stack queue or Smart Auto-Match — courts auto-rotate as they finish.</span>
        </button>
        <button class="btn btn-secondary" style="margin-top:10px; width:100%; padding:16px; display:flex; flex-direction:column; gap:4px; text-align:left;" data-action="pick-mode-roundrobin">
          <span style="font-size:16px; font-weight:700;">🔀 Round Robin</span>
          <span style="font-weight:400; font-size:12px; opacity:0.85;">Everyone is scheduled each generation with a set session length.</span>
        </button>
      </div>
    `;
    return;
  }

  if(state.settings.matchMode === 'RoundRobin') {

    const gen = state.currentGeneration;
    const activeMatches = gen.matches.filter(m => m.status === 'active').sort((a,b) => a.matchIndex - b.matchIndex);
    const queuedMatches = gen.matches.filter(m => m.status === 'queued').sort((a,b) => a.matchIndex - b.matchIndex);
    const doneCount = gen.matches.filter(m => m.status === 'done').length;

    const plan = state.settings.sessionPlan;
    const hasScheduledAhead = Array.isArray(state.scheduledGenerations) && state.scheduledGenerations.length > 0;
    let sessionProgressHtml = '';
    if(plan){
      const playedSoFar = clamp(state.matches.length - plan.matchesAtStart, 0, plan.totalMatches);
      const pct = clamp(Math.round((playedSoFar / plan.totalMatches) * 100), 0, 100);
      sessionProgressHtml = `
        <div class="session-progress-wrap" style="margin:0 2px 14px;">
          <div class="session-progress-track"><div class="session-progress-fill" style="width:${pct}%;"></div></div>
          <div class="session-progress-label">
            <span>${plan.label} · ${playedSoFar}/${plan.totalMatches} matches</span>
            <span>
              ${hasScheduledAhead ? `<button type="button" data-action="view-full-schedule" style="background:none; border:none; color:var(--court); font-size:11px; font-weight:700; cursor:pointer; padding:0; margin-right:12px;">📋 Full Schedule</button>` : ''}
              <button type="button" data-action="change-session-plan" style="background:none; border:none; color:var(--court); font-size:11px; font-weight:700; cursor:pointer; padding:0;">Change</button>
            </span>
          </div>
        </div>
      `;
    }

    // Winner vs Winner / Loser vs Loser only ever actually takes effect from
    // Generation 2 onward — it buckets players by how they did in the
    // generation that just finished, so Generation 1 never has a "last
    // generation" to bucket from. gen.wvwApplied is set precisely when the
    // bucketing logic actually ran for this generation (not just whether the
    // setting happens to be on right now), so the hint stays accurate even
    // if the toggle was changed after this generation was built.
    const wvwHintHtml = '';

    let html = `
      <div class="section-title">Round Robin — Generation ${gen.generation}</div>
      <div class="helper-text" style="margin:-4px 2px 14px;">${doneCount} of ${gen.matches.length} match${gen.matches.length===1?'':'es'} played this generation.</div>
      ${sessionProgressHtml}
      ${wvwHintHtml}
    `;

    function nameTag(matchId, team, playerId){
      const p = getPlayer(playerId);
      const justify = team === 'A' ? 'flex-end' : 'flex-start';
      const cond = p ? (p.condition || 'ok') : 'ok';
      const condBadge = cond === 'tired' ? ' 😴' : cond === 'injured' ? ' 🤕' : cond === 'cant_play' ? ' 🙅' : '';
      return `<span style="display:inline-flex; align-items:center; flex-wrap:wrap; justify-content:${justify}; gap:4px; max-width:100%;">${esc(p?.name || '—')}${condBadge}<button class="icon-btn-tiny" data-action="open-replace-player" data-match="${matchId}" data-team="${team}" data-player="${playerId}" aria-label="Replace player" title="Replace this player">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
      </button></span>`;
    }

    if(!activeMatches.length){
      html += `<div class="empty-state"><div class="big">🎉</div><div class="et">Generation ${gen.generation} complete</div><p>Head to the next generation when you're ready.</p></div>`;
    }

    activeMatches.forEach(m => {
      const activeA = m.winner === 'A', activeB = m.winner === 'B';
      if(m.serving === undefined) m.serving = 'A';
      if(m.serverNum === undefined) m.serverNum = 1;
      if(m.firstServe === undefined) m.firstServe = (m.scoreA === null && m.scoreB === null);
      const servingA = m.serving === 'A', servingB = m.serving === 'B';
      const serveLabel = m.firstServe ? '1st Serve' : `Serve ${m.serverNum}`;
      html += `
        <div class="scoreboard" style="margin-bottom:14px;">
          <div class="sb-head">
            <span class="sb-round">COURT <b>${m.court}</b></span>
            ${m.raceActive ? `<span class="race-badge">🏁 Race to 2</span>` : ''}
            <div class="live-dot"><div class="d"></div>Live</div>
          </div>
          <div class="sb-body">
            <div class="sb-team team-a">
              <span class="sb-tag">Team A</span>
              <div class="sb-names">${nameTag(m.id,'A',m.teamA[0])}<br>${duprChip(getPlayer(m.teamA[0]))}<br>${nameTag(m.id,'A',m.teamA[1])}<br>${duprChip(getPlayer(m.teamA[1]))}</div>
              <div class="sb-rating">Avg ELO: ${Math.round(((getPlayer(m.teamA[0])?.rating||1000)+(getPlayer(m.teamA[1])?.rating||1000))/2)}</div>
              ${servingA ? `<span class="serve-badge">🎾 ${serveLabel}</span>` : (m.firstServe && !(m.scoreA||0) && !(m.scoreB||0) ? `<button type="button" class="serve-set-btn" data-action="rr-set-server" data-match="${m.id}" data-team="A">Make 1st server</button>` : '')}
              <button class="btn btn-sm ${activeA ? 'btn-primary' : 'btn-secondary'} sb-winbtn" data-action="set-rr-winner" data-match="${m.id}" data-team="A">
                ${activeA ? '✓ Winner Selected' : 'Team A Wins'}
              </button>
            </div>

            <div class="sb-divider"></div>

            <div class="sb-team team-b">
              <span class="sb-tag">Team B</span>
              <div class="sb-names">${nameTag(m.id,'B',m.teamB[0])}<br>${duprChip(getPlayer(m.teamB[0]))}<br>${nameTag(m.id,'B',m.teamB[1])}<br>${duprChip(getPlayer(m.teamB[1]))}</div>
              <div class="sb-rating">Avg ELO: ${Math.round(((getPlayer(m.teamB[0])?.rating||1000)+(getPlayer(m.teamB[1])?.rating||1000))/2)}</div>
              ${servingB ? `<span class="serve-badge">🎾 ${serveLabel}</span>` : (m.firstServe && !(m.scoreA||0) && !(m.scoreB||0) ? `<button type="button" class="serve-set-btn" data-action="rr-set-server" data-match="${m.id}" data-team="B">Make 1st server</button>` : '')}
              <button class="btn btn-sm ${activeB ? 'btn-primary' : 'btn-secondary'} sb-winbtn" data-action="set-rr-winner" data-match="${m.id}" data-team="B">
                ${activeB ? '✓ Winner Selected' : 'Team B Wins'}
              </button>
            </div>
          </div>
          <div class="sb-foot rr-score-foot">
            <div class="score-stepper">
              <button type="button" class="score-btn score-btn-minus rr-score-btn" data-action="rr-score-adjust" data-match="${m.id}" data-team="A" data-delta="-1" aria-label="Decrease Team A score" ${(m.winner || !servingA || (m.scoreA === null || m.scoreA <= 0)) ? 'disabled' : ''} title="${m.winner ? 'Winner already selected' : !servingA ? 'Team A is receiving — only the serving team scores' : (m.scoreA === null || m.scoreA <= 0) ? 'Score is already at 0' : ''}">−</button>
              <input type="number" inputmode="numeric" pattern="[0-9]*" placeholder="A" class="cb-score-input rr-score-input" data-match-score="${m.id}-A" min="0" max="${getMatchWinTarget(m)}" value="${m.scoreA !== null ? m.scoreA : ''}" oninput="window.updateRRScore('${m.id}', 'A', this.value)">
              <button type="button" class="score-btn score-btn-plus rr-score-btn" data-action="rr-score-adjust" data-match="${m.id}" data-team="A" data-delta="1" aria-label="Increase Team A score" ${(m.winner || !servingA || (m.scoreA !== null && m.scoreA >= getMatchWinTarget(m)))?'disabled title="'+(m.winner?'Winner already selected':servingA?'Score is at the maximum':'Team A is receiving — only the serving team scores')+'"':''}>+</button>
            </div>
            <span class="rr-score-vs-sm">vs</span>
            <div class="score-stepper">
              <button type="button" class="score-btn score-btn-minus rr-score-btn" data-action="rr-score-adjust" data-match="${m.id}" data-team="B" data-delta="-1" aria-label="Decrease Team B score" ${(m.winner || !servingB || (m.scoreB === null || m.scoreB <= 0)) ? 'disabled' : ''} title="${m.winner ? 'Winner already selected' : !servingB ? 'Team B is receiving — only the serving team scores' : (m.scoreB === null || m.scoreB <= 0) ? 'Score is already at 0' : ''}">−</button>
              <input type="number" inputmode="numeric" pattern="[0-9]*" placeholder="B" class="cb-score-input rr-score-input" data-match-score="${m.id}-B" min="0" max="${getMatchWinTarget(m)}" value="${m.scoreB !== null ? m.scoreB : ''}" oninput="window.updateRRScore('${m.id}', 'B', this.value)">
              <button type="button" class="score-btn score-btn-plus rr-score-btn" data-action="rr-score-adjust" data-match="${m.id}" data-team="B" data-delta="1" aria-label="Increase Team B score" ${(m.winner || !servingB || (m.scoreB !== null && m.scoreB >= getMatchWinTarget(m)))?'disabled title="'+(m.winner?'Winner already selected':servingB?'Score is at the maximum':'Team B is receiving — only the serving team scores')+'"':''}>+</button>
            </div>
          </div>
          <div style="padding:0 14px 14px;">
            <div style="display:flex; gap:8px; margin-bottom:10px;">
              <button class="btn btn-secondary btn-sm" style="flex:1;" data-action="rr-advance-server" data-match="${m.id}" ${(m.firstServe || m.serverNum===2)?'disabled':''}>🎾 Switch to Serve 2</button>
              <button class="btn btn-secondary btn-sm sideout-btn" style="flex:1;" data-action="rr-side-out" data-match="${m.id}" ${(m.winner || (!m.firstServe && m.serverNum===1))?'disabled':''}>🔁 Side Out</button>
              <button class="btn btn-ghost btn-sm undo-serve-btn" data-action="rr-undo-serve" data-match="${m.id}" title="Undo the last serve decision (1st server / serve 2 / side out)" ${(!m._serveUndoStack || !m._serveUndoStack.length)?'disabled':''}>↩️${(m._serveUndoStack && m._serveUndoStack.length) ? ' '+m._serveUndoStack.length : ''}</button>
            </div>
            <button class="btn btn-primary btn-block" data-action="confirm-rr-match" data-match="${m.id}">Confirm Result &amp; Pull Next Match</button>
            <div style="display:flex; gap:8px; margin-top:8px;">
              <button class="btn btn-ghost btn-sm" style="flex:1;" data-action="rr-skip-match" data-match="${m.id}" title="${m.winner ? 'This match already has a winner selected' : hasMatchStarted(m) ? 'Scoring has started — finish or undo the match instead' : 'Move this match to the back of the queue'}" ${(m.winner || hasMatchStarted(m)) ? 'disabled' : ''}>⏭️ Skip Match</button>
              <button class="btn btn-ghost btn-sm" style="flex:1; color:var(--loss);" data-action="rr-forfeit-match" data-match="${m.id}" title="${m.winner ? 'This match already has a winner selected' : hasMatchStarted(m) ? 'Scoring has started — finish or undo the match instead' : 'Record this match as a forfeit'}" ${(m.winner || hasMatchStarted(m)) ? 'disabled' : ''}>🚩 Forfeit Match</button>
            </div>
          </div>
        </div>
      `;
    });

    if(queuedMatches.length){
      html += `<div class="section-title">Up Next (${queuedMatches.length})</div><div class="card" style="padding:6px 4px;">`;
      queuedMatches.forEach((m, i) => {
        const pA1 = getPlayer(m.teamA[0]), pA2 = getPlayer(m.teamA[1]);
        const pB1 = getPlayer(m.teamB[0]), pB2 = getPlayer(m.teamB[1]);
        const condFlag = pl => pl && pl.condition === 'tired' ? ' 😴' : pl && pl.condition === 'injured' ? ' 🤕' : pl && pl.condition === 'cant_play' ? ' 🙅' : '';
        html += `
          <div class="queue-row">
            <span class="qrank">${i+1}</span>
            <div style="flex:1; font-size:13px; min-width:0;">
              <strong>${esc(pA1?.name||'—')}${condFlag(pA1)} &amp; ${esc(pA2?.name||'—')}${condFlag(pA2)}</strong>
              <span style="color:var(--text-faint);"> vs </span>
              <strong>${esc(pB1?.name||'—')}${condFlag(pB1)} &amp; ${esc(pB2?.name||'—')}${condFlag(pB2)}</strong>
            </div>
            <button class="icon-btn-tiny" data-action="open-replace-picker" data-match="${m.id}" aria-label="Replace a player in this upcoming match" title="Swap a player on this upcoming match">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
            </button>
          </div>
        `;
      });
      html += `</div>`;
    }

    if(gen.sittingOut && gen.sittingOut.length){
      html += `
        <div class="section-title">Sitting Out This Generation (${gen.sittingOut.length})</div>
        <div class="card"><div class="helper-text" style="margin:0;">${gen.sittingOut.map(id=>esc(playerName(id))).join(', ')}</div></div>
      `;
    }

    html += `
      <div class="card" style="margin-top:14px;">
        <div style="display:flex; gap:8px;">
          <button class="btn btn-secondary btn-sm" style="flex:1;" data-action="skip-match">Reset Generation</button>
          <button class="btn btn-danger btn-sm" style="flex:1;" data-action="undo-match" ${!state.undo?'disabled':''}>Undo Last Match</button>
        </div>
      </div>
    `;
    el.innerHTML = html;

    // Attach global helper cleanly to bridge input elements smoothly without complex re-render interruptions
    window.updateRRScore = function(matchId, team, val){
      updateMatchScore(liveMatchCtx('rr', matchId), team, val);
    };
    return;
  }

  // CONTINUOUS SMART OPEN PLAY — ROTATION MODE (multi-court, event-driven)
  const courts = Array.isArray(state.rotationCourts) ? state.rotationCourts.filter(c => c && c.status === 'active') : [];

  let html = `<div class="section-title">🏓 Continuous Open Play — ${courts.length} Court${courts.length!==1?'s':''} Live</div>`;



  courts.sort((a,b) => a.courtNum - b.courtNum);
  courts.forEach(m => {
    html += renderRotationCourtScoreboard(m);
  });

  html += `
    <div class="card" style="margin-top:14px;">
      <div style="display:flex; gap:8px;">
        <button class="btn btn-secondary btn-sm" style="flex:1;" data-action="add-csop-court">➕ Add Court</button>
        <button class="btn btn-danger btn-sm" style="flex:1;" data-action="end-open-play">⏹️ End Session</button>
      </div>
    </div>
  `;

  el.innerHTML = html;

  window.updateRCScore = function(courtId, team, val) {
    updateRotationCourtScore(courtId, team, val);
  };
  return;
}

function _renderMatchViewOriginalRotation(el) {
  if(!state.current){
    el.innerHTML = `
      <div class="empty-state">
        <div class="big">🏓</div>
        <div class="et">Court is clear</div>
        <p>Ready to select players and spin up a balanced match pairing.</p>
        <button class="btn btn-primary" style="margin-top:16px;" data-action="generate-roundrobin">Generate Match</button>
      </div>
    `;
    return;
  }

  const c = state.current;
  const pA1 = getPlayer(c.teamA[0]), pA2 = getPlayer(c.teamA[1]);
  const pB1 = getPlayer(c.teamB[0]), pB2 = getPlayer(c.teamB[1]);
  if(c.serving === undefined) c.serving = 'A';
  if(c.serverNum === undefined) c.serverNum = 1;
  if(c.firstServe === undefined) c.firstServe = (c.scoreA === null && c.scoreB === null);
  if(c.winner === undefined) c.winner = null;
  const servingA = c.serving === 'A', servingB = c.serving === 'B';
  const serveLabel = c.firstServe ? '1st Serve' : `Serve ${c.serverNum}`;
  const activeA = c.winner === 'A', activeB = c.winner === 'B';

  function curNameTag(team, playerId){
    const p = getPlayer(playerId);
    const justify = team === 'A' ? 'flex-end' : 'flex-start';
    const cond = p ? (p.condition || 'ok') : 'ok';
    const condBadge = cond === 'tired' ? ' 😴' : cond === 'injured' ? ' 🤕' : cond === 'cant_play' ? ' 🙅' : '';
    return `<span style="display:inline-flex; align-items:center; flex-wrap:wrap; justify-content:${justify}; gap:4px; max-width:100%;">${esc(p?.name || '')}${condBadge}<button class="icon-btn-tiny" data-action="open-replace-current-player" data-team="${team}" data-player="${playerId}" aria-label="Replace player" title="Replace this player">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
    </button></span>`;
  }

  el.innerHTML = `
    <div class="section-title">Current Match Dashboard</div>
    <div class="scoreboard">
      <div class="sb-head">
        <span class="sb-round">MATCH <b>#${c.round}</b></span>
        ${c.raceActive ? `<span class="race-badge">🏁 Race to 2</span>` : ''}
        <div class="live-dot"><div class="d"></div>Live</div>
      </div>
      <div class="sb-body">
        <div class="sb-team team-a">
          <span class="sb-tag">Team A</span>
          <div class="sb-names">${curNameTag('A', c.teamA[0])}<br>${duprChip(pA1)}<br>${curNameTag('A', c.teamA[1])}<br>${duprChip(pA2)}</div>
          <div class="sb-rating">Avg ELO: ${Math.round(((pA1?.rating||1000)+(pA2?.rating||1000))/2)}</div>
          ${servingA ? `<span class="serve-badge">🎾 ${serveLabel}</span>` : (c.firstServe && !(c.scoreA||0) && !(c.scoreB||0) ? `<button type="button" class="serve-set-btn" data-action="rotation-set-server" data-team="A">Make 1st server</button>` : '')}
          <button id="rotationWinBtnA" class="btn btn-sm ${activeA ? 'btn-primary' : 'btn-secondary'} sb-winbtn" data-action="set-rotation-winner" data-team="A">
            ${activeA ? '✓ Winner Selected' : 'Team A Wins'}
          </button>
        </div>
        
        <div class="sb-divider"></div>
        
        <div class="sb-team team-b">
          <span class="sb-tag">Team B</span>
          <div class="sb-names">${curNameTag('B', c.teamB[0])}<br>${duprChip(pB1)}<br>${curNameTag('B', c.teamB[1])}<br>${duprChip(pB2)}</div>
          <div class="sb-rating">Avg ELO: ${Math.round(((pB1?.rating||1000)+(pB2?.rating||1000))/2)}</div>
          ${servingB ? `<span class="serve-badge">🎾 ${serveLabel}</span>` : (c.firstServe && !(c.scoreA||0) && !(c.scoreB||0) ? `<button type="button" class="serve-set-btn" data-action="rotation-set-server" data-team="B">Make 1st server</button>` : '')}
          <button id="rotationWinBtnB" class="btn btn-sm ${activeB ? 'btn-primary' : 'btn-secondary'} sb-winbtn" data-action="set-rotation-winner" data-team="B">
            ${activeB ? '✓ Winner Selected' : 'Team B Wins'}
          </button>
        </div>
      </div>
    </div>

    <div class="section-title" style="margin-top:24px;">Enter Match Scores</div>
    <div class="card">
      <div class="cb-score-row">
        <div class="cb-score-team">
          <span class="cb-score-label">Team A Score</span>
          <div class="score-stepper">
            <button type="button" class="score-btn score-btn-minus" data-action="rotation-score-adjust" data-team="A" data-delta="-1" aria-label="Decrease Team A score" ${(c.winner || !servingA || (c.scoreA === null || c.scoreA <= 0)) ? 'disabled' : ''} title="${c.winner ? 'Winner already selected' : !servingA ? 'Team A is receiving — only the serving team scores' : (c.scoreA === null || c.scoreA <= 0) ? 'Score is already at 0' : ''}">−</button>
            <input type="number" pattern="[0-9]*" inputmode="numeric" class="cb-score-input" id="scoreA" placeholder="0" min="0" max="${getMatchWinTarget(c)}" value="${c.scoreA !== null && c.scoreA !== undefined ? c.scoreA : ''}" oninput="window.updateRotationScoreInput('A', this.value)">
            <button type="button" class="score-btn score-btn-plus" data-action="rotation-score-adjust" data-team="A" data-delta="1" aria-label="Increase Team A score" ${(c.winner || !servingA || (c.scoreA !== null && c.scoreA >= getMatchWinTarget(c)))?'disabled title="'+(c.winner?'Winner already selected':servingA?'Score is at the maximum':'Team A is receiving — only the serving team scores')+'"':''}>+</button>
          </div>
        </div>
        <div class="cb-score-vs">vs</div>
        <div class="cb-score-team">
          <span class="cb-score-label">Team B Score</span>
          <div class="score-stepper">
            <button type="button" class="score-btn score-btn-minus" data-action="rotation-score-adjust" data-team="B" data-delta="-1" aria-label="Decrease Team B score" ${(c.winner || !servingB || (c.scoreB === null || c.scoreB <= 0)) ? 'disabled' : ''} title="${c.winner ? 'Winner already selected' : !servingB ? 'Team B is receiving — only the serving team scores' : (c.scoreB === null || c.scoreB <= 0) ? 'Score is already at 0' : ''}">−</button>
            <input type="number" pattern="[0-9]*" inputmode="numeric" class="cb-score-input" id="scoreB" placeholder="0" min="0" max="${getMatchWinTarget(c)}" value="${c.scoreB !== null && c.scoreB !== undefined ? c.scoreB : ''}" oninput="window.updateRotationScoreInput('B', this.value)">
            <button type="button" class="score-btn score-btn-plus" data-action="rotation-score-adjust" data-team="B" data-delta="1" aria-label="Increase Team B score" ${(c.winner || !servingB || (c.scoreB !== null && c.scoreB >= getMatchWinTarget(c)))?'disabled title="'+(c.winner?'Winner already selected':servingB?'Score is at the maximum':'Team B is receiving — only the serving team scores')+'"':''}>+</button>
          </div>
        </div>
      </div>
      <div style="display:flex; gap:8px; margin-top:10px;">
        <button class="btn btn-secondary" style="flex:1;" data-action="rotation-advance-server" ${(c.firstServe || c.serverNum===2)?'disabled':''}>🎾 Switch to Serve 2</button>
        <button class="btn btn-secondary sideout-btn" style="flex:1;" data-action="rotation-side-out" ${(c.winner || (!c.firstServe && c.serverNum===1))?'disabled':''}>🔁 Side Out</button>
        <button class="btn btn-ghost undo-serve-btn" data-action="rotation-undo-serve" title="Undo the last serve decision (1st server / serve 2 / side out)" ${(!c._serveUndoStack || !c._serveUndoStack.length)?'disabled':''}>↩️${(c._serveUndoStack && c._serveUndoStack.length) ? ' '+c._serveUndoStack.length : ''}</button>
      </div>
      <button class="btn btn-primary btn-block" style="margin-top:12px;" data-action="save-match-score">Submit Final Score</button>
      <div style="display:flex; gap:8px; margin-top:8px;">
        <button class="btn btn-ghost btn-sm" style="flex:1;" data-action="skip-match">Clear Match</button>
        <button class="btn btn-danger btn-sm" style="flex:1;" data-action="undo-match" ${!state.undo?'disabled':''}>Undo Previous Match</button>
      </div>
    </div>
  `;

  window.updateRotationScoreInput = function(team, val){
    updateMatchScore(liveMatchCtx('rotation', null), team, val);
  };
}

// (Legacy single-court rotation kept for undo recovery — not used in CSOP flow)

function renderQueueView(el){
  // Paddle Stack mode — show the PS queue instead
  if (state.settings.matchMode === 'PaddleStack' && state.paddleStack) {
    renderPaddleStackQueueView(el);
    return;
  }

  const activeList = csoActivePlayers().slice();
  const now = state.round;
  activeList.forEach(p => {
    ensureCSOP(p);
    if(p.sitOutPriority === undefined) p.sitOutPriority = 0;
    if(p.waitingRounds === undefined) p.waitingRounds = 0;
  });

  const onCourtIds = new Set();
  if (state.settings.matchMode === 'Rotation' && Array.isArray(state.rotationCourts)) {
    state.rotationCourts.filter(c=>c&&c.status==='active').forEach(c => {
      c.teamA.forEach(id => onCourtIds.add(id));
      c.teamB.forEach(id => onCourtIds.add(id));
    });
  }

  activeList.sort((a,b) => {
    // On-court players go to the bottom
    const aOnCourt = onCourtIds.has(a.id) ? 1 : 0;
    const bOnCourt = onCourtIds.has(b.id) ? 1 : 0;
    if (aOnCourt !== bOnCourt) return aOnCourt - bOnCourt;
    if(a.gamesPlayed !== b.gamesPlayed) return a.gamesPlayed - b.gamesPlayed;
    const pa = csoPlayerPriority(b, now), pb = csoPlayerPriority(a, now);
    if(pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name);
  });

  if(!activeList.length){
    el.innerHTML = `<div class="empty-state"><div class="big">👥</div><p>No active players currently in line.</p></div>`;
    return;
  }

  el.innerHTML = `
    <div class="section-title">Queue Priority Rankings</div>
    <p class="helper-text" style="margin:-4px 2px 10px;">Players on court are shown at the bottom. Priority score drives who's selected next — higher = sooner on court.</p>
    <div class="card" style="padding:10px 4px;">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="padding-left:12px; width:50px;">#</th>
              <th>Player</th>
              <th style="text-align:center;">Games</th>
              <th style="text-align:center;">Priority</th>
              <th style="text-align:center;">Streak</th>
              <th style="text-align:center;">Status</th>
            </tr>
          </thead>
          <tbody>
            ${activeList.map((p, idx) => {
              const onCourt = onCourtIds.has(p.id);
              const pri = Math.round(csoPlayerPriority(p, now));
              const streakWarn = p.streakGames >= 4 ? '🔥🔥' : p.streakGames >= 3 ? '🔥' : '';
              const statusLabel = onCourt ? `<span style="color:var(--win); font-size:11px; font-weight:700;">▶ On Court</span>` : `<span style="color:var(--text-faint); font-size:11px;">⏳ Waiting</span>`;
              return `
              <tr style="${onCourt ? 'opacity:0.55;' : ''}">
                <td style="padding-left:12px;"><span class="qrank">${idx+1}</span></td>
                <td class="namecell"><strong>${esc(p.name)}</strong></td>
                <td style="text-align:center;">${p.gamesPlayed}</td>
                <td style="text-align:center; color:var(--ball); font-weight:700;">${pri}</td>
                <td style="text-align:center; color:var(--court);">${p.streakGames || 0}${streakWarn}</td>
                <td style="text-align:center;">${statusLabel}</td>
              </tr>
            `}).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderPlayersView(el){
  const total = state.players.length;
  let html = `
    <div class="add-player-card">
      <div class="field" style="margin-bottom:8px;">
        <label>Add Player</label>
        <div class="add-player-row">
          <input type="text" id="newPlayerName" placeholder="Enter name…">
          <button class="btn btn-primary" data-action="do-add-player">Add</button>
        </div>
      </div>
      <div class="field" style="margin-bottom:8px;">
        <label>DUPR Rating <span style="font-weight:400; color:var(--text-faint); text-transform:none; letter-spacing:0;">(optional)</span></label>
        <input type="number" id="newPlayerDupr" step="0.001" min="1" max="8" placeholder="e.g. 3.067" style="font-size:14px;">
      </div>
      <label class="sub-toggle-row">
        <input type="checkbox" id="newPlayerIsSub">
        <span class="sub-toggle-label">🔁 Register as Sub Player</span>
      </label>
      <p class="sub-toggle-hint">Sub Players sit on the bench out of normal rotation — they only appear in the "Replace Player" picker when someone needs to be swapped out.</p>
      <div style="margin-top:10px;">
        <button class="btn btn-ghost btn-sm btn-block" data-action="open-bulk-import">Bulk Import Names</button>
      </div>
    </div>
  `;

  if(!total){
    html += `<div class="empty-state"><div class="big">🗂️</div><p>No players yet. Add one above to get going!</p></div>`;
    el.innerHTML = html;
    return;
  }

  function statusPill(p){
    const key = playerStatusKey(p);
    const d = STATUS_DEFS[key];
    return `<button class="pill ${d.pillClass}" data-action="open-player-status" data-id="${p.id}" title="Tap to set status">${d.label}</button>`;
  }

  function playerRow(p){
    const duoPartner = getFixedDuoPartner(p.id);
    const duoLabel = duoPartner ? `<span style="color:var(--ball); font-size:11px; font-weight:700; background:rgba(215,242,61,0.08); border:1px solid rgba(215,242,61,0.2); border-radius:999px; padding:2px 7px;">🔗 ${esc(playerName(duoPartner))}</span>` : '';
    const avatarClass = p.isSub ? 'avatar sub-avatar' : 'avatar';
    const avatarIcon = p.isSub ? '🔁' : initials(p.name);
    const winRate = p.gamesPlayed > 0 ? `${winPct(p)}% WR` : 'No games';
    const ratingColor = p.rating >= 1100 ? 'var(--win)' : p.rating >= 950 ? 'var(--ball)' : 'var(--text-faint)';
    return `
      <div class="player-row">
        <div class="${avatarClass}">${avatarIcon}</div>
        <div class="pinfo">
          <div class="pname">
            ${esc(p.name)}
            ${duoLabel}
          </div>
          <div class="pmeta">
            <span>${p.gamesPlayed} gms</span>
            <span class="dot-sep">·</span>
            <span style="color:${ratingColor};">ELO ${p.rating}</span>
            <span class="dot-sep">·</span>
            <span style="color:var(--court);">DUPR ${duprStr(p)}</span>
            <span class="dot-sep">·</span>
            <span>${winRate}</span>
          </div>
          <div style="margin-top:6px; display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
            ${statusPill(p)}
          </div>
        </div>
        <div class="row-actions">
          <button class="icon-btn" data-action="open-edit-player" data-id="${p.id}" title="Edit player">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          </button>
        </div>
      </div>
    `;
  }

  // Sort: active first, then alphabetically
  const mainRoster = state.players.filter(p => !p.isSub).sort((a,b)=>{
    if(a.active !== b.active) return b.active ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  const subRoster = state.players.filter(p => p.isSub).sort((a,b)=> a.name.localeCompare(b.name));

  const activeCount = mainRoster.filter(p=>p.active).length;
  const pausedCount = mainRoster.filter(p=>!p.active).length;

  html += `
    <div class="players-section-header">
      <span class="psh-title">Main Roster</span>
      <span class="psh-badge">${activeCount} active${pausedCount ? ` · ${pausedCount} paused` : ''}</span>
    </div>
  `;
  html += mainRoster.length
    ? `<div class="card" style="padding:4px 12px; margin-bottom:8px;">${mainRoster.map(playerRow).join('')}</div>`
    : `<div class="empty-state" style="margin-bottom:16px;"><p>No regular players yet.</p></div>`;

  html += `
    <div class="players-section-header">
      <span class="psh-title">🔁 Sub Players</span>
      <span class="psh-badge">${subRoster.length} registered</span>
    </div>
    <p class="helper-text" style="margin:-4px 2px 10px; font-size:12px;">Bench reserves. Not scheduled in normal matchmaking — only appear in the "Replace Player" picker when someone needs to be swapped out mid-match.</p>
  `;
  html += subRoster.length
    ? `<div class="card" style="padding:4px 12px;">${subRoster.map(playerRow).join('')}</div>`
    : `<div class="empty-state"><div style="font-size:22px;margin-bottom:6px;">🪑</div><p style="font-size:13px;">No Sub Players yet.<br>Check "Register as Sub Player" above to add one.</p></div>`;

  el.innerHTML = html;
}

let rankSort = 'rating';
function renderRankingsView(el){
  let pool = state.players.slice();
  const avgCache = new Map();
  const avgOf = p => {
    if(!avgCache.has(p.id)) avgCache.set(p.id, playerScoreAverages(p.id));
    return avgCache.get(p.id);
  };

  pool.sort((a,b)=>{
    if(rankSort === 'rating') return b.rating - a.rating;
    if(rankSort === 'winpct') return winPct(b) - winPct(a);
    if(rankSort === 'games') return b.gamesPlayed - a.gamesPlayed;
    if(rankSort === 'avgscore') return avgOf(b).avgFor - avgOf(a).avgFor;
    return b.rating - a.rating;
  });

  el.innerHTML = `
    <div class="section-title">Ladder Rankings</div>
    <div class="sort-bar scroll-hide">
      <div class="sort-chip ${rankSort==='rating'?'active':''}" data-action="rank-sort" data-sort="rating">By Rating (Elo)</div>
      <div class="sort-chip ${rankSort==='winpct'?'active':''}" data-action="rank-sort" data-sort="winpct">By Win %</div>
      <div class="sort-chip ${rankSort==='games'?'active':''}" data-action="rank-sort" data-sort="games">By Games Played</div>
      <div class="sort-chip ${rankSort==='avgscore'?'active':''}" data-action="rank-sort" data-sort="avgscore">By Avg Score</div>
    </div>
    <p class="helper-text" style="margin:-2px 2px 10px;">Tap a player's name for their full profile. "Avg Score" is points scored per game; "Margin" is points scored minus points allowed per game.</p>

    <div class="card" style="padding:10px 4px;">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="padding-left:12px; width:46px;">Rank</th>
              <th>Player</th>
              <th style="text-align:center;">Games</th>
              <th style="text-align:center;">W - L</th>
              <th style="text-align:center;">Win %</th>
              <th style="text-align:center;">ELO</th>
              <th style="text-align:center; color:var(--court);">DUPR</th>
              <th style="text-align:center;">Avg Score</th>
              <th style="text-align:center;">Margin</th>
              <th style="text-align:center;">Streak</th>
              <th style="text-align:center; padding-right:12px;">Sit Out</th>
            </tr>
          </thead>
          <tbody>
            ${pool.map((p, idx)=> {
              const strK = p.currentStreak || 0;
              let streakClass = 'streak-0';
              let streakTxt = '—';
              if(strK > 0) { streakClass = 'streak-w'; streakTxt = `W${strK}`; }
              else if(strK < 0) { streakClass = 'streak-l'; streakTxt = `L${Math.abs(strK)}`; }
              const avg = avgOf(p);
              const marginColor = avg.avgMargin > 0 ? 'var(--win)' : avg.avgMargin < 0 ? 'var(--loss)' : 'var(--text-faint)';
              const marginTxt = avg.games ? (avg.avgMargin > 0 ? `+${avg.avgMargin}` : avg.avgMargin) : '—';

              return `
                <tr class="rank-${idx+1}">
                  <td style="padding-left:12px;" class="rankbadge">${idx+1}</td>
                  <td class="namecell">
                    <button class="rank-name-btn" data-action="open-player-profile" data-id="${p.id}" title="View ${esc(p.name)}'s full profile">${esc(p.name)}</button>
                  </td>
                  <td style="text-align:center;">${p.gamesPlayed}</td>
                  <td style="text-align:center; font-size:11.5px; color:var(--text-dim);">${p.wins} - ${p.losses}</td>
                  <td style="text-align:center;" class="txt-win">${winPct(p)}%</td>
                  <td style="text-align:center; font-weight:700; color:var(--ball);">${p.rating}</td>
                  <td style="text-align:center; font-weight:700; color:var(--court);">${duprStr(p)}</td>
                  <td style="text-align:center; color:var(--court);">${avg.games ? avg.avgFor : '—'}</td>
                  <td style="text-align:center; font-weight:700; color:${marginColor};">${marginTxt}</td>
                  <td style="text-align:center;"><span class="streak-chip ${streakClass}">${streakTxt}</span></td>
                  <td style="text-align:center; padding-right:12px; color:var(--text-faint);">${p.sitOuts || 0}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderStatsView(el){
  if(!state.players.length){
    el.innerHTML = `<div class="empty-state"><div class="big">📊</div><p>No players recorded yet.</p></div>`;
    return;
  }

  let html = `<div class="section-title">Player Statistics</div>`;

  state.players.forEach(p => {
    // Determine highest frequency/common teammates and opponents safely
    let tmPairs = Object.entries(p.teammates || {}).map(([id, c]) => ({ name: playerName(id), count: c }));
    tmPairs.sort((a,b) => b.count - a.count);
    let topTeammates = tmPairs.slice(0,2).map(x => `${x.name} (${x.count}x)`).join(', ') || 'None';

    let opPairs = Object.entries(p.opponents || {}).map(([id, c]) => ({ name: playerName(id), count: c }));
    opPairs.sort((a,b) => b.count - a.count);
    let topOpponents = opPairs.slice(0,2).map(x => `${x.name} (${x.count}x)`).join(', ') || 'None';

    html += `
      <div class="card" style="margin-bottom:12px;">
        <div style="font-weight:800; font-size:15px; color:var(--ball); margin-bottom:8px;">${esc(p.name)}</div>
        <div class="stat-grid">
          <div class="stat-box"><div class="sv">${p.wins}</div><div class="sl">Wins</div></div>
          <div class="stat-box"><div class="sv">${p.losses}</div><div class="sl">Losses</div></div>
          <div class="stat-box"><div class="sv" style="color:var(--court);">${p.longestStreak||0}</div><div class="sl">Max Streak</div></div>
        </div>
        <div class="stat-grid" style="margin-top:8px;">
          <div class="stat-box"><div class="sv" style="color:var(--text-dim);">${p.sitOuts || 0}</div><div class="sl">Total Sits</div></div>
          <div class="stat-box"><div class="sv" style="color:var(--text-faint);">${p.rating}</div><div class="sl">ELO Rating</div></div>
          <div class="stat-box"><div class="sv" style="color:var(--court);">${duprStr(p)}</div><div class="sl">DUPR</div></div>
        </div>
        <div style="margin-top:10px; font-size:12px; line-height:1.4; color:var(--text-dim); border-top:1px solid var(--line-soft); padding-top:8px;">
          <div><strong>Common Teammates:</strong> ${esc(topTeammates)}</div>
          <div style="margin-top:3px;"><strong>Common Opponents:</strong> ${esc(topOpponents)}</div>
        </div>
      </div>
    `;
  });

  el.innerHTML = html;
}

function renderHistoryView(el){
  let matches = state.matches.slice().reverse();

  let html = `
    <div class="card" style="margin-bottom:12px; padding:10px 14px;">
      <input type="text" id="histSearch" placeholder="🔍 Search match history…" style="font-size:14px; padding:8px 12px;">
      <button class="btn btn-secondary btn-sm btn-block" style="margin-top:10px;" data-action="show-session-summary">🏆 View Session Summary</button>
    </div>
    <div class="section-title">Match History (${matches.length})</div>
  `;

  if(!matches.length){
    html += `<div class="empty-state"><div class="big">🗓️</div><p>No match history yet.</p></div>`;
    el.innerHTML = html;
    return;
  }

  html += '<div id="histItemsContainer">';
  matches.forEach(m => {
    const pA1 = playerName(m.teamA[0]), pA2 = playerName(m.teamA[1]);
    const pB1 = playerName(m.teamB[0]), pB2 = playerName(m.teamB[1]);
    const isGen = m.generation !== undefined;

    // Build substitution notes
    let subNotes = '';
    if(m.substitutions && Object.keys(m.substitutions).length){
      const notes = Object.entries(m.substitutions).map(([origId, subId]) => {
        return `<span>${esc(playerName(origId))} subbed out for <strong style="color:var(--ball);">${esc(playerName(subId))}</strong></span>`;
      });
      subNotes = `<div class="hist-sub-note">🔁 ${notes.join(' · ')}</div>`;
    }

    html += `
      <div class="hist-item" data-search-string="${esc(pA1.toLowerCase())} ${esc(pA2.toLowerCase())} ${esc(pB1.toLowerCase())} ${esc(pB2.toLowerCase())}">
        <div class="hist-top">
          <span class="hist-round">${isGen ? `Generation ${m.generation} · Court ${m.court||1}` : `Match #${m.round}`}</span>
          <span class="hist-round" style="color:var(--text-faint);">${fmtDate(m.date)}</span>
        </div>
        <div class="hist-teams">
          <div class="hist-team ${m.scoreA > m.scoreB ? 'winner' : 'loser'}">${esc(pA1)} / ${esc(pA2)}</div>
          <div class="hist-vs mono">${m.scoreA}-${m.scoreB}</div>
          <div class="hist-team ${m.scoreB > m.scoreA ? 'winner' : 'loser'}">${esc(pB1)} / ${esc(pB2)}</div>
        </div>
        ${subNotes}
      </div>
    `;
  });
  html += '</div>';
  el.innerHTML = html;

  // Live filter lookup binding seamlessly without full structural invalidation
  const input = document.getElementById('histSearch');
  if(input) {
    input.addEventListener('input', function(e){
      const q = e.target.value.toLowerCase().trim();
      const rows = document.querySelectorAll('#histItemsContainer .hist-item');
      rows.forEach(r => {
        const str = r.dataset.searchString || '';
        if(!q || str.includes(q)) r.style.display = 'block';
        else r.style.display = 'none';
      });
    });
  }
}

function renderSettingsView(el){

  el.innerHTML = `
    <div class="section-title">Match Settings</div>
    <div class="card">

      <div class="toggle-row">
        <div>
          <div class="t-label">Winner vs Winner / Loser vs Loser</div>
          <div class="t-hint">Next generation pairs last generation's winners together and losers together, while still balancing games played.</div>
        </div>
        <label class="switch">
          <input type="checkbox" id="winnerVsWinnerToggle" ${state.settings.winnerVsWinner ? 'checked' : ''}>
          <div class="track"></div><div class="thumb"></div>
        </label>
      </div>

      <div class="toggle-row">
        <div>
          <div class="t-label">🔊 Audio Scoring</div>
          <div class="t-hint">Play sound cues for +/- points, side-outs, and game wins.</div>
        </div>
        <label class="switch">
          <input type="checkbox" id="audioScoringToggle" ${state.settings.audioScoring !== false ? 'checked' : ''}>
          <div class="track"></div><div class="thumb"></div>
        </label>
      </div>

      <div class="toggle-row">
        <div>
          <div class="t-label">🗣️ Voice Announce</div>
          <div class="t-hint">Speak the score call out loud — server's score first, then opponent's, then server number (e.g. "2 1 1") — and say "Side out" on a side-out.</div>
        </div>
        <label class="switch">
          <input type="checkbox" id="voiceAnnounceToggle" ${state.settings.voiceAnnounce !== false ? 'checked' : ''}>
          <div class="track"></div><div class="thumb"></div>
        </label>
      </div>

      <div class="toggle-row">
        <div>
          <div class="t-label">🏁 Race to 2</div>
          <div class="t-hint">When both teams reach 10–10 (Love–Love), offer a sudden-death Race to 2 — first team to 2 points wins — instead of continuing to the winning score above.</div>
        </div>
        <label class="switch">
          <input type="checkbox" id="raceToTwoToggle" ${state.settings.raceToTwo ? 'checked' : ''}>
          <div class="track"></div><div class="thumb"></div>
        </label>
      </div>

      <button class="btn btn-primary btn-block" style="margin-top:18px;" data-action="save-settings">Save Settings</button>
    </div>

    <div class="section-title" style="margin-top:20px;">Backup &amp; Restore</div>
    <div class="card" style="display:flex; gap:8px;">
      <button class="btn btn-secondary btn-sm" style="flex:1;" data-action="export-data">Export Backup</button>
      <button class="btn btn-ghost btn-sm" style="flex:1;" data-action="open-import-data">Import Backup</button>
    </div>

    <div class="section-title" style="margin-top:20px;">Session</div>
    <div class="card">
      <button class="btn btn-secondary btn-block" data-action="show-session-summary">🏆 View Session Summary</button>
      <button class="btn btn-secondary btn-block" style="margin-top:8px;" data-action="open-session-history">📋 Session History</button>
    </div>

    <div class="section-title" style="margin-top:20px; color:var(--loss);">Danger Zone</div>
    <div class="card">
      <p class="helper-text" style="margin-top:0;">Wipe stats or start completely fresh. These actions can't be undone.</p>
      <button class="btn btn-danger btn-block" data-action="open-danger-zone">Clear / Reset Options</button>
    </div>

    <div class="section-title" style="margin-top:20px;">Fixed Duos 🔗</div>
    <div class="card">
      <p class="helper-text" style="margin-top:0;">Lock two players together so they always play on the same team when both are active.</p>
      ${(state.fixedDuos && state.fixedDuos.length) ? state.fixedDuos.map(([id1,id2]) => `
        <div style="display:flex; align-items:center; justify-content:space-between; padding:8px 0; border-bottom:1px solid var(--line-soft);">
          <span style="font-weight:700; font-size:13.5px;">${esc(playerName(id1))} <span style="color:var(--ball);">🔗</span> ${esc(playerName(id2))}</span>
          <button class="btn btn-ghost btn-sm" data-action="remove-fixed-duo" data-p1="${id1}" data-p2="${id2}">Remove</button>
        </div>
      `).join('') : `<p class="helper-text" style="margin:0; color:var(--text-faint);">No fixed duos set.</p>`}
      <button class="btn btn-secondary btn-block" style="margin-top:12px;" data-action="open-add-fixed-duo">+ Add Fixed Duo</button>
    </div>
  `;
}

function saveSettingsFromForm(){
  const numCourtsVal = document.getElementById('numCourtsInput') ? parseInt(document.getElementById('numCourtsInput').value, 10) || 1 : 1;
  const winnerVsWinnerVal = document.getElementById('winnerVsWinnerToggle') ? document.getElementById('winnerVsWinnerToggle').checked : true;
  const audioScoringVal = document.getElementById('audioScoringToggle') ? document.getElementById('audioScoringToggle').checked : true;
  const voiceAnnounceVal = document.getElementById('voiceAnnounceToggle') ? document.getElementById('voiceAnnounceToggle').checked : true;
  const winningScoreRaw = document.getElementById('winningScoreInput') ? parseInt(document.getElementById('winningScoreInput').value, 10) : 11;
  const raceToTwoVal = document.getElementById('raceToTwoToggle') ? document.getElementById('raceToTwoToggle').checked : false;

  state.settings.numCourts = numCourtsVal;
  state.settings.winnerVsWinner = winnerVsWinnerVal;
  state.settings.audioScoring = audioScoringVal;
  state.settings.voiceAnnounce = voiceAnnounceVal;
  state.settings.winningScore = (isNaN(winningScoreRaw) || winningScoreRaw < 1) ? 11 : winningScoreRaw;
  state.settings.raceToTwo = raceToTwoVal;

  if(state.currentGeneration) advanceRRQueue(); // pick up newly-freed courts right away if the count went up

  saveAll(); renderAll();
  toast('Settings saved.', 'success');
}

/* ============================================================
   GLOBAL CAPTURE DELEGATED CLICK ROUTERS EVENT DISPATCHER
   ============================================================ */
document.addEventListener('click', function(e){
  const t = e.target.closest('[data-action]');
  if(!t) return;
  const action = t.dataset.action;

  switch(action){
    case 'tab':
      state.tab = t.dataset.tab;
      saveAll(); renderAll();
      break;

    case 'open-nav-menu': openNavMenu(); break;
    case 'nav-menu-go':
      state.tab = t.dataset.tab;
      saveAll(); closeModal(); renderAll();
      break;
    case 'open-checkin': openCheckInModal(); break;
    case 'toggle-checkin': toggleCheckIn(t.dataset.id); break;
    case 'checkin-reset-all': confirmCheckInResetAll(); break;
    case 'checkin-open': openCheckInModal(); break;
    case 'do-checkin-reset-all': checkInResetAll(); break;
    case 'dismiss-nav-hint': {
      localStorage.setItem('kl_seen_nav_hint', '1');
      const banner = document.getElementById('onboardingBanner');
      if(banner) banner.innerHTML = '';
      break;
    }
    
    // Rotation workflow
    case 'next-match': nextRotationMatch(); break;

    // Continuous Smart Open Play (Rotation Mode multi-court)
    case 'pick-match-mode': openModePickerModal(); break;
    case 'pick-mode-openplay': {
      const hasHistory = state.matches.length > 0;
      const hasActiveSession = (state.settings.matchMode === 'Rotation' && Array.isArray(state.rotationCourts) && state.rotationCourts.some(c => c && c.status === 'active'))
        || (state.settings.matchMode === 'RoundRobin' && !!state.currentGeneration)
        || (state.settings.matchMode === 'PaddleStack' && !!state.paddleStack);
      if(hasHistory && !hasActiveSession){
        openModal(`
          <div class="modal-title">🏓 Start New Session?</div>
          <div class="modal-sub" style="line-height:1.7;">Your previous session (<strong style="color:var(--text);">${state.matches.length} match${state.matches.length!==1?'es':''}</strong>) will be <strong style="color:var(--win);">auto-saved</strong> and available to load from <em>Session History</em>. Stats and records will be wiped for a clean start.</div>
          <div class="modal-actions" style="flex-direction:column; gap:8px; margin-top:16px;">
            <button class="btn btn-primary btn-block" data-action="do-new-session-openplay">✅ Save &amp; Start Fresh</button>
            <button class="btn btn-ghost btn-block" data-action="modal-close">Cancel</button>
          </div>
        `, false);
        break;
      }
      // Show Open Play format picker (Paddle Stack vs Smart Auto-Match)
      openOpenPlayModePicker();
      break;
    }
    case 'pick-openplay-paddle-stack':
      closeModal();
      openPaddleStackSetupModal();
      break;
    case 'pick-openplay-csop':
      closeModal();
      state.settings.matchMode = 'Rotation';
      saveAll();
      _courtCountNoticeDismissed = false;
      initRotationCourts();
      break;
    case 'ps-pick-courts': {
      const n = parseInt(t.dataset.courts, 10);
      if (!isNaN(n)) {
        state.settings.numCourts = clamp(n, 1, 10);
        // Update visual selection
        document.querySelectorAll('[data-action="ps-pick-courts"]').forEach(btn => {
          const check = btn.querySelector('.session-opt-check');
          const isSelected = parseInt(btn.dataset.courts, 10) === n;
          btn.classList.toggle('recommended', isSelected);
          if (check) {
            check.style.borderColor = isSelected ? 'var(--ball)' : '';
            check.style.background = isSelected ? 'var(--ball)' : '';
          }
        });
        // Clear the custom input — picking a preset takes over as the source of truth.
        const customInput = document.getElementById('psCustomCourtsInput');
        const customCheck = document.getElementById('psCustomCourtsCheck');
        const customPreview = document.getElementById('psCustomCourtsPreview');
        if (customInput) customInput.value = '';
        if (customCheck) { customCheck.style.borderColor = ''; customCheck.style.background = ''; }
        if (customPreview) {
          const activeCount = activePlayers().length;
          const hardMax = Math.max(1, Math.min(Math.floor(activeCount / 4), 10));
          customPreview.textContent = `Up to ${hardMax} court${hardMax!==1?'s':''} possible with ${activeCount} players`;
        }
      }
      break;
    }
    case 'ps-confirm-start': psConfirmStart(); break;
    case 'ps-set-winner': confirmSelectWinner(liveMatchCtxPS(t.dataset.court), t.dataset.team); break;
    case 'ps-score-adjust': adjustMatchScore(liveMatchCtxPS(t.dataset.court), t.dataset.team, parseInt(t.dataset.delta,10)); break;
    case 'ps-set-server': setServingTeam(liveMatchCtxPS(t.dataset.court), t.dataset.team); break;
    case 'ps-advance-server': advanceServer(liveMatchCtxPS(t.dataset.court)); break;
    case 'ps-side-out': sideOutMatch(liveMatchCtxPS(t.dataset.court)); break;
    case 'ps-undo-serve': confirmUndoServeModal(liveMatchCtxPS(t.dataset.court)); break;
    case 'do-ps-undo-serve': undoServeMatch(liveMatchCtxPS(t.dataset.match)); break;
    case 'ps-confirm-match': psConfirmMatch(t.dataset.court); break;
    case 'ps-skip-confirm':
      openModal(`
        <div class="modal-title">Skip This Match?</div>
        <div class="modal-sub">Players return to the front of the queue with their same tags. No result is recorded.</div>
        <div class="modal-actions" style="margin-top:16px;">
          <button class="btn btn-ghost" data-action="modal-close">Cancel</button>
          <button class="btn btn-secondary" data-action="ps-do-skip" data-court="${t.dataset.court}">Yes, Skip</button>
        </div>
      `);
      break;
    case 'ps-do-skip': psSkipMatch(t.dataset.court); break;
    case 'ps-switch-player': openPsSwitchPlayerModal(t.dataset.court); break;
    case 'ps-pick-swap-out': openPsPickSwapInModal(t.dataset.court, t.dataset.team, parseInt(t.dataset.slot, 10)); break;
    case 'ps-do-switch-player': psdoSwitchPlayer(t.dataset.court, t.dataset.team, parseInt(t.dataset.slot, 10), parseInt(t.dataset.queueIdx, 10)); break;
    case 'ps-do-partner-swap': psdoPartnerSwap(t.dataset.court, t.dataset.swap); break;
    case 'ps-add-court': {
      const ps = state.paddleStack;
      if (!ps) break;
      const cur = clamp(ps.numCourts, 1, 10);
      if (cur >= 10) { toast('Maximum 10 courts.', 'warning'); break; }
      ps.numCourts = cur + 1;
      state.settings.numCourts = ps.numCourts;
      psFillCourts();
      saveAll(); renderAll();
      toast(`Court ${ps.numCourts} added.`, 'success');
      break;
    }
    case 'ps-end-session':
      openModal(`
        <div class="modal-title">End Open Play Session?</div>
        <div class="modal-sub">This clears every live court and the queue. Matches already recorded stay in your history and stats.</div>
        <div class="modal-actions" style="margin-top:16px;">
          <button class="btn btn-ghost" data-action="modal-close">Cancel</button>
          <button class="btn btn-danger" data-action="ps-do-end-session">Yes, End Session</button>
        </div>
      `);
      break;
    case 'ps-do-end-session':
      state.paddleStack = null;
      state.settings.matchMode = 'Rotation';
      saveAll(); closeModal(); renderAll();
      toast('Paddle Stack session ended.', 'success');
      break;
    case 'do-new-session-openplay':
      archiveCurrentSession().then(() => {
        resetPlayersAndStats();
        state.paddleStack = null;
        saveAll();
        closeModal();
        _courtCountNoticeDismissed = false;
        renderAll();
        toast('Session saved. Starting fresh — choose your Open Play format to begin.', 'success');
        openOpenPlayModePicker();
      });
      break;
    case 'pick-mode-roundrobin': {
      const hasHistory = state.matches.length > 0;
      const hasActiveSession = (state.settings.matchMode === 'Rotation' && Array.isArray(state.rotationCourts) && state.rotationCourts.some(c => c && c.status === 'active'))
        || (state.settings.matchMode === 'RoundRobin' && !!state.currentGeneration);
      if(hasHistory && !hasActiveSession){
        openModal(`
          <div class="modal-title">🔀 Start New Session?</div>
          <div class="modal-sub" style="line-height:1.7;">Your previous session (<strong style="color:var(--text);">${state.matches.length} match${state.matches.length!==1?'es':''}</strong>) will be <strong style="color:var(--win);">auto-saved</strong> and available to load from <em>Session History</em>. Stats and records will be wiped for a clean start.</div>
          <div class="modal-actions" style="flex-direction:column; gap:8px; margin-top:16px;">
            <button class="btn btn-primary btn-block" data-action="do-new-session-roundrobin">✅ Save &amp; Start Fresh</button>
            <button class="btn btn-ghost btn-block" data-action="modal-close">Cancel</button>
          </div>
        `, false);
        break;
      }
      state.settings.matchMode = 'RoundRobin';
      saveAll();
      closeModal();
      _courtCountNoticeDismissed = false;
      generateRoundRobinGeneration();
      break;
    }
    case 'do-new-session-roundrobin':
      archiveCurrentSession().then(() => {
        resetPlayersAndStats();
        state.settings.matchMode = 'RoundRobin';
        saveAll();
        closeModal();
        _courtCountNoticeDismissed = false;
        renderAll();
        toast('Session saved. Starting fresh — set up your round robin to begin.', 'success');
        generateRoundRobinGeneration();
      });
      break;
    case 'start-csop': initRotationCourts(); break;
    case 'add-csop-court': {
      const cur = clamp(parseInt(state.settings.numCourts, 10) || 1, 1, 10);
      if (cur >= 10) { toast('Maximum of 10 courts.', 'warning'); break; }
      state.settings.numCourts = cur + 1;
      const filled = fillEmptyRotationCourts();
      refreshAllNextMatchPreviews();
      saveAll(); renderAll();
      if (filled) toast(`Court ${cur + 1} is live.`, 'success');
      else toast(`Court ${cur + 1} added — waiting for enough free players to fill it.`, 'info');
      break;
    }
    case 'close-rc-court': {
      const courts = Array.isArray(state.rotationCourts) ? state.rotationCourts : [];
      const m = courts.find(c => c.id === t.dataset.court);
      if (!m) break;
      const inProgress = hasMatchStarted(m);
      openModal(`
        <div class="modal-title">Close Court ${m.courtNum}?</div>
        <div class="modal-sub" style="line-height:1.6;">
          ${inProgress ? '<strong style="color:var(--loss);">This match has an in-progress score — it will be lost, no result is recorded.</strong> ' : ''}
          The 4 players on this court return to the waiting pool and the court is removed. The rest of the session keeps running.
        </div>
        <div class="modal-actions" style="margin-top:16px;">
          <button class="btn btn-ghost" data-action="modal-close">Cancel</button>
          <button class="btn btn-danger" data-action="do-close-rc-court" data-court="${m.id}">Yes, Close Court</button>
        </div>
      `);
      break;
    }
    case 'do-close-rc-court': closeRotationCourt(t.dataset.court); break;
    case 'do-confirm-winner': {
      if (_pendingWinnerConfirm) {
        const { ctx, winningTeam } = _pendingWinnerConfirm;
        _pendingWinnerConfirm = null;
        closeModal();
        selectMatchWinner(ctx, winningTeam);
      }
      break;
    }
    case 'rc-set-winner': confirmSelectWinner(liveRotationCourtCtx(t.dataset.court), t.dataset.team); break;
    case 'rc-score-adjust': adjustRotationCourtScore(t.dataset.court, t.dataset.team, parseInt(t.dataset.delta,10)); break;
    case 'rc-set-server': setRotationCourtServer(t.dataset.court, t.dataset.team); break;
    case 'rc-advance-server': rotationCourtAdvanceServer(t.dataset.court); break;
    case 'rc-side-out': rotationCourtSideOut(t.dataset.court); break;
    case 'rc-undo-serve': rotationCourtUndoServe(t.dataset.court); break;
    case 'do-rc-undo-serve': doRotationCourtUndoServe(t.dataset.court); break;
    case 'confirm-rc-match': confirmRotationCourtMatch(t.dataset.court); break;
    case 'confirm-regen-next-match': {
      // Show confirmation modal to prevent accidental reshuffles
      const rc = Array.isArray(state.rotationCourts) ? state.rotationCourts.find(c => c.id === t.dataset.court) : null;
      if (!rc || !rc.nextMatch) break;
      const nA1 = playerName(rc.nextMatch.teamA[0]), nA2 = playerName(rc.nextMatch.teamA[1]);
      const nB1 = playerName(rc.nextMatch.teamB[0]), nB2 = playerName(rc.nextMatch.teamB[1]);
      openModal(`
        <div class="modal-title">Re-shuffle Up Next?</div>
        <div class="modal-sub" style="line-height:1.6;">
          Current lineup for Court ${rc.courtNum}:<br>
          <strong style="color:var(--text);">${esc(nA1)} &amp; ${esc(nA2)}</strong>
          <span style="color:var(--text-faint);"> vs </span>
          <strong style="color:var(--text);">${esc(nB1)} &amp; ${esc(nB2)}</strong><br>
          <span style="color:var(--text-faint); font-size:12px;">A different foursome will be picked from the waiting pool.</span>
        </div>
        <div class="modal-actions" style="margin-top:16px;">
          <button class="btn btn-ghost" data-action="modal-close">Cancel</button>
          <button class="btn btn-secondary" data-action="regen-next-match" data-court="${rc.id}">🔀 Yes, Re-shuffle</button>
        </div>
      `);
      break;
    }
    case 'regen-next-match': {
      const rc = Array.isArray(state.rotationCourts) ? state.rotationCourts.find(c => c.id === t.dataset.court) : null;
      if (rc) {
        // Exclude the players already in the current preview so the algorithm
        // is forced to pick a genuinely different foursome, not just re-confirm
        // the same optimal result.
        const currentPreviewIds = rc.nextMatch
          ? [...rc.nextMatch.teamA, ...rc.nextMatch.teamB]
          : [];
        const reshuffled = csoPreviewNextMatch(rc.id, currentPreviewIds);
        if (reshuffled) {
          rc.nextMatch = reshuffled;
          saveAll(); closeModal(); renderAll();
          toast('Up Next lineup re-shuffled.', 'success');
        } else {
          closeModal();
          toast('Not enough other players available — this is the only valid lineup right now.', 'info');
        }
      }
      break;
    }
    case 'skip-rc-match':
      openModal(`
        <div class="modal-title">Skip This Court Match?</div>
        <div class="modal-sub">The match will be cleared without recording a result. A new match will be generated for this court when you're ready.</div>
        <div class="modal-actions" style="margin-top:16px;">
          <button class="btn btn-ghost" data-action="modal-close">Cancel</button>
          <button class="btn btn-secondary" data-action="do-skip-rc-match" data-court="${t.dataset.court}">Yes, Skip</button>
        </div>
      `);
      break;
    case 'do-skip-rc-match': skipRotationCourtMatch(t.dataset.court); break;
    case 'open-replace-rc-player': openReplaceRotationCourtPlayerModal(t.dataset.court, t.dataset.team, t.dataset.player); break;
    case 'do-replace-rotation-court-player': doReplaceRotationCourtPlayer(t.dataset.court, t.dataset.team, t.dataset.player, t.dataset.sub); break;
    case 'save-match-score':
      recordRotationMatch(document.getElementById('scoreA').value, document.getElementById('scoreB').value);
      break;
    case 'rotation-score-adjust': adjustMatchScore(liveMatchCtx('rotation', null), t.dataset.team, parseInt(t.dataset.delta,10)); break;
    case 'set-rotation-winner': confirmSelectWinner(liveMatchCtx('rotation', null), t.dataset.team); break;
    case 'rotation-set-server': setServingTeam(liveMatchCtx('rotation', null), t.dataset.team); break;
    case 'rotation-advance-server': advanceServer(liveMatchCtx('rotation', null)); break;
    case 'rotation-side-out': sideOutMatch(liveMatchCtx('rotation', null)); break;
    case 'rotation-undo-serve': confirmUndoServeModal(liveMatchCtx('rotation', null)); break;
    case 'do-rotation-undo-serve': undoServeMatch(liveMatchCtx('rotation', null)); break;

    // Round robin workflow
    case 'generate-roundrobin':
      if(state.settings.matchMode === 'Rotation') {
        initRotationCourts();
      } else {
        generateRoundRobinGeneration();
      }
      break;
    case 'confirm-next-generation': closeModal(); generateRoundRobinGeneration(); break;
    case 'do-generate-rr': closeModal(); _doGenerateRoundRobinGeneration(null); break;
    case 'do-generate-full-schedule': {
      closeModal();
      const totalMatches = parseInt(t.dataset.total, 10) || (state.settings.sessionPlan ? state.settings.sessionPlan.totalMatches : 0);
      buildFullScheduleAndStart(activePlayers().slice(), totalMatches);
      break;
    }
    case 'view-full-schedule': showFullScheduleModal(); break;
    case 'sched-replace-player':
      openSchedReplaceModal(t.dataset.matchId, t.dataset.gen, t.dataset.team, t.dataset.slot);
      break;
    case 'sched-do-replace':
      schedDoReplace(t.dataset.matchId, t.dataset.gen, t.dataset.team, t.dataset.slot, t.dataset.newId);
      break;
    case 'sched-back-to-schedule':
      showFullScheduleModal();
      if(window._schedScrollTop){
        const savedTop = window._schedScrollTop;
        requestAnimationFrame(() => {
          const wrap = document.getElementById('schedBodyWrap');
          if(wrap) wrap.scrollTop = savedTop;
        });
      }
      break;
    case 'download-full-schedule-poster': downloadFullSchedulePoster(); break;
    case 'do-download-schedule-poster': {
      const inp = document.getElementById('tournamentTitleInput');
      const title = (inp && inp.value.trim()) ? inp.value.trim() : 'Pickleball Session';
      const sizeEl = document.querySelector('input[name="ppSize"]:checked');
      const size = sizeEl ? sizeEl.value : 'letter';
      closeModal();
      downloadFullSchedulePoster(title, size);
      break;
    }
    case 'pick-session-plan': pickSessionPlan(t.dataset.plan); break;
    case 'pick-session-plan-custom': openCustomSessionLengthModal(); break;
    case 'confirm-custom-session-length': confirmCustomSessionLength(); break;
    case 'back-to-session-picker': openSessionLengthPicker(); break;
    case 'back-to-session-setup': openSessionSetupModal(); break;
    case 'confirm-session-setup': confirmSessionSetup(); break;
    case 'confirm-rotation-generate': confirmRotationGenerate(); break;
    case 'setup-match-mode': {
      state.settings.matchMode = t.dataset.value;
      saveAll();
      document.querySelectorAll('[data-action="setup-match-mode"]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.value === t.dataset.value);
      });
      const nextBtn = document.getElementById('sessionSetupNextBtn');
      if(nextBtn) nextBtn.textContent = t.dataset.value === 'Rotation' ? 'Next: Balancing' : 'Next: Session Length';
      break;
    }
    case 'confirm-session-plan':
      confirmSessionPlanAndGenerate(t.dataset.plan, parseInt(t.dataset.total,10), parseFloat(t.dataset.gpp));
      break;
    case 'change-session-plan': openSessionSetupModal(); break;
    case 'start-new-session-plan': startNewSessionPlan(); break;
    case 'continue-match-cycle': continueMatchCycle(); break;
    case 'set-rr-winner':
      confirmSelectWinner(liveMatchCtx('rr', t.dataset.match), t.dataset.team);
      break;
    case 'rr-score-adjust': adjustMatchScore(liveMatchCtx('rr', t.dataset.match), t.dataset.team, parseInt(t.dataset.delta,10)); break;
    case 'rr-set-server': setServingTeam(liveMatchCtx('rr', t.dataset.match), t.dataset.team); break;
    case 'rr-advance-server': advanceServer(liveMatchCtx('rr', t.dataset.match)); break;
    case 'rr-side-out': sideOutMatch(liveMatchCtx('rr', t.dataset.match)); break;
    case 'rr-undo-serve': confirmUndoServeModal(liveMatchCtx('rr', t.dataset.match)); break;
    case 'do-rr-undo-serve': undoServeMatch(liveMatchCtx('rr', t.dataset.match)); break;
    case 'confirm-rr-match': confirmRoundRobinMatch(t.dataset.match); break;
    case 'rr-skip-match': confirmSkipRRMatch(t.dataset.match); break;
    case 'do-skip-rr-match': skipRRMatchToBack(t.dataset.match); break;
    case 'rr-forfeit-match': confirmForfeitRRMatch(t.dataset.match); break;
    case 'do-forfeit-rr-match': forfeitRRMatch(t.dataset.match, t.dataset.who); break;
    case 'accept-race-to-two': acceptRaceToTwo(t.dataset.mode, t.dataset.match); break;
    case 'decline-race-to-two': declineRaceToTwo(); break;
    case 'open-replace-player': openReplacePlayerModal(t.dataset.match, t.dataset.team, t.dataset.player); break;
    case 'open-replace-picker': openReplacePlayerPickerModal(t.dataset.match); break;
    case 'do-replace-absent': markPlayerAbsentAndAutoReplace(t.dataset.match, t.dataset.team, t.dataset.player); break;
    case 'do-replace-manual': replacePlayerInMatch(t.dataset.match, t.dataset.team, t.dataset.player, t.dataset.sub); break;
    case 'open-replace-current-player-picker': openReplaceCurrentPlayerPickerModal(); break;
    case 'open-replace-current-player': openReplaceCurrentPlayerModal(t.dataset.team, t.dataset.player); break;
    case 'do-replace-current-manual': replaceCurrentPlayer(t.dataset.team, t.dataset.player, t.dataset.sub); break;
    case 'open-player-status': openPlayerStatusModal(t.dataset.id); break;
    case 'set-player-status': setPlayerStatus(t.dataset.id, t.dataset.status); break;

    // Standard shared management commands
    case 'skip-match':
      if(state.currentGeneration){
        openModal(`
          <div class="modal-title">Reset Generation?</div>
          <div class="modal-sub">This will clear the current generation and all queued matches. Scores already recorded are kept.</div>
          <div class="modal-actions" style="margin-top:16px;">
            <button class="btn btn-ghost" data-action="modal-close">Cancel</button>
            <button class="btn btn-secondary" data-action="do-skip-match">Yes, Reset</button>
          </div>
        `);
      } else {
        openModal(`
          <div class="modal-title">Clear Match?</div>
          <div class="modal-sub">This will remove the current match without recording a result. Player stats will not be affected.</div>
          <div class="modal-actions" style="margin-top:16px;">
            <button class="btn btn-ghost" data-action="modal-close">Cancel</button>
            <button class="btn btn-secondary" data-action="do-skip-match">Yes, Clear</button>
          </div>
        `);
      }
      break;
    case 'do-skip-match': skipCurrentMatch(); closeModal(); break;
    case 'end-open-play':
      openModal(`
        <div class="modal-title">End Open Play Session?</div>
        <div class="modal-sub">This clears every live court and takes you back to the mode picker. Matches already recorded stay in your history and stats.</div>
        <div class="modal-actions" style="margin-top:16px;">
          <button class="btn btn-ghost" data-action="modal-close">Cancel</button>
          <button class="btn btn-danger" data-action="do-end-open-play">Yes, End Session</button>
        </div>
      `);
      break;
    case 'do-end-open-play':
      state.current = null;
      state.rotationCourts = [];
      state.paddleStack = null;
      state.settings.numCourts = 1; // reset court count so next session starts fresh
      _courtCountNoticeDismissed = false;
      saveAll();
      closeModal();
      renderAll();
      toast('Open Play session ended.', 'success');
      break;
    case 'undo-match':
      if(!state.undo){ toast('Nothing to undo.', 'info'); break; }
      openModal(`
        <div class="modal-title" style="color:var(--loss);">⚠️ Undo Last Match?</div>
        <div class="modal-sub" style="line-height:1.6;">This will revert scores, stats, and game counts back to right before the last match was recorded. This cannot be redone.</div>
        <div class="modal-actions" style="margin-top:16px;">
          <button class="btn btn-ghost" data-action="modal-close">Cancel</button>
          <button class="btn btn-danger" data-action="do-undo-match">Yes, Undo Match</button>
        </div>
      `);
      break;
    case 'do-undo-match': undoLastMatch(); closeModal(); break;

    // Player operations logic
    case 'do-add-player': {
      const inp = document.getElementById('newPlayerName');
      const subChk = document.getElementById('newPlayerIsSub');
      const duprInp = document.getElementById('newPlayerDupr');
      addPlayer(inp.value, subChk ? subChk.checked : false, duprInp ? duprInp.value : '');
      inp.value = '';
      if(subChk) subChk.checked = false;
      if(duprInp) duprInp.value = '';
      break;
    }
    case 'open-bulk-import':
      openModal(`
        <div class="modal-title">Bulk Import Players</div>
        <div class="modal-sub">Paste name strings separated by newlines or commas.</div>
        <textarea id="bulkText" placeholder="Alice\nBob\nCharlie"></textarea>
        <div class="modal-actions">
          <button class="btn btn-ghost" data-action="modal-close">Cancel</button>
          <button class="btn btn-primary" data-action="do-bulk-import">Import Bulk</button>
        </div>
      `);
      break;
    case 'do-bulk-import':
      bulkImport(document.getElementById('bulkText').value);
      break;
    case 'open-edit-player': {
      const p = getPlayer(t.dataset.id);
      if(p){
        openModal(`
          <div class="modal-title">Edit Player Info</div>
          <input type="text" id="editName" value="${esc(p.name)}" style="margin-top:8px;" placeholder="Player name">
          <label style="margin-top:10px; display:block; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; color:var(--text-faint); margin-bottom:5px;">DUPR Rating</label>
          <div style="display:flex; align-items:center; gap:8px;">
            <input type="number" id="editDuprRating" step="0.001" min="1" max="8" placeholder="e.g. 3.067"
              value="${p.duprRating != null ? p.duprRating : ''}"
              style="flex:1;">
            <span style="font-size:12px; color:var(--text-faint); white-space:nowrap;">Leave blank = NR</span>
          </div>
          <p class="helper-text" style="margin:3px 2px 10px;">Enter your DUPR rating from the DUPR app. Displayed per player on the scoreboard.</p>
          <label style="display:flex; align-items:center; gap:8px; font-size:12.5px; color:var(--text-dim); cursor:pointer;">
            <input type="checkbox" id="editIsSub" ${p.isSub ? 'checked' : ''} style="width:16px; height:16px; accent-color:var(--court);">
            Sub Player (bench reserve)
          </label>
          <p class="helper-text" style="margin:4px 2px 0;">Subs sit out of normal rotation, but always appear as options in the "Replace Player" picker, listed below the regular bench players.</p>
          <div class="modal-actions">
            <button class="btn btn-danger" data-action="do-delete-player" data-id="${p.id}">Remove Player</button>
            <button class="btn btn-primary" data-action="do-save-player" data-id="${p.id}">Save Changes</button>
          </div>
        `);
      }
      break;
    }
    case 'do-save-player': {
      const subChk = document.getElementById('editIsSub');
      const duprEl = document.getElementById('editDuprRating');
      editPlayerName(t.dataset.id, document.getElementById('editName').value, subChk ? subChk.checked : undefined, duprEl ? duprEl.value : undefined);
      break;
    }
    case 'do-delete-player': removePlayer(t.dataset.id); break;

    case 'open-danger-zone':
      openModal(`
        <div class="modal-title" style="color:var(--loss);">Reset Options</div>
        <div class="modal-sub">Choose what you'd like to reset. Both actions are permanent.</div>
        <button class="btn btn-danger btn-block" data-action="confirm-reset-stats">Reset Scores &amp; Match History</button>
        <button class="btn btn-danger btn-block" style="margin-top:8px;" data-action="confirm-reset-all">Clear All Data</button>
        <button class="btn btn-ghost btn-block" style="margin-top:12px;" data-action="modal-close">Cancel</button>
      `);
      break;
    case 'confirm-reset-stats':
      openModal(`
        <div class="modal-title" style="color:var(--loss);">⚠️ Reset Stats & History?</div>
        <div class="modal-sub" style="line-height:1.6;">This will permanently wipe all match history, scores, ELO ratings, and player stats. <strong style="color:var(--text);">Player names are kept.</strong> This cannot be undone.</div>
        <div class="modal-actions" style="margin-top:16px;">
          <button class="btn btn-ghost" data-action="modal-close">Cancel</button>
          <button class="btn btn-danger" data-action="do-reset-stats">Yes, Reset Stats</button>
        </div>
      `);
      break;
    case 'confirm-reset-all':
      openModal(`
        <div class="modal-title" style="color:var(--loss);">⚠️ Clear Everything?</div>
        <div class="modal-sub" style="line-height:1.6;">This will permanently delete <strong style="color:var(--text);">all players, matches, stats, and settings</strong>. The app will return to a completely blank state. This cannot be undone.</div>
        <div class="modal-actions" style="margin-top:16px;">
          <button class="btn btn-ghost" data-action="modal-close">Cancel</button>
          <button class="btn btn-danger" data-action="do-reset-all">Yes, Clear Everything</button>
        </div>
      `);
      break;
    case 'do-reset-stats': resetPlayersAndStats(); break;
    case 'do-reset-all': resetEverything(); break;

    case 'rank-sort': rankSort = t.dataset.sort; renderRankingsView(document.getElementById('view')); break;
    case 'toggle-mode-setting': {
      state.settings.matchMode = t.dataset.value;
      renderSettingsView(document.getElementById('view'));
      break;
    }
    case 'save-settings': saveSettingsFromForm(); break;
    case 'open-add-fixed-duo': {
      const activePl = activePlayers();
      if(activePl.length < 2){ toast('Need at least 2 active players to create a duo.', 'warning'); break; }
      // Filter out players already in a duo
      const inDuo = new Set((state.fixedDuos||[]).flat());
      const eligible = activePl.filter(p => !inDuo.has(p.id));
      if(eligible.length < 2){ toast('All active players are already in fixed duos.', 'warning'); break; }
      openModal(`
        <div class="modal-title">Add Fixed Duo 🔗</div>
        <div class="modal-sub">Select two players who should always be on the same team.</div>
        <div class="field" style="margin-top:10px;">
          <label>Player 1</label>
          <select id="duoP1">
            ${eligible.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>Player 2</label>
          <select id="duoP2">
            ${eligible.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}
          </select>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" data-action="modal-close">Cancel</button>
          <button class="btn btn-primary" data-action="do-add-fixed-duo">Lock as Duo 🔗</button>
        </div>
      `);
      break;
    }
    case 'do-add-fixed-duo': {
      const p1 = document.getElementById('duoP1')?.value;
      const p2 = document.getElementById('duoP2')?.value;
      if(p1 === p2){ toast('Select two different players.', 'warning'); break; }
      addFixedDuo(p1, p2);
      break;
    }
    case 'remove-fixed-duo':
      removeFixedDuo(t.dataset.p1, t.dataset.p2);
      break;

    case 'export-data': openExportNameModal(); break;
    case 'do-export-data':
      exportData(document.getElementById('exportFileName') ? document.getElementById('exportFileName').value : '');
      break;
    case 'open-import-data':
      openModal(`
        <div class="modal-title">Import Backup</div>
        <div class="modal-sub">Upload a backup .json file, or paste its contents below.</div>
        <button class="btn btn-secondary btn-block" data-action="trigger-import-file">📁 Choose Backup File…</button>
        <input type="file" id="importFileInput" accept=".json,application/json" style="display:none;" onchange="window.handleImportFileSelect(this)">
        <div class="divider-thin"></div>
        <textarea id="importText" placeholder="…or paste backup JSON here…"></textarea>
        <div class="modal-actions">
          <button class="btn btn-ghost" data-action="modal-close">Cancel</button>
          <button class="btn btn-primary" data-action="do-import-data">Restore Backup</button>
        </div>
      `);
      break;
    case 'trigger-import-file': {
      const fileInput = document.getElementById('importFileInput');
      if(fileInput) fileInput.click();
      break;
    }
    case 'do-import-data': importDataFromText(document.getElementById('importText').value); break;
    case 'modal-close': _pendingWinnerConfirm = null; closeModal(); break;
    case 'open-session-history': openSessionHistoryModal(); break;
    case 'restore-session': restoreArchivedSession(t.dataset.id); break;
    case 'delete-session': deleteArchivedSession(t.dataset.id); break;
    case 'open-player-profile': openPlayerProfile(t.dataset.id); break;
    case 'show-session-summary': showSessionSummary(); break;

    // Continuous Smart Open Play — court picker & start
    case 'csop-pick-courts': {
      const n = parseInt(t.dataset.courts, 10);
      if (!isNaN(n) && n >= 1) {
        state.settings.numCourts = n;
        // Update visual selection state
        document.querySelectorAll('[data-action="csop-pick-courts"]').forEach(btn => {
          const isSelected = parseInt(btn.dataset.courts, 10) === n;
          btn.classList.toggle('recommended', isSelected);
          const check = btn.querySelector('.session-opt-check') || document.getElementById(`csop-court-check-${btn.dataset.courts}`);
          if (check) {
            check.style.borderColor = isSelected ? 'var(--ball)' : '';
            check.style.background  = isSelected ? 'var(--ball)' : '';
          }
        });
      }
      break;
    }
    case 'csop-confirm-start': doInitRotationCourts(); break;
  }
});

document.addEventListener('keydown', function(e){
  if(e.key === 'Escape') closeModal();
});

/* ============================================================
   PLAYER PROFILE MODAL
   ============================================================ */
function openPlayerProfile(id){
  const p = getPlayer(id);
  if(!p) return;
  ensureCSOP(p);

  const wp = winPct(p);
  const avg = playerScoreAverages(p.id);
  const tmPairs = Object.entries(p.teammates||{}).map(([tid,c])=>({name:playerName(tid),count:c})).sort((a,b)=>b.count-a.count).slice(0,3);
  const opPairs = Object.entries(p.opponents||{}).map(([oid,c])=>({name:playerName(oid),count:c})).sort((a,b)=>b.count-a.count).slice(0,3);

  const strK = p.currentStreak||0;
  let streakTxt = 'None';
  if(strK>0) streakTxt = `🔥 W${strK} streak`;
  else if(strK<0) streakTxt = `❄️ L${Math.abs(strK)} streak`;

  const ratingColor = p.rating>=1100?'var(--win)':p.rating<=900?'var(--loss)':'var(--court)';
  const marginColor = avg.avgMargin > 0 ? 'var(--win)' : avg.avgMargin < 0 ? 'var(--loss)' : 'var(--text-faint)';
  const marginTxt = avg.games ? (avg.avgMargin > 0 ? `+${avg.avgMargin}` : avg.avgMargin) : '—';
  const recentForm = (p.results||[]).slice(-8);

  openModal(`
    <div class="profile-header">
      <div class="profile-avatar">${initials(p.name)}</div>
      <div>
        <div class="profile-name">${esc(p.name)}</div>
        <div class="profile-rating" style="color:${ratingColor};">⚡ ELO ${p.rating} · ${streakTxt}</div>
        ${p.duprRating != null ? `<div class="profile-rating" style="color:var(--court); margin-top:2px;">🏓 DUPR ${p.duprRating.toFixed(3)}</div>` : `<div class="profile-rating" style="color:var(--text-faint); margin-top:2px;">🏓 DUPR NR — <button style="background:none;border:none;color:var(--court);font-size:12px;cursor:pointer;padding:0;" data-action="open-edit-player" data-id="${p.id}">Add rating ›</button></div>`}
      </div>
    </div>
    <div class="profile-stat-row">
      <div class="profile-stat">
        <div class="psv" style="color:var(--win);">${p.wins}</div>
        <div class="psl">Wins</div>
      </div>
      <div class="profile-stat">
        <div class="psv" style="color:var(--loss);">${p.losses}</div>
        <div class="psl">Losses</div>
      </div>
      <div class="profile-stat">
        <div class="psv" style="color:var(--ball);">${wp}%</div>
        <div class="psl">Win Rate</div>
      </div>
    </div>
    <div class="profile-stat-row">
      <div class="profile-stat">
        <div class="psv">${p.gamesPlayed}</div>
        <div class="psl">Games</div>
      </div>
      <div class="profile-stat">
        <div class="psv" style="color:var(--court);">${p.longestStreak||0}</div>
        <div class="psl">Best Streak</div>
      </div>
      <div class="profile-stat">
        <div class="psv" style="color:var(--text-faint);">${p.sitOuts||0}</div>
        <div class="psl">Sit-outs</div>
      </div>
    </div>
    <div class="profile-stat-row">
      <div class="profile-stat">
        <div class="psv" style="color:var(--court);">${avg.games ? avg.avgFor : '—'}</div>
        <div class="psl">Avg Score / Game</div>
      </div>
      <div class="profile-stat">
        <div class="psv" style="color:var(--text-faint);">${avg.games ? avg.avgAgainst : '—'}</div>
        <div class="psl">Avg Allowed / Game</div>
      </div>
      <div class="profile-stat">
        <div class="psv" style="color:${marginColor};">${marginTxt}</div>
        <div class="psl">Avg Margin</div>
      </div>
    </div>
    ${recentForm.length ? `
    <div class="profile-pair-row">
      <b>📈 Recent form:</b> ${recentForm.map(r => r === 'W' ? `<span style="color:var(--win); font-weight:800;">W</span>` : `<span style="color:var(--loss); font-weight:800;">L</span>`).join(' ')}
    </div>` : ''}
    ${(p.streakGames||0) > 0 ? `
    <div class="profile-pair-row">
      <b>${(p.streakGames||0) >= 4 ? '🔥 Fatigue:' : '🎾 On a run:'}</b> ${p.streakGames} consecutive game${p.streakGames!==1?'s':''} without a rest${(p.streakGames||0) >= 3 ? ' <span style="color:var(--ball);">— due for a sit-out</span>' : ''}
    </div>` : ''}
    ${tmPairs.length ? `
    <div class="profile-pair-row">
      <b>🤝 Best partners:</b> ${tmPairs.map(x=>`${esc(x.name)} (${x.count}x)`).join(', ')}
    </div>` : ''}
    ${opPairs.length ? `
    <div class="profile-pair-row">
      <b>⚔️ Common opponents:</b> ${opPairs.map(x=>`${esc(x.name)} (${x.count}x)`).join(', ')}
    </div>` : ''}
    <div class="modal-actions">
      <button class="btn btn-ghost" data-action="modal-close">Close</button>
      <button class="btn btn-secondary" data-action="open-edit-player" data-id="${p.id}">Edit</button>
    </div>
  `);
}

/* ============================================================
   SESSION SUMMARY
   ============================================================ */
function showSessionSummary(){
  if(!state.matches.length){ toast('No matches played yet this session.', 'info'); return; }

  // Find MVP (most wins today / highest rating)
  const ratedPlayers = state.players.filter(p=>p.gamesPlayed>0).sort((a,b)=>b.rating-a.rating);
  const mvp = ratedPlayers[0];
  const mostGames = state.players.slice().sort((a,b)=>b.gamesPlayed-a.gamesPlayed)[0];
  const hotStreak = state.players.slice().sort((a,b)=>(b.currentStreak||0)-(a.currentStreak||0)).filter(p=>p.currentStreak>0)[0];
  const topWinRate = state.players.filter(p=>p.gamesPlayed>=2).sort((a,b)=>winPct(b)-winPct(a))[0];
  const recentMatches = state.matches.slice(-5).reverse();

  openModal(`
    <div class="summary-hero">
      <div class="summary-trophy">🏆</div>
      <div class="summary-title">Session Summary</div>
      <div class="summary-sub">${state.matches.length} match${state.matches.length!==1?'es':''} played · ${state.players.filter(p=>p.gamesPlayed>0).length} players active</div>
    </div>
    <div class="summary-grid">
      ${mvp ? `<div class="summary-card">
        <div class="sc-label">⚡ Top Rated</div>
        <div class="sc-name">${esc(mvp.name)}</div>
        <div class="sc-val">ELO ${mvp.rating}</div>
      </div>` : ''}
      ${topWinRate ? `<div class="summary-card">
        <div class="sc-label">🎯 Best Win Rate</div>
        <div class="sc-name">${esc(topWinRate.name)}</div>
        <div class="sc-val">${winPct(topWinRate)}%</div>
      </div>` : ''}
      ${mostGames ? `<div class="summary-card">
        <div class="sc-label">🎾 Most Active</div>
        <div class="sc-name">${esc(mostGames.name)}</div>
        <div class="sc-val">${mostGames.gamesPlayed} games</div>
      </div>` : ''}
      ${hotStreak ? `<div class="summary-card">
        <div class="sc-label">🔥 Hot Streak</div>
        <div class="sc-name">${esc(hotStreak.name)}</div>
        <div class="sc-val">W${hotStreak.currentStreak} in a row</div>
      </div>` : '<div class="summary-card"><div class="sc-label">🔥 Hot Streak</div><div class="sc-name" style="color:var(--text-faint);">None yet</div></div>'}
    </div>
    <div class="section-title" style="margin-top:4px;">Recent Matches</div>
    ${recentMatches.map(m=>{
      const pA1=playerName(m.teamA[0]),pA2=playerName(m.teamA[1]);
      const pB1=playerName(m.teamB[0]),pB2=playerName(m.teamB[1]);
      return `<div style="font-size:12.5px;padding:7px 2px;border-bottom:1px solid var(--line-soft);display:flex;justify-content:space-between;align-items:center;">
        <span style="color:${m.scoreA>m.scoreB?'var(--win)':'var(--text-dim)'};">${esc(pA1)}/${esc(pA2)}</span>
        <span class="mono" style="color:var(--text-faint);font-size:11px;">${m.scoreA}-${m.scoreB}</span>
        <span style="color:${m.scoreB>m.scoreA?'var(--win)':'var(--text-dim)'};">${esc(pB1)}/${esc(pB2)}</span>
      </div>`;
    }).join('')}
    <div class="modal-actions" style="margin-top:16px;">
      <button class="btn btn-primary btn-block" data-action="modal-close">Close Summary</button>
    </div>
  `);
}

/* ============================================================
   SERVICE WORKER REGISTRATION
   Required by Chrome/Android for the app to be considered
   "installable" (i.e. for beforeinstallprompt to fire at all).
   ============================================================ */
if('serviceWorker' in navigator){
  window.addEventListener('load', function(){
    navigator.serviceWorker.register('./sw.js').catch(function(err){
      console.warn('Service worker registration failed:', err);
    });
  });
}

/* ============================================================
   PWA INSTALL PROMPT
   ============================================================ */
let _deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', function(e){
  e.preventDefault();
  _deferredInstallPrompt = e;
  const topBtn = document.getElementById('topbar-install-btn');
  if(topBtn) topBtn.style.display = 'inline-flex';
});

window.addEventListener('appinstalled', function(){
  const topBtn = document.getElementById('topbar-install-btn');
  if(topBtn) topBtn.style.display = 'none';
  _deferredInstallPrompt = null;
  toast('Maezku Ladder installed.', 'success');
});

function initInstallBanner(){
  const topBtn = document.getElementById('topbar-install-btn');

  // Detect iOS (Safari — no beforeinstallprompt)
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  const isInStandaloneMode = window.navigator.standalone === true;

  // Show the topbar install button
  function showInstallBtn(){
    if(topBtn && !isInStandaloneMode) topBtn.style.display = 'inline-flex';
  }

  if(isIOS && !isInStandaloneMode){ showInstallBtn(); }

  if(topBtn){
    topBtn.addEventListener('click', async function(){
      if(_deferredInstallPrompt){
        // Android / Chrome / Edge — native prompt
        _deferredInstallPrompt.prompt();
        const { outcome } = await _deferredInstallPrompt.userChoice;
        if(outcome === 'accepted') toast('Installing Maezku Ladder…', 'info');
        _deferredInstallPrompt = null;
        topBtn.style.display = 'none';
      } else if(isIOS){
        // iOS Safari — show manual instructions
        openModal(`
          <div class="modal-title">Install on iPhone / iPad</div>
          <div class="modal-sub" style="line-height:1.8; font-size:13.5px; color:var(--text-dim);">
            <div style="margin-bottom:10px;">1. Tap the <strong style="color:var(--text);">Share</strong> button ⬆️ in Safari's bottom toolbar</div>
            <div style="margin-bottom:10px;">2. Scroll and tap <strong style="color:var(--text);">"Add to Home Screen"</strong></div>
            <div>3. Tap <strong style="color:var(--ball);">Add</strong> — Maezku Ladder appears on your home screen like a native app!</div>
          </div>
          <div class="modal-actions">
            <button class="btn btn-primary btn-block" data-action="modal-close">Got it</button>
          </div>
        `);
      }
    });
  }
}

/* ============================================================
   PADDLE STACK OPEN PLAY ENGINE
   ------------------------------------------------------------
   Implements the classic pickleball "paddle stack" rotation:
   - One shared queue across all courts (W×4 / L×4 alternating blocks)
   - Next 4 from front of queue fill the next available court
   - After match: 2 winners → back of next W block, 2 losers → back of next L block
   - When a W or L block hits 4 → flush entire block to the shared queue
   - Leftover (< 4) players sit at the front of their respective next block
   - First round: roster order, tagged 🆕 New
   - Match card shows: 🏆 Winners vs Winners / 💀 Losers vs Losers / 🆕 New vs New
   ============================================================ */

function psInit() {
  // Build initial queue from active roster in check-in order (roster order)
  const pool = activePlayers().slice();
  if (pool.length < 4) { goToAddPlayer('Add a few more players to start — you need at least 4.'); return false; }

  // Initial queue: groups of 4 in roster order, all tagged 'N' (new)
  const queue = [];
  for (let i = 0; i < pool.length; i++) {
    queue.push({ id: pool[i].id, tag: 'N' });
  }

  state.paddleStack = {
    queue,          // [{id, tag:'W'|'L'|'N'}] — front is index 0
    wBlock: [],     // accumulating winners (< 4) — will flush when full
    lBlock: [],     // accumulating losers (< 4) — will flush when full
    courts: [],     // active court matches [{id, courtNum, teamA, teamB, tags, ...scoring}]
    numCourts: clamp(parseInt(state.settings.numCourts, 10) || 1, 1, 10),
    winningScore: state.settings.winningScore || 11
  };
  // Fill courts from the queue
  psFillCourts();
  saveAll();
  return true;
}

// Pull next 4 from queue and start a match on an available court
function psFillCourts() {
  const ps = state.paddleStack;
  if (!ps) return;
  const maxCourts = ps.numCourts;
  while (ps.courts.length < maxCourts && ps.queue.length >= 4) {
    const courtNum = ps.courts.length + 1;
    const slot = ps.queue.splice(0, 4);
    const [p1, p2, p3, p4] = slot;
    const matchType = psMatchType([p1, p2], [p3, p4]);
    ps.courts.push({
      id: uid('ps'),
      courtNum,
      teamA: [p1.id, p2.id],
      teamB: [p3.id, p4.id],
      tagsA: [p1.tag, p2.tag],
      tagsB: [p3.tag, p4.tag],
      matchType,
      scoreA: null, scoreB: null,
      winner: null,
      serving: 'A', serverNum: 1, firstServe: true,
      _serveUndoStack: [],
      raceActive: false, raceOffered: false,
      status: 'active'
    });
  }
}

// Determine the label for a match based on team tags
function psMatchType(teamA, teamB) {
  // Each item is {id, tag}
  const tagsA = teamA.map(p => p.tag);
  const tagsB = teamB.map(p => p.tag);
  const dominantTag = tags => {
    if (tags.every(t => t === 'W')) return 'W';
    if (tags.every(t => t === 'L')) return 'L';
    if (tags.every(t => t === 'N')) return 'N';
    // mixed — use majority
    const wc = tags.filter(t => t === 'W').length;
    const lc = tags.filter(t => t === 'L').length;
    if (wc >= lc) return 'W'; else return 'L';
  };
  const dA = dominantTag(tagsA), dB = dominantTag(tagsB);
  if (dA === 'W' && dB === 'W') return 'WW';
  if (dA === 'L' && dB === 'L') return 'LL';
  if (dA === 'N' && dB === 'N') return 'NN';
  return 'MX'; // mixed
}

function psMatchTypeLabel(type) {
  if (type === 'WW') return '🏆 Winners vs Winners';
  if (type === 'LL') return '💀 Losers vs Losers';
  if (type === 'NN') return '🆕 New vs New';
  return '🎾 Mixed';
}

// After confirming a court result: route winners/losers to blocks
function psHandleResult(courtId, winnerTeam) {
  const ps = state.paddleStack;
  if (!ps) return;
  const m = ps.courts.find(c => c.id === courtId);
  if (!m) return;

  const winners = winnerTeam === 'A'
    ? m.teamA.map((id, i) => ({ id, tag: 'W' }))
    : m.teamB.map((id, i) => ({ id, tag: 'W' }));
  const losers = winnerTeam === 'A'
    ? m.teamB.map((id, i) => ({ id, tag: 'L' }))
    : m.teamA.map((id, i) => ({ id, tag: 'L' }));

  ps.wBlock.push(...winners);
  ps.lBlock.push(...losers);

  // When a block reaches 4, flush it to the queue.
  // Blocks alternate W/L in the queue: we always flush both when they're ready,
  // but if only one is ready we still flush it immediately so no court sits empty.
  // The "alternating W×4 / L×4" pattern emerges naturally as blocks fill up.
  if (ps.wBlock.length >= 4) {
    ps.queue.push(...ps.wBlock.splice(0, 4));
  }
  if (ps.lBlock.length >= 4) {
    ps.queue.push(...ps.lBlock.splice(0, 4));
  }

  // ── Small-group fallback ────────────────────────────────────────────────
  // Only merge partial W/L blocks when the total player count makes it
  // impossible for either block to EVER reach 4 on its own (< 8 players).
  // With 8 or 12 players the normal W×4 / L×4 rotation is always achievable
  // and should be preserved.  With e.g. 5, 6, or 7 players neither block
  // will ever fill, so we combine whatever is ready (≥ 4 combined) so the
  // session doesn't stall.
  const activePlCount = activePlayers().length;
  const combinedBlocks = ps.wBlock.length + ps.lBlock.length;
  if (
    activePlCount < 8 &&           // session is genuinely small — normal rotation impossible
    combinedBlocks >= 4 &&         // enough combined players for a match
    ps.wBlock.length < 4 &&        // neither block is full on its own
    ps.lBlock.length < 4
  ) {
    // Flush winners first, then losers — labelled 🎾 Mixed on the match card
    ps.queue.push(...ps.wBlock.splice(0));
    ps.queue.push(...ps.lBlock.splice(0));
  }
}

// Confirm a paddle stack match result
function psConfirmMatch(courtId) {
  const ps = state.paddleStack;
  if (!ps) return;
  const m = ps.courts.find(c => c.id === courtId);
  if (!m) return;
  if (m.winner === null) { toast('Select the winning team before confirming.', 'warning'); return; }

  // Save undo snapshot
  state.undo = {
    players: deepClone(state.players),
    matches: deepClone(state.matches),
    current: null,
    currentGeneration: null,
    rotationCourts: [],
    round: state.round,
    sitOutQueue: deepClone(state.sitOutQueue || []),
    paddleStack: deepClone(ps)
  };

  const sA = parseInt(m.scoreA, 10) || 0;
  const sB = parseInt(m.scoreB, 10) || 0;
  const tA_win = m.winner === 'A';
  state.round++;

  const matchRecord = {
    id: uid('m'),
    round: state.round,
    court: m.courtNum,
    teamA: m.teamA, teamB: m.teamB,
    scoreA: sA, scoreB: sB,
    winners: tA_win ? [...m.teamA] : [...m.teamB],
    losers: tA_win ? [...m.teamB] : [...m.teamA],
    date: new Date().toISOString()
  };
  state.matches.push(matchRecord);

  // Update stats
  [...m.teamA, ...m.teamB].forEach(id => {
    const p = getPlayer(id);
    if (!p) return;
    p.gamesPlayed++;
    if (matchRecord.winners.includes(id)) {
      p.wins++; p.results.push('W');
      p.currentStreak = p.currentStreak > 0 ? p.currentStreak + 1 : 1;
    } else {
      p.losses++; p.results.push('L');
      p.currentStreak = p.currentStreak < 0 ? p.currentStreak - 1 : -1;
    }
    if (Math.abs(p.currentStreak) > p.longestStreak) p.longestStreak = Math.abs(p.currentStreak);
  });

  // Teammate/opponent tracking
  [[m.teamA[0], m.teamA[1]], [m.teamB[0], m.teamB[1]]].forEach(([p1, p2]) => {
    const pl1 = getPlayer(p1), pl2 = getPlayer(p2);
    if (pl1 && pl2) { bumpPair(pl1.teammates, p2); bumpPair(pl2.teammates, p1); }
  });
  m.teamA.forEach(idA => m.teamB.forEach(idB => {
    const plA = getPlayer(idA), plB = getPlayer(idB);
    if (plA && plB) { bumpPair(plA.opponents, idB); bumpPair(plB.opponents, idA); }
  }));

  // ELO
  const rA = (getPlayer(m.teamA[0])?.rating||1000) + (getPlayer(m.teamA[1])?.rating||1000);
  const rB = (getPlayer(m.teamB[0])?.rating||1000) + (getPlayer(m.teamB[1])?.rating||1000);
  const expA = 1 / (1 + Math.pow(10, (rB - rA) / 400));
  const change = Math.round(32 * ((tA_win ? 1 : 0) - expA));
  m.teamA.forEach(id => { const p = getPlayer(id); if (p) p.rating += change; });
  m.teamB.forEach(id => { const p = getPlayer(id); if (p) p.rating -= change; });

  // Route to blocks
  psHandleResult(courtId, m.winner);

  // Remove finished court
  ps.courts = ps.courts.filter(c => c.id !== courtId);

  // Renumber courts
  ps.courts.forEach((c, i) => { c.courtNum = i + 1; });

  // Fill courts from queue
  psFillCourts();

  playGameWinSound();
  saveAll(); renderAll();
  toast('Match recorded — next match is up.', 'success');
}

// Skip a paddle stack court match (no result recorded)
function psSkipMatch(courtId) {
  const ps = state.paddleStack;
  if (!ps) return;
  const m = ps.courts.find(c => c.id === courtId);
  if (!m) return;
  // Return their slots to front of queue with same tags
  const returned = [
    ...m.teamA.map((id, i) => ({ id, tag: m.tagsA[i] || 'N' })),
    ...m.teamB.map((id, i) => ({ id, tag: m.tagsB[i] || 'N' }))
  ];
  ps.queue.unshift(...returned);
  ps.courts = ps.courts.filter(c => c.id !== courtId);
  ps.courts.forEach((c, i) => { c.courtNum = i + 1; });
  psFillCourts();
  saveAll(); renderAll(); closeModal();
  toast('Match skipped — players returned to front of queue.', 'info');
}

// Set winner on a PS court
function psSetWinner(courtId, team) {
  const ps = state.paddleStack;
  if (!ps) return;
  const m = ps.courts.find(c => c.id === courtId);
  if (!m) return;
  selectMatchWinner(liveMatchCtxPS(courtId), team);
}

// Live match context for PS courts
function liveMatchCtxPS(courtId) {
  return {
    mode: 'ps-court',
    matchId: courtId,
    getMatch() { return state.paddleStack && state.paddleStack.courts.find(c => c.id === courtId); },
    scoreInput(team) { return document.querySelector(`input[data-ps-score="${courtId}-${team}"]`); },
    winBtn(team) { return document.querySelector(`.ps-win-btn[data-court="${courtId}"][data-team="${team}"]`); },
    render() { renderActiveView(); }
  };
}

// Render the full paddle stack match view
function renderPaddleStackView(el) {
  const ps = state.paddleStack;
  if (!ps) {
    el.innerHTML = `<div class="empty-state"><div class="big">🏓</div><div class="et">No Active Session</div><p>Start a new Open Play session from the Match tab.</p></div>`;
    return;
  }

  const courts = ps.courts;
  let html = `<div class="section-title">🏓 Open Play — ${courts.length} Court${courts.length !== 1 ? 's' : ''} Live</div>`;

  courts.forEach(m => {
    if (m.serving === undefined) m.serving = 'A';
    if (m.serverNum === undefined) m.serverNum = 1;
    if (m.firstServe === undefined) m.firstServe = true;
    const pA1 = getPlayer(m.teamA[0]), pA2 = getPlayer(m.teamA[1]);
    const pB1 = getPlayer(m.teamB[0]), pB2 = getPlayer(m.teamB[1]);
    const activeA = m.winner === 'A', activeB = m.winner === 'B';
    const servingA = m.serving === 'A', servingB = m.serving === 'B';
    const serveLabel = m.firstServe ? '1st Serve' : `Serve ${m.serverNum}`;
    const winTarget = (m.raceActive ? 2 : (ps.winningScore || 11));
    const typeLabel = psMatchTypeLabel(m.matchType);

    function nameTag(team, playerId) {
      const p = getPlayer(playerId);
      const justify = team === 'A' ? 'flex-end' : 'flex-start';
      return `<span style="display:inline-flex; align-items:center; justify-content:${justify}; gap:4px; max-width:100%;">${esc(p?.name || '—')}</span>`;
    }

    html += `
      <div class="scoreboard" style="margin-bottom:14px;">
        <div class="sb-head">
          <span class="sb-round">COURT <b>${m.courtNum}</b></span>
          <span style="font-size:11px; font-weight:700; color:var(--ball); opacity:.85;">${typeLabel}</span>
          ${m.raceActive ? `<span class="race-badge">🏁 Race to 2</span>` : ''}
          <div class="live-dot"><div class="d"></div>Live</div>
        </div>
        <div class="sb-body">
          <div class="sb-team team-a">
            <span class="sb-tag">Team A</span>
            <div class="sb-names">${nameTag('A', m.teamA[0])}<br>${duprChip(pA1)}<br>${nameTag('A', m.teamA[1])}<br>${duprChip(pA2)}</div>
            <div class="sb-rating">Avg ELO: ${Math.round(((pA1?.rating||1000)+(pA2?.rating||1000))/2)}</div>
            ${servingA ? `<span class="serve-badge">🎾 ${serveLabel}</span>` : (m.firstServe && !(m.scoreA||0) && !(m.scoreB||0) ? `<button type="button" class="serve-set-btn" data-action="ps-set-server" data-court="${m.id}" data-team="A">Make 1st server</button>` : '')}
            <button class="btn btn-sm ${activeA ? 'btn-primary' : 'btn-secondary'} sb-winbtn ps-win-btn"
              data-action="ps-set-winner" data-court="${m.id}" data-team="A">
              ${activeA ? '✓ Winner Selected' : 'Team A Wins'}
            </button>
          </div>
          <div class="sb-divider"></div>
          <div class="sb-team team-b">
            <span class="sb-tag">Team B</span>
            <div class="sb-names">${nameTag('B', m.teamB[0])}<br>${duprChip(pB1)}<br>${nameTag('B', m.teamB[1])}<br>${duprChip(pB2)}</div>
            <div class="sb-rating">Avg ELO: ${Math.round(((pB1?.rating||1000)+(pB2?.rating||1000))/2)}</div>
            ${servingB ? `<span class="serve-badge">🎾 ${serveLabel}</span>` : (m.firstServe && !(m.scoreA||0) && !(m.scoreB||0) ? `<button type="button" class="serve-set-btn" data-action="ps-set-server" data-court="${m.id}" data-team="B">Make 1st server</button>` : '')}
            <button class="btn btn-sm ${activeB ? 'btn-primary' : 'btn-secondary'} sb-winbtn ps-win-btn"
              data-action="ps-set-winner" data-court="${m.id}" data-team="B">
              ${activeB ? '✓ Winner Selected' : 'Team B Wins'}
            </button>
          </div>
        </div>
        <div class="sb-foot rr-score-foot">
          <div class="score-stepper">
            <button type="button" class="score-btn score-btn-minus rr-score-btn"
              data-action="ps-score-adjust" data-court="${m.id}" data-team="A" data-delta="-1"
              ${(m.winner || !servingA || (m.scoreA === null || m.scoreA <= 0)) ? 'disabled' : ''}>−</button>
            <input type="number" inputmode="numeric" pattern="[0-9]*" placeholder="A"
              class="cb-score-input rr-score-input"
              data-ps-score="${m.id}-A"
              min="0" max="${winTarget}"
              value="${m.scoreA !== null ? m.scoreA : ''}"
              oninput="window.updatePSScore('${m.id}', 'A', this.value)">
            <button type="button" class="score-btn score-btn-plus rr-score-btn"
              data-action="ps-score-adjust" data-court="${m.id}" data-team="A" data-delta="1"
              ${(m.winner || !servingA || (m.scoreA !== null && m.scoreA >= winTarget)) ? 'disabled' : ''}>+</button>
          </div>
          <span class="rr-score-vs-sm">vs</span>
          <div class="score-stepper">
            <button type="button" class="score-btn score-btn-minus rr-score-btn"
              data-action="ps-score-adjust" data-court="${m.id}" data-team="B" data-delta="-1"
              ${(m.winner || !servingB || (m.scoreB === null || m.scoreB <= 0)) ? 'disabled' : ''}>−</button>
            <input type="number" inputmode="numeric" pattern="[0-9]*" placeholder="B"
              class="cb-score-input rr-score-input"
              data-ps-score="${m.id}-B"
              min="0" max="${winTarget}"
              value="${m.scoreB !== null ? m.scoreB : ''}"
              oninput="window.updatePSScore('${m.id}', 'B', this.value)">
            <button type="button" class="score-btn score-btn-plus rr-score-btn"
              data-action="ps-score-adjust" data-court="${m.id}" data-team="B" data-delta="1"
              ${(m.winner || !servingB || (m.scoreB !== null && m.scoreB >= winTarget)) ? 'disabled' : ''}>+</button>
          </div>
        </div>
        <div style="padding:0 14px 14px;">
          <div style="display:flex; gap:8px; margin-bottom:10px;">
            <button class="btn btn-secondary btn-sm" style="flex:1;"
              data-action="ps-advance-server" data-court="${m.id}"
              ${(m.firstServe || m.serverNum===2) ? 'disabled' : ''}>🎾 Serve 2</button>
            <button class="btn btn-secondary btn-sm sideout-btn" style="flex:1;"
              data-action="ps-side-out" data-court="${m.id}"
              ${(m.winner || (!m.firstServe && m.serverNum===1)) ? 'disabled' : ''}>🔁 Side Out</button>
            <button class="btn btn-ghost btn-sm undo-serve-btn"
              data-action="ps-undo-serve" data-court="${m.id}"
              ${(!m._serveUndoStack || !m._serveUndoStack.length) ? 'disabled' : ''}>↩️${(m._serveUndoStack && m._serveUndoStack.length) ? ' '+m._serveUndoStack.length : ''}</button>
          </div>
          <button class="btn btn-primary btn-block"
            data-action="ps-confirm-match" data-court="${m.id}">
            ✅ Confirm Result &amp; Next Match
          </button>
          ${(() => {
            const nextType = psNextMatchType(m.id);
            const isPartner = nextType === 'WW' || nextType === 'LL';
            const btnLabel = isPartner ? '🔄 Switch Partner' : '🔄 Switch Player';
            const btnTitle = isPartner
              ? 'Next match is W vs W or L vs L — swap partners within the court'
              : ps.queue.length
                ? 'Replace an on-court player with someone from the queue'
                : 'No players in queue to swap in';
            const disabled = (m.winner || hasMatchStarted(m) || (!isPartner && !ps.queue.length)) ? 'disabled' : '';
            return `<button class="btn btn-secondary btn-block" style="margin-top:8px;"
              data-action="ps-switch-player" data-court="${m.id}"
              title="${btnTitle}" ${disabled}>${btnLabel}</button>`;
          })()}
          <div style="display:flex; gap:8px; margin-top:8px;">
            <button class="btn btn-ghost btn-sm" style="flex:1;"
              data-action="ps-skip-confirm" data-court="${m.id}"
              ${hasMatchStarted(m) ? 'disabled' : ''}>⏭️ Skip</button>
            <button class="btn btn-danger btn-sm" style="flex:1;"
              data-action="undo-match" ${!state.undo ? 'disabled' : ''}>↩ Undo Last</button>
          </div>
        </div>
      </div>
    `;
  });

  // Show queue preview
  const queuePreview = ps.queue.slice(0, 12);
  if (queuePreview.length) {
    html += `<div class="section-title">Queue (${ps.queue.length} waiting)</div>`;
    html += `<div class="card" style="padding:6px 4px;">`;
    for (let i = 0; i < Math.min(queuePreview.length, 8); i++) {
      const entry = queuePreview[i];
      const p = getPlayer(entry.id);
      const tagLabel = entry.tag === 'W' ? '🏆' : entry.tag === 'L' ? '💀' : '🆕';
      const isNextGroup = i < 4;
      html += `<div class="queue-row" style="${isNextGroup ? 'background:rgba(215,242,61,0.04);' : ''}">
        <span class="qrank">${i + 1}</span>
        <span style="font-size:13px;">${tagLabel} ${esc(p?.name || '—')}</span>
        ${isNextGroup && i === 0 ? `<span style="font-size:10px; color:var(--ball); font-weight:700;">← ON DECK</span>` : ''}
      </div>`;
    }
    if (ps.queue.length > 8) {
      html += `<div style="text-align:center; font-size:11.5px; color:var(--text-faint); padding:6px 12px;">+${ps.queue.length - 8} more — see Queue tab</div>`;
    }
    html += `</div>`;
  } else if (!courts.length) {
    html += `<div class="card"><p class="helper-text" style="margin:0; text-align:center;">Queue is empty — add more players or end session.</p></div>`;
  }

  // Show accumulating blocks
  if (ps.wBlock.length || ps.lBlock.length) {
    html += `<div class="section-title">Accumulating</div><div class="card" style="padding:8px 14px; font-size:12.5px;">`;
    if (ps.wBlock.length) {
      html += `<div style="margin-bottom:4px;">🏆 Winners block: ${ps.wBlock.map(e => esc(getPlayer(e.id)?.name || '—')).join(', ')} <span style="color:var(--text-faint);">(${ps.wBlock.length}/4)</span></div>`;
    }
    if (ps.lBlock.length) {
      html += `<div>💀 Losers block: ${ps.lBlock.map(e => esc(getPlayer(e.id)?.name || '—')).join(', ')} <span style="color:var(--text-faint);">(${ps.lBlock.length}/4)</span></div>`;
    }
    html += `</div>`;
  }

  html += `
    <div class="card" style="margin-top:14px;">
      <div style="display:flex; gap:8px;">
        <button class="btn btn-secondary btn-sm" style="flex:1;" data-action="ps-add-court">➕ Add Court</button>
        <button class="btn btn-danger btn-sm" style="flex:1;" data-action="ps-end-session">⏹️ End Session</button>
      </div>
    </div>
  `;

  el.innerHTML = html;

  window.updatePSScore = function(courtId, team, val) {
    updateMatchScore(liveMatchCtxPS(courtId), team, val);
  };
}

// Render queue view for paddle stack mode
function renderPaddleStackQueueView(el) {
  const ps = state.paddleStack;
  if (!ps) {
    el.innerHTML = `<div class="empty-state"><div class="big">🏓</div><p>No active Open Play session.</p></div>`;
    return;
  }

  const onCourtIds = new Set(ps.courts.flatMap(c => [...c.teamA, ...c.teamB]));
  const tagLabel = t => t === 'W' ? '🏆 Winner' : t === 'L' ? '💀 Loser' : '🆕 New';
  const tagColor = t => t === 'W' ? 'var(--win)' : t === 'L' ? 'var(--loss)' : 'var(--ball)';

  let html = `
    <div class="section-title">🏓 Paddle Stack Queue</div>
    <p class="helper-text" style="margin:-4px 2px 10px;">Shared queue across all courts. Winners (🏆) and Losers (💀) stack in blocks of 4. When a block fills, it joins the queue. Next 4 from the front fill the next open court. 🆕 New arrivals go straight to the front. With few players, partial blocks merge automatically so play never stalls.</p>
  `;

  // On-court section
  if (ps.courts.length) {
    html += `<div class="section-title" style="color:var(--win);">▶ On Court (${ps.courts.length * 4})</div>`;
    html += `<div class="card" style="padding:6px 4px;">`;
    ps.courts.forEach(m => {
      [...m.teamA.map((id, i) => ({id, tag: m.tagsA[i]})), ...m.teamB.map((id, i) => ({id, tag: m.tagsB[i]}))].forEach(entry => {
        const p = getPlayer(entry.id);
        html += `<div class="queue-row"><span class="qrank" style="background:rgba(62,213,152,0.15); color:var(--win);">C${m.courtNum}</span>
          <span style="font-size:13px;">${esc(p?.name || '—')}</span>
          <span style="font-size:11px; color:${tagColor(entry.tag)};">${tagLabel(entry.tag)}</span>
        </div>`;
      });
    });
    html += `</div>`;
  }

  // Accumulating blocks
  if (ps.wBlock.length || ps.lBlock.length) {
    html += `<div class="section-title">⏳ Accumulating Blocks</div><div class="card" style="padding:6px 14px;">`;
    if (ps.wBlock.length) {
      html += `<p style="font-size:12px; color:var(--text-faint); margin:6px 0 4px; font-weight:700;">🏆 Winners Block (${ps.wBlock.length}/4 — flushes to queue at 4)</p>`;
      ps.wBlock.forEach((e, i) => {
        const p = getPlayer(e.id);
        html += `<div class="queue-row" style="border-left:3px solid var(--win); padding-left:10px;"><span class="qrank">${i+1}</span><span style="font-size:13px;">${esc(p?.name||'—')}</span></div>`;
      });
    }
    if (ps.lBlock.length) {
      html += `<p style="font-size:12px; color:var(--text-faint); margin:10px 0 4px; font-weight:700;">💀 Losers Block (${ps.lBlock.length}/4 — flushes to queue at 4)</p>`;
      ps.lBlock.forEach((e, i) => {
        const p = getPlayer(e.id);
        html += `<div class="queue-row" style="border-left:3px solid var(--loss); padding-left:10px;"><span class="qrank">${i+1}</span><span style="font-size:13px;">${esc(p?.name||'—')}</span></div>`;
      });
    }
    html += `</div>`;
  }

  // Main queue
  if (ps.queue.length) {
    html += `<div class="section-title">📋 Queue (${ps.queue.length})</div>`;
    html += `<div class="card" style="padding:6px 4px;">`;
    ps.queue.forEach((entry, i) => {
      const p = getPlayer(entry.id);
      const isNextFour = i < 4;
      html += `<div class="queue-row" style="${isNextFour ? 'background:rgba(215,242,61,0.06);' : ''}">
        <span class="qrank" style="${isNextFour ? 'background:var(--ball); color:#10150a;' : ''}">${i + 1}</span>
        <span style="font-size:13px; font-weight:${isNextFour ? '700' : '400'};">${esc(p?.name || '—')}</span>
        <span style="font-size:11px; color:${tagColor(entry.tag)};">${tagLabel(entry.tag)}</span>
        ${isNextFour && i === 0 ? `<span style="font-size:10px; font-weight:800; color:var(--ball);">NEXT UP →</span>` : ''}
      </div>`;
    });
    html += `</div>`;
  } else if (!ps.courts.length && !ps.wBlock.length && !ps.lBlock.length) {
    html += `<div class="empty-state"><p>Queue empty — waiting for match results to accumulate.</p></div>`;
  }

  el.innerHTML = html;
}

// Open Play mode picker — now includes PaddleStack option
function openOpenPlayModePicker() {
  openModal(`
    <div class="modal-title">🏓 Open Play Format</div>
    <div class="modal-sub" style="line-height:1.6;">How do you want to manage court rotations?</div>
    <div style="display:flex; flex-direction:column; gap:12px; margin-top:8px;">
      <button class="btn btn-primary" style="padding:18px 16px; font-size:15px; text-align:left; display:flex; flex-direction:column; gap:4px;" data-action="pick-openplay-paddle-stack">
        <span style="font-size:18px;">🎯 Paddle Stack Queue</span>
        <span style="font-weight:400; font-size:12px; opacity:0.85;">Classic pickleball rotation. W×4 / L×4 blocks. Winners play winners, losers play losers. 🆕 First round in roster order.</span>
      </button>
      <button class="btn btn-secondary" style="padding:18px 16px; font-size:15px; text-align:left; display:flex; flex-direction:column; gap:4px;" data-action="pick-openplay-csop">
        <span style="font-size:18px;">⚡ Smart Auto-Match</span>
        <span style="font-weight:400; font-size:12px; opacity:0.85;">Algorithm-driven. Each court auto-generates balanced matches independently when it finishes.</span>
      </button>
    </div>
    <div class="modal-actions" style="margin-top:16px;">
      <button class="btn btn-ghost" data-action="modal-close">Cancel</button>
    </div>
  `, false);
}

// Start paddle stack session setup modal
function openPaddleStackSetupModal() {
  const pool = activePlayers();
  const activeCount = pool.length;
  // hardMax mirrors the real ceiling used everywhere else (psInit clamps
  // numCourts to 1-10) — maxPossible is just how many preset buttons to
  // show (capped at 6 so the list doesn't get unwieldy). Custom court count
  // lets anyone with enough players reach past that 6-button visual cap, up
  // to hardMax, by typing a number instead.
  const hardMax = Math.max(1, Math.min(Math.floor(activeCount / 4), 10));
  const maxPossible = Math.min(hardMax, 6);
  const currentCourts = clamp(parseInt(state.settings.numCourts, 10) || 1, 1, hardMax);
  const currentScore = state.settings.winningScore || 11;
  const isCustomValue = currentCourts > maxPossible;

  const courtPreviewText = n => {
    const playersNeeded = n * 4;
    const waiting = activeCount - playersNeeded;
    return `${playersNeeded} on court${waiting > 0 ? ` · ${waiting} in queue` : ' · everyone plays'}`;
  };

  const courtBtns = Array.from({length: maxPossible || 1}, (_, i) => i + 1).map(n => {
    const isSelected = n === currentCourts && !isCustomValue;
    return `
      <button type="button" class="session-opt ${isSelected ? 'recommended' : ''}" data-action="ps-pick-courts" data-courts="${n}">
        <div class="session-opt-count"><span class="n">${n}</span><span class="u">court${n>1?'s':''}</span></div>
        <div class="session-opt-body">
          <div class="session-opt-name">${n === 1 ? 'Single Court' : n + ' Courts'}${isSelected ? '<span class="session-opt-tag">Current</span>' : ''}</div>
          <div class="session-opt-sub">${courtPreviewText(n)}</div>
        </div>
        <div class="session-opt-check" style="${isSelected ? 'border-color:var(--ball); background:var(--ball);' : ''}"></div>
      </button>`;
  }).join('');

  openModal(`
    <div class="modal-title">🎯 Paddle Stack Setup</div>
    <div class="modal-sub" style="line-height:1.6;"><strong style="color:var(--text);">${activeCount} player${activeCount !== 1 ? 's' : ''}</strong> ready. Players queue in roster order — 🆕 tagged as New. Winners and Losers stack in blocks of 4.</div>

    <div class="eyebrow" style="margin:14px 2px 8px;">How many courts?</div>
    <div class="session-opt-list" id="psCourtsListPs">
      ${courtBtns}
      ${maxPossible < 1 ? '<p class="helper-text" style="color:var(--loss);">Need at least 4 active players.</p>' : ''}
      <div class="session-opt custom-opt" id="psCustomCourtsRow" style="cursor:default; align-items:flex-start;">
        <div class="session-opt-count"><span class="n">✏️</span></div>
        <div class="session-opt-body">
          <div class="session-opt-name" id="psCustomCourtsName">Custom${isCustomValue ? '<span class="session-opt-tag">Current</span>' : ''}</div>
          <input type="number" id="psCustomCourtsInput" inputmode="numeric" pattern="[0-9]*" min="1" max="${hardMax}"
            placeholder="e.g. ${Math.min(hardMax, maxPossible + 1)}" value="${isCustomValue ? currentCourts : ''}"
            style="margin-top:8px; max-width:120px; font-weight:700; text-align:center;"
            oninput="window.psPickCustomCourts(this.value)">
          <div class="session-opt-sub" id="psCustomCourtsPreview" style="margin-top:6px;">${isCustomValue ? courtPreviewText(currentCourts) : `Up to ${hardMax} court${hardMax!==1?'s':''} possible with ${activeCount} players`}</div>
        </div>
        <div class="session-opt-check" id="psCustomCourtsCheck" style="${isCustomValue ? 'border-color:var(--ball); background:var(--ball);' : ''}"></div>
      </div>
    </div>

    <div class="eyebrow" style="margin:16px 2px 8px;">Winning Score</div>
    <div class="card" style="margin:0 0 4px;">
      <div class="field" style="margin:0;">
        <input type="number" id="psWinScoreInput" min="1" max="99" value="${currentScore}" style="font-size:18px; font-weight:700; text-align:center;">
        <p class="helper-text" style="margin:6px 2px 0;">First team to reach this score (win by 2) wins the match.</p>
      </div>
    </div>

    <div class="modal-actions" style="margin-top:16px;">
      <button class="btn btn-ghost" data-action="modal-close">Cancel</button>
      <button class="btn btn-primary" data-action="ps-confirm-start">🚀 Start Paddle Stack</button>
    </div>
  `, false);

  // Typing a custom court count deselects the preset buttons and applies the
  // typed value live (clamped to hardMax — the real 1-10 ceiling psInit
  // enforces, same as every other "how many courts" picker in the app).
  window.psPickCustomCourts = function(val){
    const previewEl = document.getElementById('psCustomCourtsPreview');
    const checkEl = document.getElementById('psCustomCourtsCheck');
    const raw = parseInt(val, 10);
    if(isNaN(raw) || raw < 1){
      if(previewEl) previewEl.textContent = `Up to ${hardMax} court${hardMax!==1?'s':''} possible with ${activeCount} players`;
      if(checkEl){ checkEl.style.borderColor = ''; checkEl.style.background = ''; }
      return;
    }
    const n = clamp(raw, 1, hardMax);
    state.settings.numCourts = n;
    if(previewEl) previewEl.textContent = courtPreviewText(n);
    if(checkEl){ checkEl.style.borderColor = 'var(--ball)'; checkEl.style.background = 'var(--ball)'; }
    // Clear any preset button's selected look — the typed value is now the source of truth.
    document.querySelectorAll('[data-action="ps-pick-courts"]').forEach(btn => {
      const check = btn.querySelector('.session-opt-check');
      btn.classList.remove('recommended');
      if(check){ check.style.borderColor = ''; check.style.background = ''; }
    });
  };
}

// Peek at what match type the NEXT court fill would produce for a given court
// (i.e. what the next 4 in queue would yield if this court finished right now).
// Returns 'WW', 'LL', 'NN', 'MX', or null if fewer than 4 in queue.
function psNextMatchType(courtId) {
  const ps = state.paddleStack;
  if (!ps || ps.queue.length < 4) return null;
  const slot = ps.queue.slice(0, 4);
  return psMatchType([slot[0], slot[1]], [slot[2], slot[3]]);
}

// Safe tag read — falls back to 'N' for older saved sessions that pre-date tagsA/tagsB.
function psTag(m, team, slot) {
  const arr = team === 'A' ? m.tagsA : m.tagsB;
  return (arr && arr[slot]) ? arr[slot] : 'N';
}

// Open the Switch Player / Switch Partner modal for a Paddle Stack court.
// "Switch Player"  = generic swap: pick any on-court player and replace them
//                    with a queued player (queued player goes to their spot,
//                    on-court player goes to the queue at the swapped position).
// "Switch Partner" = only shown when the NEXT match is W vs W or L vs L:
//                    re-pair within the same side so both players stay on court
//                    but swap their partners (A1 ↔ B1 style swap), keeping the
//                    upcoming match type intact.
function openPsSwitchPlayerModal(courtId) {
  const ps = state.paddleStack;
  if (!ps) return;
  const m = ps.courts.find(c => c.id === courtId);
  if (!m) return;

  if (m.winner || hasMatchStarted(m)) {
    toast('Match already decided — cannot switch players.', 'warning');
    return;
  }

  const nextType = psNextMatchType(courtId);
  const isPartnerSwap = nextType === 'WW' || nextType === 'LL';
  const tagIcon = t => t === 'W' ? '🏆' : t === 'L' ? '💀' : '🆕';

  const pA1 = getPlayer(m.teamA[0]), pA2 = getPlayer(m.teamA[1]);
  const pB1 = getPlayer(m.teamB[0]), pB2 = getPlayer(m.teamB[1]);

  if (isPartnerSwap) {
    // Partner swap: show all 4 cross-team pair options. Both players stay on court,
    // they just swap to opposite teams re-pairing with the other player.
    const title = '🔄 Switch Partner';
    const subtitle = 'Next match is <b style="color:var(--win);">Winners vs Winners</b> or <b style="color:var(--loss);">Losers vs Losers</b>. Pick two players across teams to swap — both stay on court, just re-paired.';

    const swapOptions = [
      { labelA: esc(pA1?.name || '—'), labelB: esc(pB1?.name || '—'), swapIdx: '0-0' },
      { labelA: esc(pA1?.name || '—'), labelB: esc(pB2?.name || '—'), swapIdx: '0-1' },
      { labelA: esc(pA2?.name || '—'), labelB: esc(pB1?.name || '—'), swapIdx: '1-0' },
      { labelA: esc(pA2?.name || '—'), labelB: esc(pB2?.name || '—'), swapIdx: '1-1' },
    ];
    const optHtml = swapOptions.map(o => `
      <button class="btn btn-secondary btn-block" style="margin-top:8px; justify-content:space-between;"
        data-action="ps-do-partner-swap" data-court="${courtId}" data-swap="${o.swapIdx}">
        <span style="display:flex; align-items:center; gap:8px;">
          <span style="color:var(--ball);">${o.labelA}</span>
          <span style="color:var(--text-faint); font-size:11px;">↔</span>
          <span style="color:var(--court);">${o.labelB}</span>
        </span>
        <span style="font-size:11px; color:var(--text-faint);">Swap Partners</span>
      </button>`).join('');

    openModal(`
      <div class="modal-title">${title}</div>
      <div class="modal-sub" style="line-height:1.6;">${subtitle}</div>
      <div class="eyebrow" style="margin:12px 2px 6px;">Pick the pair to swap</div>
      ${optHtml}
      <div class="modal-actions" style="margin-top:14px;">
        <button class="btn btn-ghost btn-block" data-action="modal-close">Cancel</button>
      </div>
    `);
  } else {
    // Player swap: pick which on-court player to remove, then pick the replacement
    // from the queue. Guard up-front for empty queue so the user never hits a dead end.
    const title = '🔄 Switch Player';
    if (!ps.queue.length) {
      openModal(`
        <div class="modal-title">${title}</div>
        <div class="modal-sub" style="line-height:1.6;">No players are waiting in the queue right now — nobody to swap in.</div>
        <div class="modal-actions" style="margin-top:14px;">
          <button class="btn btn-ghost btn-block" data-action="modal-close">Close</button>
        </div>
      `);
      return;
    }

    const subtitle = 'Replace an on-court player with someone from the queue. The removed player returns to their queue spot.';
    const courtPlayers = [
      { id: m.teamA[0], team: 'A', slot: 0, name: pA1?.name || '—', tag: psTag(m, 'A', 0) },
      { id: m.teamA[1], team: 'A', slot: 1, name: pA2?.name || '—', tag: psTag(m, 'A', 1) },
      { id: m.teamB[0], team: 'B', slot: 0, name: pB1?.name || '—', tag: psTag(m, 'B', 0) },
      { id: m.teamB[1], team: 'B', slot: 1, name: pB2?.name || '—', tag: psTag(m, 'B', 1) },
    ];
    const courtHtml = courtPlayers.map(cp => `
      <button class="btn btn-secondary btn-block" style="margin-top:8px; justify-content:space-between;"
        data-action="ps-pick-swap-out" data-court="${courtId}" data-team="${cp.team}" data-slot="${cp.slot}">
        <span>${tagIcon(cp.tag)} ${esc(cp.name)} <span style="font-size:11px; color:var(--text-faint);">Team ${cp.team}</span></span>
        <span style="font-size:11px; color:var(--loss);">Remove →</span>
      </button>`).join('');

    openModal(`
      <div class="modal-title">${title}</div>
      <div class="modal-sub" style="line-height:1.6;">${subtitle}</div>
      <div class="eyebrow" style="margin:12px 2px 6px;">Who's leaving the court?</div>
      ${courtHtml}
      <div class="modal-actions" style="margin-top:14px;">
        <button class="btn btn-ghost btn-block" data-action="modal-close">Cancel</button>
      </div>
    `);
  }
}

// Step 2 of Switch Player: pick the queued replacement for the chosen on-court player.
function openPsPickSwapInModal(courtId, team, slot) {
  const ps = state.paddleStack;
  if (!ps) return;
  const m = ps.courts.find(c => c.id === courtId);
  if (!m) return;

  const outId = team === 'A' ? m.teamA[slot] : m.teamB[slot];
  const outPlayer = getPlayer(outId);
  const outTag = psTag(m, team, slot);
  const tagIcon = t => t === 'W' ? '🏆' : t === 'L' ? '💀' : '🆕';

  if (!ps.queue.length) {
    toast('No players in the queue to swap in.', 'warning');
    return;
  }

  const queueHtml = ps.queue.slice(0, 8).map((entry, i) => {
    const p = getPlayer(entry.id);
    return `
      <button class="btn btn-secondary btn-block" style="margin-top:6px; justify-content:space-between;"
        data-action="ps-do-switch-player" data-court="${courtId}" data-team="${team}" data-slot="${slot}" data-queue-idx="${i}">
        <span>${tagIcon(entry.tag || 'N')} ${esc(p?.name || '—')}</span>
        <span style="font-size:11px; color:var(--text-faint);">#${i + 1} in queue</span>
      </button>`;
  }).join('');

  openModal(`
    <div class="modal-title">Swap In a Player</div>
    <div class="modal-sub">Replacing <b style="color:var(--loss);">${esc(outPlayer?.name || '—')}</b> (${tagIcon(outTag)} Team ${team}). The swapped-out player returns to their queue position.</div>
    <div class="eyebrow" style="margin:12px 2px 6px;">Pick from queue</div>
    ${queueHtml}
    ${ps.queue.length > 8 ? `<p class="helper-text" style="text-align:center;">Showing first 8 — see Queue tab for full list.</p>` : ''}
    <div class="modal-actions" style="margin-top:14px;">
      <button class="btn btn-ghost btn-block" data-action="modal-close">Cancel</button>
    </div>
  `);
}

// Execute the Switch Player swap: queued player steps onto court, on-court player
// goes back to the queue at the position the incoming player vacated.
function psdoSwitchPlayer(courtId, team, slot, queueIdx) {
  const ps = state.paddleStack;
  if (!ps) return;
  const m = ps.courts.find(c => c.id === courtId);
  if (!m || queueIdx < 0 || queueIdx >= ps.queue.length) return;

  // Ensure tagsA/tagsB arrays exist (older saved sessions may lack them)
  if (!Array.isArray(m.tagsA)) m.tagsA = ['N', 'N'];
  if (!Array.isArray(m.tagsB)) m.tagsB = ['N', 'N'];

  const outId  = team === 'A' ? m.teamA[slot] : m.teamB[slot];
  const outTag = psTag(m, team, slot);
  const inEntry = ps.queue[queueIdx];

  // Guard: don't swap a player in for themselves (shouldn't happen, but be safe)
  if (inEntry.id === outId) {
    toast('That player is already on court.', 'warning');
    closeModal();
    return;
  }

  // Place the incoming player on court
  if (team === 'A') { m.teamA[slot] = inEntry.id; m.tagsA[slot] = inEntry.tag || 'N'; }
  else              { m.teamB[slot] = inEntry.id; m.tagsB[slot] = inEntry.tag || 'N'; }

  // Put the on-court player back at the same queue position
  ps.queue.splice(queueIdx, 1, { id: outId, tag: outTag });

  // Recompute match type label
  m.matchType = psMatchType(
    [{ id: m.teamA[0], tag: m.tagsA[0] || 'N' }, { id: m.teamA[1], tag: m.tagsA[1] || 'N' }],
    [{ id: m.teamB[0], tag: m.tagsB[0] || 'N' }, { id: m.teamB[1], tag: m.tagsB[1] || 'N' }]
  );

  saveAll(); renderAll(); closeModal();
  toast(`${playerName(inEntry.id)} steps in — ${playerName(outId)} returns to queue.`, 'success');
}

// Execute the Switch Partner swap: two on-court players swap teams, both stay on court.
// swapSpec is "aSlot-bSlot" e.g. "0-1" meaning teamA[0] swaps with teamB[1].
function psdoPartnerSwap(courtId, swapSpec) {
  const ps = state.paddleStack;
  if (!ps) return;
  const m = ps.courts.find(c => c.id === courtId);
  if (!m) return;

  const parts = (swapSpec || '').split('-').map(Number);
  if (parts.length !== 2 || parts.some(isNaN)) return;
  const [aSlot, bSlot] = parts;
  if (aSlot < 0 || aSlot > 1 || bSlot < 0 || bSlot > 1) return;

  // Ensure tagsA/tagsB arrays exist (older saved sessions may lack them)
  if (!Array.isArray(m.tagsA)) m.tagsA = ['N', 'N'];
  if (!Array.isArray(m.tagsB)) m.tagsB = ['N', 'N'];

  const aId  = m.teamA[aSlot],  aTag  = m.tagsA[aSlot] || 'N';
  const bId  = m.teamB[bSlot],  bTag  = m.tagsB[bSlot] || 'N';

  // Guard: no-op self-swap (shouldn't happen in practice)
  if (aId === bId) {
    toast('Same player on both sides — no swap needed.', 'warning');
    closeModal();
    return;
  }

  // Swap
  m.teamA[aSlot] = bId;  m.tagsA[aSlot] = bTag;
  m.teamB[bSlot] = aId;  m.tagsB[bSlot] = aTag;

  // Recompute match type
  m.matchType = psMatchType(
    [{ id: m.teamA[0], tag: m.tagsA[0] || 'N' }, { id: m.teamA[1], tag: m.tagsA[1] || 'N' }],
    [{ id: m.teamB[0], tag: m.tagsB[0] || 'N' }, { id: m.teamB[1], tag: m.tagsB[1] || 'N' }]
  );

  saveAll(); renderAll(); closeModal();
  toast(`Partners swapped — ${playerName(bId)} & ${playerName(aId)} switched sides.`, 'success');
}

function psConfirmStart() {
  const scoreEl = document.getElementById('psWinScoreInput');
  if (scoreEl) {
    const v = parseInt(scoreEl.value, 10);
    state.settings.winningScore = (isNaN(v) || v < 1) ? 11 : v;
  }
  state.settings.matchMode = 'PaddleStack';
  saveAll();
  closeModal();
  if (!psInit()) return;
  saveAll(); renderAll();
  toast(`Paddle Stack started — ${state.paddleStack.courts.length} court${state.paddleStack.courts.length !== 1 ? 's' : ''} live!`, 'success');
}
/* END PADDLE STACK ENGINE */
/* ============================================================
   SYSTEM BOOT INITIALIZER EXECUTION
   ------------------------------------------------------------
   loadState() is now async (it awaits the IndexedDB connection,
   the one-time legacy-localStorage migration check, and the
   actual key reads), so the rest of boot waits on it before the
   first paint reads real data instead of the empty default state.
   ============================================================ */
(async function boot(){
  const viewEl = document.getElementById('view');
  if(viewEl) viewEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;padding:60px 20px;color:var(--text-faint);font-size:13px;">Loading…</div>';
  await loadState();
  refreshAllNextMatchPreviews(true); // gentle: only fill courts that have no saved preview
  renderAll();
  initInstallBanner();
  maybeShowNavHint();
})();

(function initTabsFadeListeners(){
  const nav = document.getElementById('tabNav');
  if(!nav) return;
  nav.addEventListener('scroll', updateTabsFade, { passive: true });
  window.addEventListener('resize', updateTabsFade);
  updateTabsFade();
  nudgeTabsOnce();
})();

/* ================================================================
   © 2026 Renzku — Maezku Ladder. All Rights Reserved.
   Unauthorized use or reproduction is strictly prohibited.
   Original Authors: Mae & Renzku | Fingerprint: ML-MAEZKU-2026-ORIGINAL
   ================================================================ */
const _kitchenLadderSig = Object.freeze({
  app: "Maezku Ladder",
  author: "Mae & Renzku",
  year: 2026,
  fingerprint: "ML-MAEZKU-2026-ORIGINAL",
  rights: "All Rights Reserved"
});

})();

/* ================================================================
   ENHANCED UI v2 — Theme Toggle · FAB · Ripple · Micro-interactions
   ================================================================ */
(function initEnhancedUI(){

  /* ---- Theme toggle ---- */
  const THEME_KEY = 'ml_theme';
  const html = document.documentElement;
  const themeToggleBtn = document.getElementById('theme-toggle-btn');
  const iconDark = document.getElementById('theme-icon-dark');
  const iconLight = document.getElementById('theme-icon-light');

  function applyTheme(mode){
    if(mode === 'light'){
      html.classList.add('light-mode');
      if(iconDark) iconDark.style.display = 'none';
      if(iconLight) iconLight.style.display = '';
      try { sessionStorage.setItem(THEME_KEY, 'light'); } catch(e){}
    } else {
      html.classList.remove('light-mode');
      if(iconDark) iconDark.style.display = '';
      if(iconLight) iconLight.style.display = 'none';
      try { sessionStorage.setItem(THEME_KEY, 'dark'); } catch(e){}
    }
  }

  // Restore saved theme
  try {
    const saved = sessionStorage.getItem(THEME_KEY);
    if(saved === 'light') applyTheme('light');
    else if(saved === 'dark') applyTheme('dark');
    else {
      // Respect system preference on first load
      const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      applyTheme(prefersDark ? 'dark' : 'light');
    }
  } catch(e){ applyTheme('dark'); }

  if(themeToggleBtn){
    themeToggleBtn.addEventListener('click', function(){
      const isLight = html.classList.contains('light-mode');
      applyTheme(isLight ? 'dark' : 'light');
    });
  }

  /* ---- FAB: show on Players tab, hide elsewhere ---- */
  const fab = document.getElementById('fab-add-player');
  if(fab){
    // Show/hide based on current tab via MutationObserver on the view
    function updateFabVisibility(){
      const tabNav = document.getElementById('tabNav');
      if(!tabNav) return;
      const active = tabNav.querySelector('.tab-btn.active');
      const tab = active ? active.dataset.tab : '';
      const shouldShow = tab === 'players' || tab === '';
      if(shouldShow){
        fab.style.display = 'flex';
        fab.classList.remove('fab-hidden');
      } else {
        fab.classList.add('fab-hidden');
        setTimeout(()=>{ if(fab.classList.contains('fab-hidden')) fab.style.display = 'none'; }, 300);
      }
    }

    // Watch tab changes
    const tabNav = document.getElementById('tabNav');
    if(tabNav){
      const obs = new MutationObserver(updateFabVisibility);
      obs.observe(tabNav, { attributes: true, subtree: true, attributeFilter: ['class'] });
    }
    // Initial check after app boots
    setTimeout(updateFabVisibility, 600);

    // FAB click — navigate to players tab and focus add input
    fab.addEventListener('click', function(){
      // Try to switch to players tab
      const tabNav = document.getElementById('tabNav');
      if(tabNav){
        const playersTab = tabNav.querySelector('[data-tab="players"]');
        if(playersTab) playersTab.click();
      }
      // Focus the player name input after a brief delay
      setTimeout(()=>{
        const nameInput = document.getElementById('newPlayerName') || document.querySelector('input[placeholder*="name"]') || document.querySelector('input[placeholder*="Name"]');
        if(nameInput){ nameInput.focus(); nameInput.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      }, 250);
    });
  }

  /* ---- Ripple effect on buttons ---- */
  document.addEventListener('click', function(e){
    const btn = e.target.closest('.btn-primary, .btn-court, .tab-btn');
    if(!btn) return;
    const rect = btn.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const ripple = document.createElement('span');
    ripple.style.cssText = `
      position:absolute; border-radius:50%; pointer-events:none;
      width:${Math.max(rect.width,rect.height)*2}px;
      height:${Math.max(rect.width,rect.height)*2}px;
      left:${x - Math.max(rect.width,rect.height)}px;
      top:${y - Math.max(rect.width,rect.height)}px;
      background:rgba(255,255,255,0.18);
      transform:scale(0); animation: ripple 0.5s ease forwards;
    `;
    // Ensure btn is positioned
    if(getComputedStyle(btn).position === 'static') btn.style.position = 'relative';
    btn.appendChild(ripple);
    setTimeout(()=>ripple.remove(), 600);
  }, { passive: true });

  /* ---- Smooth page scroll on tab switch ---- */
  document.addEventListener('click', function(e){
    const tab = e.target.closest('.tab-btn');
    if(tab) window.scrollTo({ top: 0, behavior: 'smooth' });
  }, { passive: true });

  /* ---- Enhanced confirmation dialog helper ---- */
  window.showConfirmDialog = function(opts){
    // opts: { icon, title, message, confirmLabel, cancelLabel, confirmClass, onConfirm, onCancel }
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-dialog" role="dialog" aria-modal="true">
        <div class="confirm-icon">${opts.icon || '⚠️'}</div>
        <div class="confirm-title">${opts.title || 'Are you sure?'}</div>
        <div class="confirm-msg">${opts.message || ''}</div>
        <div class="confirm-actions">
          <button class="btn btn-ghost" id="cd-cancel">${opts.cancelLabel || 'Cancel'}</button>
          <button class="btn ${opts.confirmClass || 'btn-danger'}" id="cd-confirm">${opts.confirmLabel || 'Confirm'}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = ()=>{ overlay.style.opacity='0'; overlay.style.transition='opacity .15s ease'; setTimeout(()=>overlay.remove(), 160); };
    overlay.querySelector('#cd-cancel').addEventListener('click', ()=>{ close(); opts.onCancel && opts.onCancel(); });
    overlay.querySelector('#cd-confirm').addEventListener('click', ()=>{ close(); opts.onConfirm && opts.onConfirm(); });
    overlay.addEventListener('click', e=>{ if(e.target===overlay){ close(); opts.onCancel && opts.onCancel(); } });
    // Trap focus
    overlay.querySelector('#cd-confirm').focus();
  };

  /* ---- Loading animation for data-heavy operations ---- */
  window.showLoadingOverlay = function(msg){
    let el = document.getElementById('ml-loading-overlay');
    if(!el){
      el = document.createElement('div');
      el.id = 'ml-loading-overlay';
      el.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.45);backdrop-filter:blur(6px);z-index:300;display:flex;align-items:center;justify-content:center;animation:fadeIn .15s ease;`;
      el.innerHTML = `<div style="background:var(--glass-bg);backdrop-filter:blur(20px);border:1px solid var(--glass-border);border-radius:18px;padding:28px 32px;text-align:center;box-shadow:var(--shadow-float);">
        <div style="width:36px;height:36px;border:3px solid var(--line);border-top-color:var(--ball);border-radius:50%;animation:spin .7s linear infinite;margin:0 auto 14px;"></div>
        <div style="font-size:13.5px;font-weight:600;color:var(--text-dim);">${msg||'Loading…'}</div>
      </div>`;
      document.body.appendChild(el);
    }
    return el;
  };
  window.hideLoadingOverlay = function(){
    const el = document.getElementById('ml-loading-overlay');
    if(el){ el.style.opacity='0'; el.style.transition='opacity .15s ease'; setTimeout(()=>el.remove(),160); }
  };

  /* ---- Spin keyframe (for loading spinner above) ---- */
  if(!document.getElementById('ml-spin-style')){
    const s = document.createElement('style');
    s.id = 'ml-spin-style';
    s.textContent = '@keyframes spin { to { transform: rotate(360deg); } }';
    document.head.appendChild(s);
  }

  /* ---- Intercept modal close button to add exit animation ---- */
  document.addEventListener('click', function(e){
    const closeBtn = e.target.closest('[data-action="modal-close"]');
    if(!closeBtn) return;
    const bg = document.querySelector('.modal-bg');
    if(bg){
      e.stopImmediatePropagation();
      const sheet = bg.querySelector('.modal-sheet');
      if(sheet){ sheet.style.transform='translateY(32px)'; sheet.style.opacity='0.6'; sheet.style.transition='transform .18s ease, opacity .18s ease'; }
      bg.style.opacity='0'; bg.style.transition='opacity .18s ease';
      setTimeout(()=>{ bg.remove(); }, 200);
    }
  }, true);

})();


/* ================================================================
   KITCHEN LADDER — PROTECTION LAYER
   Techniques: DevTools detection, right-click/copy disable,
   authorship watermark in storage, console branding,
   source obfuscation notice, mutation observer guard.
   ================================================================ */
(function klProtect(){

  /* 1. ---- Console branding — anyone opening DevTools sees this ---- */
  const S1 = 'font-size:22px;font-weight:900;color:#D7F23D;background:#11151A;padding:8px 18px;border-radius:8px;';
  const S2 = 'font-size:13px;color:#9AA5B1;background:#11151A;padding:4px 18px 8px;';
  const S3 = 'font-size:12px;color:#FF6B6B;background:#11151A;padding:2px 18px 6px;';
  console.log('%c🏓 Maezku Ladder', S1);
  console.log('%c© 2026 Maezku · All Rights Reserved\nhttps://github.com/renzku · znerolodarbe@gmail.com', S2);
  console.log('%c⚠️  This app is protected. Unauthorized copying is prohibited.', S3);

  /* 2. ---- Burn authorship into every available storage layer ---- */
  const SIG = {
    app: 'Maezku Ladder',
    author: 'Mae & Renzku',
    contact: 'znerolodarbe@gmail.com',
    year: 2026,
    fingerprint: 'ML-MAEZKU-2026-ORIGINAL',
    rights: 'All Rights Reserved',
    built: new Date().toISOString(),
  };
  try { localStorage.setItem('_ml_author', JSON.stringify(SIG)); } catch(e){}
  try { sessionStorage.setItem('_ml_author', JSON.stringify(SIG)); } catch(e){}
  try {
    const req = indexedDB.open('_ml_meta', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if(!db.objectStoreNames.contains('sig')) db.createObjectStore('sig');
    };
    req.onsuccess = e => {
      const db = e.target.result;
      const tx = db.transaction('sig','readwrite');
      tx.objectStore('sig').put(SIG, 'authorship');
    };
  } catch(e){}

  /* 3. ---- Right-click disable with polite message ---- */
  document.addEventListener('contextmenu', function(e){
    const tag = e.target.tagName;
    if(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return; // allow on form fields
    e.preventDefault();
    showCopyWarning();
  });

  /* 4. ---- Keyboard shortcut intercepts ---- */
  document.addEventListener('keydown', function(e){
    const ctrl = e.ctrlKey || e.metaKey;
    // Block Ctrl+U (view-source), Ctrl+S (save), Ctrl+Shift+I/J/C (devtools)
    if(ctrl && (e.key === 'u' || e.key === 'U')) { e.preventDefault(); showCopyWarning(); return; }
    if(ctrl && (e.key === 's' || e.key === 'S')) { e.preventDefault(); showSaveWarning(); return; }
    if(ctrl && e.shiftKey && ['i','I','j','J','c','C'].includes(e.key)) { showDevToolsWarning(); return; }
    if(e.key === 'F12') { showDevToolsWarning(); return; }
    // Block Ctrl+A (select all) outside inputs
    if(ctrl && (e.key === 'a' || e.key === 'A')){
      const tag = document.activeElement && document.activeElement.tagName;
      if(tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT'){ e.preventDefault(); return; }
    }
    // Block Ctrl+C copy on non-input elements
    if(ctrl && (e.key === 'c' || e.key === 'C')){
      const sel = window.getSelection();
      if(sel && sel.toString().length > 0){
        const tag = document.activeElement && document.activeElement.tagName;
        if(tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT'){
          e.preventDefault();
          showCopyWarning();
        }
      }
    }
  });

  /* 5. ---- DevTools size-change detection ---- */
  let _devtoolsOpen = false;
  const DT_THRESHOLD = 160;
  function checkDevTools(){
    const widthDiff  = window.outerWidth  - window.innerWidth;
    const heightDiff = window.outerHeight - window.innerHeight;
    const open = widthDiff > DT_THRESHOLD || heightDiff > DT_THRESHOLD;
    if(open && !_devtoolsOpen){
      _devtoolsOpen = true;
      showDevToolsWarning();
    } else if(!open && _devtoolsOpen){
      _devtoolsOpen = false;
      hideDevToolsWarning();
    }
  }
  setInterval(checkDevTools, 1500);

  /* 6. ---- Print intercept ---- */
  window.addEventListener('beforeprint', function(){
    const el = document.getElementById('ml-devtools-warning');
    if(el){
      el.querySelector('.dw-title').textContent = '🖨️ Printing Disabled';
      el.querySelector('.dw-msg').textContent =
        'Maezku Ladder is proprietary software by Mae & Renzku. Printing or screenshotting this app for redistribution is not permitted.';
      el.classList.add('show');
    }
    setTimeout(hideDevToolsWarning, 3000);
  });

  /* 7. ---- Drag intercept (prevent drag-saving images/elements, desktop only) ---- */
  document.addEventListener('dragstart', function(e){
    // Only block on desktop pointer events, never block touch-initiated events
    if(e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents) return;
    if(e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA'){
      e.preventDefault();
    }
  });

  /* 8. ---- Clipboard intercept — append attribution on copy ---- */
  document.addEventListener('copy', function(e){
    const sel = window.getSelection();
    if(!sel || !sel.toString().trim()) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if(tag === 'INPUT' || tag === 'TEXTAREA') return;
    const original = sel.toString();
    const attribution = '\n\n— Maezku Ladder © 2026 Maezku. All Rights Reserved.';
    try {
      e.clipboardData.setData('text/plain', original + attribution);
      e.preventDefault();
    } catch(err){}
  });

  /* 9. ---- Mutation observer: guard brand-name & copyright from removal ---- */
  const brandObs = new MutationObserver(function(muts){
    muts.forEach(function(m){
      m.removedNodes.forEach(function(n){
        if(n.nodeType === 1){
          const cls = n.className || '';
          if(typeof cls === 'string' && (cls.includes('brand') || cls.includes('topbar'))){
            console.warn('[KL] Protected element removed — authorship guard triggered.');
          }
        }
      });
    });
  });
  brandObs.observe(document.body, { childList: true, subtree: true });

  /* 10. ---- Hidden authorship element in DOM ---- */
  const meta = document.createElement('meta');
  meta.name = 'kl-author';
  meta.content = 'Maezku Ladder © 2026 Maezku. All Rights Reserved. Fingerprint: ML-MAEZKU-2026-ORIGINAL';
  document.head.appendChild(meta);

  /* ---- UI helper: copy warning ---- */
  function showCopyWarning(){
    _showWarning(
      '🔒',
      'Content Protected',
      'Maezku Ladder is proprietary software by Mae & Renzku.\nUnauthorized copying or redistribution is prohibited.\n\n© 2026 Maezku · All Rights Reserved'
    );
  }
  function showSaveWarning(){
    _showWarning(
      '💾',
      'Saving Disabled',
      'This app\'s source code is protected intellectual property.\nSaving or redistributing this file without permission is prohibited.\n\n© 2026 Maezku · All Rights Reserved'
    );
  }
  function showDevToolsWarning(){
    _showWarning(
      '🛠️',
      'Developer Tools Detected',
      'Maezku Ladder\'s source code is the intellectual property of Renzku.\nInspecting or copying this code without permission is prohibited.\n\n© 2026 Maezku · All Rights Reserved'
    );
  }
  function _showWarning(icon, title, msg){
    let el = document.getElementById('ml-devtools-warning');
    if(!el){
      el = document.createElement('div');
      el.id = 'ml-devtools-warning';
      el.innerHTML = `
        <div class="dw-icon">${icon}</div>
        <div class="dw-title">${title}</div>
        <div class="dw-msg">${msg.replace(/\n/g,'<br>')}</div>
        <button class="dw-close" onclick="document.getElementById('ml-devtools-warning').classList.remove('show')">I Understand</button>`;
      document.body.appendChild(el);
    } else {
      el.querySelector('.dw-icon').textContent = icon;
      el.querySelector('.dw-title').textContent = title;
      el.querySelector('.dw-msg').innerHTML = msg.replace(/\n/g,'<br>');
    }
    el.classList.add('show');
  }
  function hideDevToolsWarning(){
    const el = document.getElementById('ml-devtools-warning');
    if(el) el.classList.remove('show');
  }

})();
