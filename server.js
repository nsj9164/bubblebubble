/*
 * server.js — 정적 파일 서빙 + WebSocket 게임 서버.
 * 게임 상태는 서버가 권위(authoritative)를 갖고 60Hz로 진행하며 30Hz로 스냅샷을 뿌린다.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const S = require('./public/shared.js');

const PORT = process.env.PORT || 3210;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);

  // 배포 진단용. 이 응답이 보이면 Node 서버는 정상적으로 떠 있는 것이다.
  if (urlPath === '/healthz') {
    let files = [];
    try { files = fs.readdirSync(PUBLIC_DIR); } catch (e) { files = ['<public 폴더를 읽을 수 없음: ' + e.code + '>']; }
    let players = 0;
    for (const r of rooms.values()) players += r.players.size;
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    res.end(JSON.stringify({
      ok: true,
      app: 'bubble-bobble-online',
      port: PORT,
      uptimeSec: Math.round(process.uptime()),
      cwd: process.cwd(),
      publicDir: PUBLIC_DIR,
      publicFiles: files,
      rooms: rooms.size,
      players
    }, null, 2));
    return;
  }

  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  const target = path.join(PUBLIC_DIR, path.normalize(urlPath).replace(/^[\\/]+/, ''));
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(target, (err, data) => {
    if (err) {
      // Render 자체의 "Not Found" 페이지와 구분할 수 있도록 앱 이름을 함께 알린다
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`[bubble-bobble-online] 파일을 찾을 수 없습니다: ${urlPath}\n` +
              `이 메시지가 보인다면 Node 서버는 정상 동작 중입니다. (/healthz 로 상태 확인)\n`);
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------------------------------------------------------------- 게임 상수

const PLAYER_COLORS = ['#5fe07a', '#5fc8ff', '#ff8fd0', '#ffd75f'];
const PLAYER_NAMES_FALLBACK = ['Bub', 'Bob', 'Pug', 'Pat'];
const MAX_PLAYERS = 4;

const FIRE_COOLDOWN = 16;
const BUBBLE_SHOT_SPEED = 3.6;
const BUBBLE_SHOT_FRAMES = 26;
const BUBBLE_RISE = -0.55;
const BUBBLE_LIFE = 540;
const TRAP_TIME = 330;
const RESPAWN_DELAY = 90;
const INVULN_TIME = 150;
const COMBO_WINDOW = 50;

const LETTER_CHANCE = 0.28;   // 적을 잡았을 때 알파벳이 떨어질 확률
const LETTER_LIFE = 780;
const EXTEND_BONUS = 10000;

const BOSS_MAX_HP = 14;
const BOSS_SPEED = 0.75;
const BOSS_SHOT_SPEED = 2.3;
const BOSS_HURT_FLASH = 18;
const BOSS_MINION_LIMIT = 4;

const FRUITS = [
  { kind: 0, value: 100 }, { kind: 1, value: 200 }, { kind: 2, value: 300 },
  { kind: 3, value: 500 }, { kind: 4, value: 700 }, { kind: 5, value: 1000 }
];

// ---------------------------------------------------------------- 방 관리

/** @type {Map<string, object>} */
const rooms = new Map();

// 아케이드 기판처럼 서버가 켜져 있는 동안의 최고 점수를 모두가 공유한다
let highScore = 30000;

function makeRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  } while (rooms.has(code));
  return code;
}

function createRoom(code) {
  const room = {
    code,
    players: new Map(),
    bubbles: [],
    enemies: [],
    fruits: [],
    letters: [],       // 바닥에 떨어진 EXTEND 알파벳
    extend: new Array(S.EXTEND.length).fill(false),
    boss: null,
    shots: [],         // 보스가 뱉는 불덩이
    pops: [],          // 시각 효과(터짐) 이벤트
    level: 0,
    round: 0,          // 전체 스테이지를 한 바퀴 돌 때마다 +1 (난이도 상승)
    map: null,
    playerSpawns: [],
    nextId: 1,
    tick: 0,
    phase: 'play',     // play | clear | over
    phaseTimer: 0,
    combo: 0,
    comboTimer: 0,
    message: ''
  };
  rooms.set(code, room);
  loadLevel(room, 0);
  return room;
}

function loadLevel(room, index) {
  const parsed = S.parseLevel(index);
  room.level = index;
  room.map = parsed.rows;
  room.playerSpawns = parsed.playerSpawns;
  room.bubbles = [];
  room.fruits = [];
  room.letters = [];
  room.shots = [];
  room.enemies = parsed.enemySpawns.map((sp, i) => makeEnemy(room, sp, i));
  room.boss = parsed.bossSpawn ? makeBoss(room, parsed.bossSpawn) : null;
  room.isBoss = !!room.boss;
  room.combo = 0;
  room.comboTimer = 0;

  let slot = 0;
  for (const p of room.players.values()) {
    placePlayerAtSpawn(room, p, slot++);
    p.respawn = 0;
    p.invuln = INVULN_TIME;
  }
}

function makeEnemy(room, spawn, i) {
  return {
    id: room.nextId++,
    x: spawn.x, y: spawn.y,
    w: S.EW, h: S.EH,
    vx: 0, vy: 0,
    dir: i % 2 === 0 ? 1 : -1,
    onGround: false,
    type: i % 3,   // 0 젠짱(기본), 1 마이타(잘 뛴다), 2 몬스타(빠르다)
    angry: 0,
    thinkTimer: 30 + Math.floor(Math.random() * 60)
  };
}

function makeBoss(room, spawn) {
  return {
    id: room.nextId++,
    x: spawn.x, y: spawn.y,
    w: S.BOSS_W, h: S.BOSS_H,
    vx: 0, vy: 0,
    dir: 1,
    onGround: false,
    hp: BOSS_MAX_HP,
    maxHp: BOSS_MAX_HP,
    hurt: 0,
    shootTimer: 150,
    minionTimer: 300,
    thinkTimer: 90
  };
}

function createPlayer(room, socket, rawName) {
  const slot = room.players.size;
  const name = String(rawName || '').trim().slice(0, 10) || PLAYER_NAMES_FALLBACK[slot];
  const player = {
    id: room.nextId++,
    socket,
    name,
    slot,
    color: PLAYER_COLORS[slot % PLAYER_COLORS.length],
    x: 0, y: 0, vx: 0, vy: 0, w: S.PW, h: S.PH,
    facing: 1, onGround: false, jumpHeld: false, ridingId: 0,
    coyote: 0,
    input: { left: false, right: false, jump: false, fire: false },
    fireHeld: false, fireCooldown: 0,
    score: 0, lives: 3, respawn: 0, invuln: INVULN_TIME
  };
  placePlayerAtSpawn(room, player, slot);
  room.players.set(player.id, player);
  return player;
}

function placePlayerAtSpawn(room, p, slotIndex) {
  const sp = room.playerSpawns[slotIndex % room.playerSpawns.length];
  // 시작 지점보다 인원이 많으면 서로 겹치지 않게 살짝 어긋나게 놓는다
  const wrap = Math.floor(slotIndex / room.playerSpawns.length);
  p.x = Math.max(S.TILE, Math.min(S.W - S.TILE - p.w, sp.x + wrap * 20));
  p.y = sp.y;
  p.vx = 0; p.vy = 0;
  p.onGround = false;
  p.jumpHeld = false;
  p.ridingId = 0;
}

function enemySpeed(room) {
  return 0.85 + Math.min(room.round, 4) * 0.1;
}

// ---------------------------------------------------------------- 게임 진행

function stepRoom(room) {
  room.tick++;

  if (room.phase === 'clear') {
    if (--room.phaseTimer <= 0) {
      const next = room.level + 1;
      if (next % S.LEVELS.length === 0) room.round++;
      loadLevel(room, next);
      room.phase = 'play';
      room.message = '';
    }
    return;
  }

  if (room.phase === 'over') {
    if (--room.phaseTimer <= 0) {
      room.round = 0;
      for (const p of room.players.values()) { p.lives = 3; p.score = 0; }
      loadLevel(room, 0);
      room.phase = 'play';
      room.message = '';
    }
    return;
  }

  stepPlayers(room);
  stepEnemies(room);
  stepBoss(room);
  stepShots(room);
  stepBubbles(room);
  stepFruits(room);
  stepLetters(room);
  resolveCollisions(room);

  for (const p of room.players.values()) if (p.score > highScore) highScore = p.score;

  if (room.comboTimer > 0 && --room.comboTimer === 0) room.combo = 0;
  if (room.pops.length > 24) room.pops.length = 24;

  // 스테이지 클리어 판정
  const trapped = room.bubbles.some((b) => b.enemy !== null);
  if (room.enemies.length === 0 && !trapped && !room.boss && room.players.size > 0) {
    room.phase = 'clear';
    room.phaseTimer = 150;
    room.message = 'STAGE CLEAR!';
    return;
  }

  // 게임 오버 판정 (플레이어 전원 잔기 소진)
  if (room.players.size > 0) {
    let anyAlive = false;
    for (const p of room.players.values()) if (p.lives > 0) anyAlive = true;
    if (!anyAlive) {
      room.phase = 'over';
      room.phaseTimer = 300;
      room.message = 'GAME OVER';
    }
  }
}

function stepPlayers(room) {
  for (const p of room.players.values()) {
    if (p.lives <= 0) continue;

    if (p.respawn > 0) {
      if (--p.respawn === 0) {
        placePlayerAtSpawn(room, p, p.slot);
        p.invuln = INVULN_TIME;
      }
      continue;
    }

    S.stepPlayer(p, p.input, room.map, room.bubbles);
    if (p.invuln > 0) p.invuln--;
    if (p.fireCooldown > 0) p.fireCooldown--;

    if (p.input.fire && !p.fireHeld && p.fireCooldown <= 0) {
      fireBubble(room, p);
      p.fireCooldown = FIRE_COOLDOWN;
    }
    p.fireHeld = !!p.input.fire;
  }
}

function fireBubble(room, p) {
  room.bubbles.push({
    id: room.nextId++,
    x: p.x + p.w / 2 + p.facing * 12,
    y: p.y + p.h / 2 - 1,
    vx: p.facing * BUBBLE_SHOT_SPEED,
    phase: 0,          // 0: 날아가는 중, 1: 떠오르는 중
    timer: 0,
    life: 0,
    enemy: null,       // 갇힌 적의 type
    trapTimer: 0,
    owner: p.id,
    wobble: Math.random() * Math.PI * 2
  });
}

function stepEnemies(room) {
  const speed = enemySpeed(room);
  for (const e of room.enemies) {
    if (--e.thinkTimer <= 0) {
      e.thinkTimer = 45 + Math.floor(Math.random() * 90);
      const target = nearestPlayer(room, e);
      if (target && Math.random() < 0.65) {
        e.dir = target.x + target.w / 2 < e.x + e.w / 2 ? -1 : 1;
      }
      if (e.onGround && (e.type === 1 || Math.random() < 0.3)) {
        if (target && target.y + target.h < e.y) e.vy = S.JUMP * 0.85;
      }
    }

    e.vx = e.dir * speed * (e.angry ? 1.7 : 1) * (e.type === 2 ? 1.3 : 1);
    e.vy += S.GRAVITY;
    if (e.vy > S.MAXFALL) e.vy = S.MAXFALL;

    S.moveX(e, room.map);
    if (e.hitWall) e.dir *= -1;

    const prevOnGround = e.onGround;
    S.moveY(e, room.map, true);

    // 발판 끝에서 절반의 확률로 방향을 튼다 (나머지는 그대로 떨어짐)
    if (prevOnGround && e.onGround) {
      const footCol = Math.floor((e.x + (e.dir > 0 ? e.w + 1 : -1)) / S.TILE);
      const footRow = Math.floor((e.y + e.h + 1) / S.TILE);
      const supported = S.isSolid(room.map, footCol, footRow) || S.isOneWay(room.map, footCol, footRow);
      if (!supported && Math.random() < 0.5) e.dir *= -1;
    }

    S.wrapVertical(e);   // 바닥 구멍으로 빠지면 천장에서 나온다
  }
}

function stepBoss(room) {
  const b = room.boss;
  if (!b) return;
  if (b.hurt > 0) b.hurt--;

  const enraged = b.hp <= b.maxHp / 2;   // 체력 절반 아래로 떨어지면 사나워진다
  const target = nearestPlayer(room, b);

  if (--b.thinkTimer <= 0) {
    b.thinkTimer = enraged ? 40 : 70;
    if (target) b.dir = target.x + target.w / 2 < b.x + b.w / 2 ? -1 : 1;
    if (b.onGround && target && Math.random() < (enraged ? 0.6 : 0.35)) b.vy = S.JUMP;
  }

  b.vx = b.dir * BOSS_SPEED * (enraged ? 1.5 : 1);
  b.vy += S.GRAVITY;
  if (b.vy > S.MAXFALL) b.vy = S.MAXFALL;

  S.moveX(b, room.map);
  if (b.hitWall) b.dir *= -1;
  S.moveY(b, room.map, true);
  S.wrapVertical(b);

  // 불덩이 뱉기
  if (--b.shootTimer <= 0) {
    b.shootTimer = enraged ? 90 : 160;
    if (target) {
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      const dx = target.x + target.w / 2 - cx;
      const dy = target.y + target.h / 2 - cy;
      const len = Math.max(1, Math.hypot(dx, dy));
      room.shots.push({
        id: room.nextId++,
        x: cx, y: cy,
        vx: (dx / len) * BOSS_SHOT_SPEED,
        vy: (dy / len) * BOSS_SHOT_SPEED,
        life: 0
      });
    }
  }

  // 부하 소환
  if (--b.minionTimer <= 0) {
    b.minionTimer = enraged ? 260 : 420;
    if (room.enemies.length < BOSS_MINION_LIMIT) {
      const e = makeEnemy(room, { x: b.x + b.w / 2 - S.EW / 2, y: b.y + b.h / 2 }, room.enemies.length);
      e.dir = Math.random() < 0.5 ? -1 : 1;
      room.enemies.push(e);
      room.pops.push({ x: b.x + b.w / 2, y: b.y + b.h / 2, kind: 1 });
    }
  }
}

function damageBoss(room, amount, byPlayer) {
  const b = room.boss;
  if (!b) return;
  b.hp -= amount;
  b.hurt = BOSS_HURT_FLASH;
  room.pops.push({ x: b.x + b.w / 2, y: b.y + b.h / 2, kind: 0 });
  if (byPlayer) byPlayer.score += 50;

  if (b.hp <= 0) {
    room.pops.push({ x: b.x + b.w / 2, y: b.y + b.h / 2, kind: 5 });
    if (byPlayer) byPlayer.score += 5000;
    // 보스를 잡으면 과일이 쏟아진다
    for (let i = 0; i < 6; i++) {
      spawnFruit(room, b.x + b.w / 2 + (i - 2.5) * 12, b.y + b.h / 2);
    }
    spawnLetter(room, b.x + b.w / 2, b.y);
    room.boss = null;
    room.shots.length = 0;
  }
}

function stepShots(room) {
  for (let i = room.shots.length - 1; i >= 0; i--) {
    const s = room.shots[i];
    s.x += s.vx;
    s.y += s.vy;
    s.life++;
    const c = Math.floor(s.x / S.TILE), r = Math.floor(s.y / S.TILE);
    if (s.life > 260 || S.isSolid(room.map, c, r) || s.y < 0 || s.y > S.H) {
      room.pops.push({ x: s.x, y: s.y, kind: 0 });
      room.shots.splice(i, 1);
    }
  }
}

function nearestPlayer(room, e) {
  let best = null, bestDist = Infinity;
  for (const p of room.players.values()) {
    if (p.lives <= 0 || p.respawn > 0) continue;
    const d = Math.abs(p.x - e.x) + Math.abs(p.y - e.y);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return best;
}

function stepBubbles(room) {
  for (let i = room.bubbles.length - 1; i >= 0; i--) {
    const b = room.bubbles[i];
    b.life++;

    if (b.phase === 0) {
      b.x += b.vx;
      b.timer++;
      const col = Math.floor((b.x + (b.vx > 0 ? S.BR : -S.BR)) / S.TILE);
      const row = Math.floor(b.y / S.TILE);
      if (S.isSolid(room.map, col, row) || b.timer >= BUBBLE_SHOT_FRAMES) {
        b.phase = 1;
        b.x = Math.max(S.TILE + S.BR, Math.min(S.W - S.TILE - S.BR, b.x));
      }
      // 보스는 가둘 수 없고, 버블이 터지면서 체력을 깎는다
      if (room.boss && b.enemy === null &&
          S.rectsOverlap(b.x - S.BR, b.y - S.BR, S.BR * 2, S.BR * 2,
                         room.boss.x, room.boss.y, room.boss.w, room.boss.h)) {
        damageBoss(room, 1, room.players.get(b.owner));
        room.bubbles.splice(i, 1);
        continue;
      }
      // 날아가는 중에만 적을 가둘 수 있다
      if (b.enemy === null) {
        for (let j = room.enemies.length - 1; j >= 0; j--) {
          const e = room.enemies[j];
          if (S.rectsOverlap(b.x - S.BR, b.y - S.BR, S.BR * 2, S.BR * 2, e.x, e.y, e.w, e.h)) {
            b.enemy = e.type;
            b.trapTimer = TRAP_TIME;
            b.phase = 1;
            room.enemies.splice(j, 1);
            break;
          }
        }
      }
    } else {
      b.y += BUBBLE_RISE;
      b.x += Math.sin((b.life + b.wobble * 10) * 0.06) * 0.35;
      b.x = Math.max(S.TILE + S.BR, Math.min(S.W - S.TILE - S.BR, b.x));

      // 천장/발판 아래에 눌러붙는다
      const rowAbove = Math.floor((b.y - S.BR) / S.TILE);
      const colC = Math.floor(b.x / S.TILE);
      if (S.isSolid(room.map, colC, rowAbove)) b.y = (rowAbove + 1) * S.TILE + S.BR;
      if (b.y < S.TILE + S.BR) b.y = S.TILE + S.BR;
    }

    if (b.enemy !== null && --b.trapTimer <= 0) {
      // 시간이 지나면 적이 화가 난 채로 풀려난다
      room.enemies.push(Object.assign(makeEnemy(room, { x: b.x - S.EW / 2, y: b.y - S.EH / 2 }, 0), {
        type: b.enemy, angry: 1, dir: Math.random() < 0.5 ? -1 : 1
      }));
      room.pops.push({ x: b.x, y: b.y, kind: 1 });
      room.bubbles.splice(i, 1);
      continue;
    }

    if (b.life > BUBBLE_LIFE) {
      room.pops.push({ x: b.x, y: b.y, kind: 0 });
      room.bubbles.splice(i, 1);
    }
  }
}

function stepFruits(room) {
  for (let i = room.fruits.length - 1; i >= 0; i--) {
    const f = room.fruits[i];
    if (f.arm > 0) f.arm--;
    f.vy += S.GRAVITY;
    if (f.vy > S.MAXFALL) f.vy = S.MAXFALL;
    f.vx = 0;
    S.moveY(f, room.map, true);
    S.wrapVertical(f);
    if (++f.life > 600) room.fruits.splice(i, 1);
  }
}

function stepLetters(room) {
  for (let i = room.letters.length - 1; i >= 0; i--) {
    const l = room.letters[i];
    if (l.arm > 0) l.arm--;
    l.vy += S.GRAVITY * 0.55;          // 알파벳은 천천히 떨어져서 눈에 잘 띈다
    if (l.vy > 3) l.vy = 3;
    l.vx = 0;
    S.moveY(l, room.map, true);
    S.wrapVertical(l);
    if (++l.life > LETTER_LIFE) room.letters.splice(i, 1);
  }
}

// 아직 못 모은 글자를 우선해서 떨어뜨린다 (다 모은 글자만 계속 나오면 영영 못 채운다)
function spawnLetter(room, cx, cy) {
  const missing = [];
  for (let i = 0; i < room.extend.length; i++) if (!room.extend[i]) missing.push(i);
  if (!missing.length) return;
  const idx = missing[Math.floor(Math.random() * missing.length)];
  room.letters.push({
    id: room.nextId++,
    x: cx - 7, y: cy - 7, w: 14, h: 14,
    vx: 0, vy: -1.8,
    onGround: false,
    idx, life: 0, arm: 22
  });
}

function resolveCollisions(room) {
  for (const p of room.players.values()) {
    if (p.lives <= 0 || p.respawn > 0) continue;

    // 버블 터뜨리기 (올라탄 버블은 제외)
    for (let i = room.bubbles.length - 1; i >= 0; i--) {
      const b = room.bubbles[i];
      if (b.id === p.ridingId) continue;
      if (b.owner === p.id && b.phase === 0 && b.timer < 6) continue; // 방금 쏜 버블
      if (!S.rectsOverlap(p.x, p.y, p.w, p.h, b.x - S.BR, b.y - S.BR, S.BR * 2, S.BR * 2)) continue;
      // 버블 윗면을 밟고 서 있는 동안에는 터뜨리지 않는다 (라이딩 보호)
      if (p.vy > -2.5 && p.y + p.h <= b.y - S.BR + 6) continue;

      if (b.enemy !== null) {
        room.combo = Math.min(room.combo + 1, 6);
        room.comboTimer = COMBO_WINDOW;
        const gained = 100 * Math.pow(2, room.combo - 1);
        p.score += gained;
        spawnFruit(room, b.x, b.y);
        if (Math.random() < LETTER_CHANCE) spawnLetter(room, b.x, b.y - 10);
        room.pops.push({ x: b.x, y: b.y, kind: 2, score: gained });
      } else {
        p.score += 10;
        room.pops.push({ x: b.x, y: b.y, kind: 0 });
      }
      room.bubbles.splice(i, 1);
    }

    // 과일 먹기
    for (let i = room.fruits.length - 1; i >= 0; i--) {
      const f = room.fruits[i];
      if (f.arm > 0) continue;
      if (S.rectsOverlap(p.x, p.y, p.w, p.h, f.x, f.y, f.w, f.h)) {
        p.score += f.value;
        room.pops.push({ x: f.x + f.w / 2, y: f.y, kind: 3, score: f.value });
        room.fruits.splice(i, 1);
      }
    }

    // EXTEND 알파벳 줍기
    for (let i = room.letters.length - 1; i >= 0; i--) {
      const l = room.letters[i];
      if (l.arm > 0) continue;
      if (!S.rectsOverlap(p.x, p.y, p.w, p.h, l.x, l.y, l.w, l.h)) continue;
      room.letters.splice(i, 1);
      if (room.extend[l.idx]) {
        p.score += 100;                       // 이미 모은 글자는 점수만
        room.pops.push({ x: l.x + 7, y: l.y, kind: 3, score: 100 });
      } else {
        room.extend[l.idx] = true;
        p.score += 500;
        room.pops.push({ x: l.x + 7, y: l.y, kind: 6, letter: l.idx, score: 500 });
        if (room.extend.every(Boolean)) completeExtend(room, p);
      }
    }

    // 적 / 보스 / 불덩이와 충돌
    if (p.invuln <= 0) {
      let hit = false;
      for (const e of room.enemies) {
        if (S.rectsOverlap(p.x, p.y, p.w, p.h, e.x, e.y, e.w, e.h)) { hit = true; break; }
      }
      if (!hit && room.boss &&
          S.rectsOverlap(p.x, p.y, p.w, p.h, room.boss.x, room.boss.y, room.boss.w, room.boss.h)) hit = true;
      if (!hit) {
        for (let i = room.shots.length - 1; i >= 0; i--) {
          const s = room.shots[i];
          if (S.rectsOverlap(p.x, p.y, p.w, p.h, s.x - S.SHOT_R, s.y - S.SHOT_R, S.SHOT_R * 2, S.SHOT_R * 2)) {
            room.shots.splice(i, 1);
            hit = true;
            break;
          }
        }
      }
      if (hit) killPlayer(room, p);
    }
  }
}

function completeExtend(room, p) {
  room.extend.fill(false);
  room.letters.length = 0;
  p.score += EXTEND_BONUS;
  for (const other of room.players.values()) {
    if (other.lives > 0 && other.lives < 9) other.lives++;
  }
  room.pops.push({ x: S.W / 2, y: S.H / 2, kind: 7, score: EXTEND_BONUS });
}

function spawnFruit(room, cx, cy) {
  const f = FRUITS[Math.floor(Math.random() * FRUITS.length)];
  room.fruits.push({
    id: room.nextId++,
    x: cx - 6, y: cy - 6, w: 12, h: 12,
    vx: 0, vy: -1.5,
    onGround: false,
    kind: f.kind, value: f.value, life: 0,
    arm: 22 // 터진 자리에서 곧바로 먹히지 않도록 잠깐 대기 (튀어오르는 게 보이게)
  });
}

function killPlayer(room, p) {
  p.lives--;
  p.respawn = RESPAWN_DELAY;
  p.invuln = INVULN_TIME;
  room.pops.push({ x: p.x + p.w / 2, y: p.y + p.h / 2, kind: 4 });
  p.vx = 0; p.vy = 0;
}

// ---------------------------------------------------------------- 스냅샷

function snapshot(room) {
  const players = [];
  for (const p of room.players.values()) {
    players.push({
      i: p.id, n: p.name, c: p.color,
      x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10,
      f: p.facing, g: p.onGround ? 1 : 0,
      s: p.score, l: p.lives,
      v: p.invuln > 0 ? 1 : 0,
      d: p.respawn > 0 ? 1 : 0,
      m: Math.abs(p.vx) > 0.1 ? 1 : 0
    });
  }
  return {
    t: 's',
    k: room.tick,
    lv: room.level,
    ph: room.phase,
    msg: room.message,
    combo: room.combo,
    p: players,
    hs: highScore,
    b: room.bubbles.map((b) => ({
      i: b.id, x: Math.round(b.x * 10) / 10, y: Math.round(b.y * 10) / 10,
      e: b.enemy === null ? -1 : b.enemy, ph: b.phase, o: b.owner,
      w: b.enemy !== null && b.trapTimer < 90 ? 1 : 0
    })),
    e: room.enemies.map((e) => ({
      i: e.id, x: Math.round(e.x * 10) / 10, y: Math.round(e.y * 10) / 10,
      d: e.dir, t: e.type, a: e.angry
    })),
    f: room.fruits.map((f) => ({ i: f.id, x: Math.round(f.x), y: Math.round(f.y), k: f.kind })),
    lt: room.letters.map((l) => ({ i: l.id, x: Math.round(l.x), y: Math.round(l.y), k: l.idx })),
    ex: room.extend.map((v) => (v ? 1 : 0)),
    bs: room.boss ? {
      x: Math.round(room.boss.x * 10) / 10, y: Math.round(room.boss.y * 10) / 10,
      d: room.boss.dir, hp: room.boss.hp, mx: room.boss.maxHp, h: room.boss.hurt > 0 ? 1 : 0
    } : null,
    sh: room.shots.map((s) => ({ i: s.id, x: Math.round(s.x), y: Math.round(s.y) })),
    pop: room.pops.splice(0, room.pops.length)
  };
}

function broadcast(room, payload) {
  const text = JSON.stringify(payload);
  for (const p of room.players.values()) {
    if (p.socket.readyState === 1) p.socket.send(text);
  }
}

// ---------------------------------------------------------------- 루프

const TICK_MS = 1000 / 60;
const SNAPSHOT_EVERY = 2;   // 2틱마다 전송 = 30Hz

function startLoop() {
  let lastTime = Date.now();
  let accumulator = 0;
  let sinceBroadcast = 0;

  // 타이머를 틱 간격보다 촘촘히 돌린다. 윈도우의 타이머 해상도(약 15.6ms)가
  // 거칠어서 16.7ms 간격으로 잡으면 한 번에 2틱씩 몰려 처리되고 전송이 울컥거린다.
  setInterval(() => {
    const now = Date.now();
    accumulator += now - lastTime;
    lastTime = now;
    if (accumulator > 250) accumulator = 250; // 뒤처졌을 때 따라잡기 폭주 방지

    let steps = 0;
    while (accumulator >= TICK_MS && steps < 5) {
      accumulator -= TICK_MS;
      steps++;
      for (const room of rooms.values()) stepRoom(room);
    }
    if (steps === 0) return;

    // 진행한 틱 수로 세야 한다. room.tick 의 홀짝으로 판단하면 한 주기에 2틱이
    // 처리될 때 전송이 통째로 건너뛰어져 화면이 뚝뚝 끊긴다.
    sinceBroadcast += steps;
    if (sinceBroadcast >= SNAPSHOT_EVERY) {
      sinceBroadcast = 0;
      for (const room of rooms.values()) broadcast(room, snapshot(room));
    }
  }, Math.max(4, Math.floor(TICK_MS / 2)));
}

// ---------------------------------------------------------------- WebSocket

const wss = new WebSocketServer({ server });

wss.on('connection', (socket) => {
  let player = null;
  let room = null;

  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

    if (msg.t === 'join') {
      if (player) return;
      const wanted = String(msg.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
      if (wanted) {
        room = rooms.get(wanted);
        if (!room) { socket.send(JSON.stringify({ t: 'error', m: '그런 방이 없어요. 코드를 확인해 주세요.' })); return; }
      } else {
        room = createRoom(makeRoomCode());
      }
      if (room.players.size >= MAX_PLAYERS) {
        socket.send(JSON.stringify({ t: 'error', m: '방이 가득 찼어요 (최대 4명).' }));
        room = null; return;
      }

      player = createPlayer(room, socket, msg.name);

      socket.send(JSON.stringify({
        t: 'joined', room: room.code, id: player.id, level: room.level, color: player.color, name: player.name
      }));
      broadcast(room, { t: 'chat', m: `${player.name} 님이 입장했습니다.` });
      return;
    }

    if (!player || !room) return;

    if (msg.t === 'i') {
      player.input.left = !!msg.l;
      player.input.right = !!msg.r;
      player.input.jump = !!msg.j;
      player.input.fire = !!msg.f;
      return;
    }

    if (msg.t === 'ping') {
      socket.send(JSON.stringify({ t: 'pong', c: msg.c }));
    }
  });

  socket.on('close', () => {
    if (!player || !room) return;
    room.players.delete(player.id);
    broadcast(room, { t: 'chat', m: `${player.name} 님이 퇴장했습니다.` });
    if (room.players.size === 0) rooms.delete(room.code);
  });

  socket.on('error', () => { /* close 이벤트에서 정리된다 */ });
});

// 직접 실행할 때만 서버를 띄운다 (테스트에서는 모듈로 불러 쓴다)
if (require.main === module) {
  startLoop();
  server.listen(PORT, () => {
    console.log(`\n  🫧  보글보글 온라인 서버 실행 중`);
    console.log(`     로컬:    http://localhost:${PORT}`);
    for (const [name, addrs] of Object.entries(require('os').networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && !a.internal) console.log(`     같은 와이파이: http://${a.address}:${PORT}  (${name})`);
      }
    }
    console.log('');
  });
}

module.exports = {
  rooms, createRoom, createPlayer, loadLevel, stepRoom, snapshot,
  killPlayer, fireBubble, spawnFruit, spawnLetter, makeRoomCode,
  makeBoss, damageBoss, BOSS_MAX_HP, EXTEND_BONUS
};
