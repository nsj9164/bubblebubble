/*
 * shared.js — 서버와 클라이언트가 함께 쓰는 게임 상수/맵/물리 코드.
 * 같은 물리를 양쪽에서 돌려야 클라이언트 예측(prediction)이 서버와 어긋나지 않는다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Shared = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TILE = 16;
  var COLS = 32;
  var ROWS = 25;
  var W = COLS * TILE; // 512
  var H = ROWS * TILE; // 400

  // 물리 상수
  var GRAVITY = 0.42;
  var MAXFALL = 7.0;
  var MOVE = 1.75;
  var JUMP = -7.6;

  var PW = 12, PH = 14;   // 플레이어 히트박스
  var EW = 13, EH = 14;   // 적 히트박스
  var BR = 8;             // 버블 반지름

  // '#' 통과 불가, '=' 아래에서 뚫고 올라갈 수 있는 발판, 'P' 플레이어 시작점, 'E' 적 시작점
  var LEVELS = [
    [
      '################################',
      '#..............................#',
      '#....E..................E......#',
      '#..========..........========..#',
      '#..............................#',
      '#..............................#',
      '#........==============........#',
      '#..............................#',
      '#.....E................E.......#',
      '#..========..........========..#',
      '#..............................#',
      '#..............................#',
      '#========..............========#',
      '#..............................#',
      '#..............E...............#',
      '#........==============........#',
      '#..............................#',
      '#..............................#',
      '#..========..........========..#',
      '#..............................#',
      '#..P........................P..#',
      '#============......============#',
      '#..............................#',
      '#..............................#',
      '################################'
    ],
    [
      '################################',
      '#..E...........................#',
      '#=========.....................#',
      '#..............................#',
      '#.......E......................#',
      '#.....=========................#',
      '#..............................#',
      '#.............E................#',
      '#...........=========..........#',
      '#..............................#',
      '#...................E..........#',
      '#.................=========....#',
      '#..............................#',
      '#.........................E....#',
      '#.......................========',
      '#..............................#',
      '#..............................#',
      '#.................========.....#',
      '#..............................#',
      '#........========..............#',
      '#..............................#',
      '#..======......................#',
      '#..............................#',
      '#..P........................P..#',
      '################################'
    ],
    [
      '################################',
      '#..............................#',
      '#...E.......E.......E..........#',
      '#..=====..=====..=====..=====..#',
      '#..............................#',
      '#..............................#',
      '#..............................#',
      '#.....E.......E.......E........#',
      '#=====..=====..=====..=====....#',
      '#..............................#',
      '#..............................#',
      '#..............................#',
      '#..E................E..........#',
      '#..=====..=====..=====..=====..#',
      '#..............................#',
      '#..............................#',
      '#..............................#',
      '#..............................#',
      '#=========......======..=======#',
      '#..............................#',
      '#..............................#',
      '#..P........................P..#',
      '#..............................#',
      '#..............................#',
      '################################'
    ],
    [
      '################################',
      '#..............................#',
      '#........E..........E..........#',
      '#.....====================.....#',
      '#..............................#',
      '#..............................#',
      '#..E........................E..#',
      '#=======..............=========#',
      '#..............................#',
      '#..............................#',
      '#.............E................#',
      '#.......==============.........#',
      '#..............................#',
      '#..............................#',
      '#....E....................E....#',
      '#..======..............======..#',
      '#..............................#',
      '#..............................#',
      '#..............................#',
      '#.......================.......#',
      '#..............................#',
      '#..P........................P..#',
      '#..............................#',
      '#..............................#',
      '################################'
    ]
  ];

  // 손으로 그린 맵의 길이가 어긋나도 안전하도록 정규화한다.
  function parseLevel(index) {
    var raw = LEVELS[((index % LEVELS.length) + LEVELS.length) % LEVELS.length];
    var rows = [];
    var playerSpawns = [];
    var enemySpawns = [];

    for (var r = 0; r < ROWS; r++) {
      var line = raw[r] || '';
      var chars = [];
      for (var c = 0; c < COLS; c++) {
        var ch = line[c] || '.';
        if (ch === 'P') {
          playerSpawns.push({ x: c * TILE + (TILE - PW) / 2, y: r * TILE + (TILE - PH) });
          ch = '.';
        } else if (ch === 'E') {
          enemySpawns.push({ x: c * TILE + (TILE - EW) / 2, y: r * TILE + (TILE - EH) });
          ch = '.';
        } else if (ch !== '#' && ch !== '=') {
          ch = '.';
        }
        chars.push(ch);
      }
      // 바깥 테두리는 항상 벽으로 강제
      chars[0] = '#';
      chars[COLS - 1] = '#';
      if (r === 0 || r === ROWS - 1) {
        for (var k = 0; k < COLS; k++) chars[k] = '#';
      }
      rows.push(chars.join(''));
    }

    if (!playerSpawns.length) playerSpawns.push({ x: W / 2 - PW / 2, y: H - TILE - PH });
    return { rows: rows, playerSpawns: playerSpawns, enemySpawns: enemySpawns };
  }

  function isSolid(map, c, r) {
    if (c < 0 || c >= COLS) return true;
    if (r < 0) return false;      // 천장 위쪽은 열려 있음(버블이 모이는 공간)
    if (r >= ROWS) return true;
    return map[r][c] === '#';
  }

  function isOneWay(map, c, r) {
    if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return false;
    return map[r][c] === '=';
  }

  function moveX(o, map) {
    o.x += o.vx;
    o.hitWall = false;
    var r0 = Math.floor(o.y / TILE);
    var r1 = Math.floor((o.y + o.h - 1) / TILE);
    var r;
    if (o.vx > 0) {
      var cr = Math.floor((o.x + o.w - 1) / TILE);
      for (r = r0; r <= r1; r++) {
        if (isSolid(map, cr, r)) { o.x = cr * TILE - o.w; o.vx = 0; o.hitWall = true; break; }
      }
    } else if (o.vx < 0) {
      var cl = Math.floor(o.x / TILE);
      for (r = r0; r <= r1; r++) {
        if (isSolid(map, cl, r)) { o.x = (cl + 1) * TILE; o.vx = 0; o.hitWall = true; break; }
      }
    }
  }

  function moveY(o, map, allowOneWay) {
    var prevBottom = o.y + o.h;
    o.y += o.vy;
    o.onGround = false;
    var c0 = Math.floor(o.x / TILE);
    var c1 = Math.floor((o.x + o.w - 1) / TILE);
    var c;
    if (o.vy > 0) {
      // 발밑이 '닿는' 타일을 봐야 한다. -1을 빼면 발판 위에 정확히 서 있을 때
      // 한 프레임 걸러 한 번씩 착지 판정이 풀려서 점프가 씹힌다.
      var rb = Math.floor((o.y + o.h) / TILE);
      for (c = c0; c <= c1; c++) {
        var landOnPlatform = allowOneWay && isOneWay(map, c, rb) && prevBottom <= rb * TILE + 1;
        if (isSolid(map, c, rb) || landOnPlatform) {
          o.y = rb * TILE - o.h; o.vy = 0; o.onGround = true; break;
        }
      }
    } else if (o.vy < 0) {
      var rt = Math.floor(o.y / TILE);
      for (c = c0; c <= c1; c++) {
        if (isSolid(map, c, rt)) { o.y = (rt + 1) * TILE; o.vy = 0; break; }
      }
    }
  }

  // 플레이어 1틱 진행. 서버와 클라이언트 예측이 동일하게 호출한다.
  function stepPlayer(p, input, map, bubbles) {
    if (input.left && !input.right) { p.vx = -MOVE; p.facing = -1; }
    else if (input.right && !input.left) { p.vx = MOVE; p.facing = 1; }
    else p.vx = 0;

    // 온라인 지연에도 조작이 답답하지 않도록 코요테 타임 + 점프 선입력을 둔다
    p.coyote = p.onGround ? 6 : Math.max(0, (p.coyote || 0) - 1);
    p.jumpBuffer = (input.jump && !p.jumpHeld) ? 6 : Math.max(0, (p.jumpBuffer || 0) - 1);
    if (p.jumpBuffer > 0 && p.coyote > 0) {
      p.vy = JUMP;
      p.jumpBuffer = 0;
      p.coyote = 0;
      p.onGround = false;
    }
    // 점프 버튼을 일찍 떼면 낮게 뛴다
    if (!input.jump && p.vy < -2.2) p.vy = -2.2;
    p.jumpHeld = !!input.jump;

    p.vy += GRAVITY;
    if (p.vy > MAXFALL) p.vy = MAXFALL;

    moveX(p, map);
    var prevBottom = p.y + p.h;
    moveY(p, map, true);

    // 버블 위에 올라타기 (떨어지는 중에 버블 윗면을 밟았을 때만)
    p.ridingId = 0;
    // 버블에 올라타면 vy가 음수(-0.6)가 되므로 vy>=0 으로 검사하면 다음 프레임에
    // 곧바로 라이딩이 풀리고 발밑의 버블이 터진다. 점프로 크게 튀어오를 때만 떨어지도록.
    if (!p.onGround && p.vy > -2.5 && bubbles) {
      for (var i = 0; i < bubbles.length; i++) {
        var b = bubbles[i];
        if (b.phase === 0) continue; // 발사 중인 버블은 못 탐
        if (p.x + p.w < b.x - BR || p.x > b.x + BR) continue;
        var top = b.y - BR;
        if (prevBottom <= top + 5 && p.y + p.h >= top) {
          p.y = top - p.h;
          p.vy = -0.6;      // 버블이 떠오르는 만큼 같이 올라간다
          p.onGround = true;
          p.ridingId = b.id;
          break;
        }
      }
    }

    if (p.x < TILE) p.x = TILE;
    if (p.x + p.w > W - TILE) p.x = W - TILE - p.w;
  }

  function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }

  return {
    TILE: TILE, COLS: COLS, ROWS: ROWS, W: W, H: H,
    GRAVITY: GRAVITY, MAXFALL: MAXFALL, MOVE: MOVE, JUMP: JUMP,
    PW: PW, PH: PH, EW: EW, EH: EH, BR: BR,
    LEVELS: LEVELS,
    parseLevel: parseLevel,
    isSolid: isSolid, isOneWay: isOneWay,
    moveX: moveX, moveY: moveY,
    stepPlayer: stepPlayer,
    rectsOverlap: rectsOverlap
  };
});
