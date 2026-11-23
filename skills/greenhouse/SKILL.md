---
name: greenhouse
description: 온실 측창·천창 환기 제어 — 채팅으로 규칙 인터뷰를 하거나 규칙을 바꿀 때, MQTT 명령·재시도 상태를 살필 때, 시뮬레이터로 시험할 때 쓴다. "규칙 인터뷰", "규칙 바꿔줘", "창이 안 움직여요", "MQTT 연결" 같은 말에 쓴다.
---

# greenhouse — 온실 환기 규칙과 MQTT 제어

코드: `greenhouse/rules.js`(판단) · `interview.js`(질문과 규칙 만들기) · `control.js`(발행 · 확인 · 재시도) · `link.js`(MQTT) · `simulator.js` · `index.js`(묶음과 `/api/gh/*`). 시험: `node --test greenhouse.test.cjs`.

## 채팅으로 인터뷰할 때
1. `GET /api/gh/interview` → `questions`, 이전 `answers`. 한 번에 한 가지씩 묻는다. `example`은 예시일 뿐이니 권장값처럼 말하지 않는다.
2. `POST /api/gh/interview {"answers": {…}}` → 적용하지 않고 규칙만 본다(틀린 답은 400 `errors`). `POST /api/gh/preview {"temp","windSpeed","windDir","answers"}`로 몇 가지 날씨를 미리 보여 준다.
3. 만든 규칙을 보여 주고 **사람이 좋다고 한 뒤에만** `"apply": true`로 적용한다.

## 인터뷰 밖의 규칙
규칙은 `work-graph.json`의 `rules`다. 바꿀 때는 `POST /api/agent {text, diff, why, effect}`로 제안한다(`list: "rules"`). 필드: `title, mode(set|limit), enabled, priority(작을수록 먼저), tempMin, tempMax, windMin, windMax, windSide(any|windward|leeward), openSide, openRoof`. 비운 칸은 보지 않는다. `set`은 먼저 맞는 하나, `limit`은 맞는 것 모두 중 가장 작은 값. 창의 방위는 `vents[].facing`(북 0, 동 90).

## 하지 않는 것
- 사람이 시키지 않으면 `/api/gh/mode`, `/api/gh/command`, `/api/gh/settings`를 부르지 않는다. 실제 창이 움직인다.
- 비밀번호는 채팅으로 받지 않는다. Work › 설정에 직접 넣게 한다.

## 살필 때
`GET /api/gh/state` — `alarms`, `vents[].pending/fault/note`, `commands`(최근 60개, `attempts`·`error`). 시뮬레이터 날씨와 고장은 `POST /api/gh/sim {"fixedIndoor","windSpeed","windDir","faults":{"roof-left":"drop|jam|dead|none"}}`.
