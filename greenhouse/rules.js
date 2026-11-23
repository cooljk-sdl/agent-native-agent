'use strict';
// rules.js — 규칙 판단(순수 함수). 실내온도·풍속·풍향으로 창마다 목표 개도율을 정한다.
//
// 규칙은 work-graph.json의 rules[] 항목이다. 데이터 변경 제안(diff)은 원시값만 담을 수 있어 필드는 모두 납작하다.
//   mode      'set'   — 조건이 맞으면 이 개도율로 (priority가 작은 것 하나만)
//             'limit' — 조건이 맞으면 이 개도율을 넘지 않게 (맞는 것 모두, 가장 작은 값)
//   tempMin ≤ 실내온도 < tempMax, windMin ≤ 풍속 < windMax (비우면 보지 않음)
//   windSide  'any' | 'windward'(바람받이 창만) | 'leeward'(반대쪽 창만)
//   openSide · openRoof  측창 · 천창 개도율 0–100 (비우면 그 창에는 적용하지 않음)

const NUM = ['tempMin', 'tempMax', 'windMin', 'windMax', 'openSide', 'openRoof'];
const num = (v) => (v === '' || v === null || v === undefined || typeof v === 'boolean' ? null : Number.isFinite(Number(v)) ? Number(v) : NaN);

// 저장된 규칙 → {rule} 또는 {error}
function parseRule(x) {
  if (!x || typeof x !== 'object') return { error: '규칙이 아닙니다' };
  const r = { id: String(x.id), title: String(x.title || x.id), mode: x.mode, windSide: x.windSide || 'any', enabled: x.enabled !== false, priority: num(x.priority) };
  if (r.priority === null) r.priority = 50;
  if (Number.isNaN(r.priority)) return { error: '우선순위가 숫자가 아닙니다' };
  for (const k of NUM) { r[k] = num(x[k]); if (Number.isNaN(r[k])) return { error: `${k} 값이 숫자가 아닙니다` }; }
  if (!['set', 'limit'].includes(r.mode)) return { error: 'mode는 set 또는 limit이어야 합니다' };
  if (!['any', 'windward', 'leeward'].includes(r.windSide)) return { error: 'windSide는 any, windward, leeward 중 하나여야 합니다' };
  if (r.openSide === null && r.openRoof === null) return { error: '측창이나 천창의 개도율이 필요합니다' };
  for (const k of ['openSide', 'openRoof']) if (r[k] !== null && (r[k] < 0 || r[k] > 100)) return { error: '개도율은 0–100이어야 합니다' };
  for (const k of ['windMin', 'windMax']) if (r[k] !== null && r[k] < 0) return { error: '풍속은 0 이상이어야 합니다' };
  if (['tempMin', 'tempMax', 'windMin', 'windMax'].every((k) => r[k] === null)) return { error: '온도나 풍속 조건이 하나는 있어야 합니다' };
  if (r.windSide !== 'any' && r.windMin === null) return { error: '풍향을 보려면 최소 풍속(windMin)이 필요합니다' };
  if (r.tempMin !== null && r.tempMax !== null && r.tempMin >= r.tempMax) return { error: 'tempMin은 tempMax보다 작아야 합니다' };
  if (r.windMin !== null && r.windMax !== null && r.windMin >= r.windMax) return { error: 'windMin은 windMax보다 작아야 합니다' };
  return { rule: r };
}

const angleDiff = (a, b) => { const d = Math.abs(((a - b) % 360 + 360) % 360); return d > 180 ? 360 - d : d; };

// 바람받이인가. windDir = 바람이 불어오는 방위. 경계(90°)에서 왔다 갔다 하지 않게 ±10° 여유를 둔다
function isWindward(facing, windDir, prev) {
  const d = angleDiff(facing, windDir);
  return prev === undefined ? d < 90 : prev ? d < 100 : d < 80;
}

// 규칙이 이 창에서 켜져 있나. latch는 이전 판단(되돌림 폭 · 바람 유지 시간)을 기억한다
function isActive(r, vent, sensors, windward, st, latch, now) {
  const key = `${r.id}|${vent.id}`, prev = latch.get(key);
  const needT = r.tempMin !== null || r.tempMax !== null, needW = r.windMin !== null || r.windMax !== null;
  if ((needT && sensors.temp === null) || (needW && sensors.windSpeed === null) || (r.windSide !== 'any' && sensors.windDir === null)) {
    if (r.mode === 'limit') return !!prev;   // 센서를 잃으면 걸려 있던 제한은 풀지 않는다
    latch.delete(key); return false;
  }
  const within = (th, wh) => (r.tempMin === null || sensors.temp >= r.tempMin - th) && (r.tempMax === null || sensors.temp < r.tempMax + th)
    && (r.windMin === null || sensors.windSpeed >= r.windMin - wh) && (r.windMax === null || sensors.windSpeed < r.windMax + wh)
    && (r.windSide === 'any' || (r.windSide === 'windward') === windward);
  if (within(prev ? st.tempHyst : 0, prev ? st.windHyst : 0)) { latch.set(key, { since: prev ? prev.since : now, left: 0 }); return true; }
  if (prev && r.mode === 'limit') {          // 바람이 잠깐 잦아들었다고 바로 풀지 않는다
    if (!prev.left) prev.left = now;
    if (now - prev.left < st.windHoldSec * 1000) return true;
  }
  latch.delete(key); return false;
}

const openOf = (r, vent) => (vent.kind === 'roof' ? r.openRoof : r.openSide);

// 창마다 {ventId, target, base, baseRule, cap, capRule, windward, reason}. target이 null이면 지금 위치 유지
//   sensors: {temp, windSpeed, windDir} — 없거나 오래된 값은 null
//   lost:    센서를 잃은 상태 → st.onSensorLoss('hold' | 'close')
function evaluate({ vents, rules, sensors, settings, latch, now, lost }) {
  const list = rules.map((x) => parseRule(x).rule).filter((r) => r && r.enabled).sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1));
  const keep = new Set(); for (const r of list) for (const v of vents) keep.add(`${r.id}|${v.id}`);
  for (const k of [...latch.keys()]) if (!k.startsWith('ww|') && !keep.has(k)) latch.delete(k);   // 지우거나 끈 규칙의 기억은 버린다
  return vents.map((v) => {
    let windward = latch.get('ww|' + v.id);
    if (sensors.windDir !== null) { windward = isWindward(Number(v.facing) || 0, sensors.windDir, windward); latch.set('ww|' + v.id, windward); }
    let base = null, baseRule = null, cap = 100, capRule = null;
    for (const r of list) {
      const open = openOf(r, v); if (open === null) continue;
      const on = isActive(r, v, sensors, !!windward, settings, latch, now);
      if (!on) continue;
      if (r.mode === 'limit') { if (open < cap) { cap = open; capRule = r; } }
      else if (base === null) { base = open; baseRule = r; }
    }
    if (lost) { base = settings.onSensorLoss === 'close' ? 0 : null; baseRule = null; }
    const target = base === null ? null : Math.min(base, cap);
    const limited = capRule && (base === null || cap < base);
    const reason = lost && base === 0 ? '센서 값이 끊겨 닫습니다' : limited ? `${capRule.title} (최대 ${cap}%)` : baseRule ? baseRule.title : lost ? '센서 값이 끊겨 지금 위치를 유지합니다' : '맞는 규칙이 없어 지금 위치를 유지합니다';
    return { ventId: v.id, target, base, baseRule: baseRule && baseRule.id, cap, capRule: capRule && capRule.id, limited: !!limited, windward: windward === undefined ? null : windward, ruleId: (limited ? capRule.id : baseRule && baseRule.id) || '', reason };
  });
}

// 사람 말로
function describeRule(x) {
  const { rule: r, error } = parseRule(x); if (error) return `잘못된 규칙: ${error}`;
  const c = [];
  if (r.tempMin !== null) c.push(`실내온도 ${r.tempMin}℃ 이상`);
  if (r.tempMax !== null) c.push(`실내온도 ${r.tempMax}℃ 미만`);
  if (r.windMin !== null) c.push(`풍속 ${r.windMin}m/s 이상`);
  if (r.windMax !== null) c.push(`풍속 ${r.windMax}m/s 미만`);
  const side = { any: '', windward: '바람받이 ', leeward: '바람 반대쪽 ' }[r.windSide];
  const o = []; if (r.openRoof !== null) o.push(`${side}천창 ${r.openRoof}%`); if (r.openSide !== null) o.push(`${side}측창 ${r.openSide}%`);
  return `${c.join(', ')} → ${o.join(', ')}${r.mode === 'limit' ? ' 이하로 제한' : ''}`;
}

module.exports = { parseRule, evaluate, describeRule, angleDiff, isWindward };
