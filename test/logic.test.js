/*
 * 게임 규칙 테스트 — 서버를 모듈로 불러 틱을 직접 돌리므로 결과가 항상 같다.
 * 실행: node test/logic.test.js
 */
'use strict';

const path = require('path');
const G = require(path.join(__dirname, '..', 'server.js'));
const S = require(path.join(__dirname, '..', 'public', 'shared.js'));
const SP = require(path.join(__dirname, '..', 'public', 'sprites.js'));

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
  const floor = p.rows[S.ROWS - 1];
  const ceil = p.rows[0];
  check(`스테이지 ${i + 1} 맵이 올바름`,
    p.rows.length === S.ROWS &&
    p.rows.every((r) => r.length === S.COLS) &&
    floor.split('').every((c) => c === '#' || c === '.') &&
    p.playerSpawns.length >= 2 && p.enemySpawns.length >= 1,
    `플레이어 ${p.playerSpawns.length}, 적 ${p.enemySpawns.length}`);

  // 바닥 구멍 아래로 빠지면 같은 x 로 천장에 나온다. 천장이 막혀 있으면 거기 끼어버린다.
  const misaligned = [];
  for (let c = 0; c < S.COLS; c++) if (floor[c] === '.' && ceil[c] !== '.') misaligned.push(c);
  const holes = floor.split('').filter((c) => c === '.').length;
  check(`스테이지 ${i + 1} 바닥 구멍과 천장 구멍이 맞물림`, misaligned.length === 0,
    misaligned.length ? '어긋난 열: ' + misaligned.join(',') : `구멍 ${holes}칸`);
}

// ---- 도트 스프라이트 / 폰트 데이터
// 한 줄이라도 길이가 어긋나면 캐릭터가 잘려 보인다. 눈으로 알아채기 어려우니 검사한다.
{
  const PALETTE_KEYS = '.oBDLweyrgkcm';
  const bad = [];
  const checkSprite = (name, sp, size) => {
    if (sp.length !== size) bad.push(`${name}: 줄 수 ${sp.length}(기대 ${size})`);
    sp.forEach((row, i) => {
      if (row.length !== size) bad.push(`${name} ${i}번째 줄 길이 ${row.length}(기대 ${size})`);
      for (const ch of row) if (PALETTE_KEYS.indexOf(ch) < 0) bad.push(`${name} ${i}번째 줄에 알 수 없는 색 '${ch}'`);
    });
  };
  checkSprite('BUB', SP.BUB, 16);
  SP.ENEMY_SPRITES.forEach((sp, i) => checkSprite('적' + i, sp, 16));
  SP.FRUITS.forEach((f, i) => checkSprite('과일' + i, f, 12));
  check('스프라이트 도트가 온전함', bad.length === 0, bad.slice(0, 3).join(' / '));

  check('적 종류마다 스프라이트와 팔레트가 있음',
    SP.ENEMY_SPRITES.length === 3 && SP.ENEMY_KEYS.length === 3 &&
    SP.ENEMY_KEYS.every((k) => !!SP.ENEMY_PALETTES[k]), SP.ENEMY_KEYS.join(', '));

  const fontBad = [];
  for (const ch of Object.keys(SP.FONT)) {
    const rows = SP.FONT[ch].split('/');
    if (rows.length !== 7) fontBad.push(`'${ch}' 줄 수 ${rows.length}`);
    for (const r of rows) if (r.length !== 5 || /[^01]/.test(r)) fontBad.push(`'${ch}' 줄 "${r}"`);
  }
  check('비트맵 폰트가 5x7 규격', fontBad.length === 0, fontBad.slice(0, 3).join(' / '));

  // 화면에 실제로 찍는 글자가 폰트에 다 있어야 한다
  const used = ('1UP 2UP 3UP 4UP HIGH SCORE STAGE BOSS COMBO X GET READY TRY AGAIN ' +
                S.EXTEND + '0123456789').split('');
  const missing = [...new Set(used)].filter((c) => !SP.FONT[c.toUpperCase()]);
  check('HUD에 쓰는 글자가 폰트에 모두 있음', missing.length === 0, missing.join(''));
}

// ---- 발판 도달 가능성
// 실제 물리로 점프/이동을 시뮬레이션해서 갈 수 있는 칸을 전부 넓혀 나간다.
// 발판 간격이 점프 높이보다 넓으면 그 위층 적을 영영 잡을 수 없어 스테이지가 끝나지 않는다.
function reachability(levelIndex) {
  const lv = S.parseLevel(levelIndex);
  const map = lv.rows;
  const ACTIONS = [
    { left: true }, { right: true },
    { jump: true }, { jump: true, left: true }, { jump: true, right: true }
  ];

  const standable = (c, r) => {
    if (c < 1 || c > S.COLS - 2 || r < 1 || r > S.ROWS - 1) return false;
    const below = map[r][c];
    if (below !== '#' && below !== '=') return false;
    return map[r - 1][c] !== '#';
  };
  const mk = (c, r) => ({
    x: c * S.TILE + (S.TILE - S.PW) / 2, y: r * S.TILE - S.PH,
    vx: 0, vy: 0, w: S.PW, h: S.PH,
    facing: 1, onGround: true, jumpHeld: false, coyote: 5, ridingId: 0
  });
  // 발이 걸친 칸을 전부 본다. 가운데 칸만 보면 구멍 가장자리에 선 경우를 놓친다.
  const spotsOf = (p) => {
    const r = Math.round((p.y + p.h) / S.TILE);
    const out = [];
    for (let c = Math.floor(p.x / S.TILE); c <= Math.floor((p.x + p.w - 1) / S.TILE); c++) {
      if (standable(c, r)) out.push(c + ',' + r);
    }
    return out;
  };
  const landFrom = (x, y) => {                      // 스폰 위치에서 떨어뜨려 실제로 서는 칸
    const p = Object.assign(mk(0, 0), { x, y, onGround: false });
    for (let i = 0; i < 300; i++) { S.stepPlayer(p, {}, map, []); if (p.onGround) break; }
    return spotsOf(p);
  };

  const allSpots = new Set();
  for (let r = 1; r < S.ROWS; r++) {
    for (let c = 1; c < S.COLS - 1; c++) if (standable(c, r)) allSpots.add(c + ',' + r);
  }

  const seen = new Set();
  const queue = [];
  for (const sp of lv.playerSpawns) {
    for (const k of landFrom(sp.x, sp.y)) if (!seen.has(k)) { seen.add(k); queue.push(k); }
  }
  while (queue.length) {
    const [c, r] = queue.shift().split(',').map(Number);
    for (const act of ACTIONS) {
      const p = mk(c, r);
      for (let i = 0; i < 90; i++) {
        S.stepPlayer(p, act, map, []);
        if (!p.onGround) continue;
        for (const k of spotsOf(p)) if (allSpots.has(k) && !seen.has(k)) { seen.add(k); queue.push(k); }
      }
    }
  }

  // 발판 조각(가로로 이어진 구간) 단위로 확인
  const dead = [];
  for (let r = 1; r < S.ROWS; r++) {
    let run = null;
    for (let c = 1; c < S.COLS - 1; c++) {
      if (standable(c, r)) {
        if (!run) run = { r, from: c, to: c, reached: 0 };
        run.to = c;
        if (seen.has(c + ',' + r)) run.reached++;
      } else if (run) { if (!run.reached) dead.push(run); run = null; }
    }
    if (run && !run.reached) dead.push(run);
  }

  const unreachableEnemies = lv.enemySpawns
    .map((sp) => landFrom(sp.x, sp.y))
    .filter((spots) => !spots.some((k) => seen.has(k)));

  return { dead, unreachableEnemies, reached: seen.size, total: allSpots.size };
}

for (let i = 0; i < S.LEVELS.length; i++) {
  const { dead, unreachableEnemies, reached, total } = reachability(i);
  check(`스테이지 ${i + 1} 모든 발판에 올라갈 수 있음`, dead.length === 0,
    dead.length ? dead.map((d) => `row ${d.r} cols ${d.from}-${d.to}`).join(', ') : `${reached}/${total} 칸`);
  check(`스테이지 ${i + 1} 모든 적을 잡을 수 있음`, unreachableEnemies.length === 0,
    unreachableEnemies.length ? '못 가는 곳: ' + unreachableEnemies.map((s) => s[0] || '?').join(' ') : '');
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
  for (let i = 0; i < S.LEVELS.length; i++) {
    room.enemies.length = 0;
    room.boss = null;              // 보스판은 보스를 잡아야 넘어간다
    tick(room, 1); tick(room, 160);
  }
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

  // 한 번 뛰면 항상 같은 높이여야 한다 (누른 시간이 달라도 동일)
  const apexAfterHold = (holdTicks) => {
    tick(room, 60);                    // 착지시켜 초기화
    const ground = p.y;
    let top = p.y;
    p.input.jump = true;
    for (let i = 0; i < 120; i++) {
      G.stepRoom(room);
      if (i === holdTicks) p.input.jump = false;
      top = Math.min(top, p.y);
      if (i > holdTicks && p.onGround) break;
    }
    p.input.jump = false;
    return ground - top;
  };
  const tapHeight = apexAfterHold(1);      // 톡 누르기
  const holdHeight = apexAfterHold(60);    // 꾹 누르기
  check('점프 높이가 누른 시간과 무관하게 일정',
    Math.abs(tapHeight - holdHeight) < 1, `톡 ${tapHeight.toFixed(1)}px / 꾹 ${holdHeight.toFixed(1)}px`);
  check('점프 높이가 발판 간격(48px)을 넘음', tapHeight > 48 && tapHeight < 90, tapHeight.toFixed(1) + 'px');

  // 꾹 누르고 있어도 착지 후 자동으로 다시 뛰면 안 된다
  tick(room, 60);
  p.input.jump = true;
  tick(room, 120);                     // 계속 누른 채로 충분히 오래
  const restingY = p.y;
  const grounded = p.onGround;
  tick(room, 30);
  p.input.jump = false;
  check('버튼을 계속 눌러도 점프는 1회뿐', grounded && Math.abs(p.y - restingY) < 0.6,
    `y ${restingY.toFixed(1)} -> ${p.y.toFixed(1)}`);

  // 눌렀다 뗀 뒤 다시 누르면 정상적으로 또 뛴다
  tick(room, 10);
  const y1 = p.y;
  p.input.jump = true; tick(room, 12); p.input.jump = false;
  check('다시 누르면 또 뛴다', p.y < y1 - 20, `y ${y1.toFixed(1)} -> ${p.y.toFixed(1)}`);
  tick(room, 60);
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

// ---- 바닥 구멍 -> 천장 관통
{
  const room = freshRoom();
  const p = G.createPlayer(room, stub, '테스터');
  park(room);
  // 스테이지 1의 바닥 구멍(14~17열) 위로 옮겨 떨어뜨린다
  p.x = 15 * S.TILE + 2; p.y = 300; p.vy = 1; p.onGround = false;
  const startX = p.x;
  let wrapped = false, minY = 999;
  for (let i = 0; i < 200; i++) {
    G.stepRoom(room);
    if (p.y < 60) { wrapped = true; minY = Math.min(minY, p.y); break; }
  }
  check('바닥 구멍으로 빠지면 천장에서 나옴', wrapped, 'y=' + p.y.toFixed(1));
  check('관통해도 좌우 위치는 그대로', Math.abs(p.x - startX) < 2, `x ${startX} -> ${p.x.toFixed(1)}`);

  // 막힌 바닥에서는 관통하지 않는다
  const p2 = G.createPlayer(room, stub, '둘');
  p2.x = 3 * S.TILE + 2; p2.y = 340; p2.vy = 1; p2.onGround = false;
  tick(room, 90);
  check('막힌 바닥에서는 그대로 착지', p2.onGround && p2.y > 300, 'y=' + p2.y.toFixed(1));

  // 위로는 못 빠져나간다
  const p3 = G.createPlayer(room, stub, '셋');
  p3.x = 15 * S.TILE + 2; p3.y = 10; p3.vy = -8; p3.onGround = false;
  let escaped = false;
  for (let i = 0; i < 60; i++) { G.stepRoom(room); if (p3.y > S.H / 2) escaped = true; }
  check('천장 구멍으로 위로는 못 나감', !escaped && p3.y >= 0, 'y=' + p3.y.toFixed(1));
}

// ---- EXTEND 알파벳
{
  const room = freshRoom();
  const p = G.createPlayer(room, stub, '테스터');
  park(room);
  check('처음에는 아무 글자도 없음', room.extend.every((v) => v === false));

  G.spawnLetter(room, 200, 200);
  check('알파벳이 떨어짐', room.letters.length === 1, 'idx=' + (room.letters[0] && room.letters[0].idx));

  const l = room.letters[0];
  const idx = l.idx;
  l.x = p.x; l.y = p.y; l.arm = 0;
  const before = p.score;
  tick(room, 1);
  check('알파벳을 주우면 모은 목록에 들어감', room.extend[idx] === true && room.letters.length === 0,
    S.EXTEND[idx] + ' 획득');
  check('알파벳 획득 점수', p.score === before + 500, `${before} -> ${p.score}`);

  // 아직 못 모은 글자만 나온다
  let onlyMissing = true;
  for (let i = 0; i < 40; i++) {
    room.letters.length = 0;
    G.spawnLetter(room, 200, 200);
    if (room.letters[0] && room.extend[room.letters[0].idx]) onlyMissing = false;
  }
  check('이미 모은 글자는 다시 안 나옴', onlyMissing);

  // 마지막 한 글자를 채우면 EXTEND 완성
  // 앞에서 주운 글자가 무엇이었든 상관없도록 여기서 상태를 명확히 다시 만든다
  room.letters.length = 0;
  room.extend.fill(false);
  for (let i = 0; i < room.extend.length - 1; i++) room.extend[i] = true;
  const lastIdx = room.extend.findIndex((v) => !v);
  G.spawnLetter(room, 200, 200);
  const last = room.letters[0];
  check('마지막 남은 글자가 나옴', last.idx === lastIdx, S.EXTEND[last.idx]);
  last.x = p.x; last.y = p.y; last.arm = 0;
  const livesBefore = p.lives;
  const scoreBefore = p.score;
  tick(room, 1);
  check('EXTEND 완성 시 1UP', p.lives === livesBefore + 1, `${livesBefore} -> ${p.lives}`);
  check('EXTEND 완성 보너스 점수', p.score >= scoreBefore + G.EXTEND_BONUS, `+${p.score - scoreBefore}`);
  check('완성 후 글자 초기화', room.extend.every((v) => v === false));
}

// ---- 보스판
{
  const room = freshRoom();
  const p = G.createPlayer(room, stub, '테스터');
  const bossLevel = S.LEVELS.findIndex((rows) => rows.some((r) => r.indexOf('B') >= 0));
  check('보스판이 존재함', bossLevel >= 0, 'STAGE ' + (bossLevel + 1));

  G.loadLevel(room, bossLevel);
  check('보스판에 보스가 등장', !!room.boss && room.boss.hp === G.BOSS_MAX_HP, 'HP ' + (room.boss && room.boss.hp));

  // 보스가 살아있으면 적을 다 잡아도 스테이지가 끝나지 않는다
  room.enemies.length = 0;
  tick(room, 5);
  check('보스가 살아있으면 클리어되지 않음', room.phase === 'play', room.phase);

  // 버블로 때리면 체력이 깎인다
  const hpBefore = room.boss.hp;
  room.bubbles.push({
    id: 1, x: room.boss.x + room.boss.w / 2, y: room.boss.y + room.boss.h / 2,
    vx: 0, phase: 0, timer: 10, life: 10, enemy: null, trapTimer: 0, owner: p.id, wobble: 0
  });
  tick(room, 1);
  check('버블로 보스에게 피해', room.boss.hp === hpBefore - 1, `HP ${hpBefore} -> ${room.boss.hp}`);
  check('보스는 버블에 갇히지 않음', room.bubbles.length === 0);

  // 보스는 불덩이를 뱉는다
  room.boss.shootTimer = 1;
  tick(room, 3);
  check('보스가 불덩이를 뱉음', room.shots.length > 0, room.shots.length + '개');

  // 불덩이에 맞으면 잔기가 준다
  const s = room.shots[0];
  s.x = p.x + p.w / 2; s.y = p.y + p.h / 2;
  p.invuln = 0;
  const livesBefore = p.lives;
  tick(room, 1);
  check('불덩이에 맞으면 잔기 감소', p.lives === livesBefore - 1, `${livesBefore} -> ${p.lives}`);

  // 보스를 잡으면 과일이 쏟아지고 스테이지가 끝난다
  room.boss.hp = 1;
  G.damageBoss(room, 1, p);
  check('체력이 0이면 보스 처치', room.boss === null);
  check('보스를 잡으면 과일이 쏟아짐', room.fruits.length >= 6, room.fruits.length + '개');
  check('보스 처치 후 불덩이 제거', room.shots.length === 0);
  room.enemies.length = 0;
  tick(room, 1);
  check('보스를 잡으면 스테이지 클리어', room.phase === 'clear', room.phase);
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
