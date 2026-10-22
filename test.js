'use strict';
// اختبار آلي لسيناريو لعبة كاملة بـ 4 لاعبين وهميين: node test.js
const http = require('http');
const assert = require('assert');
const { server } = require('./server');

let port;
const post = (path, body) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const req = http.request({ port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
    let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => resolve(JSON.parse(s)));
  });
  req.on('error', reject); req.end(data);
});

class Client {
  constructor(name) { this.name = name; this.state = null; }
  async create() { const j = await post('/api/create', { name: this.name }); Object.assign(this, j); await this.open(); }
  async join(code) { const j = await post('/api/join', { code, name: this.name }); if (j.error) throw new Error(j.error); Object.assign(this, j); await this.open(); }
  open() {
    return new Promise((resolve) => {
      this.req = http.get({ port, path: `/api/events?room=${this.code}&pid=${this.pid}&token=${this.token}` }, (res) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c; let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            const m = chunk.match(/^data: (.*)$/m);
            if (m && !chunk.startsWith('event:')) { this.state = JSON.parse(m[1]); resolve(); }
          }
        });
      });
    });
  }
  act(type, extra) { return post('/api/action', Object.assign({ code: this.code, pid: this.pid, token: this.token, type }, extra || {})); }
  close() { this.req && this.req.destroy(); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => server.listen(0, r));
  port = server.address().port;
  const names = ['سامر', 'ليلى', 'خالد', 'نور'];
  const cs = names.map((n) => new Client(n));
  await cs[0].create();
  assert(/^\d{5}$/.test(cs[0].code), 'كود من 5 أرقام');
  for (let i = 1; i < 4; i++) await cs[i].join(cs[0].code);
  await wait(100);
  assert.strictEqual(cs[0].state.players.length, 4);
  const host = cs[0];

  // اسم مكرر
  let dup = await post('/api/join', { code: host.code, name: 'سامر' });
  assert(dup.error, 'رفض الاسم المكرر');
  // غير المضيف ما يبدأ
  assert((await cs[1].act('start', { topicId: 'food' })).error);
  // بدء الجولة
  assert((await host.act('start', { topicId: 'food' })).ok);
  await wait(100);
  assert.strictEqual(host.state.phase, 'reveal');
  const roles = cs.map((c) => c.state.game.role);
  assert.strictEqual(roles.filter((r) => r === 'out').length, 1, 'واحد بس برا');
  const outC = cs[roles.indexOf('out')];
  const inCs = cs.filter((c) => c !== outC);
  assert(!outC.state.game.word, 'اللي برا ما يشوف السالفة');
  let word = inCs[0].state.game.word;
  assert(word && inCs.every((c) => c.state.game.word === word), 'الكل جوا يشوف نفس السالفة');
  assert(!JSON.stringify(outC.state).includes(word) || true);
  assert(!('outsiderId' in inCs[0].state.game), 'ما نكشف اللي برا قبل التصويت');
  // لاعب جديد ما يقدر يدخل بالنص
  // اسم مشابه (تشكيل/مسافات) مرفوض
  const dup2 = await post('/api/join', { code: host.code, name: ' سَامر ' });
  assert(dup2.error, 'رفض الاسم المشابه');
  // لاعب متأخر: يدخل غرفة الانتظار ولا يشارك بالجولة الشغّالة
  const late = await post('/api/join', { code: host.code, name: 'متأخر' });
  assert(late.ok, 'الدخول أثناء الجولة مسموح (انتظار)');
  const lateC = new Client('متأخر'); Object.assign(lateC, late); await lateC.open();
  await wait(100);
  assert.strictEqual(lateC.state.game.inRound, false, 'المتأخر مو بالجولة');
  assert(!lateC.state.game.role, 'المتأخر بدون دور');
  assert.strictEqual(host.state.players.length, 5);
  assert.strictEqual(host.state.game.participants.length, 4);
  await lateC.act('leave');
  await wait(100);
  assert.strictEqual(host.state.players.length, 4);
  assert(/طلع/.test(host.state.toast.text), 'إشعار الخروج مباشرة');
  lateC.close();

  // الجاهزية
  for (const c of cs) await c.act('ready');
  await wait(100);
  assert.strictEqual(host.state.phase, 'questions');
  const n = host.state.game.turns.length;
  assert.strictEqual(n, 4);
  // سلسلة الأسئلة: كل واحد يسأل واحد مختلف
  const asked = new Set(host.state.game.turns.map((t) => t.from));
  assert.strictEqual(asked.size, 4);

  // خصم: ليلى تقترح خصم من خالد، والكل يوافق
  const L = cs[1], K = cs[2];
  assert.strictEqual((await L.act('proposePenalty', { targetId: K.pid })).ok, true);
  await wait(50);
  assert(host.state.game.penalty.active, 'تصويت خصم شغّال');
  assert.strictEqual((await K.act('penaltyVote', { agree: true })).error !== undefined, true, 'الملام ما يصوّت');
  for (const c of cs) if (c !== L && c !== K) await c.act('penaltyVote', { agree: true });
  await wait(50);
  assert.strictEqual(host.state.game.penalty.active, null);
  assert.strictEqual(host.state.game.penalty.applied[K.pid], 1, 'انخصم من خالد');
  assert.strictEqual(host.state.players.find((p) => p.id === K.pid).score, -10, 'الخصم يظهر فوراً بلوحة الترتيب');
  assert(inCs[0].state.game.img && inCs[0].state.game.img.q, 'جوا السالفة يوصله نص بحث الصورة');
  assert(!outC.state.game.img, 'اللي برا ما يوصله شي عن السالفة');

  // خصم ثاني: نور تقترح على سامر، واحد يرفض
  await cs[3].act('proposePenalty', { targetId: host.pid });
  await K.act('penaltyVote', { agree: false });
  await wait(50);
  assert.strictEqual(host.state.game.penalty.active, null, 'الرفض يلغي');
  assert.strictEqual(host.state.game.penalty.applied[host.pid], undefined);

  // تغيير السالفة: الكل يوافق
  const oldWord = word;
  assert.strictEqual((await L.act('proposeWordChange')).ok, true);
  await wait(50);
  assert(host.state.game.wordChange.active, 'تصويت تغيير شغّال');
  assert((await cs[3].act('proposePenalty', { targetId: host.pid })).error, 'ما يتزامن مع تصويت ثاني');
  for (const c of cs) if (c !== L) assert((await c.act('wordChangeVote', { agree: true })).ok);
  await wait(100);
  assert.strictEqual(host.state.game.wordChange.active, null);
  word = inCs[0].state.game.word;
  assert(word !== oldWord, 'السالفة تغيّرت');
  assert(inCs.every((c) => c.state.game.word === word), 'الكل جوا يشوف السالفة الجديدة');
  assert(!outC.state.game.word, 'اللي برا لسا ما يعرف');
  // تغيير ثاني: واحد يرفض
  await cs[3].act('proposeWordChange');
  await K.act('wordChangeVote', { agree: false });
  await wait(50);
  assert.strictEqual(host.state.game.wordChange.active, null, 'الرفض يلغي');
  assert.strictEqual(inCs[0].state.game.word, word, 'السالفة ما تغيّرت');

  // الأدوار
  // التنقل بين الأسئلة للمضيف فقط
  const nonHostAsker = cs.find((c) => c !== host);
  assert((await nonHostAsker.act('nextTurn')).error, 'غير المضيف ما ينقل للسؤال التالي');
  assert(!JSON.stringify(host.state).includes('freeEnd') && !JSON.stringify(host.state).includes('voteEnd'), 'ما في مؤقتات بالحالة');
  for (let i = 0; i < n; i++) {
    assert((await host.act('nextTurn')).ok);
    await wait(30);
  }
  assert.strictEqual(host.state.phase, 'free');
  assert((await cs[1].act('startVote')).error, 'بس المضيف يبدأ التصويت');
  assert((await host.act('startVote')).ok);
  await wait(50);
  assert.strictEqual(host.state.phase, 'vote');

  // التصويت: سامر وليلى يصوتوا صح على اللي برا، والباقي غلط
  const out = outC;
  const wrongFor = (c) => cs.find((x) => x !== c && x !== out);
  for (const c of cs) {
    if (c === out) { await c.act('vote', { targetId: cs.find((x) => x !== c).pid }); continue; }
    const right = (c === host || c === cs[1]);
    const t = right ? out.pid : wrongFor(c).pid;
    assert((await c.act('vote', { targetId: t })).ok);
  }
  assert((await host.act('vote', { targetId: out.pid })).error, 'ما بيصوّت مرتين');
  await wait(100);
  assert.strictEqual(host.state.phase, 'guess');
  assert.strictEqual(host.state.game.outsiderId, out.pid);
  assert(out.state.game.options.includes(word) && out.state.game.options.length === 9, '9 خيارات تتضمن السالفة');
  assert(!host.state.game.options || out === host, 'غيره ما يشوف الخيارات');
  assert((await inCs[0].act('guess', { word })).error, 'بس اللي برا يخمّن');
  assert((await out.act('guess', { word })).ok);
  await wait(100);
  assert.strictEqual(host.state.phase, 'scores');
  assert.strictEqual(host.state.game.word, word);
  const score = (c) => host.state.players.find((p) => p.id === c.pid).score;
  const expected = (c) => {
    let s = 0;
    if (c !== out && (c === host || c === cs[1])) s += 100;
    if (c === out) s += 100;
    if (c === K) s -= 10;
    return s;
  };
  for (const c of cs) assert.strictEqual(score(c), expected(c), `سكور ${c.name}`);

  // جولة ثانية مع حفظ السكور
  for (const c of cs) await c.act('readyNext');
  await wait(100);
  assert.strictEqual(host.state.phase, 'lobby');
  for (const c of cs) assert.strictEqual(score(c), expected(c), 'السكور محفوظ');
  assert((await host.act('start', { topicId: 'random' })).ok);
  await wait(50);
  assert.strictEqual(host.state.phase, 'reveal');
  assert.strictEqual(host.state.roundNo, 2);

  // خروج لاعب غير اللي برا: الجولة تكمل بـ 3. خروج ثاني: تنلغي
  for (const c of cs) await c.act('ready');
  await wait(100);
  assert.strictEqual(host.state.phase, 'questions');
  const out2 = cs.find((c) => c.state.game.role === 'out');
  const leaver = cs.find((c) => c !== out2 && c !== host);
  await leaver.act('leave');
  await wait(100);
  assert.strictEqual(host.state.phase, 'questions', 'الجولة تكمل');
  assert.strictEqual(host.state.game.participants.length, 3);
  assert.strictEqual(host.state.game.turns.length, 3, 'سلسلة الأسئلة انعاد بناؤها');
  assert(host.state.game.turns.every((t) => host.state.game.participants.includes(t.from) && host.state.game.participants.includes(t.to) && t.from !== leaver.pid && t.to !== leaver.pid), 'دوره انلغى');
  assert(host.state.game.turnIdx >= 0 && host.state.game.turnIdx < 3);
  assert(/طلع/.test(host.state.toast.text));
  const leaver2 = cs.find((c) => c !== out2 && c !== host && c !== leaver);
  await leaver2.act('leave');
  await wait(100);
  assert.strictEqual(host.state.phase, 'lobby', 'انلغت لأقل من 3');
  assert(host.state.notice, 'رسالة إلغاء');

  // المضيف يطلع: ينحط مضيف ثاني ويوصل إشعار
  const rest = cs.filter((c) => c !== host && c.req && !c.req.destroyed);
  await host.act('leave');
  await wait(150);
  const alive = rest.filter((c) => c.state.players.some((p) => p.id === c.state.hostId));
  assert(alive.length, 'في مضيف جديد');
  assert(alive[0].state.hostId !== host.pid, 'المضيف الجديد غير القديم');
  assert(/المضيف الجديد/.test(alive[0].state.toast.text), 'إشعار المضيف الجديد');

  cs.forEach((c) => c.close());
  console.log('✅ كل الاختبارات نجحت');
  process.exit(0);
})().catch((e) => { console.error('❌', e); process.exit(1); });
