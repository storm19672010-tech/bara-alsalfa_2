'use strict';
/**
 * برّا السالفة — سيرفر اللعبة
 * Node.js بدون أي مكتبات خارجية. الغرف محفوظة بالذاكرة.
 * الاتصال الحي بين اللاعبين: Server-Sent Events (SSE) + طلبات POST.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TOPICS, ANIME_INFO, ANIME_SHOWS, imageQuery } = require('./topics');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- إعدادات اللعبة ----------
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 12;
// ملاحظة: ما في أي مؤقتات بالعبة. المضيف هو اللي ينقل بين المراحل.
const CORRECT_POINTS = 100;  // تصويت صح / تخمين صح
const PENALTY_POINTS = 10;   // خصم السؤال الكاشف
const MAX_PROPOSALS = 3;     // عدد محاولات طلب الخصم لكل لاعب بالجولة
const MAX_WORD_CHANGES = 2;  // عدد محاولات طلب تغيير السالفة لكل لاعب بالجولة
const GUESS_OPTIONS = 9;     // عدد خيارات التخمين

const TOPIC_LIST = TOPICS.map(({ id, name, icon, words }) => ({ id, name, icon, count: words.length }));
const rooms = new Map();

// ---------- أدوات ----------
const rid = () => crypto.randomBytes(6).toString('hex');
const pick = (a) => a[Math.floor(Math.random() * a.length)];
function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function newCode() {
  for (let i = 0; i < 300; i++) {
    const c = String(10000 + crypto.randomInt(90000));
    if (!rooms.has(c)) return c;
  }
  return null;
}
function cleanName(n) {
  return String(n == null ? '' : n).replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
}
const nameKey = (n) => String(n).toLowerCase()
  .replace(/[ً-ٰٟـ]/g, '')
  .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
  .replace(/[\s\-_.]+/g, '');
const ok = (extra) => Object.assign({ ok: true }, extra || {});
const err = (m, status) => ({ error: m, status: status || 400 });

// ---------- الغرف واللاعبين ----------
function addPlayer(room, name) {
  const p = {
    id: rid(), name, token: crypto.randomBytes(16).toString('hex'),
    score: 0, connected: false, conn: null, dcTimer: null, checkTimer: null, readyNext: false,
  };
  room.players.set(p.id, p);
  return p;
}

function createRoom(hostName) {
  const code = newCode();
  if (!code) return null;
  const room = {
    code, hostId: null, phase: 'lobby', players: new Map(), round: null, roundNo: 0,
    notice: null, toast: null, toastSeq: 0, timer: null, lastActive: Date.now(),
  };
  rooms.set(code, room);
  const p = addPlayer(room, hostName);
  room.hostId = p.id;
  return { room, p };
}

function destroyRoom(room) {
  clearTimeout(room.timer);
  for (const p of room.players.values()) {
    clearTimeout(p.dcTimer); clearTimeout(p.checkTimer);
    if (p.conn) { try { p.conn.end(); } catch (e) { /* ignore */ } p.conn = null; }
  }
  rooms.delete(room.code);
}

function toast(room, text) {
  room.toast = { id: ++room.toastSeq, text };
}

function connectedParticipants(room) {
  const r = room.round;
  if (!r) return [];
  return r.participants.filter((id) => room.players.get(id) && room.players.get(id).connected);
}

function pickNewHost(room, exceptId) {
  const list = [...room.players.values()].filter((p) => p.id !== exceptId);
  const inRound = room.round ? room.round.participants : [];
  const c = list.find((p) => p.connected && inRound.includes(p.id)) || list.find((p) => p.connected) || list[0];
  return c ? c.id : null;
}

// ---------- منطق الجولة ----------
function setPhase(room, phase) {
  clearTimeout(room.timer);
  room.timer = null;
  room.phase = phase;
}

function startRound(room, topic, players) {
  const ids = players.map((p) => p.id);
  const participants = shuffle(ids);
  const order = shuffle(ids);
  room.roundNo += 1;
  room.notice = null;
  for (const p of room.players.values()) p.readyNext = false;
  room.round = {
    topic, word: pick(topic.words), outsiderId: pick(ids), participants,
    order, ready: new Set(), turns: order.map((id, i) => ({ from: id, to: order[(i + 1) % order.length] })),
    turnIdx: -1,
    votes: new Map(), guess: null, breakdown: null,
    penalty: { active: null, applied: new Map(), proposals: new Map(), seq: 0 },
    wordChange: { active: null, proposals: new Map(), used: [], seq: 0 },
  };
  room.round.wordChange.used.push(room.round.word);
  setPhase(room, 'reveal');
}

function validTurn(room, t) {
  const r = room.round;
  return t && r.participants.includes(t.from) && r.participants.includes(t.to) && room.players.has(t.from) && room.players.has(t.to);
}

function enterQuestions(room) {
  const r = room.round;
  setPhase(room, 'questions');
  r.turnIdx = -1;
  advanceTurn(room);
}

function advanceTurn(room) {
  const r = room.round;
  r.turnIdx += 1;
  while (r.turnIdx < r.turns.length && !validTurn(room, r.turns[r.turnIdx])) r.turnIdx += 1;
  if (r.turnIdx >= r.turns.length) enterFree(room);
}

function enterFree(room) {
  const r = room.round;
  setPhase(room, 'free');
}

function enterVote(room) {
  const r = room.round;
  setPhase(room, 'vote');
  r.penalty.active = null;
  r.wordChange.active = null;
}

function finishVote(room) {
  const r = room.round;
  setPhase(room, 'guess');
  const others = shuffle(r.topic.words.filter((w) => w !== r.word)).slice(0, GUESS_OPTIONS - 1);
  r.guess = { options: shuffle([r.word, ...others]), picked: null, correct: false, timedOut: false };
}

function finishRound(room, picked) {
  const r = room.round;
  setPhase(room, 'scores');
  r.guess.picked = picked;
  r.guess.timedOut = picked == null;
  r.guess.correct = picked === r.word;
  // إلغاء أي تصويت خصم معلّق
  r.penalty.active = null;
  r.wordChange.active = null;
  r.breakdown = [];
  for (const id of r.participants) {
    const p = room.players.get(id);
    if (!p) continue;
    const voteCorrect = id !== r.outsiderId && r.votes.get(id) === r.outsiderId;
    const guessCorrect = id === r.outsiderId && r.guess.correct;
    const penalties = r.penalty.applied.get(id) || 0;
    const delta = (voteCorrect ? CORRECT_POINTS : 0) + (guessCorrect ? CORRECT_POINTS : 0) - penalties * PENALTY_POINTS;
    p.score += delta;
    r.breakdown.push({ id, voteCorrect, guessCorrect, penalties, delta, votedFor: r.votes.get(id) || null });
  }
  for (const p of room.players.values()) p.readyNext = false;
}

function toLobby(room) {
  clearTimeout(room.timer);
  for (const p of [...room.players.values()]) {
    if (!p.connected) {
      room.players.delete(p.id);
      clearTimeout(p.dcTimer); clearTimeout(p.checkTimer);
    }
    else p.readyNext = false;
  }
  if (!room.players.has(room.hostId)) room.hostId = pickNewHost(room);
  room.round = null;
  setPhase(room, 'lobby');
  if (room.players.size === 0) destroyRoom(room);
}

function abortRound(room, text) {
  room.round = null;
  setPhase(room, 'lobby');
  room.notice = text;
  for (const p of room.players.values()) p.readyNext = false;
}

// ---------- خصم السؤال الكاشف ----------
function penaltyVoters(room, pen) {
  const r = room.round;
  return r.participants.filter((id) => {
    const p = room.players.get(id);
    return id !== pen.targetId && p && (p.connected || pen.votes[id] !== undefined);
  });
}

function endPenalty(room, passed, why) {
  const r = room.round;
  const pen = r.penalty.active;
  if (!pen) return;
  r.penalty.active = null;
  const target = room.players.get(pen.targetId);
  if (passed && target) {
    r.penalty.applied.set(pen.targetId, (r.penalty.applied.get(pen.targetId) || 0) + 1);
    toast(room, `تم خصم ${PENALTY_POINTS} نقاط من ${target.name} ✂️`);
  } else {
    toast(room, why || 'ما وافق الكل، الخصم ملغي');
  }
}

function checkPenalty(room) {
  const r = room.round;
  if (!r) return;
  const pen = r.penalty.active;
  if (!pen) return;
  if (!r.participants.includes(pen.targetId) || !room.players.has(pen.targetId)) return endPenalty(room, false, 'اللاعب المقصود طلع من الغرفة، الخصم ملغي');
  const voters = penaltyVoters(room, pen);
  if (voters.some((id) => pen.votes[id] === false)) return endPenalty(room, false, 'في لاعب رفض، الخصم ملغي');
  if (voters.length && voters.every((id) => pen.votes[id] === true)) return endPenalty(room, true);
}

// ---------- تغيير السالفة (لازم الكل يوافق) ----------
function wcVoters(room, wc) {
  const r = room.round;
  return r.participants.filter((id) => {
    const p = room.players.get(id);
    return p && (p.connected || wc.votes[id] !== undefined);
  });
}

function endWordChange(room, passed, why) {
  const r = room.round;
  const wc = r.wordChange.active;
  if (!wc) return;
  r.wordChange.active = null;
  if (passed) {
    const left = r.topic.words.filter((w) => !r.wordChange.used.includes(w));
    if (left.length) {
      r.word = pick(left);
      r.wordChange.used.push(r.word);
      toast(room, 'تم تغيير السالفة 🔄 شوفوا بطاقاتكم (🎴) للسالفة الجديدة');
      return;
    }
  }
  toast(room, why || 'ما وافق الكل، السالفة ما تغيّرت');
}

function checkWordChange(room) {
  const r = room.round;
  if (!r || !r.wordChange.active) return;
  if (!['questions', 'free'].includes(room.phase)) return;
  const wc = r.wordChange.active;
  const voters = wcVoters(room, wc);
  if (voters.some((id) => wc.votes[id] === false)) return endWordChange(room, false, 'في لاعب رفض، السالفة ما تغيّرت');
  if (voters.length && voters.every((id) => wc.votes[id] === true)) return endWordChange(room, true);
}

// ---------- متابعة التقدم (جاهزين / صوتوا / ...) ----------
function checkProgress(room) {
  const r = room.round;
  if (room.phase === 'reveal' && r) {
    const conn = connectedParticipants(room);
    if (conn.length && conn.every((id) => r.ready.has(id))) enterQuestions(room);
  } else if (room.phase === 'vote' && r) {
    const conn = connectedParticipants(room);
    if (conn.length && conn.every((id) => r.votes.has(id))) finishVote(room);
  } else if (room.phase === 'scores') {
    const conn = [...room.players.values()].filter((p) => p.connected);
    if (conn.length && conn.every((p) => p.readyNext)) toLobby(room);
    return;
  }
  if (room.round && (room.phase === 'questions' || room.phase === 'free' || room.phase === 'vote')) checkPenalty(room);
  if (room.round) checkWordChange(room);
}

// ---------- إزالة لاعب ----------
function removePlayer(room, pid, reason) {
  const p = room.players.get(pid);
  if (!p) return;
  clearTimeout(p.dcTimer); clearTimeout(p.checkTimer);
  const conn = p.conn;
  const leftName = p.name;
  p.conn = null;
  room.players.delete(pid);
  if (conn) { try { conn.end(); } catch (e) { /* ignore */ } }
  if (room.players.size === 0) { destroyRoom(room); return; }
  let msg = reason || `${leftName} طلع من الغرفة 🚪`;
  if (room.hostId === pid) {
    room.hostId = pickNewHost(room, pid);
    const nh = room.players.get(room.hostId);
    if (nh) msg += ` — ${nh.name} صار المضيف الجديد 👑`;
  }
  toast(room, msg);

  const r = room.round;
  const live = ['reveal', 'questions', 'free', 'vote', 'guess'].includes(room.phase);
  if (r && live && r.participants.includes(pid)) {
    r.participants = r.participants.filter((x) => x !== pid);
    r.ready.delete(pid);
    r.votes.delete(pid);
    for (const [k, v] of [...r.votes]) if (v === pid) r.votes.delete(k);
    if (pid === r.outsiderId || r.participants.length < MIN_PLAYERS) {
      abortRound(room, 'لاعب طلع من الغرفة وانلغت الجولة. السكور محفوظ، ابدؤوا جولة جديدة.');
    } else {
      // نعيد بناء سلسلة الأسئلة بدون اللاعب اللي طلع (ينلغى دوره)
      const oldIdx = r.turnIdx;
      const cur = r.turns[oldIdx];
      r.order = r.order.filter((x) => x !== pid);
      r.turns = r.order.map((id, i) => ({ from: id, to: r.order[(i + 1) % r.order.length] }));
      if (room.phase === 'questions') {
        if (cur && cur.from !== pid && r.order.includes(cur.from)) r.turnIdx = r.order.indexOf(cur.from);
        else { r.turnIdx = oldIdx - 1; advanceTurn(room); }
      } else if (room.phase !== 'reveal') {
        r.turnIdx = r.turns.length;
      }
      if (room.round) { checkProgress(room); }
    }
  } else {
    checkProgress(room);
  }
}

// ---------- العرض (الحالة المرسلة لكل لاعب) ----------
function penaltyView(room, pid) {
  const r = room.round;
  const pen = r.penalty.active;
  const out = {
    applied: Object.fromEntries(r.penalty.applied),
    proposalsLeft: Math.max(0, MAX_PROPOSALS - (r.penalty.proposals.get(pid) || 0)),
    active: null,
  };
  if (pen) {
    const voters = penaltyVoters(room, pen);
    out.active = {
      id: pen.id, targetId: pen.targetId, proposerId: pen.proposerId,
      votes: pen.votes, voters, canVote: voters.includes(pid) && pen.votes[pid] === undefined,
    };
  }
  return out;
}

function wordChangeView(room, pid) {
  const r = room.round;
  const wc = r.wordChange.active;
  const out = { proposalsLeft: Math.max(0, MAX_WORD_CHANGES - (r.wordChange.proposals.get(pid) || 0)), active: null };
  if (wc) {
    const voters = wcVoters(room, wc);
    out.active = { id: wc.id, proposerId: wc.proposerId, votes: wc.votes, voters, canVote: voters.includes(pid) && wc.votes[pid] === undefined };
  }
  return out;
}

// صورة السالفة (بحث ويكيبيديا يتم من المتصفح) + معلومات الشخصية إذا الموضوع شخصيات أنمي
function wordExtras(r) {
  // شخصيات الأنمي: تفاصيل بس بدون صورة
  const out = r.topic.id === 'animechars' ? {} : { img: imageQuery(r.topic.id, r.word) };
  if (r.topic.id === 'animechars' && ANIME_INFO[r.word]) out.info = { anime: ANIME_INFO[r.word][0], detail: ANIME_INFO[r.word][1] };
  else if (r.topic.id === 'anime' && ANIME_SHOWS[r.word]) out.info = { anime: null, detail: ANIME_SHOWS[r.word][0] };
  return out;
}

function view(room, pid) {
  const r = room.round;
  const v = {
    now: Date.now(), code: room.code, me: pid, hostId: room.hostId, phase: room.phase,
    roundNo: room.roundNo, notice: room.notice, toast: room.toast, min: MIN_PLAYERS, max: MAX_PLAYERS,
    cfg: { wordChangeMax: MAX_WORD_CHANGES, penaltyPoints: PENALTY_POINTS, correct: CORRECT_POINTS, maxProposals: MAX_PROPOSALS },
    players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name, score: p.score, connected: p.connected, ready: !!p.readyNext })),
  };
  // خصم السؤال الكاشف يظهر فوراً بلوحة الترتيب (قبل نهاية الجولة)
  if (r && ['reveal', 'questions', 'free', 'vote', 'guess'].includes(room.phase)) {
    for (const pl of v.players) {
      const n = r.penalty.applied.get(pl.id) || 0;
      if (n) { pl.score -= n * PENALTY_POINTS; pl.pending = -n * PENALTY_POINTS; }
    }
  }
  if (room.phase === 'lobby') v.topics = TOPIC_LIST;
  if (!r || room.phase === 'lobby') return v;

  const phase = room.phase;
  const inRound = r.participants.includes(pid);
  const g = { topic: { id: r.topic.id, name: r.topic.name, icon: r.topic.icon }, inRound, participants: r.participants };
  if (inRound && phase !== 'scores') {
    g.role = pid === r.outsiderId ? 'out' : 'in';
    if (g.role === 'in') { g.word = r.word; Object.assign(g, wordExtras(r)); }
  }
  if (phase === 'reveal') {
    g.readyIds = [...r.ready];
    g.total = connectedParticipants(room).length;
  } else if (phase === 'questions') {
    g.turns = r.turns; g.turnIdx = r.turnIdx; g.penalty = penaltyView(room, pid); g.wordChange = wordChangeView(room, pid);
  } else if (phase === 'free') {
    g.penalty = penaltyView(room, pid); g.wordChange = wordChangeView(room, pid);
  } else if (phase === 'vote') {
    g.voted = [...r.votes.keys()]; g.myVote = r.votes.get(pid) || null;
  } else if (phase === 'guess') {
    g.outsiderId = r.outsiderId; g.votes = Object.fromEntries(r.votes);
    if (pid === r.outsiderId) g.options = r.guess.options;
  } else if (phase === 'scores') {
    g.outsiderId = r.outsiderId; g.word = r.word; g.votes = Object.fromEntries(r.votes);
    Object.assign(g, wordExtras(r));
    g.guess = { picked: r.guess.picked, correct: r.guess.correct, timedOut: r.guess.timedOut };
    g.breakdown = r.breakdown;
  }
  v.game = g;
  return v;
}

function sendState(room, p) {
  if (!p.conn) return;
  try { p.conn.write(`data: ${JSON.stringify(view(room, p.id))}\n\n`); } catch (e) { /* ignore */ }
}

function broadcast(room) {
  room.lastActive = Date.now();
  for (const p of room.players.values()) sendState(room, p);
}

// ---------- الأوامر ----------
function act(room, p, b) {
  const r = room.round;
  const isHost = p.id === room.hostId;
  const inRound = !!r && r.participants.includes(p.id);

  switch (b.type) {
    case 'start': {
      if (!isHost) return err('بس مضيف الغرفة يبدأ اللعبة');
      if (room.phase !== 'lobby') return err('الجولة شغّالة أصلاً');
      const conn = [...room.players.values()].filter((x) => x.connected);
      if (conn.length < MIN_PLAYERS) return err(`لازم ${MIN_PLAYERS} لاعبين على الأقل`);
      const topic = b.topicId === 'random' ? pick(TOPICS) : TOPICS.find((t) => t.id === b.topicId);
      if (!topic) return err('اختر موضوع أول');
      startRound(room, topic, conn);
      return ok();
    }
    case 'ready': {
      if (room.phase !== 'reveal' || !inRound) return err('مو وقتها');
      r.ready.add(p.id);
      checkProgress(room);
      return ok();
    }
    case 'skipReveal': {
      if (!isHost || room.phase !== 'reveal') return err('مو وقتها');
      enterQuestions(room);
      return ok();
    }
    case 'nextTurn': {
      if (room.phase !== 'questions') return err('مو وقتها');
      if (!isHost) return err('بس المضيف ينقل للسؤال اللي بعده');
      advanceTurn(room);
      return ok();
    }
    case 'skipToFree': {
      if (!isHost || room.phase !== 'questions') return err('مو وقتها');
      enterFree(room);
      return ok();
    }
    case 'startVote': {
      if (!isHost || room.phase !== 'free') return err('مو وقتها');
      enterVote(room);
      return ok();
    }
    case 'proposePenalty': {
      if (!['questions', 'free'].includes(room.phase) || !inRound) return err('الخصم متاح أثناء الأسئلة بس');
      if (r.penalty.active || r.wordChange.active) return err('في تصويت شغّال، استنى');
      const target = String(b.targetId || '');
      if (target === p.id) return err('ما بتقدر تخصم من نفسك');
      if (!r.participants.includes(target) || !room.players.has(target)) return err('اللاعب مو موجود');
      const used = r.penalty.proposals.get(p.id) || 0;
      if (used >= MAX_PROPOSALS) return err(`خلصت محاولاتك (${MAX_PROPOSALS} بالجولة)`);
      r.penalty.proposals.set(p.id, used + 1);
      const pen = { id: ++r.penalty.seq, targetId: target, proposerId: p.id, votes: { [p.id]: true } };
      r.penalty.active = pen;
      checkPenalty(room);
      return ok();
    }
    case 'proposeWordChange': {
      if (!['questions', 'free'].includes(room.phase) || !inRound) return err('تغيير السالفة متاح أثناء الأسئلة بس');
      if (r.penalty.active || r.wordChange.active) return err('في تصويت شغّال، استنى');
      const used = r.wordChange.proposals.get(p.id) || 0;
      if (used >= MAX_WORD_CHANGES) return err(`خلصت محاولاتك (${MAX_WORD_CHANGES} بالجولة)`);
      if (!r.topic.words.some((w) => !r.wordChange.used.includes(w))) return err('ما بقي سوالف جديدة بهالموضوع');
      r.wordChange.proposals.set(p.id, used + 1);
      r.wordChange.active = { id: ++r.wordChange.seq, proposerId: p.id, votes: { [p.id]: true } };
      checkWordChange(room);
      return ok();
    }
    case 'wordChangeVote': {
      const wc = r && r.wordChange.active;
      if (!wc) return err('ما في تصويت شغّال');
      if (!inRound) return err('ما بتقدر تصوّت');
      if (wc.votes[p.id] !== undefined) return err('صوّتت من قبل');
      wc.votes[p.id] = !!b.agree;
      checkWordChange(room);
      return ok();
    }
    case 'cancelWordChange': {
      if (!r || !r.wordChange.active) return err('مو وقتها');
      const mine = r.wordChange.active.proposerId === p.id;
      if (!isHost && !mine) return err('بس اللي طلب التغيير أو المضيف يلغي');
      endWordChange(room, false, mine ? `${p.name} ألغى طلب تغيير السالفة` : 'المضيف ألغى تصويت تغيير السالفة');
      return ok();
    }
    case 'cancelPenalty': {
      if (!isHost || !r || !r.penalty.active) return err('مو وقتها');
      endPenalty(room, false, 'المضيف ألغى تصويت الخصم');
      return ok();
    }
    case 'endVote': {
      if (!isHost || room.phase !== 'vote') return err('مو وقتها');
      finishVote(room);
      return ok();
    }
    case 'skipGuess': {
      if (!isHost || room.phase !== 'guess') return err('مو وقتها');
      finishRound(room, null);
      return ok();
    }
    case 'penaltyVote': {
      const pen = r && r.penalty.active;
      if (!pen) return err('ما في تصويت شغّال');
      if (!inRound || p.id === pen.targetId) return err('ما بتقدر تصوّت');
      if (pen.votes[p.id] !== undefined) return err('صوّتت من قبل');
      pen.votes[p.id] = !!b.agree;
      checkPenalty(room);
      return ok();
    }
    case 'vote': {
      if (room.phase !== 'vote' || !inRound) return err('مو وقت التصويت');
      const t = String(b.targetId || '');
      if (t === p.id) return err('ما بتصوّت لنفسك');
      if (!r.participants.includes(t)) return err('اللاعب مو موجود');
      if (r.votes.has(p.id)) return err('صوّتت من قبل');
      r.votes.set(p.id, t);
      checkProgress(room);
      return ok();
    }
    case 'guess': {
      if (room.phase !== 'guess' || p.id !== r.outsiderId) return err('مو دورك');
      const w = String(b.word || '');
      if (!r.guess.options.includes(w)) return err('خيار غير صحيح');
      finishRound(room, w);
      return ok();
    }
    case 'readyNext': {
      if (room.phase !== 'scores') return err('مو وقتها');
      p.readyNext = true;
      checkProgress(room);
      return ok();
    }
    case 'startNext': {
      if (!isHost || room.phase !== 'scores') return err('مو وقتها');
      toLobby(room);
      return ok();
    }
    case 'kick': {
      if (!isHost || room.phase !== 'lobby') return err('الطرد من الصالة بس');
      const t = room.players.get(String(b.targetId || ''));
      if (!t || t.id === p.id) return err('ما بصير');
      if (t.conn) { try { t.conn.write('event: kicked\ndata: {}\n\n'); } catch (e) { /* ignore */ } }
      removePlayer(room, t.id, `${t.name} انطرد من الغرفة 🚪`);
      return ok();
    }
    case 'leave': {
      removePlayer(room, p.id);
      return ok({ left: true });
    }
    default:
      return err('أمر غير معروف');
  }
}

// ---------- HTTP ----------
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 10000) { req.destroy(); resolve(null); } });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function reply(res, result) {
  const status = result.error ? (result.status || 400) : 200;
  const out = Object.assign({}, result); delete out.status;
  json(res, status, out);
}

function auth(b) {
  const room = rooms.get(String(b.code || ''));
  if (!room) return { error: 'ما لقينا هالغرفة', status: 404 };
  const p = room.players.get(String(b.pid || ''));
  if (!p || p.token !== b.token) return { error: 'جلستك انتهت', status: 401 };
  return { room, p };
}

async function api(req, res, url) {
  const b = await readBody(req);
  if (!b) return json(res, 400, { error: 'طلب غير صالح' });

  if (url.pathname === '/api/create') {
    const name = cleanName(b.name);
    if (!name) return reply(res, err('اكتب اسمك'));
    const made = createRoom(name);
    if (!made) return reply(res, err('السيرفر مشغول، جرّب بعد شوي', 503));
    return reply(res, ok({ code: made.room.code, pid: made.p.id, token: made.p.token }));
  }

  if (url.pathname === '/api/join') {
    const room = rooms.get(String(b.code || '').trim());
    if (!room) return reply(res, err('ما لقينا غرفة بهالكود', 404));
    const name = cleanName(b.name);
    if (!name) return reply(res, err('اكتب اسمك'));
    const same = [...room.players.values()].find((p) => nameKey(p.name) === nameKey(name));
    if (same) {
      if (same.connected) return reply(res, err('الاسم مستخدم بالغرفة، اختر اسم ثاني', 409));
      same.token = crypto.randomBytes(16).toString('hex'); // رجوع لاعب انقطع
      return reply(res, ok({ code: room.code, pid: same.id, token: same.token }));
    }
    if (room.players.size >= MAX_PLAYERS) return reply(res, err('الغرفة ممتلئة', 409));
    const p = addPlayer(room, name);
    toast(room, ['lobby', 'scores'].includes(room.phase) ? `${p.name} دخل الغرفة 👋` : `${p.name} دخل الغرفة وبينتظر الجولة الجاية ⏳`);
    broadcast(room);
    return reply(res, ok({ code: room.code, pid: p.id, token: p.token }));
  }

  if (url.pathname === '/api/ping') {
    const a = auth(b);
    return reply(res, a.error ? a : ok());
  }

  if (url.pathname === '/api/action') {
    const a = auth(b);
    if (a.error) return reply(res, a);
    const result = act(a.room, a.p, b);
    if (rooms.has(a.room.code)) broadcast(a.room);
    return reply(res, result);
  }
  return json(res, 404, { error: 'غير موجود' });
}

function sse(req, res, url) {
  const a = auth({ code: url.searchParams.get('room'), pid: url.searchParams.get('pid'), token: url.searchParams.get('token') });
  if (a.error) return json(res, a.status, { error: a.error });
  const { room, p } = a;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');

  const old = p.conn;
  p.conn = res;
  p.connected = true;
  clearTimeout(p.dcTimer); clearTimeout(p.checkTimer);
  if (old) { try { old.end(); } catch (e) { /* ignore */ } }

  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* ignore */ } }, 20000);
  res.on('close', () => {
    clearInterval(ping);
    const cur = room.players.get(p.id);
    if (!cur || cur.conn !== res) return;
    cur.conn = null;
    cur.connected = false;
    cur.checkTimer = setTimeout(() => {
      if (rooms.has(room.code) && !cur.connected) { checkProgress(room); broadcast(room); }
    }, 6000);
    cur.dcTimer = setTimeout(() => {
      if (!rooms.has(room.code) || cur.connected || !room.players.has(cur.id)) return;
      if (['lobby', 'scores'].includes(room.phase)) removePlayer(room, cur.id);
      else if (room.hostId === cur.id) {
        room.hostId = pickNewHost(room, cur.id) || cur.id;
        const nh = room.players.get(room.hostId);
        if (nh && nh.id !== cur.id) toast(room, `${cur.name} انقطع، و${nh.name} صار المضيف الجديد 👑`);
      }
      if (rooms.has(room.code)) broadcast(room);
    }, 20000);
    broadcast(room);
  });
  broadcast(room);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function serveStatic(req, res, url) {
  if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (rel === '/' || rel === '') rel = '/index.html';
  let file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  // احتياط: إذا انرفع index.html برا مجلد public نقدّمه من المجلد الرئيسي
  if (rel === '/index.html' && !fs.existsSync(file)) file = path.join(__dirname, 'index.html');
  fs.readFile(file, (e, data) => {
    if (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400); return res.end(); }
  if (req.method === 'GET' && url.pathname === '/api/events') return sse(req, res, url);
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) return api(req, res, url);
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url);
  res.writeHead(405); res.end();
});

// تنظيف الغرف المهجورة
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const anyone = [...room.players.values()].some((p) => p.connected);
    if (!anyone && now - room.lastActive > 15 * 60 * 1000) destroyRoom(room);
  }
}, 60 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log(`برّا السالفة شغّالة على المنفذ ${PORT}`));
}
module.exports = { server };
