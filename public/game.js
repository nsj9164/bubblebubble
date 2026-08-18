/*
 * game.js — 클라이언트: 접속 / 입력 / 로컬 예측 / 렌더링
 */
(function () {
  'use strict';

  var S = window.Shared;
  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  var lobby = document.getElementById('lobby');
  var errEl = document.getElementById('err');
  var nickEl = document.getElementById('nick');
  var codeEl = document.getElementById('code');
  var roomTag = document.getElementById('roomTag');
  var pingTag = document.getElementById('pingTag');
  var toastEl = document.getElementById('toast');

  var SP = window.Sprites;
  var HUD_H = 40;                    // 캔버스 위쪽 아케이드 점수판 높이
  var VIEW_H = S.H + HUD_H;

  // ---------------------------------------------------------------- 상태

  var ws = null;
  var myId = 0;
  var roomCode = '';
  var level = 0;
  var map = S.parseLevel(0).rows;
  var phase = 'play';
  var message = '';

  var input = { left: false, right: false, jump: false, fire: false };
  var lastSentInput = '';

  // 서버 스냅샷 (최신)
  var srv = { p: [], b: [], e: [], f: [], lt: [], sh: [], ex: [], bs: null };
  // 화면 표시용 보간 위치: id -> {x, y}
  var view = {};
  // 내 캐릭터의 로컬 예측 상태
  var me = null;

  var particles = [];
  var floaters = [];

  // ---------------------------------------------------------------- 도트 스프라이트

  // 픽셀을 매 프레임 찍으면 느리다. 팔레트/방향별로 한 번만 그려서 캐시해 둔다.
  var spriteCache = {};
  function bakeSprite(key, rows, palette, flip) {
    var id = key + (flip ? '|L' : '|R');
    if (spriteCache[id]) return spriteCache[id];
    var size = rows.length;
    var cv = document.createElement('canvas');
    cv.width = size; cv.height = size;
    var c = cv.getContext('2d');
    for (var r = 0; r < size; r++) {
      var line = flip ? rows[r].split('').reverse().join('') : rows[r];
      for (var x = 0; x < line.length; x++) {
        var col = palette[line[x]];
        if (!col) continue;
        c.fillStyle = col;
        c.fillRect(x, r, 1, 1);
      }
    }
    spriteCache[id] = cv;
    return cv;
  }

  function drawSprite(cv, cx, bottom) {   // 발끝(bottom) 기준으로 가운데 정렬
    ctx.drawImage(cv, Math.round(cx - cv.width / 2), Math.round(bottom - cv.height));
  }

  // ---------------------------------------------------------------- 비트맵 글씨

  function drawText(text, x, y, color, scale) {
    scale = scale || 1;
    ctx.fillStyle = color;
    var cx = x;
    for (var i = 0; i < text.length; i++) {
      var g = SP.FONT[text.charAt(i).toUpperCase()];
      if (g) {
        var rows = g.split('/');
        for (var r = 0; r < 7; r++) {
          for (var c = 0; c < 5; c++) {
            if (rows[r].charAt(c) === '1') ctx.fillRect(cx + c * scale, y + r * scale, scale, scale);
          }
        }
      }
      cx += 6 * scale;
    }
    return cx;
  }
  function textW(text, scale) { return text.length * 6 * (scale || 1) - (scale || 1); }
  function pad(n, len) {
    var s = String(n);
    while (s.length < len) s = '0' + s;
    return s;
  }

  // ---------------------------------------------------------------- 사운드

  var actx = null;
  function audio() {
    if (!actx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) actx = new AC();
    }
    if (actx && actx.state === 'suspended') actx.resume();
    return actx;
  }
  function blip(freq, dur, type, vol, slideTo) {
    var a = audio(); if (!a) return;
    var o = a.createOscillator(), g = a.createGain();
    o.type = type || 'square';
    o.frequency.setValueAtTime(freq, a.currentTime);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, a.currentTime + dur);
    g.gain.setValueAtTime(vol || 0.05, a.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
    o.connect(g); g.connect(a.destination);
    o.start(); o.stop(a.currentTime + dur + 0.02);
  }
  var SFX = {
    jump: function () { blip(340, 0.12, 'square', 0.04, 720); },
    fire: function () { blip(880, 0.09, 'sine', 0.05, 320); },
    pop: function () { blip(520, 0.08, 'square', 0.05, 180); },
    kill: function () { blip(300, 0.18, 'sawtooth', 0.05, 900); },
    fruit: function () { blip(660, 0.1, 'triangle', 0.06, 1320); },
    die: function () { blip(400, 0.5, 'sawtooth', 0.06, 60); },
    clear: function () { [523, 659, 784, 1046].forEach(function (f, i) { setTimeout(function () { blip(f, 0.16, 'square', 0.05); }, i * 110); }); },
    letter: function () { blip(880, 0.14, 'triangle', 0.06, 1760); },
    extend: function () {
      [523, 659, 784, 1046, 1318].forEach(function (f, i) {
        setTimeout(function () { blip(f, 0.22, 'triangle', 0.07); }, i * 90);
      });
    },
    bossDown: function () {
      [220, 165, 110].forEach(function (f, i) {
        setTimeout(function () { blip(f, 0.5, 'sawtooth', 0.07, f / 3); }, i * 130);
      });
    }
  };

  // ---------------------------------------------------------------- 접속

  function connect(code, name) {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host);

    ws.onopen = function () {
      ws.send(JSON.stringify({ t: 'join', room: code, name: name }));
    };

    ws.onmessage = function (ev) {
      var m = JSON.parse(ev.data);
      if (m.t === 'joined') {
        myId = m.id;
        roomCode = m.room;
        level = m.level;
        map = S.parseLevel(level).rows;
        lobby.style.display = 'none';
        roomTag.innerHTML = '방 코드 <b>' + roomCode + '</b> · 클릭하면 초대링크 복사';
        history.replaceState(null, '', '#' + roomCode);
        localStorage.setItem('bb_nick', name);
        audio();
        toast('방 코드 ' + roomCode + ' 를 친구에게 알려주세요!');
      } else if (m.t === 'error') {
        errEl.textContent = m.m;
        try { ws.close(); } catch (e) {}
      } else if (m.t === 'chat') {
        toast(m.m);
      } else if (m.t === 'pong') {
        pingTag.textContent = Math.max(0, Math.round(performance.now() - m.c)) + ' ms';
      } else if (m.t === 's') {
        onSnapshot(m);
      }
    };

    ws.onclose = function () {
      if (!lobby.style.display || lobby.style.display === 'none') {
        lobby.style.display = 'flex';
        errEl.textContent = '서버와의 연결이 끊어졌습니다. 다시 접속해 주세요.';
      }
    };
    ws.onerror = function () { errEl.textContent = '서버에 연결할 수 없습니다.'; };
  }

  function onSnapshot(m) {
    if (m.lv !== level) {
      level = m.lv;
      map = S.parseLevel(level).rows;
      renderMapCanvas();
    }
    if (phase !== m.ph && m.ph === 'clear') SFX.clear();
    phase = m.ph;
    message = m.msg;
    // 예측용 물리 코드가 기대하는 필드명으로 맞춰준다
    for (var bi = 0; bi < m.b.length; bi++) { m.b[bi].phase = m.b[bi].ph; m.b[bi].id = m.b[bi].i; }
    srv = m;

    // 내 캐릭터 서버 보정
    var sp = null;
    for (var i = 0; i < m.p.length; i++) if (m.p[i].i === myId) sp = m.p[i];
    if (sp) {
      if (!me) {
        me = { x: sp.x, y: sp.y, vx: 0, vy: 0, w: S.PW, h: S.PH, facing: sp.f, onGround: false, jumpHeld: false, ridingId: 0 };
      } else if (sp.d) {
        // 사망/리스폰 중에는 서버 위치를 그대로 따른다
        me.x = sp.x; me.y = sp.y; me.vx = 0; me.vy = 0;
      } else {
        var dx = sp.x - me.x, dy = sp.y - me.y;
        if (Math.abs(dy) > S.H / 2) {
          // 바닥 구멍으로 빠져 천장으로 나오는 중. 한쪽만 넘어간 상태라 보정하면 안 된다.
        } else if (Math.abs(dx) > 64 || Math.abs(dy) > 64) {
          me.x = sp.x; me.y = sp.y; me.vy = 0;   // 완전히 어긋났을 때만 서버 위치로 즉시 보정
        } else {
          // 지연 때문에 생기는 몇 픽셀 차이까지 매번 당기면 달릴 때 고무줄처럼 흔들린다
          if (Math.abs(dx) > 6) me.x += dx * 0.15;
          // 점프 중에는 서버가 나보다 지연만큼 늦게 뛰므로 y가 크게 벌어지는 게 정상이다.
          // 여기서 y를 당기면 뛰다가 땅으로 끌려갔다 다시 솟는 것처럼 보인다.
          // 양쪽 다 땅을 밟고 있을 때만 y를 맞춘다. (착지하면 어차피 같은 발판이라 오차가 사라진다)
          if (me.onGround && sp.g && Math.abs(dy) > 4) me.y += dy * 0.25;
        }
      }
    }

    // 이펙트
    for (var j = 0; j < (m.pop || []).length; j++) {
      var e = m.pop[j];
      spawnBurst(e.x, e.y, e.kind);
      if (e.score) floaters.push({ x: e.x, y: e.y, text: '+' + e.score, life: 60 });
      if (e.kind === 2) SFX.kill();
      else if (e.kind === 3) SFX.fruit();
      else if (e.kind === 4) SFX.die();
      else if (e.kind === 5) SFX.bossDown();
      else if (e.kind === 6) SFX.letter();
      else if (e.kind === 7) { SFX.extend(); toast('EXTEND 완성! 모두 1UP 🎉'); }
      else SFX.pop();
    }

  }

  var toastTimer = null;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.style.opacity = '0'; }, 3000);
  }

  // ---------------------------------------------------------------- 입력

  var KEYMAP = {
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
    ArrowUp: 'jump', KeyW: 'jump', Space: 'jump',
    KeyZ: 'fire', KeyX: 'fire', ShiftLeft: 'fire', ControlLeft: 'fire', Enter: 'fire'
  };

  window.addEventListener('keydown', function (ev) {
    if (lobby.style.display !== 'none') {
      if (ev.code === 'Enter') doJoin(codeEl.value.trim() ? codeEl.value : '');
      return;
    }
    var k = KEYMAP[ev.code];
    if (!k) return;
    ev.preventDefault();
    // 점프 소리는 실제로 뛰었을 때만 낸다 (공중에서 눌렀는데 소리만 나면 뛴 줄 안다)
    if (!input[k] && k === 'fire') SFX.fire();
    input[k] = true;
  });

  window.addEventListener('keyup', function (ev) {
    var k = KEYMAP[ev.code];
    if (!k) return;
    ev.preventDefault();
    input[k] = false;
  });

  window.addEventListener('blur', function () {
    input.left = input.right = input.jump = input.fire = false;
  });

  // 모바일 터치 버튼
  if ('ontouchstart' in window) {
    document.body.classList.add('touch');
    var btns = document.querySelectorAll('#touch button');
    Array.prototype.forEach.call(btns, function (b) {
      var k = b.getAttribute('data-k');
      var on = function (ev) { ev.preventDefault(); input[k] = true; audio(); };
      var off = function (ev) { ev.preventDefault(); input[k] = false; };
      b.addEventListener('touchstart', on, { passive: false });
      b.addEventListener('touchend', off, { passive: false });
      b.addEventListener('touchcancel', off, { passive: false });
    });
  }

  function sendInput() {
    if (!ws || ws.readyState !== 1) return;
    var packed = (input.left ? 1 : 0) + '' + (input.right ? 1 : 0) + (input.jump ? 1 : 0) + (input.fire ? 1 : 0);
    if (packed === lastSentInput) return;
    lastSentInput = packed;
    ws.send(JSON.stringify({ t: 'i', l: input.left, r: input.right, j: input.jump, f: input.fire }));
  }
  setInterval(function () { lastSentInput = ''; sendInput(); }, 200); // 유실 대비 주기적 재전송
  setInterval(function () {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'ping', c: performance.now() }));
  }, 2000);

  // ---------------------------------------------------------------- 로비

  document.getElementById('createBtn').onclick = function () { doJoin(''); };
  document.getElementById('joinBtn').onclick = function () { doJoin(codeEl.value); };
  roomTag.onclick = function () {
    if (!roomCode) return;
    var url = location.origin + location.pathname + '#' + roomCode;
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { toast('초대 링크를 복사했어요: ' + url); });
    else toast(url);
  };

  function doJoin(code) {
    var name = nickEl.value.trim();
    errEl.textContent = '';
    if (ws && ws.readyState <= 1) { try { ws.close(); } catch (e) {} }
    connect(String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''), name);
  }

  nickEl.value = localStorage.getItem('bb_nick') || '';
  if (location.hash.length > 1) {
    codeEl.value = location.hash.slice(1).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  }

  // ---------------------------------------------------------------- 이펙트

  function spawnBurst(x, y, kind) {
    var colors = ['#bfe9ff', '#ff9de0', '#ffd75f', '#8fffa8', '#ff6b8f'];
    var n = kind === 4 ? 20 : (kind === 5 ? 44 : (kind === 7 ? 56 : (kind === 6 ? 18 : 12)));
    for (var i = 0; i < n; i++) {
      var a = (Math.PI * 2 * i) / n + Math.random() * 0.4;
      var sp = 1 + Math.random() * 2.2;
      particles.push({
        x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 0.5,
        life: 24 + Math.random() * 18, max: 42,
        c: colors[kind === 4 ? 4 : (i % 4)]
      });
    }
  }

  function stepEffects() {
    for (var i = particles.length - 1; i >= 0; i--) {
      var p = particles[i];
      p.x += p.vx; p.y += p.vy; p.vy += 0.12; p.vx *= 0.97;
      if (--p.life <= 0) particles.splice(i, 1);
    }
    for (var j = floaters.length - 1; j >= 0; j--) {
      floaters[j].y -= 0.5;
      if (--floaters[j].life <= 0) floaters.splice(j, 1);
    }
  }

  // ---------------------------------------------------------------- 보간

  function lerpView(id, tx, ty) {
    var v = view[id];
    if (!v) { v = view[id] = { x: tx, y: ty, seen: 0 }; }
    var dx = tx - v.x, dy = ty - v.y;
    if (Math.abs(dx) > 40 || Math.abs(dy) > 40) { v.x = tx; v.y = ty; }
    else { v.x += dx * 0.4; v.y += dy * 0.4; }
    v.seen = frame;
    return v;
  }

  // ---------------------------------------------------------------- 렌더

  // 스테이지별 블록 스타일. brick 은 입체 벽돌, stripe 는 대각 줄무늬(원작 핑크 판).
  var TILE_STYLES = [
    { kind: 'brick',  base: '#3f3a8c', light: '#8f86ff', dark: '#201c52', seam: '#2a2668' },
    { kind: 'stripe', base: '#8c1f5a', light: '#ff7fc0', dark: '#5a0f38', seam: '#ff9fd0' },
    { kind: 'brick',  base: '#1f6b5a', light: '#6fe0c0', dark: '#0e3a30', seam: '#164f43' },
    { kind: 'brick',  base: '#7a4a10', light: '#ffc46b', dark: '#4a2a06', seam: '#5e380c' },
    { kind: 'brick',  base: '#7a1030', light: '#ff5f8f', dark: '#4a0618', seam: '#5e0a22' }
  ];
  function style() { return TILE_STYLES[level % TILE_STYLES.length]; }

  // 16x16 타일을 한 번만 그려서 캐시한다
  var tileCache = {};
  function makeTile(styleIndex, kind) {
    var id = styleIndex + '|' + kind;
    if (tileCache[id]) return tileCache[id];
    var st = TILE_STYLES[styleIndex];
    var T = S.TILE;
    var cv = document.createElement('canvas');
    cv.width = T; cv.height = T;
    var c = cv.getContext('2d');

    if (st.kind === 'stripe') {
      c.fillStyle = st.base;
      c.fillRect(0, 0, T, T);
      c.fillStyle = st.light;
      for (var y = 0; y < T; y++) {
        for (var x = 0; x < T; x++) {
          if (((x + y) % 8) < 4) c.fillRect(x, y, 1, 1);
        }
      }
      c.fillStyle = st.dark;
      c.fillRect(0, T - 2, T, 2);
      c.fillRect(0, 0, T, 1);
    } else {
      c.fillStyle = st.base;
      c.fillRect(0, 0, T, T);
      // 벽돌 이음새
      c.fillStyle = st.seam;
      c.fillRect(0, 7, T, 2);
      c.fillRect(3, 0, 2, 7);
      c.fillRect(11, 9, 2, 7);
      // 입체감
      c.fillStyle = st.light;
      c.fillRect(0, 0, T, 2);
      c.fillRect(0, 0, 2, T);
      c.fillRect(0, 9, T, 2);
      c.fillStyle = st.dark;
      c.fillRect(0, T - 2, T, 2);
      c.fillRect(T - 2, 0, 2, T);
    }

    if (kind === 'plat') {   // 발판은 윗면을 밝게 해서 밟는 자리가 또렷하게 보이게
      c.fillStyle = st.light;
      c.fillRect(0, 0, T, 3);
    }
    tileCache[id] = cv;
    return cv;
  }

  // 맵은 움직이지 않으므로 스테이지가 바뀔 때 한 장으로 미리 그려 둔다
  var mapCanvas = document.createElement('canvas');
  mapCanvas.width = S.W; mapCanvas.height = S.H;
  function renderMapCanvas() {
    var mc = mapCanvas.getContext('2d');
    var si = level % TILE_STYLES.length;
    mc.clearRect(0, 0, S.W, S.H);
    for (var r = 0; r < S.ROWS; r++) {
      for (var c = 0; c < S.COLS; c++) {
        var ch = map[r][c];
        if (ch === '#') mc.drawImage(makeTile(si, 'wall'), c * S.TILE, r * S.TILE);
        else if (ch === '=') mc.drawImage(makeTile(si, 'plat'), c * S.TILE, r * S.TILE);
      }
    }
  }

  // 버블은 쏜 사람 색으로 물든다 (원작에서 법과 밥의 버블 색이 다르다)
  function bubbleColor(ownerId) {
    for (var i = 0; i < srv.p.length; i++) if (srv.p[i].i === ownerId) return srv.p[i].c;
    return '#8fe0ff';
  }

  function rgba(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  function drawBubble(x, y, enemyType, warning, ownerId) {
    var r = S.BR;
    var pulse = Math.sin(frame * 0.12 + x * 0.1) * 0.6;
    var col = enemyType >= 0 ? '#ff8fd0' : bubbleColor(ownerId);

    ctx.fillStyle = rgba(col, 0.28);
    ctx.beginPath(); ctx.arc(x, y, r + pulse, 0, Math.PI * 2); ctx.fill();

    if (enemyType >= 0) {
      var sp = SP.ENEMY_SPRITES[enemyType % SP.ENEMY_SPRITES.length];
      var pal = SP.ENEMY_PALETTES[SP.ENEMY_KEYS[enemyType % SP.ENEMY_KEYS.length]];
      var baked = bakeSprite('e' + enemyType, sp, pal, false);
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.drawImage(baked, 0, 0, baked.width, baked.height,
        Math.round(x - 6), Math.round(y - 6), 12, 12);
      ctx.restore();
    }

    ctx.strokeStyle = warning && (frame >> 2) % 2 === 0 ? '#ffffff' : col;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, r + pulse, 0, Math.PI * 2); ctx.stroke();

    // 반짝임
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(Math.round(x - r * 0.45), Math.round(y - r * 0.55), 2, 2);
  }

  function drawEnemy(cx, bottom, type, dir, angry) {
    var idx = type % SP.ENEMY_SPRITES.length;
    var pal = angry ? SP.ANGRY_PALETTE : SP.ENEMY_PALETTES[SP.ENEMY_KEYS[idx]];
    var key = 'enemy' + idx + (angry ? 'A' : '');
    drawSprite(bakeSprite(key, SP.ENEMY_SPRITES[idx], pal, dir < 0), cx, bottom);
  }

  // 플레이어 색마다 밝은/어두운 톤을 만들어 등껍질 음영에 쓴다
  function shade(hex, amount) {
    var n = parseInt(hex.slice(1), 16);
    var r = Math.max(0, Math.min(255, ((n >> 16) & 255) + amount));
    var g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amount));
    var b = Math.max(0, Math.min(255, (n & 255) + amount));
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }

  function drawPlayer(cx, bottom, color, facing, moving, ghost, name, isMe) {
    ctx.save();
    if (ghost && (frame >> 2) % 2 === 0) ctx.globalAlpha = 0.4;
    var bob = moving ? Math.sin(frame * 0.3) : 0;
    var pal = SP.playerPalette(color, shade(color, 70), shade(color, -80));
    drawSprite(bakeSprite('bub' + color, SP.BUB, pal, facing < 0), cx, bottom + bob);
    ctx.restore();

    if (name) {
      var w = textW(name, 1);
      drawText(name, Math.round(cx - w / 2), Math.round(bottom - 24), isMe ? '#ffffff' : 'rgba(255,255,255,0.65)', 1);
    }
  }

  function drawFruit(x, y, kind) {
    var idx = kind % SP.FRUITS.length;
    var baked = bakeSprite('fruit' + idx, SP.FRUITS[idx], SP.FRUIT_PALETTE, false);
    ctx.drawImage(baked, Math.round(x), Math.round(y));
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  var LETTER_COLORS = ['#ff6b8f', '#ffd75f', '#8fe08f', '#5fc8ff', '#ff9de0', '#c9a0ff'];
  function drawLetter(x, y, idx) {
    var ch = S.EXTEND.charAt(idx) || '?';
    var col = LETTER_COLORS[idx % LETTER_COLORS.length];
    var bob = Math.sin(frame * 0.12 + idx) * 1.2;
    y += bob;
    // 반짝이는 거품에 담긴 글자
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.beginPath(); ctx.arc(x + 7, y + 7, 9, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x + 7, y + 7, 9, 0, Math.PI * 2); ctx.stroke();
    drawText(ch, Math.round(x + 4), Math.round(y + 3), col, 1);
  }

  function drawShot(x, y) {
    var r = S.SHOT_R + Math.sin(frame * 0.4 + x) * 0.8;
    var g = ctx.createRadialGradient(x, y, 0, x, y, r * 2);
    g.addColorStop(0, '#fff2a8');
    g.addColorStop(0.45, '#ff9a3c');
    g.addColorStop(1, 'rgba(255,60,20,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r * 2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff6cf';
    ctx.beginPath(); ctx.arc(x, y, r * 0.5, 0, Math.PI * 2); ctx.fill();
  }

  function drawBoss(x, y, dir, hurt) {
    var w = S.BOSS_W, h = S.BOSS_H;
    var body = hurt && (frame >> 1) % 2 === 0 ? '#ffffff' : '#b23a6b';
    var dark = hurt && (frame >> 1) % 2 === 0 ? '#ffd7e6' : '#6d1f42';

    // 그림자
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.ellipse(x + w / 2, y + h, w / 2, 3, 0, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = dark;
    roundRect(x, y + 4, w, h - 4, 6); ctx.fill();
    ctx.fillStyle = body;
    roundRect(x + 2, y + 2, w - 4, h - 6, 6); ctx.fill();

    // 뿔
    ctx.fillStyle = '#ffd75f';
    ctx.beginPath();
    ctx.moveTo(x + 5, y + 3); ctx.lineTo(x + 9, y - 5); ctx.lineTo(x + 12, y + 3); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + w - 12, y + 3); ctx.lineTo(x + w - 9, y - 5); ctx.lineTo(x + w - 5, y + 3); ctx.fill();

    // 눈 (노려보는 방향)
    var ox = dir > 0 ? 3 : -3;
    ctx.fillStyle = '#fff';
    ctx.fillRect(x + 6 + ox, y + 8, 7, 6);
    ctx.fillRect(x + w - 13 + ox, y + 8, 7, 6);
    ctx.fillStyle = '#231018';
    ctx.fillRect(x + 8 + ox, y + 10, 4, 4);
    ctx.fillRect(x + w - 11 + ox, y + 10, 4, 4);

    // 이빨
    ctx.fillStyle = '#fff';
    for (var i = 0; i < 4; i++) ctx.fillRect(x + 7 + i * 5, y + h - 8, 3, 4);
  }

  function drawBossHealth(bs) {
    var barW = 220, barH = 8;
    var x = (S.W - barW) / 2, y = 20;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x - 3, y - 3, barW + 6, barH + 6);
    ctx.fillStyle = '#3a2d4a';
    ctx.fillRect(x, y, barW, barH);
    var ratio = Math.max(0, bs.hp / bs.mx);
    ctx.fillStyle = ratio > 0.5 ? '#5fe07a' : (ratio > 0.25 ? '#ffd75f' : '#ff5f7a');
    ctx.fillRect(x, y, barW * ratio, barH);
    drawText('BOSS', Math.round(S.W / 2 - textW('BOSS', 1) / 2), y - 11, '#ffd7e6', 1);
  }

  function drawOverlayText() {
    if (!message) return;
    var y = Math.round(S.H / 2) - 20;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(0, y - 10, S.W, 46);
    drawText(message, Math.round((S.W - textW(message, 3)) / 2), y, phase === 'over' ? '#ff6b8f' : '#ffd75f', 3);
    var sub = phase === 'over' ? 'TRY AGAIN' : 'GET READY';
    drawText(sub, Math.round((S.W - textW(sub, 1)) / 2), y + 26, '#ffffff', 1);
  }

  // 왼쪽 벽에 세로로 세우는 EXTEND (원작과 같은 자리)
  function drawExtendColumn() {
    var top = 96;
    // 글자가 벽 무늬에 묻히지 않도록 검은 띠를 깔고 그린다
    ctx.fillStyle = '#000000';
    ctx.fillRect(1, top - 6, 14, S.EXTEND.length * 26 + 4);
    for (var i = 0; i < S.EXTEND.length; i++) {
      var lit = srv.ex && srv.ex[i];
      var col = lit ? LETTER_COLORS[i % LETTER_COLORS.length] : '#4a4480';
      drawText(S.EXTEND.charAt(i), 3, top + i * 26, col, 2);
    }
  }

  // 아케이드 점수판 (1UP / HIGH SCORE / 2UP)
  function drawHud() {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, S.W, HUD_H);

    var players = srv.p || [];
    var slots = [
      { label: '1UP', color: '#4ae0ff', x: 12, align: 'left' },
      { label: 'HIGH SCORE', color: '#ff4f6b', x: S.W / 2, align: 'center' },
      { label: '2UP', color: '#4ae0ff', x: S.W - 12, align: 'right' }
    ];
    var values = [
      players[0] ? pad(players[0].s, 6) : '',
      pad(srv.hs || 0, 6),
      players[1] ? pad(players[1].s, 6) : ''
    ];

    for (var i = 0; i < slots.length; i++) {
      var s = slots[i];
      if (!values[i]) continue;
      var lw = textW(s.label, 1), vw = textW(values[i], 2);
      var lx = s.align === 'left' ? s.x : (s.align === 'right' ? s.x - lw : s.x - lw / 2);
      var vx = s.align === 'left' ? s.x : (s.align === 'right' ? s.x - vw : s.x - vw / 2);
      // 1UP 은 원작처럼 깜빡인다
      if (i !== 1 && (frame % 60) < 30) drawText(s.label, Math.round(lx), 3, s.color, 1);
      if (i === 1) drawText(s.label, Math.round(lx), 3, s.color, 1);
      drawText(values[i], Math.round(vx), 13, '#ffffff', 2);
    }

    // 남은 목숨을 작은 캐릭터로 표시
    for (var pi = 0; pi < Math.min(2, players.length); pi++) {
      var p = players[pi];
      var pal = SP.playerPalette(p.c, shade(p.c, 70), shade(p.c, -80));
      var icon = bakeSprite('bub' + p.c, SP.BUB, pal, false);
      for (var l = 0; l < Math.min(p.l, 5); l++) {
        var ix = pi === 0 ? 12 + l * 11 : S.W - 12 - (l + 1) * 11;
        ctx.drawImage(icon, 0, 0, icon.width, icon.height, ix, 29, 10, 10);
      }
    }

    var stageText = 'STAGE ' + (level + 1);
    drawText(stageText, Math.round((S.W - textW(stageText, 1)) / 2), 31, '#8f86ff', 1);

    if (players.length > 2) {
      var extra = '';
      for (var q = 2; q < players.length; q++) extra += (q + 1) + 'UP ' + pad(players[q].s, 6) + '  ';
      drawText(extra.trim(), Math.round(S.W - textW(extra.trim(), 1) - 100), 31, '#ffd75f', 1);
    }
  }

  function render() {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, S.W, VIEW_H);

    drawHud();

    ctx.save();
    ctx.translate(0, HUD_H);       // 아래쪽이 실제 플레이 화면

    ctx.drawImage(mapCanvas, 0, 0);
    drawExtendColumn();

    // 과일
    for (var i = 0; i < srv.f.length; i++) {
      var f = srv.f[i];
      var v = lerpView('f' + f.i, f.x, f.y);
      drawFruit(v.x, v.y, f.k);
    }

    // EXTEND 알파벳
    for (var li = 0; li < srv.lt.length; li++) {
      var l = srv.lt[li];
      var lv2 = lerpView('l' + l.i, l.x, l.y);
      drawLetter(lv2.x, lv2.y, l.k);
    }

    // 보스
    if (srv.bs) {
      var bossView = lerpView('boss', srv.bs.x, srv.bs.y);
      drawBoss(bossView.x, bossView.y, srv.bs.d, srv.bs.h);
    }

    // 적
    for (var j = 0; j < srv.e.length; j++) {
      var e = srv.e[j];
      var ev = lerpView('e' + e.i, e.x, e.y);
      drawEnemy(ev.x + S.EW / 2, ev.y + S.EH, e.t, e.d, e.a);
    }

    // 보스의 불덩이
    for (var si = 0; si < srv.sh.length; si++) {
      var sh = srv.sh[si];
      var sv = lerpView('s' + sh.i, sh.x, sh.y);
      drawShot(sv.x, sv.y);
    }

    // 버블
    for (var k = 0; k < srv.b.length; k++) {
      var b = srv.b[k];
      var bv = lerpView('b' + b.i, b.x, b.y);
      drawBubble(bv.x, bv.y, b.e, b.w, b.o);
    }

    // 플레이어
    for (var m = 0; m < srv.p.length; m++) {
      var p = srv.p[m];
      if (p.l <= 0) continue;
      if (p.d) continue; // 리스폰 대기 중에는 안 보임
      var px, py;
      if (p.i === myId && me) { px = me.x; py = me.y; }
      else { var pv = lerpView('p' + p.i, p.x, p.y); px = pv.x; py = pv.y; }
      drawPlayer(px + S.PW / 2, py + S.PH, p.c, p.i === myId && me ? me.facing : p.f, p.m, p.v, p.n, p.i === myId);
    }

    // 이펙트
    for (var n = 0; n < particles.length; n++) {
      var pa = particles[n];
      ctx.globalAlpha = Math.max(0, pa.life / pa.max);
      ctx.fillStyle = pa.c;
      ctx.fillRect(pa.x | 0, pa.y | 0, 2, 2);
    }
    ctx.globalAlpha = 1;

    for (var q = 0; q < floaters.length; q++) {
      var fl = floaters[q];
      ctx.globalAlpha = Math.min(1, fl.life / 30);
      drawText(fl.text, Math.round(fl.x - textW(fl.text, 1) / 2), Math.round(fl.y), '#ffd75f', 1);
    }
    ctx.globalAlpha = 1;

    if (srv.combo > 1) {
      var ctext = 'COMBO X' + srv.combo;
      drawText(ctext, 24, 24, '#ff9de0', 1);
    }

    if (srv.bs) drawBossHealth(srv.bs);

    drawOverlayText();
    ctx.restore();
  }

  // ---------------------------------------------------------------- 루프

  var frame = 0;
  var acc = 0;
  var last = performance.now();
  var STEP = 1000 / 60;

  function loop(now) {
    requestAnimationFrame(loop);
    acc += now - last;
    last = now;
    if (acc > 200) acc = 200;

    var steps = 0;
    while (acc >= STEP && steps < 5) {
      acc -= STEP;
      steps++;
      frame++;
      // 내 캐릭터 로컬 예측 (지연 없이 즉각 반응하도록)
      if (me && phase === 'play') {
        var alive = true;
        for (var i = 0; i < srv.p.length; i++) if (srv.p[i].i === myId && (srv.p[i].d || srv.p[i].l <= 0)) alive = false;
        if (alive) {
          var vyBefore = me.vy;
          S.stepPlayer(me, input, map, srv.b);
          if (me.vy < -5 && vyBefore > -5) SFX.jump();   // 실제로 뛴 순간
        }
      }
      stepEffects();
      sendInput();
    }

    render();
    fitCanvas();
  }

  var lastFitW = 0, lastFitH = 0;
  function fitCanvas() {
    var stage = document.getElementById('stage');
    var aw = stage.clientWidth, ah = stage.clientHeight;
    if (aw === lastFitW && ah === lastFitH) return;
    lastFitW = aw; lastFitH = ah;
    var scale = Math.max(1, Math.min(Math.floor(aw / S.W * 2) / 2, Math.floor(ah / VIEW_H * 2) / 2));
    canvas.style.width = (S.W * scale) + 'px';
    canvas.style.height = (VIEW_H * scale) + 'px';
  }

  renderMapCanvas();
  requestAnimationFrame(loop);
})();
