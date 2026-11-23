'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { parseRule, evaluate, isWindward, angleDiff } = require('./greenhouse/rules.js');
const iv = require('./greenhouse/interview.js');
const { createGreenhouse } = require('./greenhouse/index.js');

const ANS = { facing: '270', closeTemp: 18, openTemp: 24, fullTemp: 30, order: 'roof', maxRoof: 100, maxSide: 80, cautionWind: 5, cautionOpen: 20, dangerWind: 10, onSensorLoss: 'hold' };
const VENTS = [['side-left', 'side', 270], ['side-right', 'side', 90], ['roof-left', 'roof', 270], ['roof-right', 'roof', 90]].map(([id, kind, facing]) => ({ id, title: id, kind, facing }));
const SET = { tempHyst: 1, windHyst: 1, windHoldSec: 120, onSensorLoss: 'hold' };
const RULES = iv.buildRules(ANS);
const ev = (temp, windSpeed, windDir, o = {}) => Object.fromEntries(evaluate({ vents: VENTS, rules: RULES, sensors: { temp, windSpeed, windDir }, settings: SET, latch: new Map(), now: 0, lost: false, ...o }).map((d) => [d.ventId, d]));

// 시간과 발행을 손으로 움직이는 온실
function bench(over = {}) {
  let t = 1_000_000, data = { version: 1, links: [], vents: [], rules: [], commands: [] };
  const sent = [], reqs = [], file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gh-')), 'greenhouse.json');
  if (Object.keys(over).length) fs.writeFileSync(file, JSON.stringify(over));
  const gh = createGreenhouse({ file, loadData: () => structuredClone(data), saveData: (s) => { data = structuredClone(s); },
    readJson: (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}), writeJson: (f, x) => fs.writeFileSync(f, JSON.stringify(x)), changed() {}, request: (x) => reqs.push(x) },
  { now: () => t, publish: (topic, m) => { sent.push({ topic, ...m }); return true; } });
  gh.start();
  const b = { gh, sent, reqs, data: () => data, file,
    sensors: (temp, windSpeed, windDir) => { gh.onMessage('greenhouse/1/sensor/indoor', JSON.stringify({ temp })); gh.onMessage('greenhouse/1/sensor/outdoor', JSON.stringify({ windSpeed, windDir })); },
    state: (id, m, retained) => gh.onMessage(`greenhouse/1/vent/${id}/state`, JSON.stringify(m), retained),
    all: (position) => VENTS.forEach((v) => b.state(v.id, { position, moving: false })),
    run: (sec, keep) => { for (let i = 0; i < sec; i++) { t += 1000; if (keep) b.sensors(...keep); gh.tick(); } },
    last: (id) => data.commands.filter((c) => c.vent === id).at(-1) };
  return b;
}

test('풍향: 바람받이와 경계 여유', () => {
  assert.equal(angleDiff(350, 10), 20);
  assert.equal(isWindward(270, 270), true); assert.equal(isWindward(270, 90), false);
  assert.equal(isWindward(0, 350), true);
  assert.equal(isWindward(270, 5, true), true, '95°는 아직 바람받이'); assert.equal(isWindward(270, 5, false), false);
});

test('규칙 검사: 틀린 규칙은 이유와 함께 거른다', () => {
  const ok = { id: 'a', mode: 'set', tempMin: 20, openSide: 10 };
  assert.ok(parseRule(ok).rule);
  for (const bad of [{ mode: 'x' }, { openSide: 120 }, { openSide: '' }, { tempMin: 'abc' }, { tempMin: '' }, { windSide: 'windward' }, { tempMax: 10 }]) assert.ok(parseRule({ ...ok, ...bad }).error, JSON.stringify(bad));
});

test('인터뷰: 답 검사와 순서', () => {
  assert.equal(Object.keys(iv.checkAnswers({}).errors).length, iv.QUESTIONS.length);
  assert.ok(iv.checkAnswers({ ...ANS, openTemp: 18 }).errors.openTemp);
  assert.ok(iv.checkAnswers({ ...ANS, dangerWind: 5 }).errors.dangerWind);
  assert.ok(iv.checkAnswers({ ...ANS, maxRoof: 101 }).errors.maxRoof);
  assert.ok(iv.checkAnswers(ANS).answers);
  for (const r of RULES) assert.ok(parseRule(r).rule, r.title);
  assert.equal(iv.facingOf('side-right', 270), 90);
});

test('판단: 온도 단계, 바람받이 제한, 강풍', () => {
  assert.equal(ev(21, 1, 0)['roof-left'].target, null, '사이 온도는 유지');
  assert.deepEqual([ev(25, 1, 0)['roof-left'].target, ev(25, 1, 0)['side-left'].target], [50, 0]);
  assert.deepEqual([ev(31, 1, 0)['roof-left'].target, ev(31, 1, 0)['side-left'].target], [100, 80]);
  assert.equal(ev(15, 1, 0)['side-left'].target, 0);
  const w = ev(31, 6, 270); assert.deepEqual([w['side-left'].target, w['side-right'].target, w['roof-left'].target, w['roof-right'].target], [20, 80, 20, 100]);
  const d = ev(31, 12, 270); for (const v of VENTS) assert.equal(d[v.id].target, 0);
});

test('판단: 온도 되돌림 폭과 바람 유지 시간', () => {
  const latch = new Map(), at = (temp, wind, now) => ev(temp, wind, 270, { latch, now })['roof-left'].target;
  assert.equal(at(24, 1, 0), 50); assert.equal(at(23.5, 1, 1000), 50); assert.equal(at(22.9, 1, 2000), null);
  assert.equal(at(31, 11, 3000), 0); assert.equal(at(31, 9.5, 4000), 0, '되돌림 폭 안');
  assert.equal(at(31, 1, 5000), 0, '바로 풀지 않음'); assert.equal(at(31, 1, 124_000), 0); assert.equal(at(31, 1, 125_000), 100);
});

test('판단: 센서를 잃으면 제한은 남고 온도 규칙은 쉰다', () => {
  const latch = new Map(); ev(31, 11, 270, { latch });
  const d = ev(31, null, null, { latch, lost: true })['side-left'];
  assert.equal(d.target, null); assert.equal(d.cap, 0);
  assert.equal(ev(null, 1, 0, { lost: true, settings: { ...SET, onSensorLoss: 'close' } })['side-left'].target, 0);
});

test('명령: 발행 JSON과 완료', () => {
  const b = bench(); b.gh.applyInterview(ANS, true); b.all(0); b.sensors(25, 1, 0); b.run(1);
  const m = b.sent.find((x) => x.ventId === 'roof-left');
  assert.equal(m.topic, 'greenhouse/1/vent/roof-left/cmd');
  assert.deepEqual([m.action, m.target, m.attempt, m.maxAttempts, m.ruleId], ['set', 50, 1, 3, 'iv-open']);
  assert.equal(b.sent.some((x) => x.ventId === 'side-left'), false, '이미 0%인 창에는 보내지 않는다');
  b.state('roof-left', { position: 30, moving: true, cmdId: m.cmdId }); assert.equal(b.last('roof-left').status, 'sent');
  b.state('roof-left', { position: 50, moving: true, cmdId: m.cmdId }); assert.equal(b.last('roof-left').status, 'sent', '움직이는 중은 완료가 아니다');
  b.state('roof-left', { position: 49, moving: false, cmdId: m.cmdId }); assert.equal(b.last('roof-left').status, 'done');
  b.run(5, [25, 1, 0]); assert.equal(b.sent.filter((x) => x.ventId === 'roof-left').length, 1);
});

test('재시도: 응답이 없으면 3번까지, 그다음 실패와 확인 요청', () => {
  const b = bench(); b.gh.applyInterview(ANS, true); b.all(0); b.sensors(25, 1, 0); b.run(1);
  b.run(15, [25, 1, 0]); let m = b.sent.filter((x) => x.ventId === 'roof-left');
  assert.deepEqual(m.map((x) => x.attempt), [1, 2]); assert.equal(m[0].cmdId, m[1].cmdId); assert.equal(b.last('roof-left').status, 'retrying');
  b.run(30, [25, 1, 0]); m = b.sent.filter((x) => x.ventId === 'roof-left');
  assert.deepEqual(m.map((x) => x.attempt), [1, 2, 3]); assert.equal(b.last('roof-left').status, 'failed');
  assert.ok(b.reqs.some((r) => r.ref === 'roof-left'));
  b.run(100, [25, 1, 0]); assert.equal(b.sent.filter((x) => x.ventId === 'roof-left').length, 3, '쉬는 동안 보내지 않는다');
  b.run(250, [25, 1, 0]); assert.ok(b.sent.filter((x) => x.ventId === 'roof-left').length > 3, '쉰 뒤 다시 시도');
});

test('재시도: 움직이면 기다리고, 걸리면 다시 보내고, 성공하면 끝난다', () => {
  const b = bench(); b.gh.applyInterview(ANS, true); b.all(0); b.sensors(25, 1, 0); b.run(1);
  for (let p = 2; p <= 20; p += 2) { b.run(5, [25, 1, 0]); b.state('roof-left', { position: p, moving: true }); }
  assert.equal(b.last('roof-left').attempts, 1, '50초 걸려도 움직이면 재시도하지 않는다');
  for (let i = 0; i < 15; i++) { b.run(1, [25, 1, 0]); b.state('roof-left', { position: 20, moving: true }); }
  assert.equal(b.last('roof-left').attempts, 2, '걸리면 재시도');
  b.state('roof-left', { position: 50, moving: false }); assert.equal(b.last('roof-left').status, 'done');
});

test('상태: 옛(retained) 값과 틀린 값은 완료로 치지 않는다', () => {
  const b = bench(); b.gh.applyInterview(ANS, true); b.all(0); b.sensors(25, 1, 0); b.run(1);
  b.state('roof-left', { position: 50, moving: false }, true); assert.equal(b.last('roof-left').status, 'sent');
  b.state('roof-left', { position: 500 }); b.state('roof-left', { position: '50' }); b.gh.onMessage('greenhouse/1/sensor/indoor', 'nope');
  assert.equal(b.last('roof-left').status, 'sent'); assert.ok(b.gh.view().mqtt.badMessages >= 3);
});

test('강풍: 최소 간격을 기다리지 않고 닫고, 실패한 창도 닫으려 한다', () => {
  const b = bench(); b.gh.applyInterview(ANS, true); b.all(0); b.sensors(25, 1, 0); b.run(1);
  b.state('roof-left', { position: 50, moving: false }); b.run(1, [31, 12, 270]);
  assert.equal(b.last('roof-left').target, 0, '2초 만에 닫기');
  const c = bench(); c.gh.applyInterview(ANS, true); c.all(30); c.sensors(31, 1, 0); c.run(1); c.run(50, [31, 1, 0]);
  assert.equal(c.last('side-left').status, 'failed'); c.run(1, [31, 12, 270]); assert.equal(c.last('side-left').target, 0);
});

test('강풍: 온도가 사이 구간이어도 열린 창을 닫고, 움직이던 창은 대체한다', () => {
  const b = bench(); b.gh.applyInterview(ANS, true); b.all(60); b.sensors(21, 12, 0); b.run(1);
  for (const v of VENTS) assert.equal(b.last(v.id).target, 0);
  const c = bench(); c.gh.applyInterview(ANS, true); c.all(0); c.sensors(31, 1, 0); c.run(1); c.run(1, [21, 12, 0]);
  assert.equal(c.last('roof-left').target, 0); assert.ok(c.data().commands.some((x) => x.vent === 'roof-left' && x.status === 'superseded'));
});

test('규칙이 없거나 센서가 없으면 움직이지 않는다', () => {
  const b = bench(); b.all(50); b.run(60); assert.equal(b.sent.length, 0);
  const c = bench(); c.gh.applyInterview({ ...ANS, onSensorLoss: 'close' }, true); c.all(50); c.run(20); assert.equal(c.sent.length, 0, '처음에는 기다린다');
  c.run(15); assert.equal(c.last('side-left').target, 0, '끊긴 것이 확실하면 닫는다');
});

test('수동: 자동과 재시도를 멈추고, 바람 제한을 넘으면 확인을 받는다', () => {
  const b = bench(); b.gh.applyInterview(ANS, true); b.all(0); b.sensors(25, 1, 0); b.run(1);
  assert.throws(() => b.gh.command({ vent: 'side-left', target: 10 }, 'x'), /자동 모드/);
  b.gh.setMode('manual'); const n = b.sent.length; assert.equal(b.last('roof-left').status, 'canceled'); b.run(60, [31, 12, 0]); assert.equal(b.sent.length, n);
  assert.throws(() => b.gh.command({ vent: 'side-left', target: 50 }, 'x'), (e) => e.needsConfirm === true);
  assert.throws(() => b.gh.command({ vent: 'side-left', target: 150 }, 'x'), /0–100/);
  assert.equal(b.gh.command({ vent: 'side-left', target: 50, force: true }, 'x').target, 50);
});

test('설정: 검사, 비밀번호 감춤, 실제 브로커로 바꾸면 수동', () => {
  const b = bench({ mqttKind: 'external', url: 'mqtt://a.local', password: 'secret' });
  assert.equal(JSON.stringify(b.gh.view()).includes('secret'), false);
  for (const bad of [{ url: 'http://x' }, { url: 'mqtt://u:p@x' }, { base: 'a/#' }, { stallSec: 0 }, { maxAttempts: 99 }, { minStep: 1 }]) assert.throws(() => b.gh.saveConfig(bad), undefined, JSON.stringify(bad));
  assert.equal(b.gh.settings().password, 'secret');
});

test('다시 시작하면 끝을 못 본 명령은 중단으로 남는다', () => {
  const b = bench(); b.gh.applyInterview(ANS, true); b.all(0); b.sensors(25, 1, 0); b.run(1);
  b.gh.start(); assert.equal(b.last('roof-left').status, 'interrupted');
});

test('실제 MQTT 왕복: 내장 브로커에서 첫 명령을 놓쳐도 재시도로 끝난다', { timeout: 60000 }, async () => {
  let data = { version: 1, links: [], vents: [], rules: [], commands: [] };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gh-')), 'g.json');
  fs.writeFileSync(file, JSON.stringify({ stallSec: 4, timeoutSec: 40 }));
  const gh = createGreenhouse({ file, loadData: () => structuredClone(data), saveData: (s) => { data = structuredClone(s); }, readJson: (f) => JSON.parse(fs.readFileSync(f, 'utf8')), writeJson: (f, x) => fs.writeFileSync(f, JSON.stringify(x)), changed() {}, request() {} }, { simPort: 0 });
  await gh.start();
  const call = (p, body) => gh.routes({ method: 'POST' }, {}, p, { sendJson: () => {}, csrfOk: () => true, jsonBody: async () => body, actor: () => 't', audit() {} });
  try {
    await call('/api/gh/sim', { fixedIndoor: 25, windSpeed: 1, faults: { 'roof-left': 'drop' } });
    gh.applyInterview(ANS, true);
    const until = Date.now() + 45000; let c;
    do { await new Promise((r) => setTimeout(r, 300)); c = data.commands.find((x) => x.vent === 'roof-left'); } while ((!c || !['done', 'failed'].includes(c.status)) && Date.now() < until);
    assert.equal(c && c.status, 'done'); assert.equal(c.attempts, 2); assert.ok(Math.abs(gh.ctl.live.get('roof-left').position - 50) <= 3);
  } finally { await gh.stop(); }
});
