'use strict';
// interview.js — 규칙 인터뷰: 질문, 답 검사, 답 → 규칙. 화면과 채팅의 에이전트가 같은 것을 쓴다.

const DIRS = [['0', '북'], ['45', '북동'], ['90', '동'], ['135', '남동'], ['180', '남'], ['225', '남서'], ['270', '서'], ['315', '북서']];
// example은 답을 시작하기 쉽게 넣어 둔 예시일 뿐 권장값이 아니다 — 작물과 시설에 맞게 사람이 정한다
const QUESTIONS = [
  { id: 'facing', q: '온실 왼쪽 측창은 어느 방위를 바라보나요?', why: '바람받이 창을 가려내는 데 씁니다. 오른쪽 창은 반대 방위로 봅니다.', type: 'choice', options: DIRS, example: '270' },
  { id: 'closeTemp', q: '실내온도가 몇 도보다 낮으면 창을 모두 닫을까요?', why: '추울 때 온기를 지키는 기준입니다.', type: 'number', unit: '℃', min: -20, max: 50, example: 18 },
  { id: 'openTemp', q: '몇 도부터 환기를 시작할까요?', why: '이 온도부터 창을 조금 엽니다.', type: 'number', unit: '℃', min: -20, max: 60, example: 24 },
  { id: 'fullTemp', q: '몇 도부터 최대로 열까요?', why: '환기 시작 온도와 이 온도 사이는 중간 단계로 엽니다.', type: 'number', unit: '℃', min: -20, max: 60, example: 30 },
  { id: 'order', q: '어느 창부터 열까요?', why: '처음 여는 창을 정합니다. 온도가 더 오르면 나머지도 엽니다.', type: 'choice', options: [['roof', '천창 먼저'], ['side', '측창 먼저'], ['both', '같이']], example: 'roof' },
  { id: 'maxRoof', q: '천창은 최대 몇 %까지 열까요?', why: '시설이 허용하는 만큼만 엽니다.', type: 'number', unit: '%', min: 0, max: 100, example: 100 },
  { id: 'maxSide', q: '측창은 최대 몇 %까지 열까요?', why: '시설이 허용하는 만큼만 엽니다.', type: 'number', unit: '%', min: 0, max: 100, example: 100 },
  { id: 'cautionWind', q: '풍속이 몇 m/s부터 바람받이 창을 줄일까요?', why: '바람이 직접 들이치는 쪽만 줄이고, 반대쪽은 계속 환기합니다.', type: 'number', unit: 'm/s', min: 0.5, max: 40, example: 5 },
  { id: 'cautionOpen', q: '그때 바람받이 창은 몇 %까지만 열까요?', why: '측창과 천창에 똑같이 적용합니다.', type: 'number', unit: '%', min: 0, max: 100, example: 20 },
  { id: 'dangerWind', q: '풍속이 몇 m/s부터 모든 창을 닫을까요?', why: '온도와 관계없이 강풍이 우선입니다.', type: 'number', unit: 'm/s', min: 1, max: 60, example: 10 },
  { id: 'onSensorLoss', q: '센서 값이 끊기면 창을 어떻게 할까요?', why: '온도나 바람을 알 수 없을 때의 동작입니다.', type: 'choice', options: [['hold', '지금 위치 유지'], ['close', '모두 닫기']], example: 'hold' },
];

// {answers} 또는 {errors: {id: 이유}}
function checkAnswers(input) {
  const a = {}, errors = {};
  for (const q of QUESTIONS) {
    const v = input && input[q.id];
    if (v === undefined || v === null || v === '') { errors[q.id] = '답이 필요합니다'; continue; }
    if (q.type === 'choice') { if (!q.options.some(([k]) => k === String(v))) errors[q.id] = '보기 중에서 골라 주세요'; else a[q.id] = String(v); continue; }
    const n = Number(v);
    if (typeof v === 'boolean' || !Number.isFinite(n) || n < q.min || n > q.max) errors[q.id] = `${q.min}–${q.max}${q.unit} 사이로 적어 주세요`; else a[q.id] = n;
  }
  const bad = (id, m) => { if (!errors[id]) errors[id] = m; };
  if (a.closeTemp >= a.openTemp) bad('openTemp', '닫는 온도보다 높아야 합니다');
  if (a.openTemp >= a.fullTemp) bad('fullTemp', '환기 시작 온도보다 높아야 합니다');
  if (a.cautionWind >= a.dangerWind) bad('dangerWind', '창을 줄이는 풍속보다 높아야 합니다');
  return Object.keys(errors).length ? { errors } : { answers: a };
}

function buildRules(a) {
  const r1 = (n) => Math.round(n * 10) / 10, pct = (max, f) => Math.round(max * f);
  const mid = r1((a.openTemp + a.fullTemp) / 2);
  const stage1 = { roof: [0.5, 0], side: [0, 0.5], both: [0.33, 0.33] }[a.order];
  const stage2 = { roof: [1, 0.5], side: [0.5, 1], both: [0.66, 0.66] }[a.order];
  const base = { enabled: true, source: 'interview', tempMin: '', tempMax: '', windMin: '', windMax: '', windSide: 'any', openSide: '', openRoof: '' };
  const set = (id, title, priority, tempMin, f) => ({ ...base, id, title, mode: 'set', priority, tempMin, openRoof: pct(a.maxRoof, f[0]), openSide: pct(a.maxSide, f[1]) });
  return [
    { ...base, id: 'iv-danger', title: '강풍: 모두 닫기', mode: 'limit', priority: 10, windMin: a.dangerWind, openSide: 0, openRoof: 0 },
    { ...base, id: 'iv-caution', title: '바람받이 창 줄이기', mode: 'limit', priority: 20, windMin: a.cautionWind, windSide: 'windward', openSide: a.cautionOpen, openRoof: a.cautionOpen },
    set('iv-full', '3단계 환기: 최대', 30, a.fullTemp, [1, 1]),
    ...(mid > a.openTemp && mid < a.fullTemp ? [set('iv-mid', '2단계 환기', 40, mid, stage2)] : []),
    set('iv-open', '1단계 환기: 시작', 50, a.openTemp, stage1),
    { ...base, id: 'iv-close', title: '보온: 모두 닫기', mode: 'set', priority: 60, tempMax: a.closeTemp, openSide: 0, openRoof: 0 },
  ];
}

// 왼쪽 창은 답한 방위, 오른쪽 창은 반대 방위
const facingOf = (ventId, facing) => (Number(facing) + (/right/.test(ventId) ? 180 : 0)) % 360;

module.exports = { QUESTIONS, checkAnswers, buildRules, facingOf };
