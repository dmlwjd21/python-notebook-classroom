// 서비스 워커: 파이썬 input()의 입력값을 화면에서 커널 워커로 넘겨주는 다리 역할만 한다.
// 커널 워커는 __pyinput__ 주소로 동기 요청을 보내 기다리고,
// 화면은 학생이 입력한 값을 postMessage로 이곳에 보내 그 요청에 응답한다.

const WAIT_MS = 25000; // 이 시간 안에 입력이 없으면 204로 응답하고, 커널이 다시 요청한다
const pending = new Map(); // id -> resolve
const early = new Map();   // id -> 요청보다 먼저 도착한 입력값

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type !== 'input-response') return;
  const resolve = pending.get(msg.id);
  if (resolve) {
    pending.delete(msg.id);
    resolve(msg.value);
  } else {
    early.set(msg.id, msg.value);
  }
});

function textResponse(value) {
  return new Response(value, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.endsWith('/__pyinput__')) return;
  const id = url.searchParams.get('id');
  if (early.has(id)) {
    const value = early.get(id);
    early.delete(id);
    event.respondWith(textResponse(value));
    return;
  }
  event.respondWith(new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } }));
    }, WAIT_MS);
    pending.set(id, (value) => {
      clearTimeout(timer);
      resolve(textResponse(value));
    });
  }));
});
