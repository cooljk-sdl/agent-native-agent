'use strict';
// control.js — 명령 하나를 끝까지 책임진다: 발행 → 상태 확인 → 안 되면 다시 발행 → 그래도 안 되면 실패.
// 시간과 발행을 밖에서 받으므로(now, publish) 시험에서 그대로 돌릴 수 있다.
const crypto = require('node:crypto');

// io: { now(), settings(), publish(ventId, payload) → boolean, save(cmd), failed(cmd) }
function createController(io) {
  const live = new Map();      // ventId → {position, moving, error, at}
  const pending = new Map();   // ventId → {cmd, sentAt, progressAt, best}
  const faults = new Map();    // ventId → {target, until, text}
  const lastSent = new Map();  // ventId → 마지막으로 새 명령을 보낸 시각
  const iso = () => new Date(io.now()).toISOString();

  function payloadOf(cmd) {
    return { cmdId: cmd.id, ventId: cmd.vent, action: 'set', target: cmd.target, attempt: cmd.attempts, maxAttempts: cmd.maxAttempts, ruleId: cmd.rule || null, reason: cmd.reason, by: cmd.by, ts: iso() };
  }
  function transmit(p) {
    const now = io.now(), l = live.get(p.cmd.vent);
    p.sentAt = p.progressAt = now; p.best = l ? Math.abs(l.position - p.cmd.target) : Infinity;
    const payload = payloadOf(p.cmd);
    p.cmd.payload = JSON.stringify(payload); p.cmd.sentAt = iso();
    io.publish(p.cmd.vent, payload); io.save(p.cmd);
  }
  function end(p, status, error) {
    pending.delete(p.cmd.vent);
    p.cmd.status = status; p.cmd.error = error || p.cmd.error || ''; p.cmd.doneAt = iso(); io.save(p.cmd);
  }
  // 새 명령. 같은 창에 걸려 있던 명령은 대체된다
  function send({ vent, target, rule, reason, by, safety }) {
    const old = pending.get(vent.id); if (old) end(old, 'superseded');
    const l = live.get(vent.id);
    const cmd = { id: 'c' + io.now().toString(36) + crypto.randomBytes(2).toString('hex'), title: `${vent.title} ${target}%`, vent: vent.id, rule: rule || '', target, from: l ? l.position : '', status: 'sent',
      attempts: 1, maxAttempts: io.settings().maxAttempts, reason, by, safety: !!safety, day: iso().slice(0, 10), createdAt: iso(), sentAt: '', doneAt: '', error: '', payload: '' };
    const p = { cmd, sentAt: 0, progressAt: 0, best: Infinity };
    pending.set(vent.id, p); lastSent.set(vent.id, io.now()); transmit(p);
    return cmd;
  }
  function retry(p, why) {
    p.cmd.error = why;
    if (p.cmd.attempts >= p.cmd.maxAttempts) {
      end(p, 'failed', why);
      const cool = io.settings().faultCooldownSec * 1000;
      faults.set(p.cmd.vent, { target: p.cmd.target, until: io.now() + (p.cmd.safety ? Math.min(60000, cool) : cool), text: why });
      io.failed(p.cmd); return;
    }
    p.cmd.attempts++; p.cmd.status = 'retrying'; transmit(p);
  }
  // 장치 상태. retained(구독하자마자 받는 옛 값)는 위치만 알려 줄 뿐 명령의 완료로 치지 않는다
  function onState(ventId, m, retained) {
    const pos = typeof m.position === 'number' ? m.position : NaN;
    if (!Number.isFinite(pos) || pos < 0 || pos > 100) return false;
    const st = io.settings(), now = io.now(), err = m.error ? String(m.error).slice(0, 120) : '';
    live.set(ventId, { position: pos, moving: m.moving === true, error: err, at: now, retained });
    const f = faults.get(ventId);
    if (f && !retained && !err && m.moving !== true && Math.abs(pos - f.target) <= st.tolerance) faults.delete(ventId);   // 늦게라도 도착했다
    const p = pending.get(ventId); if (!p || retained) return true;
    const dist = Math.abs(pos - p.cmd.target);
    if (dist <= st.tolerance && m.moving !== true && !err) { faults.delete(ventId); end(p, 'done'); p.cmd.error = ''; io.save(p.cmd); return true; }
    if (dist <= p.best - 1) { p.best = dist; p.progressAt = now; }
    if (err && (!m.cmdId || m.cmdId === p.cmd.id) && now - p.sentAt >= 3000) retry(p, `장치 오류: ${err}`);
    return true;
  }
  function tick() {
    const st = io.settings(), now = io.now();
    for (const p of [...pending.values()]) {
      const l = live.get(p.cmd.vent);
      if (now - p.sentAt >= st.timeoutSec * 1000) retry(p, `${st.timeoutSec}초 안에 목표에 닿지 못했습니다`);
      else if (now - p.progressAt >= st.stallSec * 1000) retry(p, l && l.at >= p.sentAt ? `${st.stallSec}초 동안 움직임이 없습니다` : `${st.stallSec}초 동안 상태 응답이 없습니다`);
    }
    for (const [id, f] of faults) if (now >= f.until && !pending.has(id)) f.ready = true;   // 다시 시도해도 되는 때
  }
  // 다시 연결됨: 끊겨 있던 동안을 멈춤으로 세지 않는다
  function resume() { for (const p of pending.values()) { p.sentAt = p.progressAt = io.now(); } }
  function cancelAll(status, why) { for (const p of [...pending.values()]) end(p, status, why); }

  // 자동: 판단을 명령으로. 보내지 않으면 이유를 돌려준다
  function auto(vent, d) {
    const st = io.settings(), now = io.now(), l = live.get(vent.id), p = pending.get(vent.id), f = faults.get(vent.id);
    let target = d.target;
    if (target === null) {                                            // 맞는 규칙은 없지만 제한에 걸려 있다
      const at = p ? p.cmd.target : l ? l.position : null;
      if (!d.capRule || (at !== null && at <= d.cap + st.tolerance)) return 'hold';
      target = d.cap;
    }
    const safety = !!d.limited || (d.capRule && target <= d.cap);
    if (p && Math.abs(p.cmd.target - target) < 1) return 'pending';
    if (!l && !safety) return 'unknown-position';
    const closing = safety && (!l || l.position > target || (p && p.cmd.target > target));
    if (!p && l) {
      const diff = Math.abs(l.position - target);
      if (diff <= st.tolerance) return 'at-target';
      if (diff < st.minStep && !closing && target !== 0 && target !== 100) return 'small';
    }
    if (f && !f.ready && !(closing && Math.abs(f.target - target) >= 1)) return 'fault';
    if (!closing && now - (lastSent.get(vent.id) || -Infinity) < st.minIntervalSec * 1000) return 'interval';
    send({ vent, target, rule: d.ruleId, reason: d.reason, by: 'auto', safety: closing });
    return 'sent';
  }
  return { live, pending, faults, send, onState, tick, resume, cancelAll, auto, clearFault: (id) => faults.delete(id), reset() { live.clear(); faults.clear(); lastSent.clear(); } };
}

module.exports = { createController };
