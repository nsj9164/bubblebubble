/*
 * 네트워크 테스트 — 서버를 실제로 띄우고 두 명이 접속해서 동기화를 확인한다.
 * 실행: node test/network.test.js
 */
'use strict';

const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.TEST_PORT || 34210;
const HOST = 'ws://localhost:' + PORT;
const ROOT = path.join(__dirname, '..');

const results = [];
function check(label, cond, extra) {
  results.push(!!cond);
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra ? '  -> ' + extra : ''));
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name, roomCode) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(HOST);
    const api = { ws, name, snaps: [], times: [], joined: null };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name, room: roomCode || '' })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === 'joined') { api.joined = m; resolve(api); }
      else if (m.t === 'error') reject(new Error(m.m));
      else if (m.t === 's') { api.snaps.push(m); api.times.push(Date.now()); }
    });
    ws.on('error', reject);
    api.input = (o) => ws.send(JSON.stringify({ t: 'i', l: !!o.l, r: !!o.r, j: !!o.j, f: !!o.f }));
    api.last = () => api.snaps[api.snaps.length - 1];
    api.self = () => api.last().p.find((p) => p.i === api.joined.id);
    setTimeout(() => reject(new Error(name + ' 접속 시간 초과')), 5000);
  });
}

function get(urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port: PORT, path: urlPath }, (res) => {
      let len = 0;
      res.on('data', (c) => { len += c.length; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], len }));
    }).on('error', reject);
  });
}

function getBody(urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port: PORT, path: urlPath }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

let server;
(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT) }), stdio: 'ignore'
  });
  await wait(1200);

  // ---- 정적 파일 서빙
  for (const [p, type] of [['/', 'text/html'], ['/game.js', 'text/javascript'], ['/shared.js', 'text/javascript']]) {
    const r = await get(p);
    check('정적 파일 응답 ' + p, r.status === 200 && r.type.startsWith(type) && r.len > 0, `${r.status}, ${r.len} bytes`);
  }
  const missing = await get(encodeURI('/없는파일.js'));
  check('없는 파일은 404', missing.status === 404);

  // 배포 진단용 엔드포인트 (Render 등에서 서버가 실제로 떴는지 확인할 때 쓴다)
  const health = await get('/healthz');
  check('/healthz 응답', health.status === 200 && health.type.startsWith('application/json'), health.status + ' ' + health.type);
  const healthBody = JSON.parse(await getBody('/healthz'));
  check('/healthz 가 public 파일 목록을 알려줌',
    healthBody.ok === true && healthBody.publicFiles.includes('index.html'),
    healthBody.publicFiles.join(', '));

  // ---- 방 만들기 / 참가
  const a = await client('가가');
  const code = a.joined.room;
  check('방 생성', /^[A-Z0-9]{4}$/.test(code), code);
  const b = await client('나나', code);
  check('친구가 같은 방에 참가', b.joined.room === code);
  check('플레이어마다 다른 색', a.joined.color !== b.joined.color, `${a.joined.color} / ${b.joined.color}`);

  await wait(700);
  check('스냅샷 수신', a.snaps.length > 5, a.snaps.length + '개');
  check('두 명 모두 보임', a.last().p.length === 2, JSON.stringify(a.last().p.map((p) => p.n)));
  check('스테이지에 적이 있음', a.last().e.length > 0, a.last().e.length + '마리');

  // ---- 물리 (중력 / 이동 / 점프)
  const y0 = a.self().y;
  await wait(500);
  check('중력으로 착지 후 안정', Math.abs(a.self().y - y0) < 0.6, `y ${y0} -> ${a.self().y}`);

  const x0 = a.self().x;
  a.input({ r: true }); await wait(500); a.input({});
  check('오른쪽 이동', a.self().x > x0 + 10, `x ${x0} -> ${a.self().x}`);

  let jumpOk = 0, tries = 0, jumpFailedAlive = false;
  while (jumpOk < 6 && tries < 15 && !jumpFailedAlive) {
    tries++;
    await wait(600 + tries * 17);            // 매번 다른 틱 위상에서 눌러본다
    const before = a.self();
    if (before.d || before.l <= 0) continue; // 적에게 맞아 부활 대기 중이면 이번 시도는 건너뛴다
    // 고정 시간 대기 대신 "새 스냅샷이 올 때까지" 기다리며 최고점을 본다.
    // 스냅샷 도착이 몇십 ms 밀리면 점프 직전 상태를 보고 실패로 오판하게 된다.
    const n0 = a.snaps.length;
    a.input({ j: true });
    let top = before.y, died = false;
    const t0 = Date.now();
    while (a.snaps.length < n0 + 8 && Date.now() - t0 < 1000) {
      await wait(20);
      const s = a.self();
      if (s.d) { died = true; break; }
      top = Math.min(top, s.y);
    }
    a.input({});
    if (died) continue;                      // 뛰는 도중에 죽었으면 무효
    if (top < before.y - 8) jumpOk++;
    else jumpFailedAlive = true;             // 살아있는데 안 뛰었다면 진짜 실패
  }
  check('점프 6회 모두 성공', jumpOk === 6, `${jumpOk}/6 (시도 ${tries}회)`);
  await wait(600);

  // 점프 높이가 매번 같은가 (가변 점프였다면 지연 때문에 들쭉날쭉해진다)
  const heights = [];
  for (let n = 0; n < 3 && heights.length < 3; n++) {
    await wait(800);
    const before = a.self();
    if (before.d || before.l <= 0) continue;
    a.input({ j: true }); await wait(60); a.input({});
    let top = before.y;
    for (let i = 0; i < 12; i++) { await wait(50); top = Math.min(top, a.self().y); }
    heights.push(Math.round(before.y - top));
  }
  const spread = Math.max(...heights) - Math.min(...heights);
  check('점프 높이가 매번 일정', heights.length === 3 && spread <= 4, heights.join(' / ') + ' px');

  // ---- 버블 발사
  a.input({ f: true }); await wait(120); a.input({}); await wait(150);
  check('버블 발사가 서버에 반영됨', a.last().b.length > 0, a.last().b.length + '개');
  const oldBubbles = new Set(a.last().b.map((x) => x.i));

  // ---- 양방향 동기화
  const bx = a.last().p.find((p) => p.i === b.joined.id).x;
  b.input({ r: true }); await wait(600); b.input({}); await wait(200);
  const seenByA = a.last().p.find((p) => p.i === b.joined.id);
  const seenByB = b.self();
  check('상대 플레이어의 이동이 내 쪽에 반영됨', seenByA.x > bx + 10, `x ${bx} -> ${seenByA.x}`);
  check('두 클라이언트가 같은 위치를 봄', Math.abs(seenByA.x - seenByB.x) < 4, `${seenByA.x} vs ${seenByB.x}`);
  check('두 클라이언트의 스테이지 정보 일치', a.last().lv === b.last().lv);

  // ---- 월드 진행
  const e0 = a.last().e.map((e) => e.x + ',' + e.y).join('|');
  await wait(1200);
  check('적이 스스로 움직임', e0 !== a.last().e.map((e) => e.x + ',' + e.y).join('|'));

  await wait(10500);
  check('버블이 수명 후 사라짐', a.last().b.filter((x) => oldBubbles.has(x.i)).length === 0);
  check('스냅샷이 끊기지 않고 도착', a.snaps.length > 100, a.snaps.length + '개');

  // 전송 간격이 고르게 유지되는가 (울컥거리면 남의 캐릭터가 뚝뚝 끊겨 보인다)
  const mark = a.times.length;
  await wait(3000);
  const gaps = [];
  for (let i = mark + 1; i < a.times.length; i++) gaps.push(a.times[i] - a.times[i - 1]);
  gaps.sort((x, y) => x - y);
  const avg = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  const p95 = gaps[Math.floor(gaps.length * 0.95)];
  check('스냅샷 평균 간격이 30Hz에 가까움', avg > 25 && avg < 42, avg.toFixed(1) + 'ms');
  check('전송 간격이 크게 튀지 않음', p95 < 70 && gaps[gaps.length - 1] < 150,
    `p95 ${p95}ms, 최대 ${gaps[gaps.length - 1]}ms`);
  check('게임이 정상 진행 중', ['play', 'clear'].includes(a.last().ph), a.last().ph);

  // ---- 잘못된 입력에도 죽지 않는가
  a.ws.send('이건 JSON이 아님');
  a.ws.send(JSON.stringify({ t: '모르는타입' }));
  await wait(400);
  check('잘못된 메시지를 무시하고 계속 동작', a.snaps.length > 0 && a.ws.readyState === 1);

  // ---- 없는 방 코드
  try {
    await client('길잃음', 'ZZZZ');
    check('없는 방 코드 거부', false);
  } catch (e) {
    check('없는 방 코드 거부', /방이 없어요/.test(e.message), e.message);
  }

  // ---- 퇴장
  b.ws.close();
  await wait(600);
  check('퇴장한 플레이어 제거', a.last().p.length === 1, a.last().p.length + '명');
  a.ws.close();
  await wait(300);

  const failed = results.filter((r) => !r).length;
  console.log('\n===== 네트워크 테스트 ' + (results.length - failed) + '/' + results.length + ' 통과 =====');
  if (server) server.kill();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('테스트 중 오류:', e);
  if (server) server.kill();
  process.exit(1);
});
