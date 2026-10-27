(() => {
  'use strict';

  const I = window.PyClassIntegrity;
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const joinText = (v) => (Array.isArray(v) ? v.join('') : String(v ?? ''));

  let toastTimer = null;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  // ---------------------------------------------------------------- 탭

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.id !== `tab-${tab.dataset.tab}`; });
    });
  });

  // ---------------------------------------------------------------- 제출 파일 불러오기

  const submissions = []; // { name, nb, analysis }
  let activeIndex = -1;

  function parseNotebook(json) {
    if (!json || !Array.isArray(json.cells)) throw new Error('노트북 형식이 아니에요');
    return {
      metadata: json.metadata || {},
      cells: json.cells
        .filter((c) => c.cell_type === 'code' || c.cell_type === 'markdown')
        .map((c, i) => ({ id: c.id || `cell-${i}`, type: c.cell_type, source: joinText(c.source) })),
    };
  }

  function score(a) {
    return a.flags.reduce((s, f) => s + (f.level === 'high' ? 100 : f.level === 'mid' ? 10 : 1), 0);
  }

  async function addFiles(files) {
    let added = 0;
    for (const file of files) {
      try {
        const nb = parseNotebook(JSON.parse(await file.text()));
        const analysis = I.analyze(nb);
        const existing = submissions.findIndex((s) => s.name === file.name);
        const item = { name: file.name, nb, analysis };
        if (existing >= 0) submissions[existing] = item;
        else submissions.push(item);
        added += 1;
      } catch (err) {
        toast(`${file.name}: 열 수 없어요 (${err.message})`);
      }
    }
    submissions.sort((a, b) => score(b.analysis) - score(a.analysis) || a.name.localeCompare(b.name, 'ko'));
    renderList();
    if (added && activeIndex < 0) select(0);
    else if (activeIndex >= 0) select(Math.min(activeIndex, submissions.length - 1));
  }

  // 채점 탭에서 학생 한 명의 작성 기록을 열 때 사용
  const toJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
  window.PyClassReview = {
    open(name, json) {
      const nb = parseNotebook(toJson(json));
      const item = { name, nb, analysis: I.analyze(nb) };
      const existing = submissions.findIndex((s) => s.name === name);
      if (existing >= 0) submissions[existing] = item;
      else submissions.push(item);
      renderList();
      select(submissions.findIndex((s) => s.name === name));
      document.querySelector('.tab[data-tab="review"]').click();
    },
    analyze: (json) => I.analyze(parseNotebook(toJson(json))),
  };

  const dropZone = $('#dropZone');
  $('#reviewFiles').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('over');
    addFiles([...e.dataTransfer.files].filter((f) => /\.ipynb$/i.test(f.name)));
  });

  function shortBadges(a) {
    if (!a.hasRecord) return [['high', '기록 없음']];
    const s = a.summary;
    const out = [];
    if (s.mismatchCells.length) out.push(['high', '기록 불일치']);
    if (s.pasteExternal) out.push(['high', `외부 붙여넣기 ${s.pasteExternal}`]);
    if (s.fastBursts) out.push(['high', '빠른 입력']);
    if (s.pasteBlocked) out.push(['mid', `차단 ${s.pasteBlocked}`]);
    if (s.bulkInserts) out.push(['mid', '일괄 입력']);
    if (s.fileOpens) out.push(['mid', '파일 열기']);
    if (s.awayCount) out.push([s.awayMs > 60000 ? 'mid' : 'low', `이탈 ${s.awayCount}회`]);
    if (!out.length) out.push(['ok', '특이사항 없음']);
    return out;
  }

  function renderList() {
    const box = $('#fileItems');
    box.textContent = '';
    submissions.forEach((sub, i) => {
      const btn = el('button', `file-item${i === activeIndex ? ' active' : ''}`);
      btn.append(el('div', 'name', sub.name.replace(/\.ipynb$/i, '')));
      const badges = el('div', 'badges');
      for (const [level, text] of shortBadges(sub.analysis)) badges.append(el('span', `badge ${level}`, text));
      btn.append(badges);
      btn.addEventListener('click', () => select(i));
      box.append(btn);
    });
  }

  // ---------------------------------------------------------------- 상세 화면

  let stopReplay = () => {};

  function fmtTime(rec, t) {
    return new Date(rec.t0 + t).toLocaleString('ko-KR', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
  }

  function cellLabels(sub) {
    const labels = new Map();
    sub.nb.cells.forEach((c, i) => labels.set(c.id, `셀 ${i + 1}${c.type === 'markdown' ? ' (텍스트)' : ''}`));
    const rec = sub.analysis.record;
    if (rec) {
      for (const ev of rec.events) {
        if (ev.type === 'cell-delete' && !labels.has(ev.cell)) labels.set(ev.cell, '삭제된 셀');
      }
    }
    return labels;
  }

  function select(i) {
    stopReplay();
    activeIndex = i;
    renderList();
    const sub = submissions[i];
    const detail = $('#detail');
    detail.textContent = '';
    if (!sub) return;
    const a = sub.analysis;

    detail.append(el('h2', '', sub.name.replace(/\.ipynb$/i, '')));
    if (a.hasRecord) {
      const s = a.summary;
      const policy = [];
      if (a.policy.blockPaste) policy.push('외부 붙여넣기 차단');
      if (!a.policy.allowFileOpen) policy.push('파일 열기 차단');
      detail.append(el('div', 'meta',
        `기록 시작 ${fmtTime(a.record, 0)} · 마지막 활동 ${fmtTime(a.record, s.span)} · 과제 설정: ${policy.join(', ') || '기본(기록만)'}`));
    }

    const flags = el('ul', 'flags');
    if (a.flags.length) for (const f of a.flags) flags.append(el('li', f.level, f.text));
    else flags.append(el('li', 'ok', '특이사항 없음'));
    detail.append(flags);

    if (!a.hasRecord) {
      detail.append(el('div', 'cell-head', '최종 코드'));
      renderFinalCode(detail, sub);
      return;
    }

    const s = a.summary;
    const stats = el('div', 'stats');
    const statDefs = [
      [s.pasteExternal, '외부 붙여넣기'],
      [s.pasteInternal, '내부 붙여넣기'],
      [s.awayCount, '다른 탭·창 이동'],
      [I.fmtDuration(s.awayMs), '이동해 있던 시간'],
      [`${s.runs}회`, `실행 (오류 ${s.runErrors}회)`],
      [s.typedChars.toLocaleString(), '직접 입력한 글자'],
    ];
    for (const [v, k] of statDefs) {
      const box = el('div', 'stat');
      box.append(el('div', 'v', String(v)), el('div', 'k', k));
      stats.append(box);
    }
    detail.append(stats);

    const subtabs = el('div', 'subtabs');
    const panel = el('div');
    const views = [
      ['작성 과정 재생', () => renderReplay(panel, sub)],
      ['타임라인', () => renderTimeline(panel, sub)],
      ['최종 코드', () => renderFinalCode(panel, sub)],
    ];
    views.forEach(([label, render], idx) => {
      const b = el('button', `subtab${idx === 0 ? ' active' : ''}`, label);
      b.addEventListener('click', () => {
        stopReplay();
        subtabs.querySelectorAll('.subtab').forEach((x) => x.classList.toggle('active', x === b));
        panel.textContent = '';
        render();
      });
      subtabs.append(b);
    });
    detail.append(subtabs, panel);
    views[0][1]();
  }

  function renderFinalCode(panel, sub) {
    sub.nb.cells.forEach((c, i) => {
      panel.append(el('div', 'cell-head', `셀 ${i + 1}${c.type === 'markdown' ? ' (텍스트)' : ''}`));
      panel.append(el('pre', 'code-view', c.source));
    });
  }

  const KIND_LABEL = { i: '입력', p: '붙여넣기', x: '잘라내기', d: '지우기', u: '실행 취소/다시 실행', m: '끌어서 이동', s: '전체 바꾸기' };

  function renderReplay(panel, sub) {
    const rec = sub.analysis.record;
    const labels = cellLabels(sub);
    const bar = el('div', 'replay-bar');
    const cellSel = el('select');
    for (const [id, label] of labels) {
      const opt = el('option', '', label);
      opt.value = id;
      cellSel.append(opt);
    }
    const editCounts = new Map();
    for (const e of rec.edits) editCounts.set(e[1], (editCounts.get(e[1]) || 0) + 1);
    const busiest = [...editCounts].sort((x, y) => y[1] - x[1])[0];
    if (busiest && labels.has(busiest[0])) cellSel.value = busiest[0];
    const playBtn = el('button', '', '▶ 재생');
    const speedSel = el('select');
    for (const [ms, label] of [[600, '느리게'], [250, '보통'], [80, '빠르게']]) {
      const opt = el('option', '', label);
      opt.value = ms;
      speedSel.append(opt);
    }
    speedSel.value = '250';
    const slider = el('input');
    slider.type = 'range';
    slider.min = 0;
    bar.append(cellSel, playBtn, speedSel, slider);
    const info = el('div', 'replay-info');
    const view = el('pre', 'code-view');
    panel.append(bar, info, view);

    let steps = [];
    let timer = null;

    const show = (n) => {
      const step = steps[n];
      const e = step.edit;
      let html;
      if (e && e[4]) {
        const from = e[2];
        const to = from + e[4].length;
        const src = step.source;
        html = `${escapeHtml(src.slice(0, from))}<mark class="${e[5] === 'p' ? 'paste' : ''}">${escapeHtml(src.slice(from, to))}</mark>${escapeHtml(src.slice(to))}`;
      } else {
        html = escapeHtml(step.source);
      }
      view.innerHTML = html || '<span class="meta">(빈 셀)</span>';
      if (!e) {
        info.textContent = `처음 상태 · ${steps.length - 1}단계 기록됨`;
      } else {
        const kind = KIND_LABEL[e[5]] || e[5];
        const cps = e[5] === 'i' && e[6] > 0 ? ` · 초당 ${(e[4].length / (e[6] / 1000)).toFixed(1)}자` : '';
        info.innerHTML = `${n}/${steps.length - 1}단계 · ${escapeHtml(fmtTime(rec, step.t))} · <span class="kind-${e[5]}">${escapeHtml(kind)}</span>${e[4] ? ` ${e[4].length}자` : ''}${e[3] ? ` (지운 글자 ${e[3]}자)` : ''}${cps}`;
      }
    };

    const stop = () => {
      clearInterval(timer);
      timer = null;
      playBtn.textContent = '▶ 재생';
    };
    stopReplay = stop;

    const load = () => {
      stop();
      steps = I.cellTimeline(rec, cellSel.value);
      slider.max = steps.length - 1;
      slider.value = steps.length - 1;
      show(steps.length - 1);
    };

    cellSel.addEventListener('change', load);
    slider.addEventListener('input', () => { stop(); show(+slider.value); });
    playBtn.addEventListener('click', () => {
      if (timer) return stop();
      if (+slider.value >= steps.length - 1) slider.value = 0;
      playBtn.textContent = '❚❚ 멈춤';
      show(+slider.value);
      timer = setInterval(() => {
        if (+slider.value >= steps.length - 1) return stop();
        slider.value = +slider.value + 1;
        show(+slider.value);
      }, +speedSel.value);
    });
    speedSel.addEventListener('change', () => { if (timer) { stop(); playBtn.click(); } });
    load();
  }

  function renderTimeline(panel, sub) {
    const rec = sub.analysis.record;
    const labels = cellLabels(sub);
    const label = (id) => labels.get(id) || '셀';
    const rows = [];

    for (const ev of rec.events) {
      let text = '';
      let level = '';
      let detailText = null;
      switch (ev.type) {
        case 'session': text = '노트북 열기(접속)'; break;
        case 'away':
          if (ev.ms < 1000) continue;
          text = `다른 탭·창으로 이동 (${I.fmtDuration(ev.ms)})`;
          level = ev.ms > 60000 ? 'high' : '';
          break;
        case 'paste':
          text = `${label(ev.cell)}에 ${ev.internal ? '내부' : '외부'} 붙여넣기 (${ev.chars}자)`;
          level = ev.internal ? '' : 'high';
          detailText = ev.text;
          break;
        case 'paste-blocked':
          text = `${label(ev.cell)} 붙여넣기 차단됨 (${ev.chars}자)`;
          level = 'high';
          detailText = ev.text;
          break;
        case 'run': text = `${label(ev.cell)} 실행 · ${ev.ok ? '성공' : `오류${ev.ename ? `: ${ev.ename}` : ''}`}`; break;
        case 'cell-add': text = `${label(ev.cell)} 추가`; break;
        case 'cell-delete': text = '셀 삭제'; detailText = ev.source; break;
        case 'file-open': text = `다른 파일 열기: ${ev.name}${ev.hadRecord ? ' (작성 기록 포함 파일)' : ''}`; level = 'high'; break;
        case 'new-notebook': text = '새 노트북 만들기'; break;
        case 'interrupt': text = '실행 중단'; break;
        case 'submit': text = '제출'; break;
        case 'unsubmit': text = '제출 취소'; break;
        default: text = ev.type;
      }
      rows.push({ t: ev.t, text, level, detailText });
    }
    for (const e of rec.edits) {
      if (e[5] !== 'i' || e[4].length < 40) continue;
      const cps = e[6] > 0 ? e[4].length / (e[6] / 1000) : Infinity;
      if (cps <= 15) continue;
      rows.push({
        t: e[0],
        text: `${label(e[1])}에 ${e[6] > 0 ? `매우 빠른 입력 (초당 ${cps.toFixed(0)}자)` : '한꺼번에 입력'} ${e[4].length}자`,
        level: 'high',
        detailText: e[4],
      });
    }
    rows.sort((x, y) => x.t - y.t);

    const table = el('table', 'timeline');
    for (const r of rows) {
      const tr = el('tr', r.level);
      tr.append(el('td', 'time', fmtTime(rec, r.t)));
      const td = el('td');
      if (r.detailText) {
        const det = el('details');
        det.append(el('summary', '', r.text), el('pre', 'code-view', r.detailText));
        td.append(det);
      } else {
        td.textContent = r.text;
      }
      tr.append(td);
      table.append(tr);
    }
    panel.append(table);
  }

  // ---------------------------------------------------------------- 과제 템플릿 설정

  let templateJson = null;
  let templateFileName = '';

  $('#templateFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      if (!Array.isArray(json.cells)) throw new Error('노트북 형식이 아니에요');
      templateJson = json;
      templateFileName = file.name;
      const policy = { ...I.defaultPolicy(), ...((json.metadata && json.metadata.pyclass && json.metadata.pyclass.policy) || {}) };
      $('#optBlockPaste').checked = policy.blockPaste;
      $('#optBlockOpen').checked = !policy.allowFileOpen;
      $('#templateName').textContent = `${file.name} (다른 파일 열기)`;
      $('#templateOptions').disabled = false;
    } catch (err) {
      toast(`파일을 열 수 없어요: ${err.message}`);
    }
  });

  $('#templateDownload').addEventListener('click', () => {
    if (!templateJson) return;
    const json = JSON.parse(JSON.stringify(templateJson));
    json.metadata = json.metadata || {};
    const policy = { blockPaste: $('#optBlockPaste').checked, allowFileOpen: !$('#optBlockOpen').checked };
    if ($('#optClean').checked) {
      json.metadata.pyclass = { version: 1, policy };
      for (const c of json.cells) {
        if (c.cell_type === 'code') {
          c.outputs = [];
          c.execution_count = null;
        }
      }
    } else {
      json.metadata.pyclass = { ...(json.metadata.pyclass || {}), version: 1, policy };
    }
    const blob = new Blob([JSON.stringify(json, null, 1)], { type: 'application/x-ipynb+json' });
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = templateFileName;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('설정을 넣은 과제 파일을 다운로드했어요');
  });
})();
