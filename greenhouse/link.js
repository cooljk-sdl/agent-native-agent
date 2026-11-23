'use strict';
// link.js — MQTT 연결 하나. 끊기면 새 클라이언트로 다시 붙는다: 라이브러리의 재연결은 확인받지 못한 옛 명령을
// 다시 보내는데, 창 명령은 오래된 것이 뒤늦게 나가면 안 된다.
const mqtt = require('mqtt');
const crypto = require('node:crypto');

function createLink({ url, username, password, base, onMessage, onChange }) {
  let client = null, closed = false, timer = null;
  const link = { connected: false, error: '', publish, close };
  function open() {
    if (closed) return;
    const will = { topic: `${base}/controller/status`, payload: JSON.stringify({ online: false }), qos: 1, retain: true };
    const c = client = mqtt.connect(url, { clientId: 'ana-gh-' + crypto.randomBytes(4).toString('hex'), username: username || undefined, password: password || undefined, clean: true, reconnectPeriod: 0, connectTimeout: 8000, keepalive: 20, queueQoSZero: false, will });
    let gone = false;
    const lost = () => { if (gone) return; gone = true; link.connected = false; c.end(true); if (!closed) { timer = setTimeout(open, 3000); timer.unref(); } onChange(link); };
    c.on('connect', () => {
      c.subscribe([`${base}/sensor/+`, `${base}/vent/+/state`], { qos: 1 }, (e, granted) => {
        if (gone || closed) return;
        const refused = (granted || []).find((g) => g.qos >= 128);
        if (e || refused) { link.error = `구독 실패: ${e ? e.message : refused.topic}`; return lost(); }
        link.connected = true; link.error = '';
        c.publish(`${base}/controller/status`, JSON.stringify({ online: true, ts: new Date().toISOString() }), { qos: 1, retain: true });
        onChange(link);
      });
    });
    c.on('message', (topic, payload, packet) => { if (!gone && !closed) onMessage(topic, payload, !!packet.retain); });
    c.on('error', (e) => { link.error = e.message || e.code || '연결 오류'; lost(); });
    c.on('close', lost);
  }
  function publish(topic, obj) {
    if (!link.connected) return false;
    client.publish(topic, JSON.stringify(obj), { qos: 1, retain: false }, (e) => { if (e) link.error = e.message; });
    return true;
  }
  function close() {
    if (closed) return; closed = true; link.connected = false; clearTimeout(timer);
    const c = client; if (!c) return;
    try { c.publish(`${base}/controller/status`, JSON.stringify({ online: false }), { qos: 1, retain: true }); } catch {}
    c.end(false); setTimeout(() => c.end(true), 500).unref();
  }
  open();
  return link;
}

module.exports = { createLink };
