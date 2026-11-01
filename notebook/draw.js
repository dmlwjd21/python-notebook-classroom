// 판서: 노트북 위에 펜·형광펜·레이저 포인터로 그리기 (수업 화면 공유·전자칠판용)
// 획은 문서 좌표로 저장해서, 스크롤해도 그 위치의 코드에 붙어 함께 움직인다.
(() => {
  'use strict';

  const btn = document.querySelector('[data-cmd="draw"]');
  if (!btn) return;

  const COLORS = ['#e53935', '#1e88e5', '#43a047', '#fdd835', '#212121'];
  const SIZES = { 가늘게: 2, 보통: 4, 굵게: 8 };
  const LASER_MS = 1200;
  const ERASE_RADIUS = 14;

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
    </div>`;
  document.body.append(palette);

  const state = {
    on: false,
    tool: 'pen',
    color: COLORS[0],
    size: 4,
    strokes: [],     // { tool, color, width, pts: [[x, y]] } (문서 좌표)
    laser: [],       // { pts: [[x, y, t]] }
    history: [],     // 되돌리기용 { type, ... }
    current: null,
    raf: 0,
  };

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
    if (pts.length === 1) {
      ctx.moveTo(pts[0][0] - ox, pts[0][1] - oy);
      ctx.lineTo(pts[0][0] - ox + 0.01, pts[0][1] - oy);
      return;
    }
    ctx.moveTo(pts[0][0] - ox, pts[0][1] - oy);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      ctx.quadraticCurveTo(pts[i][0] - ox, pts[i][1] - oy, mx - ox, my - oy);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last[0] - ox, last[1] - oy);
  }

  function drawStroke(s, ox, oy) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    if (s.tool === 'marker') {
      ctx.globalAlpha = 0.35;
      ctx.lineCap = 'butt';
    }
    strokePath(s.pts, ox, oy);
    ctx.stroke();
    ctx.restore();
  }

  function draw() {
    state.raf = 0;
    const ox = scrollX;
    const oy = scrollY;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const s of state.strokes) drawStroke(s, ox, oy);
    const cur = state.current;
    if (cur && (cur.tool === 'pen' || cur.tool === 'marker')) drawStroke(cur, ox, oy);

    // 레이저: 꼬리가 점점 사라짐
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
      strokePath(pts, ox, oy);
      ctx.stroke();
      ctx.restore();
    }
    if (state.laser.length) requestDraw();
  }

  function requestDraw() {
    if (!state.raf) state.raf = requestAnimationFrame(draw);
  }

  // ------------------------------------------------------------ 입력

  const docPoint = (e) => [e.clientX + scrollX, e.clientY + scrollY];

  // 점 (px, py)에서 선분 (ax, ay)-(bx, by)까지 거리의 제곱
  function segDist2(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    return (px - (ax + t * dx)) ** 2 + (py - (ay + t * dy)) ** 2;
  }

  // 지우개가 지나간 길(이전 위치 → 지금 위치)에 닿은 획을 지운다. 빠르게 문질러도 빠뜨리지 않도록 선분으로 검사
  function eraseAt(x, y, fromX = x, fromY = y) {
    const removed = [];
    state.strokes = state.strokes.filter((s, idx) => {
      const r = ERASE_RADIUS + s.width / 2;
      const hit = s.pts.some(([px, py], i) => {
        if (segDist2(px, py, fromX, fromY, x, y) < r * r) return true;
        const next = s.pts[i + 1];
        return next ? segDist2(x, y, px, py, next[0], next[1]) < r * r : false;
      });
      if (hit) removed.push({ s, idx });
      return !hit;
    });
    if (removed.length) {
      state.history.push({ type: 'erase', removed });
      requestDraw();
    }
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!state.on) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = docPoint(e);
    if (state.tool === 'eraser') {
      eraseAt(x, y);
      state.current = { tool: 'eraser', last: [x, y] };
      return;
    }
    if (state.tool === 'laser') {
      state.current = { tool: 'laser', pts: [[x, y, performance.now()]] };
      state.laser.push(state.current);
    } else {
      const width = state.tool === 'marker' ? state.size * 4 + 6 : state.size;
      state.current = { tool: state.tool, color: state.color, width, pts: [[x, y]] };
    }
    requestDraw();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!state.on || !state.current) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events) {
      const [x, y] = docPoint(ev);
      if (state.current.tool === 'eraser') {
        const [lx, ly] = state.current.last;
        eraseAt(x, y, lx, ly);
        state.current.last = [x, y];
      } else if (state.current.tool === 'laser') state.current.pts.push([x, y, performance.now()]);
      else {
        const last = state.current.pts[state.current.pts.length - 1];
        if ((last[0] - x) ** 2 + (last[1] - y) ** 2 > 1) state.current.pts.push([x, y]);
      }
    }
    requestDraw();
  });

  function endStroke() {
    const cur = state.current;
    state.current = null;
    if (!cur || cur.tool === 'eraser' || cur.tool === 'laser') return;
    state.strokes.push(cur);
    state.history.push({ type: 'add', stroke: cur });
    updateButton();
    requestDraw();
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
    updateButton();
    requestDraw();
  }

  function clearAll() {
    if (!state.strokes.length) return;
    state.history.push({ type: 'clear', strokes: state.strokes });
    state.strokes = [];
    updateButton();
    requestDraw();
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

  selectTool('pen');
  selectColor(COLORS[0]);
  selectSize(4);
  resize();
})();
