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
  var levelTag = document.getElementById('levelTag');
  var pingTag = document.getElementById('pingTag');
  var scoresEl = document.getElementById('scores');
  var extendEl = document.getElementById('extend');
  var toastEl = document.getElementById('toast');

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
  var stars = [];
  for (var i = 0; i < 60; i++) {
    stars.push({ x: Math.random() * S.W, y: Math.random() * S.H, s: Math.random() * 1.6 + 0.4, a: Math.random() });
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
      levelTag.textContent = 'STAGE ' + (level + 1);
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

    updateScoreboard(m.p);
    updateExtend(m.ex);
  }

  function updateScoreboard(players) {
    var html = '';
    for (var i = 0; i < players.length; i++) {
      var p = players[i];
      var hearts = p.l > 0 ? new Array(p.l + 1).join('♥') : '－';
      html += '<div class="pcard" style="border-left-color:' + p.c + '">' +
        '<span class="nm" style="color:' + p.c + '">' + escapeHtml(p.n) + (p.i === myId ? ' (나)' : '') + '</span>' +
        '<span class="sc">' + p.s + '</span>' +
        '<span class="lv" style="color:#ff6b8f">' + hearts + '</span></div>';
    }
    scoresEl.innerHTML = html;
  }

  var lastExtend = '';
  function updateExtend(ex) {
    if (!ex) return;
    var sig = ex.join('');
    if (sig === lastExtend) return;
    lastExtend = sig;
    var html = '';
    for (var i = 0; i < S.EXTEND.length; i++) {
      html += '<span class="ex' + (ex[i] ? ' on' : '') + '">' + S.EXTEND[i] + '</span>';
    }
    extendEl.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
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

  var LEVEL_TINTS = [
    { wall: '#3d3070', edge: '#6a55c4', plat: '#4a3b8c', platTop: '#8f79ff' },
    { wall: '#0f4a5c', edge: '#2fa2c0', plat: '#166274', platTop: '#4ad9f5' },
    { wall: '#5c2a3d', edge: '#c05a7e', plat: '#7a3752', platTop: '#ff8fb8' },
    { wall: '#2f5230', edge: '#5fa860', plat: '#3d6b3e', platTop: '#8fe08f' },
    { wall: '#4a1430', edge: '#a8305e', plat: '#5f1a3c', platTop: '#ff5f8f' }   // 보스판
  ];

  function tint() { return LEVEL_TINTS[level % LEVEL_TINTS.length]; }

  function drawBackground() {
    var t = tint();
    var g = ctx.createLinearGradient(0, 0, 0, S.H);
    g.addColorStop(0, '#0a0620');
    g.addColorStop(1, '#140b30');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S.W, S.H);

    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      ctx.globalAlpha = 0.25 + Math.abs(Math.sin(frame * 0.02 + s.a * 9)) * 0.5;
      ctx.fillStyle = '#9fd8ff';
      ctx.fillRect(s.x | 0, s.y | 0, s.s, s.s);
    }
    ctx.globalAlpha = 1;

    // 은은한 배경 격자
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 1;
    for (var x = 0; x < S.W; x += S.TILE * 2) {
      ctx.beginPath(); ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, S.H); ctx.stroke();
    }
    void t;
  }

  function drawMap() {
    var t = tint();
    for (var r = 0; r < S.ROWS; r++) {
      for (var c = 0; c < S.COLS; c++) {
        var ch = map[r][c];
        var x = c * S.TILE, y = r * S.TILE;
        if (ch === '#') {
          ctx.fillStyle = t.wall;
          ctx.fillRect(x, y, S.TILE, S.TILE);
          ctx.fillStyle = t.edge;
          ctx.fillRect(x, y, S.TILE, 2);
          ctx.fillRect(x, y, 2, S.TILE);
          ctx.fillStyle = 'rgba(0,0,0,0.25)';
          ctx.fillRect(x + S.TILE - 2, y + 2, 2, S.TILE - 2);
          ctx.fillRect(x + 2, y + S.TILE - 2, S.TILE - 4, 2);
        } else if (ch === '=') {
          ctx.fillStyle = t.plat;
          ctx.fillRect(x, y, S.TILE, S.TILE);
          ctx.fillStyle = t.platTop;
          ctx.fillRect(x, y, S.TILE, 3);
          ctx.fillStyle = 'rgba(0,0,0,0.3)';
          ctx.fillRect(x, y + S.TILE - 3, S.TILE, 3);
        }
      }
    }
  }

  function drawBubble(x, y, enemyType, warning) {
    var r = S.BR;
    var pulse = Math.sin(frame * 0.12 + x * 0.1) * 0.6;

    if (enemyType >= 0) {
      ctx.fillStyle = warning && (frame >> 2) % 2 === 0 ? 'rgba(255,120,120,0.55)' : 'rgba(160,230,255,0.35)';
    } else {
      ctx.fillStyle = 'rgba(190,240,255,0.22)';
    }
    ctx.beginPath(); ctx.arc(x, y, r + pulse, 0, Math.PI * 2); ctx.fill();

    ctx.strokeStyle = enemyType >= 0 ? '#ff9de0' : '#bfeaff';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x, y, r + pulse, 0, Math.PI * 2); ctx.stroke();

    if (enemyType >= 0) drawEnemyBody(x - S.EW / 2, y - S.EH / 2 + 1, enemyType, 0, 0, 0.75);

    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.beginPath(); ctx.arc(x - r * 0.35, y - r * 0.4, 1.8, 0, Math.PI * 2); ctx.fill();
  }

  function drawEnemyBody(x, y, type, dir, angry, scale) {
    scale = scale || 1;
    var w = S.EW * scale, h = S.EH * scale;
    var body = angry ? '#ff5f7a' : (type === 1 ? '#ffb14d' : '#7f8fff');
    var dark = angry ? '#b02a45' : (type === 1 ? '#b06a1d' : '#4550b0');

    ctx.fillStyle = dark;
    ctx.fillRect(x, y + h * 0.25, w, h * 0.75);
    ctx.fillStyle = body;
    ctx.fillRect(x + 1, y + h * 0.2, w - 2, h * 0.7);
    // 뿔/머리
    ctx.fillRect(x + 2, y, w - 4, h * 0.3);
    // 눈
    ctx.fillStyle = '#fff';
    var ex = dir < 0 ? x + 2 : x + w - 6;
    ctx.fillRect(ex, y + h * 0.28, 4 * scale, 4 * scale);
    ctx.fillStyle = '#111';
    ctx.fillRect(ex + (dir < 0 ? 0 : 2 * scale), y + h * 0.32, 2 * scale, 2.5 * scale);
    // 발
    ctx.fillStyle = dark;
    ctx.fillRect(x, y + h - 2, 4 * scale, 2 * scale);
    ctx.fillRect(x + w - 4 * scale, y + h - 2, 4 * scale, 2 * scale);
  }

  function drawPlayer(x, y, color, facing, moving, ghost, name, isMe) {
    ctx.save();
    if (ghost && (frame >> 2) % 2 === 0) ctx.globalAlpha = 0.35;

    var w = S.PW, h = S.PH;
    var bob = moving ? Math.sin(frame * 0.35) * 1 : 0;
    y += bob;

    // 몸통
    ctx.fillStyle = color;
    roundRect(x, y + 2, w, h - 2, 4);
    ctx.fill();
    // 배
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    roundRect(x + 3, y + 6, w - 6, h - 7, 3);
    ctx.fill();
    // 등껍질 무늬
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(x + (facing > 0 ? 1 : w - 5), y + 4, 4, 4);
    // 눈
    ctx.fillStyle = '#fff';
    var ex = facing > 0 ? x + w - 6 : x + 2;
    ctx.fillRect(ex, y + 3, 4, 4);
    ctx.fillStyle = '#111';
    ctx.fillRect(ex + (facing > 0 ? 2 : 0), y + 4, 2, 3);
    // 발
    ctx.fillStyle = '#ffd75f';
    ctx.fillRect(x + 1, y + h - 1, 4, 2);
    ctx.fillRect(x + w - 5, y + h - 1, 4, 2);
    ctx.restore();

    // 이름표
    ctx.font = '7px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = isMe ? '#ffffff' : 'rgba(255,255,255,0.7)';
    ctx.fillText(name, x + w / 2, y - 3);
    ctx.textAlign = 'left';
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

  var FRUIT_COLORS = ['#ff5f7a', '#ffd75f', '#8fe08f', '#5fc8ff', '#ff9de0', '#ffffff'];
  function drawFruit(x, y, kind) {
    ctx.fillStyle = FRUIT_COLORS[kind % FRUIT_COLORS.length];
    ctx.beginPath(); ctx.arc(x + 6, y + 7, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#6fdc6f';
    ctx.fillRect(x + 5, y, 2, 3);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.beginPath(); ctx.arc(x + 4, y + 5, 1.4, 0, Math.PI * 2); ctx.fill();
  }

  var LETTER_COLORS = ['#ff6b8f', '#ffd75f', '#8fe08f', '#5fc8ff', '#ff9de0', '#c9a0ff'];
  function drawLetter(x, y, idx) {
    var ch = S.EXTEND[idx] || '?';
    var col = LETTER_COLORS[idx % LETTER_COLORS.length];
    var bob = Math.sin(frame * 0.12 + idx) * 1.2;
    y += bob;
    // 반짝이는 거품에 담긴 글자
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath(); ctx.arc(x + 7, y + 7, 9, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x + 7, y + 7, 9, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = col;
    ctx.font = 'bold 11px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(ch, x + 7, y + 11);
    ctx.textAlign = 'left';
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
    ctx.font = 'bold 9px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffd7e6';
    ctx.fillText('BOSS', S.W / 2, y - 5);
    ctx.textAlign = 'left';
  }

  function drawOverlayText() {
    if (!message) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = 'bold 26px "Segoe UI", sans-serif';
    var y = S.H / 2;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, y - 32, S.W, 60);
    ctx.fillStyle = phase === 'over' ? '#ff6b8f' : '#ffd75f';
    ctx.fillText(message, S.W / 2, y + 4);
    ctx.font = '11px "Segoe UI", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText(phase === 'over' ? '잠시 후 처음부터 다시 시작합니다' : '다음 스테이지로!', S.W / 2, y + 22);
    ctx.restore();
  }

  function render() {
    drawBackground();
    drawMap();

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
      drawEnemyBody(ev.x, ev.y, e.t, e.d, e.a, 1);
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
      drawBubble(bv.x, bv.y, b.e, b.w);
    }

    // 플레이어
    for (var m = 0; m < srv.p.length; m++) {
      var p = srv.p[m];
      if (p.l <= 0) continue;
      if (p.d) continue; // 리스폰 대기 중에는 안 보임
      var px, py;
      if (p.i === myId && me) { px = me.x; py = me.y; }
      else { var pv = lerpView('p' + p.i, p.x, p.y); px = pv.x; py = pv.y; }
      drawPlayer(px, py, p.c, p.i === myId && me ? me.facing : p.f, p.m, p.v, p.n, p.i === myId);
    }

    // 이펙트
    for (var n = 0; n < particles.length; n++) {
      var pa = particles[n];
      ctx.globalAlpha = Math.max(0, pa.life / pa.max);
      ctx.fillStyle = pa.c;
      ctx.fillRect(pa.x | 0, pa.y | 0, 2, 2);
    }
    ctx.globalAlpha = 1;

    ctx.font = 'bold 9px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    for (var q = 0; q < floaters.length; q++) {
      var fl = floaters[q];
      ctx.globalAlpha = Math.min(1, fl.life / 30);
      ctx.fillStyle = '#ffd75f';
      ctx.fillText(fl.text, fl.x, fl.y);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';

    if (srv.combo > 1) {
      ctx.font = 'bold 12px "Segoe UI", sans-serif';
      ctx.fillStyle = '#ff9de0';
      ctx.fillText('COMBO x' + srv.combo, 22, 30);
    }

    if (srv.bs) drawBossHealth(srv.bs);

    drawOverlayText();
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
    var scale = Math.max(1, Math.min(Math.floor(aw / S.W * 2) / 2, Math.floor(ah / S.H * 2) / 2));
    canvas.style.width = (S.W * scale) + 'px';
    canvas.style.height = (S.H * scale) + 'px';
  }

  requestAnimationFrame(loop);
})();
