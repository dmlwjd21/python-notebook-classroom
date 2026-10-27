// 작성 과정 기록(학생 화면)과 기록 분석(교사 검토 화면)에서 함께 쓰는 코드.
// 기록은 노트북의 metadata.pyclass 안에 저장되어 .ipynb 파일과 함께 제출된다.
//
// metadata.pyclass = {
//   version: 1,
//   policy: { blockPaste, allowFileOpen },          // 과제 설정 (교사가 템플릿에 넣음)
//   record: {
//     t0,                                            // 기록 시작 시각(epoch ms). 아래 t는 모두 t0 기준 ms
//     baseline: { cellId: source },                  // 기록 시작 시점의 셀 내용
//     events: [{ t, type, ... }],                    // 붙여넣기, 탭 이탈, 실행 등
//     edits: [[t, cellId, from, removedLen, inserted, kind, dur]],  // 입력 과정
//   }
// }
(function () {
  'use strict';

  const MAX_SNIPPET = 2000;       // 붙여넣은 내용은 앞부분만 저장
  const MERGE_MS = 2000;          // 이 간격 안의 연속 타이핑은 하나로 묶어 저장
  const MIN_AWAY_MS = 1000;       // 이보다 짧은 이탈은 요약에서 제외
  const FAST_CPS = 15;            // 초당 이 글자 수를 넘는 입력은 사람이 치기 어려움
  const FAST_MIN_CHARS = 40;
  const BULK_MIN_CHARS = 40;      // 붙여넣기가 아닌데 한 번에 들어온 긴 입력

  const KIND = { paste: 'p', cut: 'x', '+delete': 'd', undo: 'u', redo: 'u', drag: 'm', setValue: 's' };

  // record: 작성 과정 기록 여부 (수업 자료는 끌 수 있음)
  const defaultPolicy = () => ({ blockPaste: false, allowFileOpen: true, record: true });

  function normalize(text) {
    return String(text).replace(/\r\n?/g, '\n').trim();
  }

  function newRecord(nb) {
    const baseline = {};
    for (const c of nb.cells) baseline[c.id] = c.source;
    return { t0: Date.now(), baseline, events: [], edits: [] };
  }

  function ensureMeta(nb) {
    nb.metadata = nb.metadata || {};
    const p = nb.metadata.pyclass || (nb.metadata.pyclass = {});
    p.version = 1;
    p.policy = { ...defaultPolicy(), ...(p.policy || {}) };
    if (!p.record) p.record = newRecord(nb);
    return p;
  }

  // ------------------------------------------------------------ 학생 화면: 기록기

  class Recorder {
    constructor(getNotebook, { onChange, toast }) {
      this.getNotebook = getNotebook;
      this.onChange = onChange || (() => {});
      this.toast = toast || (() => {});
      this.clips = [];            // 이 페이지 안에서 복사한 텍스트(내부 붙여넣기 판별용)
      this.awayStart = null;
      this.ignoreFocusLoss = false;
    }

    get meta() { return ensureMeta(this.getNotebook()); }
    get rec() { return this.meta.record; }
    get policy() { return this.meta.policy; }

    rel() { return Date.now() - this.rec.t0; }

    get recording() { return this.policy.record !== false; }

    log(type, data = {}) {
      if (!this.recording) return;
      this.rec.events.push({ t: this.rel(), type, ...data });
      this.onChange();
    }

    rememberClip(text) {
      const n = normalize(text);
      if (!n) return;
      this.clips.push(n);
      if (this.clips.length > 30) this.clips.shift();
    }

    isInternal(text) {
      const n = normalize(text);
      if (!n) return true;
      return this.clips.some((c) => c === n || c.includes(n));
    }

    attachEditor(cellId, cm) {
      const clipFromEditor = (ed) => {
        if (ed.somethingSelected()) return ed.getSelection();
        return ed.listSelections().map((r) => `${ed.getLine(r.head.line)}\n`).join('');
      };
      cm.on('copy', (ed) => this.rememberClip(clipFromEditor(ed)));
      cm.on('cut', (ed) => this.rememberClip(clipFromEditor(ed)));

      cm.on('beforeChange', (ed, change) => {
        if (change.origin !== 'paste') return;
        const text = change.text.join('\n');
        const internal = this.isInternal(text);
        if (!internal && this.policy.blockPaste) {
          change.cancel();
          this.log('paste-blocked', { cell: cellId, chars: text.length, text: text.slice(0, MAX_SNIPPET) });
          this.toast('이 과제에서는 외부에서 복사한 내용을 붙여넣을 수 없어요');
          return;
        }
        this.log('paste', { cell: cellId, chars: text.length, internal, text: text.slice(0, MAX_SNIPPET) });
      });

      cm.on('change', (ed, change) => this.recordEdit(cellId, ed, change));
    }

    recordEdit(cellId, ed, change) {
      if (!this.recording) return;
      const t = this.rel();
      const from = ed.indexFromPos(change.from);
      const removed = change.removed.join('\n').length;
      const ins = change.text.join('\n');
      const kind = KIND[change.origin] || 'i';
      const edits = this.rec.edits;
      const last = edits[edits.length - 1];

      if (last && last[1] === cellId && t - (last[0] + last[6]) < MERGE_MS) {
        // 이어서 타이핑: 직전 입력 안쪽을 고치거나(한글 조합 포함) 바로 뒤에 덧붙이는 경우
        if (kind === 'i' && last[5] === 'i' && from >= last[2] && from + removed <= last[2] + last[4].length) {
          const at = from - last[2];
          last[4] = last[4].slice(0, at) + ins + last[4].slice(at + removed);
          last[6] = t - last[0];
          this.onChange();
          return;
        }
        // 연속 지우기(Backspace)
        if (kind === 'd' && last[5] === 'd' && !ins && from + removed === last[2]) {
          last[2] = from;
          last[3] += removed;
          last[6] = t - last[0];
          this.onChange();
          return;
        }
      }
      edits.push([t, cellId, from, removed, ins, kind, 0]);
      this.onChange();
    }

    attachWindow() {
      document.addEventListener('copy', () => {
        // 출력, 문제 설명 등 편집기 밖에서 복사한 내용
        const sel = window.getSelection && window.getSelection().toString();
        if (sel) this.rememberClip(sel);
      });
      document.addEventListener('cut', () => {
        const sel = window.getSelection && window.getSelection().toString();
        if (sel) this.rememberClip(sel);
      });
      const leave = () => {
        if (this.ignoreFocusLoss || this.awayStart != null) return;
        this.awayStart = Date.now();
      };
      const back = () => {
        if (this.awayStart == null) return;
        const start = this.awayStart;
        this.awayStart = null;
        const ms = Date.now() - start;
        if (!this.recording) return;
        this.rec.events.push({ t: start - this.rec.t0, type: 'away', ms });
        this.onChange();
      };
      document.addEventListener('visibilitychange', () => (document.hidden ? leave() : document.hasFocus() && back()));
      window.addEventListener('blur', leave);
      window.addEventListener('focus', () => {
        back();
        if (this.ignoreFocusLoss === 'until-focus') this.ignoreFocusLoss = false;
      });
      window.addEventListener('pagehide', back);
    }

    // 파일 선택창, 확인창처럼 플랫폼이 직접 띄운 창 때문에 생기는 포커스 이동은 이탈로 보지 않는다.
    suspendUntilFocus() {
      this.ignoreFocusLoss = 'until-focus';
    }

    withoutAwayTracking(fn) {
      this.ignoreFocusLoss = true;
      try {
        return fn();
      } finally {
        setTimeout(() => { this.ignoreFocusLoss = false; }, 300);
      }
    }
  }

  // ------------------------------------------------------------ 교사 화면: 분석

  function applyEdit(src, e) {
    return src.slice(0, e[2]) + e[4] + src.slice(e[2] + e[3]);
  }

  // 셀의 처음 내용(기록 시작 시점 또는 셀을 추가한 시점)
  function initialSource(record, cellId) {
    if (Object.prototype.hasOwnProperty.call(record.baseline, cellId)) return record.baseline[cellId];
    const add = record.events.find((ev) => ev.type === 'cell-add' && ev.cell === cellId);
    return add ? add.source || '' : '';
  }

  // 셀 하나의 작성 과정: [{ t, source, edit }] (0번째는 처음 상태)
  function cellTimeline(record, cellId) {
    let src = initialSource(record, cellId);
    const steps = [{ t: 0, source: src, edit: null }];
    for (const e of record.edits) {
      if (e[1] !== cellId) continue;
      src = applyEdit(src, e);
      steps.push({ t: e[0] + e[6], source: src, edit: e });
    }
    return steps;
  }

  function fmtDuration(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}초`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}분 ${s % 60}초`;
    return `${Math.floor(m / 60)}시간 ${m % 60}분`;
  }

  function analyze(nb) {
    const p = nb.metadata && nb.metadata.pyclass;
    if (!p || !p.record) return { hasRecord: false, flags: [{ level: 'high', text: '작성 기록이 없어요 (이 플랫폼 밖에서 만든 파일일 수 있어요)' }] };
    const rec = p.record;
    const ev = rec.events;
    const s = {
      pasteExternal: 0, pasteExternalChars: 0, pasteInternal: 0, pasteBlocked: 0,
      awayCount: 0, awayMs: 0, runs: 0, runErrors: 0, fileOpens: 0,
      typedChars: 0, fastBursts: 0, bulkInserts: 0, mismatchCells: [],
    };
    for (const e of ev) {
      if (e.type === 'paste') {
        if (e.internal) s.pasteInternal += 1;
        else { s.pasteExternal += 1; s.pasteExternalChars += e.chars; }
      } else if (e.type === 'paste-blocked') s.pasteBlocked += 1;
      else if (e.type === 'away' && e.ms >= MIN_AWAY_MS) { s.awayCount += 1; s.awayMs += e.ms; }
      else if (e.type === 'run') { s.runs += 1; if (!e.ok) s.runErrors += 1; }
      else if (e.type === 'file-open') s.fileOpens += 1;
    }
    for (const e of rec.edits) {
      if (e[5] !== 'i') continue;
      const len = e[4].length;
      s.typedChars += len;
      if (len >= FAST_MIN_CHARS && e[6] > 0 && len / (e[6] / 1000) > FAST_CPS) s.fastBursts += 1;
      else if (len >= BULK_MIN_CHARS && e[6] === 0) s.bulkInserts += 1;
    }
    for (const c of nb.cells) {
      const steps = cellTimeline(rec, c.id);
      if (steps[steps.length - 1].source !== c.source) s.mismatchCells.push(c.id);
    }
    const allT = ev.map((e) => e.t).concat(rec.edits.map((e) => e[0] + e[6]));
    s.span = allT.length ? Math.max(...allT) : 0;

    const flags = [];
    if (s.mismatchCells.length) flags.push({ level: 'high', text: `기록과 최종 코드가 달라요 (${s.mismatchCells.length}개 셀): 기록 조작 가능성` });
    if (s.pasteExternal) flags.push({ level: 'high', text: `외부 붙여넣기 ${s.pasteExternal}회 (${s.pasteExternalChars}자)` });
    if (s.pasteBlocked) flags.push({ level: 'mid', text: `차단된 붙여넣기 시도 ${s.pasteBlocked}회` });
    if (s.fastBursts) flags.push({ level: 'high', text: `사람이 치기 어려운 속도의 입력 ${s.fastBursts}회 (자동 입력 프로그램 의심)` });
    if (s.bulkInserts) flags.push({ level: 'mid', text: `붙여넣기가 아닌 한꺼번에 들어온 입력 ${s.bulkInserts}회` });
    if (s.fileOpens) flags.push({ level: 'mid', text: `다른 .ipynb 파일 열기 ${s.fileOpens}회` });
    if (s.awayCount) flags.push({ level: s.awayMs > 60000 ? 'mid' : 'low', text: `다른 탭·창 이동 ${s.awayCount}회 (총 ${fmtDuration(s.awayMs)})` });
    return { hasRecord: true, record: rec, policy: p.policy, summary: s, flags };
  }

  window.PyClassIntegrity = { Recorder, ensureMeta, newRecord, analyze, cellTimeline, initialSource, fmtDuration, defaultPolicy };
})();
