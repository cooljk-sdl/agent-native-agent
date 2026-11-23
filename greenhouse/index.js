'use strict';
// index.js — 온실 환기: MQTT 센서 → 규칙 판단 → 명령 발행 → 상태 확인. dashboard-api.js가 만들어 쓴다.
//
// 토픽(base 기본 'greenhouse/1'):
//   구독  <base>/sensor/indoor   {"temp": 27.4}
//         <base>/sensor/outdoor  {"windSpeed": 3.2, "windDir": 270}     windDir = 바람이 불어오는 방위(북 0, 동 90)
//         <base>/vent/<id>/state {"position": 48, "moving": true, "cmdId": "…", "error": null}
//   발행  <base>/vent/<id>/cmd   {"cmdId","ventId","action":"set","target":50,"attempt":1,"maxAttempts":3,…}
//         <base>/controller/status {"online": true} (retain)
const fs = require('node:fs');
const { parseRule, evaluate, describeRule } = require('./rules.js');
const interview = require('./interview.js');
const { createController } = require('./control.js');

const VENTS = [['side-left', '측창 좌', 'side'], ['side-right', '측창 우', 'side'], ['roof-left', '천창 좌', 'roof'], ['roof-right', '천창 우', 'roof']];
const DEFAULTS = { mode: 'auto', mqttKind: 'sim', url: '', username: '', password: '', base: 'greenhouse/1',
  tempHyst: 1, windHyst: 1, windHoldSec: 120, minStep: 5, tolerance: 3, stallSec: 15, timeoutSec: 180, maxAttempts: 3, minIntervalSec: 60, faultCooldownSec: 300, staleSec: 30, onSensorLoss: 'hold', answers: null };
const RANGES = { tempHyst: [0, 10], windHyst: [0, 10], windHoldSec: [0, 3600], minStep: [1, 50], tolerance: [1, 20], stallSec: [3, 600], timeoutSec: [5, 1800], maxAttempts: [1, 10], minIntervalSec: [0, 3600], faultCooldownSec: [10, 86400], staleSec: [5, 3600] };
const KEEP = 150;
const BASE = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+){0,6}$/;

// host: { file, loadData, saveData, writeJson, readJson, changed(version), request(x) }
function createGreenhouse(host, opt = {}) {
  const now = opt.now || Date.now;
  let settings = { ...DEFAULTS }, link = null, sim = null, timer = null, decisions = [], notes = {}, dataError = '', linkGen = 0, switching = Promise.resolve();
  let startedAt = now(), badMessages = 0, ruleCount = 0;
  const latch = new Map(), sensors = { indoor: null, outdoor: null };

  const loadSettings = () => { try { const s = host.readJson(host.file); settings = { ...DEFAULTS, ...(s && typeof s === 'object' ? s : {}) }; } catch (e) { settings = { ...DEFAULTS, mode: 'manual' }; dataError = `설정 파일을 읽지 못했습니다: ${e.message}`; } };
  const saveSettings = () => { host.writeJson(host.file, settings); try { fs.chmodSync(host.file, 0o600); } catch {} };
  const load = () => { const s = host.loadData(); for (const k of ['vents', 'rules', 'commands']) if (!Array.isArray(s[k])) s[k] = []; return s; };
  const mutate = (fn) => { const s = load(); fn(s); s.version = (s.version || 1) + 1; host.saveData(s); host.changed(s.version); return s; };
  const ventsOf = (s) => (s.vents || []).filter((v) => v && VENTS.some(([id]) => id === v.id) && ['side', 'roof'].includes(v.kind));

  const ctl = createController({
    now, settings: () => settings,
    publish: (id, payload) => (opt.publish ? opt.publish(`${settings.base}/vent/${id}/cmd`, payload) : !!link && link.publish(`${settings.base}/vent/${id}/cmd`, payload)),
    save: (cmd) => { try { mutate((s) => {
      const i = s.commands.findIndex((x) => x && x.id === cmd.id);
      if (i >= 0) s.commands[i] = { ...cmd }; else s.commands.push({ ...cmd });
      if (s.commands.length > KEEP) s.commands.splice(0, s.commands.length - KEEP);
    }); } catch (e) { dataError = `명령 기록을 저장하지 못했습니다: ${e.message}`; } },
    failed: (cmd) => {
      const name = cmd.title.replace(/ \d+%$/, '');
      try { host.request({ kind: 'action', title: `${settings.mqttKind === 'sim' ? '[시뮬레이터] ' : ''}${name} 동작을 확인해 주세요`, ref: cmd.vent,
        why: `${name}에 ${cmd.target}% 명령을 ${cmd.attempts}번 보냈지만 끝나지 않았습니다. 마지막 이유: ${cmd.error}`, ask: '창이 걸려 있지 않은지, 모터와 통신이 정상인지 현장에서 확인해 주세요.',
        effect: '확인한 뒤 Work › 모니터에서 [오류 지우기]를 누르면 바로 다시 제어합니다.', ifNot: '잠시 뒤 다시 시도하고, 그동안 이 창은 지금 위치에 머뭅니다.' }); } catch {}
    },
  });

  // ---- MQTT 메시지 ----
  function onMessage(topic, payload, retained) {
    const rest = topic.startsWith(settings.base + '/') ? topic.slice(settings.base.length + 1) : '';
    let m; try { m = JSON.parse(payload.toString()); } catch { badMessages++; return; }
    if (!m || typeof m !== 'object') { badMessages++; return; }
    const inRange = (v, a, b) => typeof v === 'number' && Number.isFinite(v) && v >= a && v <= b;
    if (rest === 'sensor/indoor') { if (retained) return; if (!inRange(m.temp, -40, 80)) { badMessages++; return; } sensors.indoor = { temp: m.temp, at: now() }; return; }
    if (rest === 'sensor/outdoor') { if (retained) return; if (!inRange(m.windSpeed, 0, 80) || !inRange(m.windDir, 0, 360)) { badMessages++; return; } sensors.outdoor = { windSpeed: m.windSpeed, windDir: m.windDir % 360, at: now() }; return; }
    const v = /^vent\/([\w-]+)\/state$/.exec(rest);
    if (v && VENTS.some(([id]) => id === v[1]) && !ctl.onState(v[1], m, retained)) badMessages++;
  }
  const fresh = (x) => (x && now() - x.at <= settings.staleSec * 1000 ? x : null);
  function readings() {
    const i = fresh(sensors.indoor), o = fresh(sensors.outdoor);
    return { temp: i ? i.temp : null, windSpeed: o ? o.windSpeed : null, windDir: o ? o.windDir : null };
  }
  const connected = () => (opt.publish ? true : !!link && link.connected);

  // ---- 1초마다: 판단하고 필요한 명령만 낸다 ----
  function tick() {
    let s; try { s = load(); if (/읽지 못했습니다: 작업/.test(dataError)) dataError = ''; } catch (e) { dataError = `읽지 못했습니다: 작업 데이터 ${e.message}`; return; }
    const r = readings(), missing = r.temp === null || r.windSpeed === null;
    const lost = missing && now() - startedAt > settings.staleSec * 1000;
    ruleCount = s.rules.filter((x) => { const q = parseRule(x).rule; return q && q.enabled; }).length;
    decisions = evaluate({ vents: ventsOf(s), rules: s.rules, sensors: r, settings, latch, now: now(), lost });
    if (!connected()) return;
    ctl.tick();
    // 규칙이 하나도 없으면(인터뷰 전) 센서가 끊겨도 스스로 움직이지 않는다
    if (settings.mode !== 'auto' || !ruleCount || (missing && !lost)) { notes = {}; return; }
    for (const v of ventsOf(s)) { const d = decisions.find((x) => x.ventId === v.id); if (d) notes[v.id] = ctl.auto(v, d); }
  }

  // ---- 연결 ----
  async function reconnect() {
    const gen = ++linkGen;
    if (link) { link.close(); link = null; }
    if (sim) { const old = sim; sim = null; await old.stop(); }
    ctl.cancelAll('canceled', 'MQTT 연결을 바꿨습니다'); ctl.reset(); latch.clear(); sensors.indoor = sensors.outdoor = null; startedAt = now(); decisions = [];
    if (gen !== linkGen) return;
    let url = settings.url;
    if (settings.mqttKind === 'sim') { const { createSimulator } = require('./simulator.js'); const x = await createSimulator({ base: settings.base, port: opt.simPort, vents: VENTS.map((v) => v[0]) }); if (gen !== linkGen) { await x.stop(); return; } sim = x; url = x.url; }
    if (!url) return;
    const { createLink } = require('./link.js');
    const secret = settings.mqttKind === 'sim' ? {} : { username: settings.username, password: settings.password };
    let was = false;
    link = createLink({ url, ...secret, base: settings.base, onMessage: (...a) => { if (gen === linkGen) onMessage(...a); }, onChange: (l) => { if (gen !== linkGen) return; if (l.connected && !was) ctl.resume(); was = l.connected; } });
  }
  const queueReconnect = () => (switching = switching.then(reconnect).catch((e) => { dataError = `MQTT 연결 준비 실패: ${e.message}`; }));

  function start() {
    loadSettings();
    try {
      const s = load();
      const left = (s.commands || []).some((c) => c && ['sent', 'retrying'].includes(c.status));
      if (!s.vents.length || left) mutate((d) => {
        if (!d.vents.length) d.vents.push(...VENTS.map(([id, title, kind]) => ({ id, title, kind, facing: interview.facingOf(id, 270) })));
        for (const c of d.commands) if (['sent', 'retrying'].includes(c.status)) { c.status = 'interrupted'; c.error = '서버가 다시 시작되어 결과를 확인하지 못했습니다'; c.doneAt = new Date(now()).toISOString(); }
      });
    } catch (e) { dataError = `작업 데이터를 준비하지 못했습니다: ${e.message}`; }
    startedAt = now();
    if (opt.publish) return Promise.resolve();
    timer = setInterval(() => { try { tick(); } catch (e) { dataError = `제어 오류: ${e.message}`; } }, 1000);
    return queueReconnect();
  }
  async function stop() { clearInterval(timer); linkGen++; if (link) link.close(); if (sim) await sim.stop(); link = sim = null; }

  // ---- 화면 상태 ----
  function view() {
    const s = load(), r = readings(), alarms = [];
    const al = (level, text, vent) => alarms.push({ level, text, vent: vent || '' });
    if (dataError) al('bad', dataError);
    if (!connected()) al('bad', settings.mqttKind === 'external' && !settings.url ? 'MQTT 브로커 주소가 없습니다. 설정에서 입력해 주세요.' : `MQTT에 연결되지 않아 명령을 보내지 않습니다${link && link.error ? ` (${link.error})` : ''}.`);
    if (now() - startedAt > settings.staleSec * 1000) {
      const loss = settings.onSensorLoss === 'close' ? '규칙에 따라 모두 닫습니다' : '지금 위치를 유지합니다';
      if (r.temp === null) al('bad', `실내온도 값이 ${settings.staleSec}초 넘게 오지 않았습니다. ${loss}.`);
      if (r.windSpeed === null) al('bad', `풍향·풍속 값이 ${settings.staleSec}초 넘게 오지 않았습니다. ${loss}.`);
    }
    for (const x of s.rules) { const e = parseRule(x).error; if (e) al('warn', `규칙 "${String((x && x.title) || (x && x.id))}"을(를) 쓰지 못합니다: ${e}`); }
    for (const [id, f] of ctl.faults) { const v = s.vents.find((x) => x.id === id); al('bad', `${v ? v.title : id}: ${f.text}`, id); }
    return {
      mode: settings.mode, ruleCount: s.rules.filter((x) => { const q = parseRule(x).rule; return q && q.enabled; }).length, sensors: { ...r, indoorAt: sensors.indoor && sensors.indoor.at, outdoorAt: sensors.outdoor && sensors.outdoor.at },
      mqtt: { kind: settings.mqttKind, connected: connected(), url: settings.mqttKind === 'sim' ? (sim ? sim.url : '') : settings.url, base: settings.base, error: link ? link.error : '', badMessages },
      vents: ventsOf(s).map((v) => {
        const l = ctl.live.get(v.id), p = ctl.pending.get(v.id), f = ctl.faults.get(v.id);
        return { id: v.id, title: v.title, kind: v.kind, facing: v.facing, live: l ? { position: l.position, moving: l.moving, error: l.error, at: l.at } : null,
          pending: p ? { id: p.cmd.id, target: p.cmd.target, attempts: p.cmd.attempts, maxAttempts: p.cmd.maxAttempts, error: p.cmd.error } : null,
          fault: f ? { text: f.text, until: f.until } : null, decision: decisions.find((d) => d.ventId === v.id) || null, note: settings.mode === 'auto' ? notes[v.id] || '' : 'manual' };
      }),
      rules: s.rules.map((x) => ({ ...x, text: describeRule(x), error: parseRule(x).error || '' })).sort((a, b) => (Number(a.priority) || 50) - (Number(b.priority) || 50)),
      commands: s.commands.slice(-60).reverse(), alarms, sim: sim ? sim.view() : null,
      settings: { ...settings, password: undefined, hasPassword: !!settings.password },
    };
  }

  function preview(x) {
    const s = load(), v = ['temp', 'windSpeed', 'windDir'].map((k) => x[k]);
    if (v.some((n) => typeof n !== 'number' || !Number.isFinite(n))) throw Object.assign(new Error('온도, 풍속, 풍향을 숫자로 넣어 주세요'), { status: 400 });
    let rules = s.rules, vents = ventsOf(s);
    if (x.answers) { const c = interview.checkAnswers(x.answers); if (c.errors) throw Object.assign(new Error('인터뷰 답을 확인해 주세요'), { status: 400, errors: c.errors }); rules = interview.buildRules(c.answers); vents = vents.map((q) => ({ ...q, facing: interview.facingOf(q.id, c.answers.facing) })); }
    return evaluate({ vents, rules, sensors: { temp: v[0], windSpeed: v[1], windDir: v[2] }, settings, latch: new Map(), now: now(), lost: false });
  }
  function applyInterview(input, apply) {
    const c = interview.checkAnswers(input);
    if (c.errors) throw Object.assign(new Error('답을 확인해 주세요'), { status: 400, errors: c.errors });
    const rules = interview.buildRules(c.answers);
    if (apply) {
      const at = new Date(now()).toISOString();
      mutate((s) => { s.rules = s.rules.filter((x) => x && x.source !== 'interview').concat(rules.map((r) => ({ ...r, at }))); for (const v of s.vents) v.facing = interview.facingOf(v.id, c.answers.facing); });
      settings.answers = c.answers; settings.onSensorLoss = c.answers.onSensorLoss; saveSettings(); latch.clear();
    }
    return rules.map((r) => ({ ...r, text: describeRule(r) }));
  }
  function setMode(mode) {
    if (!['auto', 'manual'].includes(mode)) throw Object.assign(new Error('mode: auto | manual'), { status: 400 });
    if (mode === 'manual' && settings.mode !== 'manual') ctl.cancelAll('canceled', '수동으로 바꿔 멈췄습니다');
    settings.mode = mode; notes = {}; saveSettings();
  }
  function command(x, by) {
    const fail = (m, status, extra) => { throw Object.assign(new Error(m), { status, ...extra }); };
    if (settings.mode !== 'manual') fail('자동 모드입니다. 수동으로 바꾼 뒤 조작해 주세요.', 409);
    if (!connected()) fail('MQTT에 연결되지 않았습니다.', 503);
    const v = ventsOf(load()).find((q) => q.id === x.vent); if (!v) fail('없는 창입니다', 404);
    if (typeof x.target !== 'number' || !Number.isFinite(x.target) || x.target < 0 || x.target > 100) fail('개도율은 0–100입니다', 400);
    const d = decisions.find((q) => q.ventId === v.id);
    if (d && x.target > d.cap && x.force !== true) fail(`지금 "${d.reason}" 제한에 걸려 있습니다. 그래도 ${x.target}%로 열까요?`, 409, { needsConfirm: true });
    ctl.clearFault(v.id);
    return ctl.send({ vent: v, target: Math.round(x.target), rule: '', reason: '수동 조작', by, safety: false });
  }
  function saveConfig(x) {
    const n = { ...settings }, fail = (m) => { throw Object.assign(new Error(m), { status: 400 }); };
    for (const [k, [a, b]] of Object.entries(RANGES)) if (x[k] !== undefined) { if (typeof x[k] !== 'number' || !(x[k] >= a && x[k] <= b)) fail(`${k}: ${a}–${b} 사이여야 합니다`); n[k] = x[k]; }
    if (n.minStep < n.tolerance) fail('최소 움직임은 도착 오차보다 작을 수 없습니다');
    if (n.stallSec > n.timeoutSec) fail('멈춤 판단 시간은 전체 제한 시간보다 길 수 없습니다');
    for (const k of ['maxAttempts']) n[k] = Math.round(n[k]);
    if (x.onSensorLoss !== undefined) { if (!['hold', 'close'].includes(x.onSensorLoss)) fail('onSensorLoss: hold | close'); n.onSensorLoss = x.onSensorLoss; }
    if (x.mqttKind !== undefined) { if (!['sim', 'external'].includes(x.mqttKind)) fail('mqttKind: sim | external'); n.mqttKind = x.mqttKind; }
    if (x.base !== undefined) { if (typeof x.base !== 'string' || !BASE.test(x.base)) fail('토픽 앞부분은 영문, 숫자, -, _ 와 / 로 적어 주세요'); n.base = x.base; }
    if (x.url !== undefined) {
      const url = String(x.url).trim(); let u = null; try { u = url ? new URL(url) : null; } catch { fail('브로커 주소 형식이 아닙니다 (예: mqtt://192.168.0.10:1883)'); }
      if (u && (!['mqtt:', 'mqtts:', 'ws:', 'wss:'].includes(u.protocol) || !u.hostname)) fail('mqtt://, mqtts://, ws://, wss:// 주소만 쓸 수 있습니다');
      if (u && (u.username || u.password)) fail('아이디와 비밀번호는 주소가 아니라 아래 칸에 넣어 주세요');
      if (url !== n.url) n.password = '';   // 다른 브로커로 옛 비밀번호를 보내지 않는다
      n.url = url;
    }
    if (x.username !== undefined) n.username = String(x.username).slice(0, 200);
    if (typeof x.password === 'string' && x.password) n.password = x.password.slice(0, 500);
    if (n.mqttKind === 'external' && !n.url) fail('실제 브로커를 쓰려면 주소가 필요합니다');
    const moved = ['mqttKind', 'url', 'username', 'password', 'base'].some((k) => n[k] !== settings[k]);
    if (moved && n.mqttKind === 'external') n.mode = 'manual';   // 실제 장치에 처음 붙을 때는 사람이 보고 자동으로 바꾼다
    settings = n; saveSettings();
    if (moved) queueReconnect();
    return { reconnecting: moved };
  }
  function ruleAct(x) {
    let hit = false;
    mutate((s) => { const i = s.rules.findIndex((r) => r && r.id === x.id); if (i < 0) return; hit = true; if (x.action === 'remove') s.rules.splice(i, 1); else if (x.action === 'toggle') s.rules[i].enabled = s.rules[i].enabled === false; });
    if (!hit) throw Object.assign(new Error('없는 규칙입니다'), { status: 404 });
  }

  // ---- 라우트: /api/gh/* ----
  async function routes(req, res, p, { sendJson, csrfOk, jsonBody, actor, audit }) {
    if (req.method === 'GET') {
      if (p === '/api/gh/state') return sendJson(res, 200, view()), true;
      if (p === '/api/gh/interview') return sendJson(res, 200, { questions: interview.QUESTIONS, answers: settings.answers }), true;
      return sendJson(res, 404, { error: 'not found' }), true;
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' }), true;
    if (!csrfOk(req)) return sendJson(res, 403, { error: 'forbidden (origin/content-type)' }), true;
    const body = await jsonBody(req, res); if (!body) return true;
    const by = actor(req);
    try {
      if (p === '/api/gh/mode') { setMode(body.mode); audit(by, 'gh.mode', body.mode); return sendJson(res, 200, { ok: true }), true; }
      if (p === '/api/gh/command') { const c = command(body, by); audit(by, 'gh.command', c.title); return sendJson(res, 200, { ok: true, command: c }), true; }
      if (p === '/api/gh/clear-fault') { ctl.clearFault(String(body.vent)); audit(by, 'gh.clear', String(body.vent).slice(0, 40)); return sendJson(res, 200, { ok: true }), true; }
      if (p === '/api/gh/interview') { const rules = applyInterview(body.answers, body.apply === true); if (body.apply === true) audit(by, 'gh.interview', `${rules.length} rules`); return sendJson(res, 200, { ok: true, applied: body.apply === true, rules }), true; }
      if (p === '/api/gh/preview') return sendJson(res, 200, { ok: true, decisions: preview(body) }), true;
      if (p === '/api/gh/rule') { if (!['toggle', 'remove'].includes(body.action)) return sendJson(res, 400, { error: 'action: toggle | remove' }), true; ruleAct(body); audit(by, `gh.rule.${body.action}`, String(body.id).slice(0, 40)); return sendJson(res, 200, { ok: true }), true; }
      if (p === '/api/gh/settings') { const r = saveConfig(body); audit(by, 'gh.settings', r.reconnecting ? 'mqtt' : 'control'); return sendJson(res, 200, { ok: true, ...r }), true; }
      if (p === '/api/gh/sim') { if (!sim) return sendJson(res, 409, { error: '시뮬레이터가 꺼져 있습니다' }), true; sim.set(body); return sendJson(res, 200, { ok: true, sim: sim.view() }), true; }
    } catch (e) { if (!e.status) throw e; return sendJson(res, e.status, { error: e.message, errors: e.errors, needsConfirm: e.needsConfirm }), true; }
    return sendJson(res, 404, { error: 'not found' }), true;
  }
  return { start, stop, tick, view, routes, onMessage, applyInterview, preview, setMode, command, saveConfig, ruleAct, ctl, settings: () => settings };
}

module.exports = { createGreenhouse };
