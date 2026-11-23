'use strict';
// simulator.js — 내장 MQTT 브로커와 가상 온실. 실제 브로커가 없어도 명령 → 동작 → 상태 왕복을 그대로 확인한다.
// 이 컴퓨터 안(127.0.0.1)에서만 열린다.
const net = require('node:net');

const SPEED = 5;   // 창이 1초에 움직이는 양(%)
const FAULTS = ['none', 'drop', 'jam', 'dead'];   // drop: 첫 명령만 놓침 · jam: 중간에서 걸림 · dead: 응답 없음

async function createSimulator({ base, port = 18830, vents }) {
  const { Aedes } = await import('aedes');
  const broker = await Aedes.createBroker();
  const server = net.createServer(broker.handle);
  const listen = (p) => new Promise((ok, no) => { server.once('error', no); server.listen(p, '127.0.0.1', () => { server.removeListener('error', no); ok(); }); });
  try { await listen(port); } catch (e) { if (e.code !== 'EADDRINUSE') throw e; await listen(0); }
  server.on('error', () => {});

  const env = { indoor: 22, outdoor: 18, sun: 40, windSpeed: 2, windDir: 270, fixedIndoor: null, sensorOn: true };
  const dev = new Map(vents.map((id) => [id, { id, position: 0, target: 0, moving: false, cmdId: '', fault: 'none', error: null, jamAt: null, sentAt: 0 }]));
  // 한 건씩 차례로 — aedes는 retain 저장을 기다리는 동안 다음 메시지가 앞지르면 늦은 쪽을 중복으로 보고 버린다
  let line = Promise.resolve(), closing = false;
  const publish = (topic, obj, retain) => {
    const packet = { cmd: 'publish', qos: 1, dup: false, retain: !!retain, topic, payload: Buffer.from(JSON.stringify(obj)) };
    line = line.then(() => new Promise((ok) => { if (closing) return ok(); broker.publish(packet, () => ok()); }));
  };
  const state = (d) => { d.sentAt = Date.now(); publish(`${base}/vent/${d.id}/state`, { ventId: d.id, position: Math.round(d.position), target: d.target, moving: d.moving, cmdId: d.cmdId, error: d.error, ts: new Date().toISOString() }, true); };

  broker.subscribe(`${base}/vent/+/cmd`, (packet, done) => {
    try {
      const d = dev.get(packet.topic.split('/').slice(-2)[0]), m = JSON.parse(packet.payload.toString());
      if (d && m.action === 'set' && Number.isFinite(m.target) && d.fault !== 'dead' && !(d.fault === 'drop' && m.attempt === 1)) {
        d.target = Math.max(0, Math.min(100, m.target)); d.cmdId = m.cmdId; d.error = null; d.moving = d.position !== d.target;
        d.jamAt = d.fault === 'jam' ? (d.position + d.target) / 2 : null;
        if (d.fault === 'jam' && m.attempt > 1) d.jamAt = d.position;
        state(d);
      }
    } catch {}
    done();
  }, () => {});

  let last = Date.now(), sensorAt = 0;
  const step = () => {
    const now = Date.now(), dt = Math.min(5, (now - last) / 1000); last = now;
    let open = 0;
    for (const d of dev.values()) {
      if (d.moving) {
        const goal = d.jamAt === null ? d.target : d.jamAt, diff = goal - d.position;
        d.position += Math.sign(diff) * Math.min(Math.abs(diff), SPEED * dt);
        if (Math.abs(goal - d.position) < 0.01) { d.position = goal; if (d.jamAt === null) d.moving = false; else if (d.position !== d.target) { d.moving = false; d.error = '모터 과부하'; } }
        if (d.fault !== 'dead') state(d);
      } else if (d.fault !== 'dead' && now - d.sentAt > 10000) state(d);
      open += d.position / 100 / dev.size;
    }
    if (env.fixedIndoor !== null) env.indoor = env.fixedIndoor;
    else { const goal = env.outdoor + env.sun * 0.2 * (1 - 0.8 * open); env.indoor += (goal - env.indoor) * Math.min(1, dt / 30); }
    if (env.sensorOn && now - sensorAt >= 2000) {
      sensorAt = now; const ts = new Date().toISOString();
      publish(`${base}/sensor/indoor`, { temp: Math.round(env.indoor * 10) / 10, ts });
      publish(`${base}/sensor/outdoor`, { windSpeed: env.windSpeed, windDir: env.windDir, ts });
    }
  };
  const timer = setInterval(step, 500); timer.unref();

  const LIMITS = { outdoor: [-20, 45], sun: [0, 100], windSpeed: [0, 40], windDir: [0, 359] };
  return {
    url: `mqtt://127.0.0.1:${server.address().port}`,
    view: () => ({ ...env, indoor: Math.round(env.indoor * 10) / 10, faults: Object.fromEntries([...dev].map(([k, d]) => [k, d.fault])) }),
    set(x) {
      for (const [k, [a, b]] of Object.entries(LIMITS)) if (typeof x[k] === 'number' && Number.isFinite(x[k])) env[k] = Math.max(a, Math.min(b, x[k]));
      if ('fixedIndoor' in x) env.fixedIndoor = typeof x.fixedIndoor === 'number' && Number.isFinite(x.fixedIndoor) ? Math.max(-20, Math.min(60, x.fixedIndoor)) : null;
      if (typeof x.sensorOn === 'boolean') env.sensorOn = x.sensorOn;
      for (const [k, f] of Object.entries(x.faults && typeof x.faults === 'object' ? x.faults : {})) if (dev.has(k) && FAULTS.includes(f)) { const d = dev.get(k); d.fault = f; if (f === 'none') { d.error = null; d.jamAt = null; } }
    },
    stop: () => new Promise((ok) => { closing = true; clearInterval(timer); broker.close(() => server.close(() => ok())); }),
  };
}

module.exports = { createSimulator };
