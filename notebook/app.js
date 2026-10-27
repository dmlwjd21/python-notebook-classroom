(() => {
  'use strict';

  const CFG = window.PYCLASS_CONFIG;
  // 클래스룸 과제 링크(?c=반&t=문제파일)로 들어오면 과제 모드: assignment.js가 드라이브에서 노트북을 불러온다
  const params = new URLSearchParams(location.search);
  // 수업 자료 링크(?m=문제파일)는 제출 없이 드라이브에 자동 저장만 하는 실습 모드
  let ASSIGNMENT = null;
  if (params.get('c') && params.get('t')) ASSIGNMENT = { mode: 'assignment', courseId: params.get('c'), templateId: params.get('t') };
  else if (params.get('m')) ASSIGNMENT = { mode: 'practice', templateId: params.get('m') };
  const STORAGE_KEY = !ASSIGNMENT ? 'pyclass:notebook:v1'
    : ASSIGNMENT.mode === 'practice' ? `pyclass:practice:${ASSIGNMENT.templateId}`
      : `pyclass:assignment:${ASSIGNMENT.courseId}:${ASSIGNMENT.templateId}`;
  const INPUT_URL = new URL('__pyinput__', location.href).href;

  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 8.5v7l5.5-3.5z" fill="currentColor"/></svg>';
  const STOP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="9" y="9" width="6" height="6" fill="currentColor"/></svg>';

  // ---------------------------------------------------------------- 노트북 데이터

  function uid() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  function newCell(type, source = '') {
    return { id: uid(), type, source, outputs: [], execCount: null };
  }

  function starterNotebook() {
    return {
      title: '제목 없음',
      metadata: {},
      cells: [
        newCell('markdown', '# 파이썬 노트북\n코드 셀 왼쪽의 ▶ 버튼을 누르거나 **Ctrl+Enter**로 실행하세요.'),
        newCell('code', 'name = input("이름을 입력하세요: ")\nprint(f"안녕하세요, {name}님!")'),
      ],
    };
  }

  function loadLocal() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.cells)) return null;
      return data;
    } catch {
      return null;
    }
  }

  function placeholderNotebook() {
    return { title: '과제 불러오는 중', metadata: {}, cells: [newCell('markdown', '')] };
  }

  let nb = ASSIGNMENT ? placeholderNotebook() : (loadLocal() || starterNotebook());
  if (!nb.cells.length) nb.cells.push(newCell('code'));
  let locked = !!ASSIGNMENT; // 과제 모드에서는 불러오기 전, 그리고 제출한 뒤에 편집을 막는다
  let loaded = !ASSIGNMENT;
  const saveListeners = [];

  const Integrity = window.PyClassIntegrity;
  const recorder = new Integrity.Recorder(() => nb, {
    onChange: () => scheduleSave(),
    toast: (text) => toast(text),
  });

  // ---------------------------------------------------------------- 저장

  let saveTimer = null;
  const saveState = $('#saveState');

  function saveNow(announce) {
    clearTimeout(saveTimer);
    if (!loaded) return;
    for (const fn of saveListeners) fn();
    if (ASSIGNMENT) {
      // 과제 모드: 진짜 저장은 드라이브(assignment.js). 브라우저에는 만일을 위한 임시 사본만 둔다
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(nb)); } catch { /* 공간 부족: 드라이브 저장에 맡김 */ }
      if (announce) toast('드라이브에 자동 저장되고 있어요');
      return;
    }
    const data = JSON.stringify(nb);
    try {
      localStorage.setItem(STORAGE_KEY, data);
    } catch {
      // 저장 공간이 부족하면 출력(그래프 등)을 빼고 저장한다
      try {
        const light = { ...nb, cells: nb.cells.map((c) => ({ ...c, outputs: [] })) };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(light));
      } catch {
        saveState.textContent = '브라우저 저장 실패';
        return;
      }
    }
    saveState.textContent = '브라우저에 저장됨';
    if (announce) toast('브라우저에 저장했어요. 파일로 받으려면 파일 > .ipynb 다운로드');
  }

  function scheduleSave() {
    if (!loaded) return;
    if (!ASSIGNMENT) saveState.textContent = '저장 중…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveNow(false), 800);
  }

  // ---------------------------------------------------------------- 런타임(커널)

  const runtimeChip = $('#runtimeChip');
  const runtimeText = $('#runtimeText');
  const interruptBtn = $('#interruptBtn');

  function setRuntimeStatus(state, text) {
    runtimeChip.dataset.state = state;
    runtimeText.textContent = text;
    runtimeChip.title = text;
    interruptBtn.disabled = !(state === 'busy');
  }

  class Kernel {
    constructor() {
      this.runSeq = 0;
      this.start();
    }

    start() {
      this.ready = false;
      this.current = null;
      this.readyPromise = new Promise((resolve, reject) => {
        this.resolveReady = resolve;
        this.rejectReady = reject;
      });
      this.readyPromise.catch(() => {});
      setRuntimeStatus('connecting', '런타임 연결 중…');
      this.worker = new Worker('kernel-worker.js');
      this.worker.onmessage = (e) => this.onMessage(e.data);
      this.worker.onerror = (e) => {
        setRuntimeStatus('error', '런타임 오류');
        console.error(e);
      };
      this.worker.postMessage({ type: 'init', pyodideUrl: CFG.pyodideUrl, inputUrl: INPUT_URL });
    }

    onMessage(m) {
      const cur = this.current && m.runId === this.current.runId ? this.current : null;
      switch (m.type) {
        case 'progress':
          if (!this.ready) { if (m.text) setRuntimeStatus('connecting', m.text); }
          else if (cur) cur.handlers.onProgress(m.text);
          break;
        case 'ready':
          this.ready = true;
          this.pythonVersion = m.pythonVersion;
          setRuntimeStatus('ready', `연결됨 · Python ${m.pythonVersion}`);
          this.resolveReady();
          break;
        case 'init-error':
          setRuntimeStatus('error', '런타임을 불러오지 못했어요');
          this.rejectReady(new Error(m.message));
          break;
        case 'output':
          if (cur) cur.handlers.onOutput(m.output);
          break;
        case 'input-request':
          if (cur) cur.handlers.onInput(m);
          break;
        case 'done':
          if (cur) {
            this.current = null;
            setRuntimeStatus('ready', `연결됨 · Python ${this.pythonVersion}`);
            cur.resolve(m.ok ? 'ok' : 'error');
          }
          break;
      }
    }

    async run(code, filename, handlers) {
      const readyPromise = this.readyPromise;
      try {
        await readyPromise;
      } catch (err) {
        if (err.message === 'restart') return 'interrupted';
        handlers.onOutput({
          output_type: 'error', ename: 'RuntimeError', evalue: err.message,
          traceback: [`파이썬 런타임을 불러오지 못했어요. 인터넷 연결을 확인하고 새로고침해 주세요.\n(${err.message})`],
        });
        return 'error';
      }
      if (readyPromise !== this.readyPromise) return 'interrupted';
      const runId = ++this.runSeq;
      return new Promise((resolve) => {
        this.current = { runId, handlers, resolve };
        setRuntimeStatus('busy', '실행 중…');
        this.worker.postMessage({ type: 'run', runId, code, filename });
      });
    }

    restart() {
      this.worker.terminate();
      if (!this.ready) this.rejectReady(new Error('restart'));
      const cur = this.current;
      this.current = null;
      this.start();
      if (cur) cur.resolve('interrupted');
    }
  }

  // 서비스 워커(input() 처리용)가 페이지를 제어하게 된 뒤에 커널을 시작한다.
  async function setupServiceWorker() {
    if (!('serviceWorker' in navigator)) return false;
    try {
      await navigator.serviceWorker.register('sw.js');
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) => {
          navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
          setTimeout(resolve, 3000);
        });
      }
      return !!navigator.serviceWorker.controller;
    } catch (err) {
      console.warn('서비스 워커 등록 실패', err);
      return false;
    }
  }

  let kernel = null;
  let execCounter = 0;

  // ---------------------------------------------------------------- 실행 대기열

  const queue = [];
  let runningId = null;

  function enqueue(ids) {
    for (const id of ids) {
      if (id === runningId || queue.includes(id)) continue;
      const cell = findCell(id);
      if (!cell || cell.type !== 'code') continue;
      queue.push(id);
      setCellState(id, 'queued');
    }
    pump();
  }

  function clearQueue() {
    for (const id of queue) setCellState(id, 'idle');
    queue.length = 0;
  }

  async function pump() {
    if (runningId || !queue.length || !kernel) return;
    const id = queue.shift();
    const cell = findCell(id);
    if (!cell) return pump();
    runningId = id;
    cell.outputs = [];
    cell.execCount = null;
    const view = views.get(id);
    view.outputLimitHit = false;
    renderOutputs(cell);
    setCellState(id, 'running');

    const n = ++execCounter;
    const result = await kernel.run(cell.source, `<셀 ${n}>`, {
      onOutput: (out) => addOutput(cell, out, n),
      onInput: (req) => showInputBox(cell, req),
      onProgress: (text) => setProgress(cell, text),
    });

    setProgress(cell, '');
    const err = cell.outputs.find((o) => o.output_type === 'error');
    recorder.log('run', { cell: id, ok: result === 'ok', ...(err ? { ename: err.ename } : {}) });
    if (result === 'interrupted') {
      cell.outputs.push({
        output_type: 'error', ename: 'KeyboardInterrupt', evalue: '',
        traceback: ['실행을 중단했어요. 런타임이 다시 시작되어 앞에서 만든 변수는 모두 지워졌어요.'],
      });
    }
    cell.execCount = result === 'interrupted' ? null : n;
    renderOutputs(cell);
    setCellState(id, 'idle');
    runningId = null;
    scheduleSave();
    if (result !== 'ok') clearQueue();
    pump();
  }

  function addOutput(cell, out, n) {
    const view = views.get(cell.id);
    if (out.output_type === 'execute_result') out.execution_count = n;
    if (out.output_type === 'stream') {
      const total = cell.outputs.reduce((s, o) => s + (o.text ? o.text.length : 0), 0);
      if (total >= CFG.maxOutputChars) {
        if (!view.outputLimitHit) {
          view.outputLimitHit = true;
          cell.outputs.push({ output_type: 'stream', name: 'stderr', text: '\n…출력이 너무 길어 나머지는 생략했어요.\n' });
          scheduleRenderOutputs(cell);
        }
        return;
      }
      const last = cell.outputs[cell.outputs.length - 1];
      if (last && last.output_type === 'stream' && last.name === out.name) {
        last.text += out.text;
      } else {
        cell.outputs.push(out);
      }
    } else {
      cell.outputs.push(out);
    }
    scheduleRenderOutputs(cell);
  }

  // ---------------------------------------------------------------- 화면 그리기

  const notebookEl = $('#notebook');
  const views = new Map(); // cell.id -> { root, cm, outputsEl, ... }
  let selectedId = null;

  function findCell(id) {
    return nb.cells.find((c) => c.id === id);
  }

  function indexOf(id) {
    return nb.cells.findIndex((c) => c.id === id);
  }

  function makeInserter(afterId) {
    const ins = el('div', 'inserter');
    const addCode = el('button', '', '+ 코드');
    const addText = el('button', '', '+ 텍스트');
    addCode.addEventListener('click', () => insertCell('code', afterId, true));
    addText.addEventListener('click', () => insertCell('markdown', afterId, true));
    ins.append(addCode, addText);
    return ins;
  }

  function createView(cell) {
    const wrap = el('div', 'cell-wrap');
    const root = el('div', `cell ${cell.type}`);
    root.dataset.id = cell.id;
    root.dataset.state = 'idle';

    const gutter = el('div', 'cell-gutter');
    const runBtn = el('button', 'run-btn');
    runBtn.title = '셀 실행 (Ctrl+Enter)';
    runBtn.innerHTML = PLAY_ICON;
    runBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (runningId === cell.id) interrupt();
      else runCell(cell.id, 'stay');
    });
    const count = el('div', 'exec-count');
    gutter.append(runBtn, count);

    const body = el('div', 'cell-body');
    const editorHost = el('div', 'editor');
    body.append(editorHost);

    let mdRender = null;
    if (cell.type === 'markdown') {
      mdRender = el('div', 'md-render');
      mdRender.addEventListener('dblclick', () => startEditing(cell.id));
      body.append(mdRender);
    }

    const outputsEl = el('div', 'outputs');
    body.append(outputsEl);

    const tools = el('div', 'cell-tools');
    const toolDefs = [
      ['↑', '위로 이동', () => moveCell(cell.id, -1)],
      ['↓', '아래로 이동', () => moveCell(cell.id, 1)],
      ['🗑', '셀 삭제', () => deleteCell(cell.id)],
    ];
    for (const [label, title, fn] of toolDefs) {
      const b = el('button', '', label);
      b.title = title;
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      tools.append(b);
    }

    root.append(gutter, body, tools);
    root.addEventListener('mousedown', () => selectCell(cell.id));
    wrap.append(root, makeInserter(cell.id));

    const cm = CodeMirror(editorHost, {
      value: cell.source,
      mode: cell.type === 'code' ? 'python' : 'markdown',
      lineNumbers: cell.type === 'code',
      lineWrapping: cell.type !== 'code',
      indentUnit: 4,
      tabSize: 4,
      indentWithTabs: false,
      matchBrackets: true,
      autoCloseBrackets: true,
      viewportMargin: Infinity,
      readOnly: locked,
      extraKeys: {
        Tab: (ed) => (ed.somethingSelected() ? ed.indentSelection('add') : ed.replaceSelection('    ', 'end')),
        'Shift-Tab': (ed) => ed.indentSelection('subtract'),
        'Ctrl-Enter': () => runCell(cell.id, 'stay'),
        'Cmd-Enter': () => runCell(cell.id, 'stay'),
        'Shift-Enter': () => runCell(cell.id, 'next'),
        'Alt-Enter': () => runCell(cell.id, 'insert'),
        'Ctrl-/': 'toggleComment',
        'Cmd-/': 'toggleComment',
        'Ctrl-S': () => saveNow(true),
        'Cmd-S': () => saveNow(true),
      },
    });
    cm.on('change', () => {
      cell.source = cm.getValue();
      scheduleSave();
    });
    recorder.attachEditor(cell.id, cm);
    cm.on('focus', () => selectCell(cell.id));
    if (cell.type === 'markdown') {
      cm.on('blur', () => setTimeout(() => {
        if (!root.contains(document.activeElement)) finishEditing(cell.id);
      }, 0));
    }

    const view = { wrap, root, cm, count, runBtn, outputsEl, mdRender, renderPending: false, outputLimitHit: false };
    views.set(cell.id, view);
    renderOutputs(cell);
    renderCount(cell);
    if (mdRender) renderMarkdown(cell);
    return view;
  }

  // 셀 목록이 바뀌면(추가/삭제/이동) 기존 편집기는 살린 채 순서만 다시 맞춘다.
  function renderStructure() {
    const alive = new Set(nb.cells.map((c) => c.id));
    for (const [id, view] of views) {
      if (!alive.has(id)) {
        view.wrap.remove();
        views.delete(id);
      }
    }
    if (!notebookEl.firstChild || !notebookEl.firstChild.classList.contains('inserter')) {
      notebookEl.prepend(makeInserter(null));
    }
    let prev = notebookEl.firstChild;
    for (const cell of nb.cells) {
      const view = views.get(cell.id) || createView(cell);
      if (prev.nextSibling !== view.wrap) {
        notebookEl.insertBefore(view.wrap, prev.nextSibling);
        view.cm.refresh();
      }
      prev = view.wrap;
    }
    if (!findCell(selectedId)) selectedId = null;
    updateSelection();
  }

  function renderCount(cell) {
    const view = views.get(cell.id);
    if (!view || cell.type !== 'code') return;
    view.count.textContent = cell.execCount != null ? `[${cell.execCount}]` : '';
  }

  function renderMarkdown(cell) {
    const view = views.get(cell.id);
    const html = marked.parse(cell.source || '');
    view.mdRender.innerHTML = DOMPurify.sanitize(html);
  }

  function scheduleRenderOutputs(cell) {
    const view = views.get(cell.id);
    if (!view || view.renderPending) return;
    view.renderPending = true;
    requestAnimationFrame(() => {
      view.renderPending = false;
      renderOutputs(cell);
    });
  }

  function renderOutputs(cell) {
    const view = views.get(cell.id);
    if (!view) return;
    const box = view.outputsEl;
    const keepInput = box.querySelector('.input-row');
    const keepProgress = box.querySelector('.out-progress');
    box.textContent = '';
    for (const out of cell.outputs) box.append(renderOutput(out));
    if (keepProgress) box.append(keepProgress);
    if (keepInput) box.append(keepInput);
    renderCount(cell);
  }

  function renderOutput(out) {
    switch (out.output_type) {
      case 'stream': {
        const pre = el('pre', `out-stream ${out.name === 'stderr' ? 'stderr' : ''}`, out.text);
        return pre;
      }
      case 'error':
        return el('pre', 'out-error', (out.traceback || []).join('\n') || `${out.ename}: ${out.evalue}`);
      case 'execute_result':
      case 'display_data': {
        const data = out.data || {};
        if (data['image/png']) {
          const img = el('img', 'out-img');
          img.alt = '그래프 출력';
          img.src = `data:image/png;base64,${data['image/png']}`;
          return img;
        }
        if (data['text/html']) {
          const div = el('div', 'out-html');
          div.innerHTML = DOMPurify.sanitize(joinText(data['text/html']));
          return div;
        }
        return el('pre', 'out-text', joinText(data['text/plain'] || ''));
      }
      default:
        return el('div', 'out-note', `(표시할 수 없는 출력: ${out.output_type})`);
    }
  }

  function joinText(v) {
    return Array.isArray(v) ? v.join('') : String(v);
  }

  function setProgress(cell, text) {
    const view = views.get(cell.id);
    if (!view) return;
    let p = view.outputsEl.querySelector('.out-progress');
    if (!text) { if (p) p.remove(); return; }
    if (!p) { p = el('div', 'out-progress'); view.outputsEl.append(p); }
    p.textContent = text;
  }

  function showInputBox(cell, req) {
    const view = views.get(cell.id);
    const row = el('div', 'input-row');
    const prompt = el('span', 'prompt', req.prompt);
    const input = el('input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    row.append(prompt, input);
    view.outputsEl.append(row);
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      const value = input.value;
      row.remove();
      addOutput(cell, { output_type: 'stream', name: 'stdout', text: `${req.prompt}${value}\n` });
      const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (sw) sw.postMessage({ type: 'input-response', id: req.id, value });
    });
    input.focus();
  }

  function setCellState(id, state) {
    const view = views.get(id);
    if (!view) return;
    view.root.dataset.state = state;
    view.runBtn.innerHTML = state === 'running' ? STOP_ICON : PLAY_ICON;
    view.runBtn.title = state === 'running' ? '실행 중단' : '셀 실행 (Ctrl+Enter)';
  }

  function updateSelection() {
    for (const [id, view] of views) view.root.classList.toggle('selected', id === selectedId);
  }

  function selectCell(id) {
    if (selectedId === id) return;
    selectedId = id;
    updateSelection();
  }

  function focusCell(id) {
    const cell = findCell(id);
    const view = views.get(id);
    if (!cell || !view) return;
    selectCell(id);
    if (cell.type === 'markdown') startEditing(id);
    else view.cm.focus();
    view.root.scrollIntoView({ block: 'nearest' });
  }

  // ---------------------------------------------------------------- 텍스트 셀 편집

  function startEditing(id) {
    const view = views.get(id);
    if (locked || !view || view.root.classList.contains('editing')) return;
    view.root.classList.add('editing');
    view.cm.refresh();
    view.cm.focus();
  }

  function finishEditing(id) {
    const cell = findCell(id);
    const view = views.get(id);
    if (!cell || !view || cell.type !== 'markdown') return;
    view.root.classList.remove('editing');
    renderMarkdown(cell);
  }

  // ---------------------------------------------------------------- 셀 조작

  function runCell(id, then) {
    const cell = findCell(id);
    if (!cell) return;
    if (cell.type === 'markdown') finishEditing(id);
    else enqueue([id]);

    if (then === 'next') {
      const next = nb.cells[indexOf(id) + 1];
      if (next) focusCell(next.id);
      else if (!locked) insertCell('code', id, true);
    } else if (then === 'insert') {
      insertCell('code', id, true);
    }
  }

  function insertCell(type, afterId, focus) {
    if (locked) return null;
    const cell = newCell(type);
    const idx = afterId == null ? 0 : indexOf(afterId) + 1;
    nb.cells.splice(idx, 0, cell);
    recorder.log('cell-add', { cell: cell.id, kind: type, source: cell.source });
    renderStructure();
    scheduleSave();
    if (focus) focusCell(cell.id);
    return cell;
  }

  function deleteCell(id) {
    const idx = indexOf(id);
    if (locked || idx < 0) return;
    if (id === runningId) interrupt();
    const q = queue.indexOf(id);
    if (q >= 0) queue.splice(q, 1);
    recorder.log('cell-delete', { cell: id, source: nb.cells[idx].source });
    nb.cells.splice(idx, 1);
    if (!nb.cells.length) nb.cells.push(newCell('code'));
    const neighbor = nb.cells[Math.min(idx, nb.cells.length - 1)];
    selectedId = neighbor.id;
    renderStructure();
    scheduleSave();
  }

  function moveCell(id, dir) {
    const idx = indexOf(id);
    const to = idx + dir;
    if (locked || idx < 0 || to < 0 || to >= nb.cells.length) return;
    const [cell] = nb.cells.splice(idx, 1);
    nb.cells.splice(to, 0, cell);
    renderStructure();
    scheduleSave();
  }

  function interrupt() {
    if (!kernel) return;
    clearQueue();
    if (runningId || !kernel.ready) {
      recorder.log('interrupt');
      kernel.restart();
      execCounter = 0;
      toast('실행을 중단하고 런타임을 다시 시작했어요');
    }
  }

  function restartRuntime() {
    if (!kernel) return;
    clearQueue();
    kernel.restart();
    execCounter = 0;
    toast('런타임을 다시 시작했어요. 변수가 모두 지워졌어요');
  }

  function runAll(fromId) {
    const start = fromId ? indexOf(fromId) : 0;
    enqueue(nb.cells.slice(Math.max(0, start)).filter((c) => c.type === 'code').map((c) => c.id));
  }

  function clearAllOutputs() {
    for (const cell of nb.cells) {
      cell.outputs = [];
      cell.execCount = null;
      renderOutputs(cell);
    }
    scheduleSave();
  }

  // ---------------------------------------------------------------- .ipynb 불러오기 / 내보내기

  function splitLines(text) {
    const lines = text.split('\n');
    return lines.map((line, i) => (i < lines.length - 1 ? `${line}\n` : line)).filter((l) => l !== '');
  }

  function toIpynb(src = nb) {
    return {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        ...src.metadata,
        kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
        language_info: { name: 'python' },
      },
      cells: src.cells.map((c) => {
        const base = { id: c.id, cell_type: c.type, metadata: {}, source: splitLines(c.source) };
        if (c.type !== 'code') return base;
        return {
          ...base,
          execution_count: c.execCount,
          outputs: c.outputs.map((o) => (o.output_type === 'stream' ? { ...o, text: splitLines(o.text) } : o)),
        };
      }),
    };
  }

  function fromIpynb(json, filename) {
    if (!json || !Array.isArray(json.cells)) throw new Error('노트북 형식이 아니에요');
    const cells = json.cells
      .filter((c) => c.cell_type === 'code' || c.cell_type === 'markdown')
      .map((c) => {
        const cell = newCell(c.cell_type, joinText(c.source || ''));
        // 작성 기록이 셀 id로 연결되어 있으므로 원래 id를 유지한다
        if (typeof c.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(c.id)) cell.id = c.id;
        if (c.cell_type === 'code') {
          cell.outputs = (c.outputs || []).map((o) => (o.output_type === 'stream' ? { ...o, text: joinText(o.text || '') } : o));
          cell.execCount = c.execution_count ?? null;
        }
        return cell;
      });
    const { kernelspec, language_info, ...rest } = json.metadata || {};
    return {
      title: (filename || '제목 없음').replace(/\.ipynb$/i, ''),
      metadata: rest,
      cells: cells.length ? cells : [newCell('code')],
    };
  }

  function replaceNotebook(next) {
    clearQueue();
    if (runningId) interrupt();
    for (const view of views.values()) view.wrap.remove();
    views.clear();
    nb = next;
    Integrity.ensureMeta(nb);
    selectedId = nb.cells[0].id;
    $('#titleInput').value = nb.title;
    fitTitle();
    document.title = `${nb.title || '제목 없음'} - ${CFG.appName}`;
    renderStructure();
    applyPolicy();
    saveNow(false);
  }

  // 과제 설정(교사가 템플릿에 넣은 값)을 화면에 반영한다
  function applyPolicy() {
    const policy = recorder.policy;
    for (const cmd of ['new', 'open']) {
      document.querySelectorAll(`[data-cmd="${cmd}"]`).forEach((b) => { b.disabled = !policy.allowFileOpen || !!ASSIGNMENT; });
    }
    const chip = $('#recordChip');
    const recording = policy.record !== false;
    const lines = recording ? ['붙여넣기, 다른 탭·창으로 이동, 코드 입력 과정이 제출 파일에 함께 기록돼요.'] : [];
    if (policy.blockPaste) lines.push('외부에서 복사한 내용을 붙여넣을 수 없어요.');
    if (!policy.allowFileOpen) lines.push('다른 노트북 파일을 열 수 없어요.');
    chip.title = lines.join('\n');
    chip.hidden = !recording && !policy.blockPaste;
    chip.textContent = recording
      ? (policy.blockPaste ? '● 기록 중 · 붙여넣기 제한' : '● 작성 과정 기록 중')
      : '● 붙여넣기 제한';
  }

  function download() {
    Integrity.ensureMeta(nb);
    const blob = new Blob([JSON.stringify(toIpynb(), null, 1)], { type: 'application/x-ipynb+json' });
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(nb.title || '제목 없음').trim() || '제목 없음'}.ipynb`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  $('#fileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      const next = fromIpynb(json, file.name);
      const hadRecord = !!(next.metadata.pyclass && next.metadata.pyclass.record);
      replaceNotebook(next);
      recorder.log('file-open', { name: file.name, hadRecord });
      toast(`${file.name} 파일을 열었어요`);
    } catch (err) {
      toast(`파일을 열 수 없어요: ${err.message}`);
    }
  });

  // ---------------------------------------------------------------- 메뉴 / 명령

  const commands = {
    'new': () => {
      const ok = recorder.withoutAwayTracking(() => confirm('새 노트북을 만들까요? 지금 노트북은 사라져요. 필요하면 먼저 다운로드해 두세요.'));
      if (!ok) return;
      const policy = { ...recorder.policy };
      replaceNotebook({ title: '제목 없음', metadata: { pyclass: { policy } }, cells: [newCell('code')] });
      recorder.log('new-notebook');
    },
    'open': () => {
      recorder.suspendUntilFocus();
      $('#fileInput').click();
    },
    'download': download,
    'clear-outputs': clearAllOutputs,
    'delete-cell': () => selectedId && deleteCell(selectedId),
    'run-all': () => runAll(),
    'run-after': () => runAll(selectedId),
    'interrupt': interrupt,
    'restart': restartRuntime,
    'restart-run-all': () => { restartRuntime(); runAll(); },
    'shortcuts': () => $('#shortcutDialog').showModal(),
    'add-code': () => insertCell('code', selectedId ?? nb.cells[nb.cells.length - 1].id, true),
    'add-text': () => insertCell('markdown', selectedId ?? nb.cells[nb.cells.length - 1].id, true),
  };

  document.addEventListener('click', (e) => {
    const cmdBtn = e.target.closest('[data-cmd]');
    const menu = e.target.closest('.menu');
    document.querySelectorAll('.menu.open').forEach((m) => { if (m !== menu || cmdBtn) m.classList.remove('open'); });
    if (cmdBtn) {
      commands[cmdBtn.dataset.cmd]?.();
      return;
    }
    if (e.target.classList.contains('menu-btn')) menu.classList.toggle('open');
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveNow(true);
    }
    if (e.key === 'Escape') document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open'));
  });

  const titleInput = $('#titleInput');
  titleInput.value = nb.title;
  titleInput.readOnly = !!ASSIGNMENT; // 과제 파일 이름은 바꾸지 않는다
  function fitTitle() {
    // 한글은 영문보다 넓으므로 글자별로 폭을 다르게 잡는다
    const units = [...titleInput.value].reduce((s, ch) => s + (/[^\x00-\xff]/.test(ch) ? 1.9 : 1.1), 0);
    titleInput.style.width = `${Math.max(6, units + 1)}ch`;
  }
  titleInput.addEventListener('input', () => {
    nb.title = titleInput.value;
    document.title = `${nb.title || '제목 없음'} - ${CFG.appName}`;
    fitTitle();
    scheduleSave();
  });
  titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') titleInput.blur(); });
  fitTitle();
  document.title = `${nb.title || '제목 없음'} - ${CFG.appName}`;

  let toastTimer = null;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  // ---------------------------------------------------------------- 시작

  function setLocked(value) {
    locked = !!value;
    document.body.classList.toggle('locked', locked);
    for (const [id, view] of views) {
      view.cm.setOption('readOnly', locked);
      if (locked) finishEditing(id);
    }
    document.querySelectorAll('.toolbar [data-cmd="add-code"], .toolbar [data-cmd="add-text"], .menu-pop [data-cmd="delete-cell"]')
      .forEach((b) => { b.disabled = locked; });
  }

  // assignment.js 등 다른 모듈에서 쓰는 기능
  window.PyClassApp = {
    assignment: ASSIGNMENT,
    recorder,
    toast,
    getNotebook: () => nb,
    toIpynb,
    fromIpynb,
    // 드라이브 등에서 불러온 노트북으로 바꾼다 (파일 열기 기록은 남기지 않음)
    load(next) {
      loaded = true;
      replaceNotebook(next);
    },
    setLocked,
    // 숨겨져 있던 노트북을 보여준 뒤 편집기 크기를 다시 계산한다
    refreshEditors: () => { for (const view of views.values()) view.cm.refresh(); },
    setSaveText: (text) => { saveState.textContent = text; },
    onSave: (fn) => saveListeners.push(fn),
    saveNow: () => saveNow(false),
  };

  Integrity.ensureMeta(nb);
  selectedId = nb.cells[0].id;
  renderStructure();
  applyPolicy();
  setLocked(locked);
  recorder.attachWindow();
  if (!ASSIGNMENT) recorder.log('session');

  setupServiceWorker().then((swReady) => {
    if (!swReady) console.warn('서비스 워커를 쓸 수 없어 input()이 동작하지 않을 수 있어요.');
    kernel = new Kernel();
    pump();
  });
})();
