// 판서: 노트북 위에 펜·형광펜·레이저 포인터로 그리기 (수업 화면 공유·전자칠판용)
// 획은 그린 위치의 셀에 붙여 저장한다(셀 기준 좌표). 위쪽 출력이 늘어나거나 화면 크기가 달라져도 그 코드 위에 남는다.
// 수업 자료에서 선생님이 "판서 저장"을 켜 두면 획이 노트북 파일(metadata.pyclass.drawing)에 함께 저장된다.
(() => {
  'use strict';

  const btn = document.querySelector('[data-cmd="draw"]');
  if (!btn) return;
  const App = window.PyClassApp;

  const COLORS = ['#e53935', '#1e88e5', '#43a047', '#fdd835', '#212121'];
  const SIZES = { 가늘게: 2, 보통: 4, 굵게: 8 };
  const LASER_MS = 1200;
  const ERASE_RADIUS = 14;
  const SAVE_DELAY = 1500;

  const canvas = document.createElement('canvas');
  canvas.className = 'draw-canvas';
  document.body.append(canvas);
  const ctx = canvas.getContext('2d');

  const palette = document.createElement('div');
  palette.className = 'draw-palette';
  palette.hidden = true;
  palette.innerHTML = `
    <div class="dp-group" role="group" aria-label="도구">
      <button type="button" data-tool="pen" title="펜 (P)">✒️<span>펜</span></button>
      <button type="button" data-tool="marker" title="형광펜 (H)">🖍️<span>형광펜</span></button>
      <button type="button" data-tool="laser" title="레이저 포인터 (L) - 잠시 뒤 사라져요">🔴<span>레이저</span></button>
      <button type="button" data-tool="eraser" title="지우개 (E) - 닿은 획을 지워요">🧽<span>지우개</span></button>
    </div>
    <div class="dp-group dp-colors" role="group" aria-label="색">
      ${COLORS.map((c) => `<button type="button" data-color="${c}" style="--c:${c}" title="색"></button>`).join('')}
    </div>
    <div class="dp-group" role="group" aria-label="굵기">
      ${Object.entries(SIZES).map(([k, v]) => `<button type="button" data-size="${v}" title="${k}"><i style="--s:${v + 2}px"></i></button>`).join('')}
    </div>
    <div class="dp-group">
      <button type="button" data-act="undo" title="되돌리기 (Ctrl+Z)">↶<span>되돌리기</span></button>
      <button type="button" data-act="clear" title="모두 지우기">🗑️<span>모두 지우기</span></button>
      <button type="button" data-act="close" title="판서 끝내기 (Esc) - 그린 내용은 남아요">✕<span>닫기</span></button>
    </div>
    <div class="dp-note" hidden>💾 판서가 내 드라이브의 실습 파일에 함께 저장돼요</div>`;
  document.body.append(palette);
  const note = palette.querySelector('.dp-note');

  const state = {
    on: false,
    tool: 'pen',
    color: COLORS[0],
    size: 4,
    // 획: { tool, color, width, cell, pts: [[x, y]] }
    //   cell이 있으면 그 셀의 왼쪽 위 기준 좌표, 없으면(셀 밖) 문서 좌표
    strokes: [],
    laser: [],       // { pts: [[문서 x, 문서 y, 시각]] }
    history: [],     // 되돌리기용
    current: null,
    raf: 0,
    persist: false,  // 노트북 파일에 저장할지 (수업 자료 + 선생님 설정)
    saveTimer: null,
  };

  // ------------------------------------------------------------ 좌표 (셀 기준 ↔ 화면)

  function cellElAt(clientX, clientY) {
    for (const el of document.elementsFromPoint(clientX, clientY)) {
      const cell = el.closest && el.closest('.cell[data-id]');
      if (cell) return cell;
    }
    return null;
  }

  // 획의 기준점(화면 좌표). 셀이 지워졌으면 null → 그리지 않음
  function originOf(stroke, cache) {
    if (!stroke.cell) return [-scrollX, -scrollY];
    if (cache.has(stroke.cell)) return cache.get(stroke.cell);
    const el = document.querySelector(`.cell[data-id="${CSS.escape(stroke.cell)}"]`);
    const r = el ? el.getBoundingClientRect() : null;
    const o = r && (r.width || r.height) ? [r.left, r.top] : null;
    cache.set(stroke.cell, o);
    return o;
  }

  const round = (v) => Math.round(v * 10) / 10;

  // ------------------------------------------------------------ 그리기

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    canvas.style.width = `${innerWidth}px`;
    canvas.style.height = `${innerHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    requestDraw();
  }

  function strokePath(pts, ox, oy) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0] + ox, pts[0][1] + oy);
    if (pts.length === 1) {
      ctx.lineTo(pts[0][0] + ox + 0.01, pts[0][1] + oy);
      return;
    }
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0] + ox, pts[i][1] + oy, mx + ox, my + oy);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last[0] + ox, last[1] + oy);
  }

  function drawStroke(s, origin) {
    if (!origin || !s.pts || !s.pts.length) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    if (s.tool === 'marker') {
      ctx.globalAlpha = 0.35;
      ctx.lineCap = 'butt';
    }
    strokePath(s.pts, origin[0], origin[1]);
    ctx.stroke();
    ctx.restore();
  }

  function draw() {
    state.raf = 0;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    const cache = new Map();
    for (const s of state.strokes) drawStroke(s, originOf(s, cache));
    const cur = state.current;
    if (cur && (cur.tool === 'pen' || cur.tool === 'marker')) drawStroke(cur, originOf(cur, cache));

    // 레이저: 꼬리가 점점 사라짐 (문서 좌표)
    const now = performance.now();
    state.laser = state.laser.filter((l) => now - l.pts[l.pts.length - 1][2] < LASER_MS);
    for (const l of state.laser) {
      const pts = l.pts.filter((p) => now - p[2] < LASER_MS);
      if (!pts.length) continue;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowColor = '#ff1744';
      ctx.shadowBlur = 12;
      ctx.strokeStyle = 'rgba(255, 23, 68, 0.85)';
      ctx.lineWidth = 5;
      strokePath(pts, -scrollX, -scrollY);
      ctx.stroke();
      ctx.restore();
    }
    if (state.laser.length) requestDraw();
  }

  function requestDraw() {
    if (!state.raf) state.raf = requestAnimationFrame(draw);
  }

  // ------------------------------------------------------------ 저장 (수업 자료)

  function save() {
    if (!state.persist || !App) return;
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      const nb = App.getNotebook();
      nb.metadata = nb.metadata || {};
      nb.metadata.pyclass = nb.metadata.pyclass || {};
      nb.metadata.pyclass.drawing = { version: 1, strokes: state.strokes };
      App.saveNow(); // 드라이브 자동 저장으로 이어짐
    }, SAVE_DELAY);
  }

  function changed() {
    updateButton();
    requestDraw();
    save();
  }

  // 노트북을 (다시) 불러오면 그 파일에 저장된 판서를 꺼낸다
  window.addEventListener('pyclass:policy', (e) => {
    if (!App || !App.assignment || !e.detail.loaded) return;
    state.persist = App.assignment.mode === 'practice' && e.detail.policy.saveDrawing !== false;
    note.hidden = !state.persist;
    const saved = state.persist && App.getNotebook().metadata && App.getNotebook().metadata.pyclass
      && App.getNotebook().metadata.pyclass.drawing;
    state.strokes = saved && Array.isArray(saved.strokes) ? saved.strokes.filter((s) => s && Array.isArray(s.pts) && s.pts.length) : [];
    state.history = [];
    updateButton();
    requestDraw();
  });

  // ------------------------------------------------------------ 입력

  // 점과 선분 사이 거리의 제곱
  function segDist2(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    return (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
  }

  // 지우개가 지나간 길(이전 위치 → 지금 위치, 화면 좌표)에 닿은 획을 지운다
  function eraseAlong(x, y, fromX = x, fromY = y) {
    const cache = new Map();
    const removed = [];
    state.strokes = state.strokes.filter((s, idx) => {
      const o = originOf(s, cache);
      if (!o) return true;
      const r = ERASE_RADIUS + s.width / 2;
      const hit = s.pts.some(([qx, qy], i) => {
        const px = qx + o[0];
        const py = qy + o[1];
        if (segDist2(px, py, fromX, fromY, x, y) < r * r) return true;
        const next = s.pts[i + 1];
        return next ? segDist2(x, y, px, py, next[0] + o[0], next[1] + o[1]) < r * r : false;
      });
      if (hit) removed.push({ s, idx });
      return !hit;
    });
    if (removed.length) {
      state.history.push({ type: 'erase', removed });
      changed();
    }
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!state.on) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const x = e.clientX;
    const y = e.clientY;
    if (state.tool === 'eraser') {
      eraseAlong(x, y);
      state.current = { tool: 'eraser', last: [x, y] };
      return;
    }
    if (state.tool === 'laser') {
      state.current = { tool: 'laser', pts: [[x + scrollX, y + scrollY, performance.now()]] };
      state.laser.push(state.current);
      requestDraw();
      return;
    }
    const cellEl = cellElAt(x, y);
    const cell = cellEl ? cellEl.dataset.id : null;
    const o = cellEl ? (() => { const r = cellEl.getBoundingClientRect(); return [r.left, r.top]; })() : [-scrollX, -scrollY];
    const width = state.tool === 'marker' ? state.size * 4 + 6 : state.size;
    state.current = { tool: state.tool, color: state.color, width, cell, pts: [[round(x - o[0]), round(y - o[1])]], origin: o };
    requestDraw();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!state.on || !state.current) return;
    const cur = state.current;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events) {
      const x = ev.clientX;
      const y = ev.clientY;
      if (cur.tool === 'eraser') {
        eraseAlong(x, y, cur.last[0], cur.last[1]);
        cur.last = [x, y];
      } else if (cur.tool === 'laser') {
        cur.pts.push([x + scrollX, y + scrollY, performance.now()]);
      } else {
        // 그리는 도중 스크롤해도 기준점이 맞도록 매번 셀 위치를 다시 잰다
        const o = cur.cell ? originOf(cur, new Map()) || cur.origin : [-scrollX, -scrollY];
        const p = [round(x - o[0]), round(y - o[1])];
        const last = cur.pts[cur.pts.length - 1];
        if ((last[0] - p[0]) ** 2 + (last[1] - p[1]) ** 2 > 1) cur.pts.push(p);
      }
    }
    requestDraw();
  });

  function endStroke() {
    const cur = state.current;
    state.current = null;
    if (!cur || cur.tool === 'eraser' || cur.tool === 'laser') return;
    delete cur.origin;
    state.strokes.push(cur);
    state.history.push({ type: 'add', stroke: cur });
    changed();
  }
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);

  function undo() {
    const h = state.history.pop();
    if (!h) return;
    if (h.type === 'add') state.strokes = state.strokes.filter((s) => s !== h.stroke);
    else if (h.type === 'erase') {
      for (const { s, idx } of h.removed.slice().reverse()) state.strokes.splice(Math.min(idx, state.strokes.length), 0, s);
    } else if (h.type === 'clear') state.strokes = h.strokes;
    changed();
  }

  function clearAll() {
    if (!state.strokes.length) return;
    state.history.push({ type: 'clear', strokes: state.strokes });
    state.strokes = [];
    changed();
  }

  // ------------------------------------------------------------ 켜기 / 끄기, 도구 고르기

  function updateButton() {
    btn.classList.toggle('active', state.on);
    btn.textContent = state.strokes.length && !state.on ? '✏️ 판서 (그림 있음)' : '✏️ 판서';
  }

  function setOn(on) {
    state.on = on;
    document.body.classList.toggle('drawing', on);
    palette.hidden = !on;
    if (!on) state.current = null;
    updateButton();
    requestDraw();
  }

  function selectTool(tool) {
    state.tool = tool;
    palette.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    canvas.dataset.tool = tool;
  }

  function selectColor(color) {
    state.color = color;
    palette.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('active', b.dataset.color === color));
    if (state.tool === 'eraser' || state.tool === 'laser') selectTool('pen');
  }

  function selectSize(size) {
    state.size = size;
    palette.querySelectorAll('[data-size]').forEach((b) => b.classList.toggle('active', Number(b.dataset.size) === size));
  }

  btn.addEventListener('click', () => setOn(!state.on));

  palette.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tool) selectTool(b.dataset.tool);
    else if (b.dataset.color) selectColor(b.dataset.color);
    else if (b.dataset.size) selectSize(Number(b.dataset.size));
    else if (b.dataset.act === 'undo') undo();
    else if (b.dataset.act === 'clear') clearAll();
    else if (b.dataset.act === 'close') setOn(false);
  });

  document.addEventListener('keydown', (e) => {
    if (!state.on) return;
    if (e.key === 'Escape') { setOn(false); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const keyTool = { p: 'pen', h: 'marker', l: 'laser', e: 'eraser' }[e.key.toLowerCase()];
    if (keyTool) { e.preventDefault(); selectTool(keyTool); }
  });

  window.addEventListener('resize', resize);
  window.addEventListener('scroll', requestDraw, { passive: true });
  // 셀 내용·출력이 바뀌어 위치가 움직이면 다시 그린다
  const nbEl = document.getElementById('notebook');
  if (nbEl && window.ResizeObserver) new ResizeObserver(requestDraw).observe(nbEl);

  selectTool('pen');
  selectColor(COLORS[0]);
  selectSize(4);
  resize();
})();
