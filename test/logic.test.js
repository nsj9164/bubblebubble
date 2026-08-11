/*
 * 게임 규칙 테스트 — 서버를 모듈로 불러 틱을 직접 돌리므로 결과가 항상 같다.
 * 실행: node test/logic.test.js
 */
'use strict';

const path = require('path');
const G = require(path.join(__dirname, '..', 'server.js'));
const S = require(path.join(__dirname, '..', 'public', 'shared.js'));

const results = [];
function check(label, cond, extra) {
  results.push(!!cond);
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra ? '  -> ' + extra : ''));
}

const stub = { readyState: 3, send() {} };
let seq = 0;
const freshRoom = () => G.createRoom('T' + seq++);
const tick = (room, n) => { for (let i = 0; i < n; i++) G.stepRoom(room); };

// 적이 0마리면 곧바로 스테이지 클리어가 되어 시간이 멈춘다. 관계없는 테스트에서는 더미를 하나 둔다.
function park(room) {
  room.enemies.length = 0;
  room.enemies.push({ id: 9000, x: 470, y: 32, w: S.EW, h: S.EH, vx: 0, vy: 0, dir: 1, onGround: false, type: 0, angry: 0, thinkTimer: 1e9 });
}
const dummyEnemy = (x, y) => ({ id: 500, x, y, w: S.EW, h: S.EH, vx: 0, vy: 0, dir: 1, onGround: true, type: 0, angry: 0, thinkTimer: 1e9 });
const trappedBubble = (id, x, y, trapTimer) =>
  ({ id, x, y, vx: 0, phase: 1, timer: 99, life: 5, enemy: 0, trapTimer: trapTimer, owner: 0, wobble: 0 });

// ---- 맵 데이터
for (let i = 0; i < S.LEVELS.length; i++) {
  const p = S.parseLevel(i);
  check(`스테이지 ${i + 1} 맵이 올바름`,
    p.rows.length === S.ROWS &&
    p.rows.every((r) => r.length === S.COLS) &&
    p.rows[S.ROWS - 1].split('').every((c) => c === '#') &&
    p.playerSpawns.length >= 2 && p.enemySpawns.length >= 1,
    `플레이어 ${p.playerSpawns.length}, 적 ${p.enemySpawns.length}`);
}

// ---- 스테이지 클리어와 진행
{
  const room = freshRoom();
  G.createPlayer(room, stub, '테스터');
  room.enemies.length = 0;
  tick(room, 1);
  check('적 전멸 시 clear 단계 진입', room.phase === 'clear' && room.message === 'STAGE CLEAR!', room.phase);
  tick(room, 160);
  check('클리어 후 다음 스테이지 로드', room.level === 1 && room.phase === 'play', 'stage ' + (room.level + 1));
  check('새 스테이지에 적 재배치', room.enemies.length > 0, room.enemies.length + '마리');
  check('스테이지 이동 시 버블/과일 초기화', room.bubbles.length === 0 && room.fruits.length === 0);
}

// ---- 한 바퀴 돌면 난이도 상승
{
  const room = freshRoom();
  G.createPlayer(room, stub, '테스터');
  for (let i = 0; i < S.LEVELS.length; i++) { room.enemies.length = 0; tick(room, 1); tick(room, 160); }
  check('모든 스테이지를 돌면 라운드 증가', room.round === 1 && room.level === S.LEVELS.length,
    `round ${room.round}, level ${room.level}`);
  check('스테이지가 순환됨', room.enemies.length > 0);
}

// ---- 버블 발사 / 포획 / 처치 / 과일
{
  const room = freshRoom();
  const p = G.createPlayer(room, stub, '테스터');
  park(room);
  room.enemies.push(dummyEnemy(p.x + 60, p.y));
  p.facing = 1;
  p.input.fire = true;
  tick(room, 1);
  p.input.fire = false;
  check('버블 발사', room.bubbles.length === 1, room.bubbles.length + '개');

  tick(room, 20);
  check('버블이 적을 포획', room.bubbles.length === 1 && room.bubbles[0].enemy === 0 && room.enemies.length === 1,
    `버블 ${room.bubbles.length}, 남은 적 ${room.enemies.length}(더미)`);

  const b = room.bubbles[0];
  b.x = p.x + p.w / 2; b.y = p.y + p.h / 2;
  tick(room, 1);
  check('갇힌 버블을 터뜨리면 100점', p.score === 100, p.score + '점');
  check('처치 시 과일 드롭', room.fruits.length === 1);
  check('터진 버블 제거', room.bubbles.length === 0);

  const f = room.fruits[0];
  f.x = p.x; f.y = p.y;
  const before = p.score;
  tick(room, 3);
  check('과일은 터진 직후 바로 먹히지 않음', p.score === before && room.fruits.length === 1);
  tick(room, 25);
  check('과일 획득 시 점수 증가', p.score > before && room.fruits.length === 0, `${before} -> ${p.score}`);
}

// ---- 콤보
{
  const room = freshRoom();
  const p = G.createPlayer(room, stub, '테스터');
  park(room);
  room.bubbles.push(trappedBubble(1, p.x + p.w / 2, p.y + p.h / 2, 300));
  tick(room, 1);
  const first = p.score;
  room.bubbles.push(trappedBubble(2, p.x + p.w / 2, p.y + p.h / 2, 300));
  tick(room, 1);
  check('연속 처치 시 점수 2배', first === 100 && p.score === 300, `1번째 ${first}, 누적 ${p.score}`);
}

// ---- 가둔 적의 탈출
{
  const room = freshRoom();
  G.createPlayer(room, stub, '테스터');
  room.enemies.length = 0;
  room.bubbles.push(trappedBubble(1, 200, 200, 2));
  tick(room, 3);
  check('시간 초과 시 적이 탈출', room.enemies.length === 1 && room.bubbles.length === 0);
  check('탈출한 적은 화난 상태', room.enemies[0] && room.enemies[0].angry === 1);
}

// ---- 피격 / 잔기 / 게임오버
{
  const room = freshRoom();
  const p = G.createPlayer(room, stub, '테스터');
  const hit = () => { p.invuln = 0; park(room); room.enemies.push(dummyEnemy(p.x, p.y)); G.stepRoom(room); };

  hit();
  check('적과 충돌 시 잔기 감소', p.lives === 2, '잔기 ' + p.lives);
  check('사망 후 부활 대기', p.respawn > 0, p.respawn + '틱');
  tick(room, 95);
  check('부활 완료 + 무적 부여', p.respawn === 0 && p.invuln > 0, '무적 ' + p.invuln + '틱');

  hit(); tick(room, 95); hit();
  check('잔기 소진', p.lives === 0);
  G.stepRoom(room);
  check('전원 사망 시 GAME OVER', room.phase === 'over' && room.message === 'GAME OVER');
  tick(room, 305);
  check('게임오버 후 자동 재시작', room.phase === 'play' && room.level === 0);
  check('재시작 시 잔기/점수 초기화', p.lives === 3 && p.score === 0, `잔기 ${p.lives}, 점수 ${p.score}`);
}

// ---- 무적
{
  const room = freshRoom();
  const p = G.createPlayer(room, stub, '테스터');
  p.invuln = 60;
  park(room);
  room.enemies.push(dummyEnemy(p.x, p.y));
  tick(room, 5);
  check('무적 중에는 피격되지 않음', p.lives === 3);
}

// ---- 이동 / 점프 (착지 판정이 매 프레임 안정적인지 포함)
{
  const room = freshRoom();
  const p = G.createPlayer(room, stub, '테스터');
  park(room);
  tick(room, 30);
  check('중력으로 발판에 안착', p.onGround === true, 'y=' + p.y);

  let groundedEveryTick = true;
  for (let i = 0; i < 30; i++) { G.stepRoom(room); if (!p.onGround) groundedEveryTick = false; }
  check('가만히 서 있을 때 착지 판정이 흔들리지 않음', groundedEveryTick);

  const x0 = p.x;
  p.input.right = true; tick(room, 30); p.input.right = false;
  check('오른쪽 이동', p.x > x0 + 40, `x ${x0} -> ${p.x.toFixed(1)}`);

  // 어느 타이밍에 눌러도 점프가 씹히지 않아야 한다
  let jumpOk = 0;
  for (let trial = 0; trial < 10; trial++) {
    tick(room, 40 + trial);           // 매번 다른 프레임 위상에서 시도
    const y0 = p.y;
    p.input.jump = true; tick(room, 10); p.input.jump = false;
    if (p.y < y0 - 20) jumpOk++;
    tick(room, 40);
  }
  check('점프 10회 모두 성공', jumpOk === 10, jumpOk + '/10');
}

// ---- 버블 타기
{
  const room = freshRoom();
  const p = G.createPlayer(room, stub, '테스터');
  park(room);
  p.x = 200; p.y = 200; p.vy = 2; p.onGround = false;
  room.bubbles.push({ id: 7, x: p.x + p.w / 2, y: 200 + p.h + S.BR + 1, vx: 0, phase: 1, timer: 99, life: 5, enemy: null, trapTimer: 0, owner: p.id, wobble: 0 });
  G.stepRoom(room);
  const rode = p.onGround && p.ridingId === 7;
  const yLand = p.y;
  tick(room, 30);
  check('버블 위에 올라탈 수 있음', rode, 'ridingId=' + p.ridingId);
  check('버블을 타면 위로 올라감', p.y < yLand - 5, `y ${yLand.toFixed(1)} -> ${p.y.toFixed(1)}`);
  check('타고 있는 버블은 터지지 않음', room.bubbles.length === 1);
}

// ---- 버블이 맵 밖으로 나가지 않음
{
  const room = freshRoom();
  G.createPlayer(room, stub, '테스터');
  park(room);
  room.bubbles.push({ id: 8, x: 100, y: 300, vx: 0, phase: 1, timer: 99, life: 5, enemy: null, trapTimer: 0, owner: 0, wobble: 0 });
  let inside = true;
  for (let i = 0; i < 400; i++) {
    G.stepRoom(room);
    const b = room.bubbles[0];
    if (b && (b.y < S.TILE || b.x < S.TILE || b.x > S.W - S.TILE)) inside = false;
  }
  check('버블이 벽/천장을 뚫지 않음', inside);
}

// ---- 스냅샷
{
  const room = freshRoom();
  const p = G.createPlayer(room, stub, '스냅');
  tick(room, 5);
  const snap = G.snapshot(room);
  check('스냅샷 필드 구성',
    snap.t === 's' && Array.isArray(snap.p) && Array.isArray(snap.b) &&
    Array.isArray(snap.e) && Array.isArray(snap.f) && typeof snap.lv === 'number',
    Object.keys(snap).join(','));
  check('스냅샷에 플레이어 정보 포함', snap.p[0] && snap.p[0].n === '스냅' && snap.p[0].i === p.id);
  const size = JSON.stringify(snap).length;
  check('스냅샷 크기가 작음 (<4KB)', size < 4096, size + ' bytes');
}

// ---- 방 정원
{
  const room = freshRoom();
  for (let i = 0; i < 4; i++) G.createPlayer(room, stub, 'P' + i);
  check('한 방에 4명까지 색이 겹치지 않음',
    new Set([...room.players.values()].map((p) => p.color)).size === 4);
  const spawns = [...room.players.values()].map((p) => `${p.x},${p.y}`);
  check('플레이어들이 시작 지점에 배치됨', spawns.every((s) => s.length > 0), spawns.join(' / '));
}

const failed = results.filter((r) => !r).length;
console.log('\n===== 로직 테스트 ' + (results.length - failed) + '/' + results.length + ' 통과 =====');
process.exit(failed ? 1 : 0);
