// 알고리즘 보기: 코드 셀 옆에 순서도 / 의사코드를 실시간으로 보여준다.
// AI가 아니라 정해진 규칙으로 파이썬 구조(if·for·while·def·입출력·대입)를 바꾸므로 같은 코드는 항상 같은 결과가 나온다.
(() => {
  'use strict';

  const MODE_KEY = 'pyclass:algo-mode';
  const VIEW_KEY = 'pyclass:algo-view';
  const RENDER_DELAY = 250;

  // ================================================================ 1. 파이썬 코드 → 구조(트리)

  // 문자열 바깥 부분에만 변환을 적용 (문자열 안의 ==, and 등은 그대로)
  function segments(text) {
    const out = [];
    let buf = '';
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"' || ch === "'") {
        if (buf) { out.push({ s: buf, str: false }); buf = ''; }
        const q = text.substr(i, 3) === ch.repeat(3) ? ch.repeat(3) : ch;
        let j = i + q.length;
        while (j < text.length) {
          if (text[j] === '\\') { j += 2; continue; }
          if (text.substr(j, q.length) === q) { j += q.length; break; }
          j++;
        }
        out.push({ s: text.slice(i, j), str: true });
        i = j;
      } else {
        buf += ch;
        i++;
      }
    }
    if (buf) out.push({ s: buf, str: false });
    return out;
  }
  const mapCode = (text, fn) => segments(text).map((p) => (p.str ? p.s : fn(p.s))).join('');

  // 괄호·문자열 밖에서 조건에 맞는 첫 위치
  function findTop(text, test) {
    let depth = 0;
    let pos = 0;
    for (const p of segments(text)) {
      if (!p.str) {
        for (let k = 0; k < p.s.length; k++) {
          const ch = p.s[k];
          if ('([{'.includes(ch)) depth++;
          else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
          else if (depth === 0 && test(text, pos + k)) return pos + k;
        }
      }
      pos += p.s.length;
    }
    return -1;
  }

  function splitTop(text, sep) {
    const parts = [];
    let rest = text;
    for (;;) {
      const at = findTop(rest, (t, i) => t[i] === sep);
      if (at < 0) { parts.push(rest); break; }
      parts.push(rest.slice(0, at));
      rest = rest.slice(at + 1);
    }
    return parts.map((s) => s.trim()).filter((s) => s !== '');
  }

  // 여러 줄에 걸친 괄호·문자열, 주석, \ 줄잇기를 정리해 "논리적인 한 줄" 목록으로
  function logicalLines(src) {
    const lines = [];
    let cur = '';
    let depth = 0;
    let indent = 0;
    let lineStart = true;
    let i = 0;
    const n = src.length;
    while (i < n) {
      const ch = src[i];
      if (lineStart) {
        let k = i;
        let ind = 0;
        while (k < n && (src[k] === ' ' || src[k] === '\t')) { ind += src[k] === '\t' ? 4 : 1; k++; }
        if (cur === '' && depth === 0) indent = ind;
        else if (cur && !cur.endsWith(' ')) cur += ' ';
        i = k;
        lineStart = false;
        continue;
      }
      if (ch === '#') { while (i < n && src[i] !== '\n') i++; continue; }
      if (ch === '"' || ch === "'") {
        const triple = src.substr(i, 3) === ch.repeat(3);
        const q = triple ? ch.repeat(3) : ch;
        let j = i + q.length;
        while (j < n) {
          if (src[j] === '\\') { j += 2; continue; }
          if (src.substr(j, q.length) === q) { j += q.length; break; }
          if (!triple && src[j] === '\n') break;
          j++;
        }
        cur += src.slice(i, j).replace(/\n/g, ' ');
        i = j;
        continue;
      }
      if (ch === '\\' && src[i + 1] === '\n') { i += 2; lineStart = true; continue; }
      if (ch === '\n') {
        i++;
        lineStart = true;
        if (depth > 0) continue;
        if (cur.trim()) lines.push({ indent, text: cur.trim() });
        cur = '';
        continue;
      }
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
      cur += ch;
      i++;
    }
    if (cur.trim()) lines.push({ indent, text: cur.trim() });
    // 문서 문자열(따옴표만 있는 줄)은 동작과 관계없으므로 뺀다
    return lines.filter((l) => !/^[rbuRBUfF]*("""|'''|"|')[\s\S]*\1$/.test(l.text) || segments(l.text).some((p) => !p.str && p.s.trim()));
  }

  const HEADER = /^(if|elif|else|for|while|def|class|try|except|finally|with|async\s+def|async\s+for|async\s+with)\b/;

  function parseLine(text) {
    const m = text.match(HEADER);
    if (m) {
      const colon = findTop(text, (t, i) => t[i] === ':' && !/\blambda\b[^:]*$/.test(t.slice(0, i)));
      if (colon >= 0) {
        const head = text.slice(0, colon).trim();
        const inline = text.slice(colon + 1).trim();
        const kw = m[1].replace(/^async\s+/, '');
        const rest = head.slice(m[1].length).trim();
        let st;
        if (kw === 'if' || kw === 'elif' || kw === 'while') st = { kind: kw, cond: rest };
        else if (kw === 'else') st = { kind: 'else' };
        else if (kw === 'for') {
          const at = findTop(rest, (t, i) => t.slice(i, i + 4) === ' in ' );
          st = at >= 0 ? { kind: 'for', target: rest.slice(0, at).trim(), iter: rest.slice(at + 4).trim() } : { kind: 'block', label: head };
        } else if (kw === 'def') {
          const dm = rest.match(/^(\w+)\s*\((.*)\)\s*(->.*)?$/);
          st = dm ? { kind: 'def', name: dm[1], params: dm[2].trim() } : { kind: 'block', label: head };
        } else st = { kind: 'block', label: head };
        st.header = true;
        st.inline = inline;
        return st;
      }
    }
    if (/^(import\s|from\s+\S+\s+import\s)/.test(text)) return { kind: 'import', text };
    if (text === 'pass') return { kind: 'pass' };
    if (text === 'break') return { kind: 'break' };
    if (text === 'continue') return { kind: 'continue' };
    if (/^return\b/.test(text)) return { kind: 'return', value: text.slice(6).trim() };
    return { kind: 'simple', text };
  }

  function buildTree(lines) {
    let pos = 0;
    function block(indent) {
      const out = [];
      while (pos < lines.length && lines[pos].indent >= indent) {
        const ln = lines[pos++];
        const parts = splitTop(ln.text, ';');
        const sts = parts.map(parseLine);
        for (const st of sts) {
          if (st.header) {
            if (st.inline) st.body = splitTop(st.inline, ';').map(parseLine);
            else if (pos < lines.length && lines[pos].indent > ln.indent) st.body = block(lines[pos].indent);
            else st.body = [];
          }
          out.push(st);
        }
      }
      return combine(out);
    }
    return block(lines.length ? lines[0].indent : 0);
  }

  // if / elif / else 를 하나로 묶는다
  function combine(sts) {
    const out = [];
    for (const st of sts) {
      const last = out[out.length - 1];
      if (st.kind === 'if') out.push({ kind: 'ifchain', branches: [{ cond: st.cond, body: st.body }], orelse: null });
      else if (st.kind === 'elif' && last && last.kind === 'ifchain' && !last.orelse) last.branches.push({ cond: st.cond, body: st.body });
      else if (st.kind === 'else' && last && last.kind === 'ifchain' && !last.orelse) last.orelse = st.body;
      else if (st.kind === 'else' && last && (last.kind === 'for' || last.kind === 'while')) last.orelse = st.body;
      else if (st.kind === 'elif' || st.kind === 'else') out.push({ kind: 'block', label: st.kind === 'else' ? 'else' : `elif ${st.cond}`, body: st.body });
      else out.push(st);
    }
    return out;
  }

  function parse(src) {
    return buildTree(logicalLines(src));
  }

  function collectDefs(sts, out = []) {
    for (const st of sts) {
      if (st.kind === 'def') out.push(st);
      if (st.body) collectDefs(st.body, out);
      if (st.branches) st.branches.forEach((b) => collectDefs(b.body, out));
      if (st.orelse) collectDefs(st.orelse, out);
    }
    return out;
  }

  // ================================================================ 2. 문장 → 순서도·의사코드 글

  const cond = (t) => mapCode(t, (s) => s
    .replace(/!=/g, '≠').replace(/>=/g, '≥').replace(/<=/g, '≤').replace(/==/g, '=')
    .replace(/\bnot\s+in\b/g, '∉').replace(/\band\b/g, '그리고').replace(/\bor\b/g, '또는').replace(/\bnot\b/g, '아님'));

  const PLT = {
    figure: '그래프 준비', bar: '막대그래프 그리기', barh: '가로 막대그래프 그리기', plot: '꺾은선 그래프 그리기',
    scatter: '산점도 그리기', hist: '히스토그램 그리기', pie: '원그래프 그리기', title: '제목 설정',
    xlabel: 'x축 이름 설정', ylabel: 'y축 이름 설정', legend: '범례 표시', grid: '그리드 표시',
    xticks: 'x축 눈금 설정', yticks: 'y축 눈금 설정', xlim: 'x축 범위 설정', ylim: 'y축 범위 설정',
    subplot: '그래프 칸 나누기', tight_layout: '그래프 간격 맞추기', savefig: '그래프 파일로 저장',
  };

  function callInfo(text) {
    const m = text.match(/^([\w.]+)\s*\(([\s\S]*)\)$/);
    return m ? { fn: m[1], args: m[2].trim() } : null;
  }

  function assignParts(text) {
    const aug = findTop(text, (t, i) => /^(\*\*|\/\/|>>|<<|[+\-*/%@&|^])=/.test(t.slice(i)) && t[i - 1] !== '=' && !/[<>!=]/.test(t[i - 1] || ''));
    if (aug >= 0) {
      const op = text.slice(aug).match(/^(\*\*|\/\/|>>|<<|[+\-*/%@&|^])=/)[1];
      const target = text.slice(0, aug).trim();
      if (/^[\w.[\]'"\s,()]+$/.test(target)) return { target, op, value: text.slice(aug + op.length + 1).trim() };
    }
    const eq = findTop(text, (t, i) => t[i] === '=' && t[i + 1] !== '=' && !'=!<>+-*/%@&|^:'.includes(t[i - 1] || ''));
    if (eq > 0) return { target: text.slice(0, eq).trim(), value: text.slice(eq + 1).trim() };
    return null;
  }

  // 순서도 상자 하나: { shape, text }
  function describe(st, userFns) {
    const text = st.text;
    const call = callInfo(text);
    if (call && call.fn === 'print') return { shape: 'io', text: `출력: ${call.args || '(빈 줄)'}`, pseudo: `${call.args || '빈 줄'} 출력` };
    if (call) {
      const pm = call.fn.match(/^(?:plt|pyplot|matplotlib\.pyplot)\.(\w+)$/);
      if (pm && pm[1] === 'show') return { shape: 'io', text: '그래프 출력', pseudo: '그래프 출력' };
      if (pm && PLT[pm[1]]) return { shape: 'process', text: `${PLT[pm[1]]}${call.args ? `: ${call.args}` : ''}`, pseudo: `${PLT[pm[1]]}${call.args ? ` (${call.args})` : ''}` };
      if (userFns.has(call.fn)) return { shape: 'sub', text: `${call.fn}(${call.args}) 실행`, pseudo: `함수 ${call.fn}(${call.args}) 실행` };
    }
    const asg = assignParts(text);
    if (asg) {
      if (/\binput\s*\(/.test(asg.value)) {
        const prompt = (asg.value.match(/input\s*\(\s*((["']).*?\2)?/) || [])[1];
        return { shape: 'io', text: `입력: ${asg.target}`, pseudo: `${asg.target} 입력받기${prompt ? ` (안내: ${prompt})` : ''}` };
      }
      const value = asg.op ? `${asg.target} ${asg.op} ${asg.value}` : asg.value;
      const vcall = callInfo(asg.value);
      const shape = vcall && userFns.has(vcall.fn) ? 'sub' : 'process';
      return { shape, text: `${asg.target} ← ${value}`, pseudo: `${asg.target} ← ${value}` };
    }
    if (/\binput\s*\(/.test(text)) return { shape: 'io', text: '입력', pseudo: '입력받기' };
    return { shape: 'process', text, pseudo: text };
  }

  function rangeText(target, iter) {
    const call = callInfo(iter);
    if (call && call.fn === 'range') {
      const a = splitTop(call.args, ',');
      const num = (s) => (/^-?\d+$/.test(s) ? Number(s) : null);
      let start = '0';
      let stop;
      let step = '1';
      if (a.length === 1) [stop] = a;
      else if (a.length === 2) [start, stop] = a;
      else if (a.length >= 3) [start, stop, step] = a;
      else return null;
      const st = num(step);
      const down = st != null && st < 0;
      const last = num(stop) != null ? String(num(stop) + (down ? 1 : -1)) : `${stop} ${down ? '+' : '-'} 1`;
      const stepText = step === '1' ? '' : (down ? ` (${-st}씩 줄이며)` : ` (${step}씩)`);
      return {
        flow: `${target} : ${start} → ${last}${step === '1' ? '' : `, ${step}씩`}`,
        pseudo: `${target}를 ${start}부터 ${last}까지${stepText} 바꾸며 반복`,
      };
    }
    return { flow: `${target} : ${iter}의 각 값`, pseudo: `${iter}의 각 값을 ${target}에 넣으며 반복` };
  }

  // ================================================================ 3. 의사코드

  function pseudocode(sts, userFns) {
    const out = [];
    const put = (depth, text, cls = '') => out.push({ depth, text, cls });
    function walk(list, d) {
      for (const st of list) {
        switch (st.kind) {
          case 'import': case 'pass': break;
          case 'simple': put(d, describe(st, userFns).pseudo); break;
          case 'break': put(d, '반복 멈추기', 'kw'); break;
          case 'continue': put(d, '다음 반복으로 건너뛰기', 'kw'); break;
          case 'return': put(d, st.value ? `${st.value} 돌려주기` : '함수 끝내기', 'kw'); break;
          case 'ifchain':
            st.branches.forEach((b, i) => {
              put(d, `${i === 0 ? '만약' : '아니고 만약'} ${cond(b.cond)} 이면`, 'kw');
              walk(b.body, d + 1);
            });
            if (st.orelse) { put(d, '아니면', 'kw'); walk(st.orelse, d + 1); }
            break;
          case 'for': put(d, rangeText(st.target, st.iter).pseudo, 'kw'); walk(st.body, d + 1); if (st.orelse) { put(d, '반복을 다 마치면', 'kw'); walk(st.orelse, d + 1); } break;
          case 'while': put(d, `${cond(st.cond)} 인 동안 반복`, 'kw'); walk(st.body, d + 1); if (st.orelse) { put(d, '반복을 다 마치면', 'kw'); walk(st.orelse, d + 1); } break;
          case 'def': put(d, `함수 ${st.name}(${st.params}) 만들기`, 'kw'); walk(st.body, d + 1); break;
          case 'block': put(d, st.label, 'kw'); walk(st.body || [], d + 1); break;
          default: break;
        }
      }
    }
    walk(sts, 0);
    return out;
  }

  // ================================================================ 4. 순서도 배치와 그리기 (SVG)

  const FONT_SIZE = 12.5;
  const FONT = `${FONT_SIZE}px "Noto Sans KR", "Roboto", sans-serif`;
  const BOX_H = 34;
  const GAP = 22;
  const PADX = 14;
  const HGAP = 30;
  const LM = 22;
  const TOP = 14;
  const MAX_CHARS = 30;

  let measureCtx = null;
  function textW(t) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = FONT;
    return measureCtx.measureText(t).width;
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const trunc = (t) => (t.length > MAX_CHARS ? `${t.slice(0, MAX_CHARS - 1)}…` : t);

  let markerSeq = 0;

  function makeCtx() {
    const id = `algoArrow${++markerSeq}`;
    return {
      id,
      line: (x1, y1, x2, y2) => `<line class="fl-edge" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`,
      arrow: (x1, y1, x2, y2) => `<line class="fl-edge" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#${id})"/>`,
      path: (pts, arrowEnd) => `<polyline class="fl-edge" fill="none" points="${pts.map((p) => p.join(',')).join(' ')}"${arrowEnd ? ` marker-end="url(#${id})"` : ''}/>`,
      label: (x, y, t) => `<text class="fl-label" x="${x}" y="${y}">${esc(t)}</text>`,
    };
  }

  function nodeL(C, shape, fullText) {
    const t = trunc(fullText);
    const w0 = textW(t);
    let w;
    let h = BOX_H;
    if (shape === 'decision') { w = Math.max(96, w0 * 1.25 + 52); h = 50; }
    else if (shape === 'hex') { w = Math.max(96, w0 + 44); h = 38; }
    else if (shape === 'io' || shape === 'sub') w = Math.max(84, w0 + PADX * 2 + 18);
    else if (shape === 'terminal') w = Math.max(72, w0 + PADX * 2 + 8);
    else w = Math.max(64, w0 + PADX * 2);
    w = Math.round(w);
    return {
      w, h, ax: w / 2,
      draw(x, y, out) {
        const cx = x + w / 2;
        const cy = y + h / 2;
        let s;
        if (shape === 'terminal') s = `<rect class="fl-shape fl-terminal" x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}"/>`;
        else if (shape === 'decision') s = `<polygon class="fl-shape fl-decision" points="${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}"/>`;
        else if (shape === 'hex') s = `<polygon class="fl-shape fl-loop" points="${x + 14},${y} ${x + w - 14},${y} ${x + w},${cy} ${x + w - 14},${y + h} ${x + 14},${y + h} ${x},${cy}"/>`;
        else if (shape === 'io') s = `<polygon class="fl-shape fl-io" points="${x + 10},${y} ${x + w},${y} ${x + w - 10},${y + h} ${x},${y + h}"/>`;
        else if (shape === 'sub') s = `<rect class="fl-shape fl-process" x="${x}" y="${y}" width="${w}" height="${h}"/><line class="fl-shape-line" x1="${x + 8}" y1="${y}" x2="${x + 8}" y2="${y + h}"/><line class="fl-shape-line" x1="${x + w - 8}" y1="${y}" x2="${x + w - 8}" y2="${y + h}"/>`;
        else if (shape === 'jump') s = `<rect class="fl-shape fl-jump" x="${x}" y="${y}" width="${w}" height="${h}" rx="4"/>`;
        else s = `<rect class="fl-shape fl-process" x="${x}" y="${y}" width="${w}" height="${h}" rx="2"/>`;
        out.push(`<g><title>${esc(fullText)}</title>${s}<text class="fl-text" x="${cx}" y="${cy}">${esc(t)}</text></g>`);
      },
    };
  }

  const EMPTY = { w: 0, h: 0, ax: 0, empty: true, draw() {} };

  function seqL(C, items) {
    items = items.filter((c) => c && !c.empty);
    if (!items.length) return EMPTY;
    const ax = Math.max(...items.map((c) => c.ax));
    const offs = items.map((c) => ax - c.ax);
    const w = Math.max(...items.map((c, i) => offs[i] + c.w));
    const h = items.reduce((s, c) => s + c.h, 0) + GAP * (items.length - 1);
    return {
      w, h, ax,
      draw(x, y, out) {
        let cy = y;
        items.forEach((c, i) => {
          if (i > 0) out.push(C.arrow(x + ax, cy - GAP, x + ax, cy));
          c.draw(x + offs[i], cy, out);
          cy += c.h + GAP;
        });
      },
    };
  }

  function ifL(C, condText, thenL, elseL) {
    const d = nodeL(C, 'decision', `${condText} ?`);
    const hasElse = elseL && !elseL.empty;
    const A = Math.max(d.w / 2, thenL.ax);
    const leftW = A + Math.max(d.w / 2, thenL.w - thenL.ax);
    const eX = leftW + HGAP;
    const eAx = hasElse ? eX + elseL.ax : eX;
    const w = hasElse ? eX + elseL.w : eX + 6;
    const bodyH = Math.max(thenL.h, hasElse ? elseL.h : 0);
    const h = d.h + GAP + bodyH + GAP;
    return {
      w, h, ax: A,
      draw(x, y, out) {
        d.draw(x + A - d.w / 2, y, out);
        const by = y + d.h + GAP;
        const mergeY = y + h - GAP / 2;
        if (thenL.empty) out.push(C.line(x + A, y + d.h, x + A, mergeY));
        else {
          out.push(C.arrow(x + A, y + d.h, x + A, by));
          thenL.draw(x + A - thenL.ax, by, out);
          out.push(C.line(x + A, by + thenL.h, x + A, mergeY));
        }
        out.push(C.label(x + A + 5, y + d.h + 13, '예'));
        const ry = y + d.h / 2;
        out.push(C.line(x + A + d.w / 2, ry, x + eAx, ry));
        out.push(C.label(x + A + d.w / 2 + 4, ry - 5, '아니오'));
        if (hasElse) {
          out.push(C.arrow(x + eAx, ry, x + eAx, by));
          elseL.draw(x + eX, by, out);
          out.push(C.line(x + eAx, by + elseL.h, x + eAx, mergeY));
        } else out.push(C.line(x + eAx, ry, x + eAx, mergeY));
        out.push(C.arrow(x + eAx, mergeY, x + A, mergeY));
        out.push(C.line(x + A, mergeY, x + A, y + h));
      },
    };
  }

  function loopL(C, shape, text, bodyL, yes, no) {
    const d = nodeL(C, shape, text);
    const A = LM + Math.max(d.w / 2, bodyL.ax);
    const right = A + Math.max(d.w / 2, bodyL.w - bodyL.ax);
    const exitX = right + HGAP * 0.8;
    const w = exitX + 6;
    const h = TOP + d.h + GAP + (bodyL.empty ? 0 : bodyL.h) + GAP + 16;
    return {
      w, h, ax: A,
      draw(x, y, out) {
        const dy = y + TOP;
        out.push(C.line(x + A, y, x + A, dy));
        d.draw(x + A - d.w / 2, dy, out);
        const by = dy + d.h + GAP;
        let bottom;
        if (bodyL.empty) bottom = dy + d.h + GAP / 2;
        else {
          out.push(C.arrow(x + A, dy + d.h, x + A, by));
          bodyL.draw(x + A - bodyL.ax, by, out);
          bottom = by + bodyL.h;
        }
        out.push(C.label(x + A + 5, dy + d.h + 13, yes));
        const backY = bottom + GAP / 2;
        out.push(C.path([[x + A, bottom], [x + A, backY], [x + LM / 2, backY], [x + LM / 2, y + TOP / 2], [x + A, y + TOP / 2]], true));
        const ry = dy + d.h / 2;
        const exitY = y + h - 6;
        out.push(C.path([[x + A + d.w / 2, ry], [x + exitX, ry], [x + exitX, exitY], [x + A, exitY]], true));
        out.push(C.label(x + A + d.w / 2 + 4, ry - 5, no));
        out.push(C.line(x + A, exitY, x + A, y + h));
      },
    };
  }

  function stmtsL(C, sts, userFns) {
    const items = [];
    for (const st of sts) {
      switch (st.kind) {
        case 'import': case 'pass': case 'def': break;
        case 'simple': { const dsc = describe(st, userFns); items.push(nodeL(C, dsc.shape, dsc.text)); break; }
        case 'break': items.push(nodeL(C, 'jump', '반복 멈춤 (break)')); break;
        case 'continue': items.push(nodeL(C, 'jump', '다음 반복으로 (continue)')); break;
        case 'return': items.push(nodeL(C, 'terminal', st.value ? `반환: ${st.value}` : '반환')); break;
        case 'ifchain': {
          const build = (i) => {
            if (i >= st.branches.length) return st.orelse ? stmtsL(C, st.orelse, userFns) : EMPTY;
            const b = st.branches[i];
            return ifL(C, cond(b.cond), stmtsL(C, b.body, userFns), build(i + 1));
          };
          items.push(build(0));
          break;
        }
        case 'for': items.push(loopL(C, 'hex', rangeText(st.target, st.iter).flow, stmtsL(C, st.body, userFns), '반복', '끝')); if (st.orelse) items.push(stmtsL(C, st.orelse, userFns)); break;
        case 'while': items.push(loopL(C, 'decision', `${cond(st.cond)} ?`, stmtsL(C, st.body, userFns), '예', '아니오')); if (st.orelse) items.push(stmtsL(C, st.orelse, userFns)); break;
        case 'block': items.push(seqL(C, [nodeL(C, 'process', st.label), stmtsL(C, st.body || [], userFns)])); break;
        default: break;
      }
    }
    return seqL(C, items);
  }

  function chart(C, title, startText, sts, userFns, endText) {
    const last = sts[sts.length - 1];
    const parts = [nodeL(C, 'terminal', startText), stmtsL(C, sts, userFns)];
    if (!(last && last.kind === 'return')) parts.push(nodeL(C, 'terminal', endText));
    return { title, layout: seqL(C, parts) };
  }

  function flowchartSvg(tree) {
    const defs = collectDefs(tree);
    const userFns = new Set(defs.map((d) => d.name));
    const C = makeCtx();
    const charts = [chart(C, defs.length ? '메인' : '', '시작', tree, userFns, '끝')];
    for (const d of defs) charts.push(chart(C, `함수 ${d.name}`, `${d.name}(${d.params}) 시작`, d.body, userFns, '끝'));
    const PAD = 10;
    const TITLE_H = 20;
    const out = [];
    let x = PAD;
    let maxH = 0;
    for (const c of charts) {
      const th = c.title ? TITLE_H : 0;
      if (c.title) out.push(`<text class="fl-title" x="${x}" y="${PAD + 12}">${esc(c.title)}</text>`);
      c.layout.draw(x, PAD + th, out);
      x += c.layout.w + 36;
      maxH = Math.max(maxH, c.layout.h + th);
    }
    const W = Math.ceil(x - 36 + PAD);
    const H = Math.ceil(maxH + PAD * 2);
    return `<svg class="flowchart" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="순서도">`
      + `<defs><marker id="${C.id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="fl-arrowhead"/></marker></defs>`
      + `${out.join('')}</svg>`;
  }

  // ================================================================ 5. 화면 연결

  const notebookEl = document.getElementById('notebook');
  const toggle = document.getElementById('algoToggle');
  if (!notebookEl || !toggle) return;

  const App = window.PyClassApp;
  const toggleLabel = toggle.closest('label') || toggle;

  let enabled = false;   // 지금 화면에 보이는지
  let wanted = false;    // 학생이 체크해 둔 값 (브라우저에 기억)
  let forbidden = false; // 선생님이 이 과제에서 꺼 둠
  // 과제·수업 자료 화면은 선생님 설정을 불러오기 전까지 보류 (그 전에 순서도가 잠깐 보이지 않도록)
  let pending = !!(App && App.assignment);
  let view = 'flow';
  try {
    wanted = localStorage.getItem(MODE_KEY) === '1';
    view = localStorage.getItem(VIEW_KEY) === 'pseudo' ? 'pseudo' : 'flow';
  } catch { /* 저장 공간 없음 */ }

  const attached = new WeakMap(); // 셀 요소 → { cm, panel, timer }

  function render(cellEl) {
    const info = attached.get(cellEl);
    if (!info || !info.panel) return;
    const body = info.panel.querySelector('.algo-body');
    const src = info.cm.getValue();
    if (!src.trim()) {
      body.innerHTML = '<p class="algo-empty">코드를 쓰면 여기에 순서도가 나타나요.</p>';
      return;
    }
    try {
      const tree = parse(src);
      if (view === 'flow') {
        body.innerHTML = flowchartSvg(tree);
      } else {
        const defs = collectDefs(tree);
        const lines = pseudocode(tree, new Set(defs.map((d) => d.name)));
        body.innerHTML = lines.length
          ? `<ol class="algo-pseudo">${lines.map((l) => `<li class="${l.cls}" style="padding-left:${l.depth * 1.6}em">${esc(l.text)}</li>`).join('')}</ol>`
          : '<p class="algo-empty">순서도로 나타낼 문장이 없어요.</p>';
      }
    } catch (err) {
      console.warn(err);
      body.innerHTML = '<p class="algo-empty">이 코드는 아직 순서도로 바꿀 수 없어요.</p>';
    }
  }

  function makePanel() {
    const panel = document.createElement('div');
    panel.className = 'algo-panel';
    panel.innerHTML = `<div class="algo-tabs" role="tablist">
        <button type="button" data-view="flow">순서도</button>
        <button type="button" data-view="pseudo">의사코드</button>
      </div><div class="algo-body"></div>`;
    panel.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    return panel;
  }

  function attach(cellEl) {
    if (!cellEl.classList.contains('code')) return;
    const cmEl = cellEl.querySelector('.CodeMirror');
    if (!cmEl || !cmEl.CodeMirror) return;
    let info = attached.get(cellEl);
    if (!info) {
      info = { cm: cmEl.CodeMirror, panel: null, timer: null };
      attached.set(cellEl, info);
      info.cm.on('change', () => {
        if (!enabled) return;
        clearTimeout(info.timer);
        info.timer = setTimeout(() => render(cellEl), RENDER_DELAY);
      });
    }
    if (enabled && !info.panel) {
      info.panel = makePanel();
      cellEl.querySelector('.editor').after(info.panel);
      render(cellEl);
    }
  }

  function detachAll() {
    notebookEl.querySelectorAll('.cell.code').forEach((cellEl) => {
      const info = attached.get(cellEl);
      if (info && info.panel) { info.panel.remove(); info.panel = null; }
    });
  }

  function show(on) {
    enabled = on;
    toggle.checked = on;
    document.body.classList.toggle('algo-mode', on);
    if (on) notebookEl.querySelectorAll('.cell.code').forEach(attach);
    else detachAll();
    notebookEl.querySelectorAll('.CodeMirror').forEach((el) => el.CodeMirror && el.CodeMirror.refresh());
  }

  function applyAvailability() {
    toggleLabel.hidden = forbidden || pending;
    show(!forbidden && !pending && wanted);
  }

  // 선생님이 꺼 둔 과제에서 억지로 켜면(개발자 도구 등) 작성 기록에 남기고 다시 끈다
  let lastViolation = 0;
  function violation() {
    if (App && Date.now() - lastViolation > 10000) {
      lastViolation = Date.now();
      App.recorder.log('policy-violation', { feature: 'algo' });
      App.toast('이 과제에서는 알고리즘 보기를 쓸 수 없어요. 켜려고 한 기록이 남아요.');
    }
  }

  toggle.addEventListener('change', () => {
    if (forbidden || pending) {
      if (forbidden) violation();
      toggle.checked = false;
      return;
    }
    wanted = toggle.checked;
    try { localStorage.setItem(MODE_KEY, wanted ? '1' : '0'); } catch { /* 무시 */ }
    show(wanted);
  });

  window.addEventListener('pyclass:policy', (e) => {
    if (App && App.assignment && !e.detail.loaded) return;
    forbidden = e.detail.policy.algo === false;
    pending = false;
    applyAvailability();
  });

  setInterval(() => {
    if (!forbidden) return;
    if (document.body.classList.contains('algo-mode') || notebookEl.querySelector('.algo-panel, .flowchart, .algo-pseudo')) {
      violation();
      detachAll();
      notebookEl.querySelectorAll('.flowchart, .algo-pseudo, .algo-panel').forEach((n) => n.remove());
      enabled = false;
      document.body.classList.remove('algo-mode');
    }
  }, 2000);

  notebookEl.addEventListener('click', (e) => {
    const b = e.target.closest('.algo-tabs [data-view]');
    if (!b) return;
    view = b.dataset.view;
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* 무시 */ }
    notebookEl.querySelectorAll('.algo-tabs [data-view]').forEach((x) => x.classList.toggle('active', x.dataset.view === view));
    notebookEl.querySelectorAll('.cell.code').forEach((cellEl) => render(cellEl));
  });

  // 셀이 새로 생기거나 노트북을 새로 불러오면 자동으로 연결 (셀은 #notebook의 바로 아래에 추가된다)
  new MutationObserver(() => {
    notebookEl.querySelectorAll('.cell.code').forEach(attach);
  }).observe(notebookEl, { childList: true });

  applyAvailability();
})();
