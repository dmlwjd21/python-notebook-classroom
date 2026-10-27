// 교사용: 채점
// 평가(같은 문제 파일로 낸 과제들) 선택 → 클래스룸에서 제출물 수집 → 채점 Worker로 자동 채점
// → 결과 확인·점수 수정 → 클래스룸 임시 점수 / 구글 시트 / CSV
(() => {
  'use strict';

  const CFG = window.PYCLASS_CONFIG;
  const G = window.PyClassGoogle;
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  const JOB_TIMEOUT_MS = 30000;
  const FETCH_CONCURRENCY = 6;
  // 채점 엔진이나 브라우저를 건드릴 수 있는 코드: 점수 조작 가능성이 있어 교사 확인 필요
  const SUSPICIOUS = /\bimport\s+js\b|\bfrom\s+js\b|pyodide|__main__|sys\.modules|globals\s*\(|\bbuiltins\b|__import__|setattr\s*\(|\bexec\s*\(|\beval\s*\(|__dict__|importlib|__builtins__/;

  let assessments = [];  // [{ templateId, title, items: [{ course, w }] }]
  let current = null;    // 선택한 평가
  let rubricCode = null;
  let rubricFileId = null;
  let rows = [];         // 학생별 결과
  let selectedKey = null;

  // ------------------------------------------------------------ 로그인 / 평가 목록

  $('#gradeSignInBtn').addEventListener('click', async () => {
    $('#gradeSigninError').hidden = true;
    try {
      await window.PyClassTeacher.signIn();
    } catch (err) {
      $('#gradeSigninError').textContent = err.message;
      $('#gradeSigninError').hidden = false;
    }
  });

  window.addEventListener('pyclass:teacher-signed-in', loadAssessments);
  // 탭을 열 때마다 새로 만든 과제가 목록에 보이도록 다시 불러온다 (채점 중에는 그대로 둠)
  document.querySelector('.tab[data-tab="grade"]').addEventListener('click', () => {
    if (window.PyClassTeacher.me && !$('#gStart').dataset.running) loadAssessments();
  });

  async function loadAssessments() {
    $('#gradeSignin').hidden = true;
    $('#gradeMain').hidden = false;
    const sel = $('#gAssess');
    sel.textContent = '';
    sel.append(el('option', '', '불러오는 중…'));
    try {
      const list = await window.PyClassTeacher.listOurAssignments();
      const byTemplate = new Map();
      for (const r of list) {
        if (!byTemplate.has(r.templateId)) byTemplate.set(r.templateId, { templateId: r.templateId, title: r.w.title, items: [] });
        byTemplate.get(r.templateId).items.push({ course: r.course, w: r.w });
      }
      assessments = [...byTemplate.values()];
      sel.textContent = '';
      sel.append(el('option', '', assessments.length ? '평가를 고르세요' : '이 플랫폼으로 만든 과제가 없어요'));
      sel.firstChild.value = '';
      for (const a of assessments) {
        const opt = el('option', '', `${a.title} · ${a.items.length}개 반`);
        opt.value = a.templateId;
        sel.append(opt);
      }
    } catch (err) {
      sel.textContent = '';
      sel.append(el('option', '', `목록을 불러오지 못했어요: ${err.message}`));
    }
  }

  $('#gAssess').addEventListener('change', async (e) => {
    current = assessments.find((a) => a.templateId === e.target.value) || null;
    rubricCode = null;
    rubricFileId = null;
    rows = [];
    renderTable();
    $('#gDetail').hidden = true;
    $('#gActions').hidden = true;
    $('#gSummary').textContent = '';
    $('#gStart').disabled = !current;
    if (!current) return;
    $('#gRubricState').textContent = '저장된 채점 기준 찾는 중…';
    try {
      const files = await G.findFiles({ pyclassRubricFor: current.templateId }, 'id,name,modifiedTime');
      if (files.length) {
        rubricFileId = files[0].id;
        rubricCode = await G.readFile(rubricFileId);
        $('#gRubricState').textContent = `✓ ${files[0].name} (드라이브에 저장됨)`;
      } else {
        $('#gRubricState').textContent = '채점 기준이 없어요. 기준 파일을 올리거나, 없이 진행하면 수집·작성 기록만 보여줘요.';
      }
    } catch (err) {
      $('#gRubricState').textContent = `채점 기준을 불러오지 못했어요: ${err.message}`;
    }
  });

  $('#gRubricFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !current) return;
    const text = await file.text();
    if (!/\bRUBRIC\s*=/.test(text)) {
      $('#gRubricState').textContent = '이 파일에는 RUBRIC이 없어요. 채점 기준 파일이 맞는지 확인해 주세요.';
      return;
    }
    $('#gRubricState').textContent = '드라이브에 저장 중…';
    try {
      if (rubricFileId) {
        await G.updateFile(rubricFileId, text, { mimeType: 'text/x-python' });
      } else {
        const folderId = await G.ensureFolder('파이썬 노트북 과제 (문제 파일)', { pyclassFolder: 'teacher' });
        const created = await G.createFile({
          name: `[채점기준] ${current.title}.py`,
          parents: [folderId],
          appProperties: { pyclassRubricFor: current.templateId },
          content: text,
          mimeType: 'text/x-python',
        });
        rubricFileId = created.id;
      }
      rubricCode = text;
      $('#gRubricState').textContent = `✓ ${file.name} (드라이브에 비공개로 저장됨)`;
    } catch (err) {
      $('#gRubricState').textContent = `저장 실패: ${err.message}`;
    }
  });

  // ------------------------------------------------------------ 수집

  const progress = (text) => { $('#gProgress').textContent = text; };

  async function pool(items, limit, fn) {
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx], idx);
      }
    });
    await Promise.all(workers);
  }

  const STATE_LABEL = { TURNED_IN: '제출', RETURNED: '돌려줌', RECLAIMED_BY_STUDENT: '제출 취소', CREATED: '미제출', NEW: '미제출' };

  function savedEdit(key) {
    try { return JSON.parse(localStorage.getItem(`pyclass:grade:${current.templateId}:${key}`)) || {}; } catch { return {}; }
  }

  function saveEdit(row) {
    try {
      localStorage.setItem(`pyclass:grade:${current.templateId}:${row.key}`, JSON.stringify({ override: row.override, memo: row.memo }));
    } catch { /* 저장 공간 없음 */ }
  }

  $('#gStart').addEventListener('click', async () => {
    if (!current) return;
    $('#gStart').disabled = true;
    $('#gStart').dataset.running = '1';
    $('#gActions').hidden = true;
    $('#gExportMsg').textContent = '';
    try {
      progress('문제 파일 불러오는 중…');
      const template = await G.readFile(current.templateId);
      rows = [];
      for (const { course, w } of current.items) {
        progress(`${course.name}: 학생 명단과 제출물 확인 중…`);
        const [students, subs] = await Promise.all([G.listStudents(course.id), G.listSubmissions(course.id, w.id)]);
        const subByUser = new Map(subs.map((s) => [s.userId, s]));
        for (const st of students) {
          const sub = subByUser.get(st.userId) || null;
          const email = st.profile.emailAddress || '';
          const attachments = (sub && sub.assignmentSubmission && sub.assignmentSubmission.attachments) || [];
          const file = attachments.map((a) => a.driveFile).find((f) => f && /\.ipynb$/i.test(f.title || '')) || null;
          const key = `${course.id}:${st.userId}`;
          const edit = savedEdit(key);
          rows.push({
            key, course, w, sub,
            name: st.profile.name.fullName,
            email,
            studentNo: email.split('@')[0],
            state: sub ? (STATE_LABEL[sub.state] || sub.state) : '미제출',
            late: !!(sub && sub.late),
            submitted: !!(sub && (sub.state === 'TURNED_IN' || sub.state === 'RETURNED') && file),
            fileId: file ? file.id : null,
            json: null, result: null, error: null, flags: [], suspicious: false,
            override: edit.override ?? null, memo: edit.memo || '',
          });
        }
      }
      rows.sort((a, b) => a.course.name.localeCompare(b.course.name, 'ko') || a.studentNo.localeCompare(b.studentNo, 'ko', { numeric: true }));
      renderTable();

      const targets = rows.filter((r) => r.submitted);
      let done = 0;
      await pool(targets, FETCH_CONCURRENCY, async (r) => {
        try {
          r.json = await G.readFile(r.fileId);
          const nb = JSON.parse(r.json);
          const code = (nb.cells || []).filter((c) => c.cell_type === 'code').map((c) => [].concat(c.source).join('')).join('\n');
          r.code = code;
          r.suspicious = SUSPICIOUS.test(code);
          r.analysis = window.PyClassReview.analyze(r.json);
          r.flags = r.analysis.flags || [];
        } catch (err) {
          r.error = `제출 파일을 읽지 못했어요: ${err.message}`;
        }
        done += 1;
        progress(`제출물 불러오는 중 ${done}/${targets.length}`);
      });

      if (rubricCode) {
        await runGrading(targets.filter((r) => r.json), template);
      }
      progress(`완료: ${targets.length}명 제출 / 전체 ${rows.length}명`);
      $('#gActions').hidden = false;
    } catch (err) {
      progress(`실패: ${err.message}`);
    } finally {
      $('#gStart').disabled = false;
      delete $('#gStart').dataset.running;
      renderTable();
      renderSummary();
    }
  });

  // ------------------------------------------------------------ 채점 Worker

  function startWorker() {
    return new Promise((resolve, reject) => {
      const worker = new Worker('grade-worker.js');
      worker.onmessage = (e) => {
        if (e.data.type === 'ready') resolve(worker);
        else if (e.data.type === 'init-error') { worker.terminate(); reject(new Error(e.data.message)); }
      };
      worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || '채점 엔진 오류')); };
      worker.postMessage({
        type: 'init',
        pyodideUrl: CFG.pyodideUrl,
        coreUrl: new URL('grader_core.py', location.href).href,
        rubricCode,
      });
    });
  }

  function makeJobId() {
    return (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random()}`;
  }

  async function runGrading(allTargets, template) {
    progress('채점 엔진 준비 중… (처음 한 번은 20초쯤 걸려요)');
    // 의심 코드는 다른 학생 채점에 영향을 줄 수 없도록 맨 뒤에서 하나씩 새 엔진으로 채점
    const targets = allTargets.filter((r) => !r.suspicious).concat(allTargets.filter((r) => r.suspicious));
    let worker = await startWorker();
    let done = 0;
    for (const r of targets) {
      if (r.suspicious) {
        worker.terminate();
        worker = await startWorker();
      }
      const jobId = makeJobId(); // 학생 코드가 맞힐 수 없는 값: 가짜 결과 메시지를 걸러냄
      const outcome = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ timeout: true }), JOB_TIMEOUT_MS);
        worker.onmessage = (e) => {
          if (e.data.type !== 'result' || e.data.jobId !== jobId) return;
          clearTimeout(timer);
          resolve(e.data);
        };
        worker.postMessage({ type: 'grade', jobId, student: r.json, template, code: r.code });
      });
      if (outcome.timeout) {
        r.error = `채점 시간 초과(${JOB_TIMEOUT_MS / 1000}초): 무한 반복 등이 있는지 코드를 확인해 주세요`;
        worker.terminate();
        progress('채점 엔진 다시 시작 중…');
        worker = await startWorker();
      } else if (outcome.error) {
        r.error = `채점 오류: ${outcome.error}`;
      } else {
        try { r.result = JSON.parse(outcome.result); } catch { r.error = '채점 결과를 읽지 못했어요'; }
        if (r.result && r.result.tampered && r.result.tampered.length) {
          r.error = `채점 엔진을 바꾸는 코드가 실행됐어요(${r.result.tampered.join(', ')}). 이 학생의 자동 점수는 믿을 수 없으니 직접 채점해 주세요.`;
          r.suspicious = true;
          worker.terminate(); // 다음 학생은 깨끗한 엔진으로
          worker = await startWorker();
        }
      }
      done += 1;
      progress(`채점 중 ${done}/${targets.length}`);
      if (done % 10 === 0 || done === targets.length) renderTable();
    }
    worker.terminate();
  }

  // ------------------------------------------------------------ 결과 표

  const finalScore = (r) => (r.override != null && r.override !== '' ? Number(r.override) : (r.result ? r.result.total : null));

  function needsCheck(r) {
    return !!(r.error || r.suspicious || r.late || (r.flags || []).some((f) => f.level === 'high'));
  }

  function problemTitles() {
    const withResult = rows.find((r) => r.result);
    return withResult ? withResult.result.problems.map((p) => p.title) : [];
  }

  function renderTable() {
    const table = $('#gTable');
    table.textContent = '';
    if (!rows.length) return;
    const titles = problemTitles();
    const head = el('tr');
    for (const h of ['반', '학번', '이름', '상태', ...titles, '총점', '확인']) head.append(el('th', '', h));
    table.append(head);
    const onlyCheck = $('#gOnlyCheck').checked;
    for (const r of rows) {
      if (onlyCheck && !needsCheck(r)) continue;
      const tr = el('tr', r.key === selectedKey ? 'active' : '');
      tr.append(el('td', '', r.course.name), el('td', 'num', r.studentNo), el('td', '', r.name));
      tr.append(el('td', r.submitted ? '' : 'muted', r.state + (r.late ? ' (늦음)' : '')));
      for (let i = 0; i < titles.length; i++) {
        const p = r.result && r.result.problems[i];
        tr.append(el('td', 'num', p ? `${p.score}/${p.max}` : ''));
      }
      const score = finalScore(r);
      const scoreTd = el('td', 'num score', score == null ? '' : String(score));
      if (r.override != null && r.override !== '') scoreTd.title = `자동 채점 ${r.result ? r.result.total : '-'}점 → 수정`;
      if (r.override != null && r.override !== '') scoreTd.classList.add('edited');
      tr.append(scoreTd);
      const badges = el('td', 'badges');
      if (r.error) badges.append(el('span', 'badge high', '채점 오류'));
      if (r.suspicious) badges.append(el('span', 'badge high', '의심 코드'));
      const high = (r.flags || []).filter((f) => f.level === 'high').length;
      if (high) badges.append(el('span', 'badge high', `기록 경고 ${high}`));
      if (r.late) badges.append(el('span', 'badge mid', '늦음'));
      tr.append(badges);
      tr.addEventListener('click', () => showDetail(r.key));
      table.append(tr);
    }
  }

  $('#gOnlyCheck').addEventListener('change', renderTable);

  function renderSummary() {
    const box = $('#gSummary');
    box.textContent = '';
    if (!rows.length) return;
    const submitted = rows.filter((r) => r.submitted);
    const scores = submitted.map(finalScore).filter((s) => s != null);
    const avg = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : '-';
    const max = rows.find((r) => r.result) ? rows.find((r) => r.result).result.max : null;
    const defs = [
      [`${submitted.length}/${rows.length}`, '제출'],
      [max ? `${avg} / ${max}` : avg, '평균 점수'],
      [rows.filter(needsCheck).length, '확인 필요'],
    ];
    for (const [v, k] of defs) {
      const s = el('div', 'stat');
      s.append(el('div', 'v', String(v)), el('div', 'k', k));
      box.append(s);
    }
  }

  // ------------------------------------------------------------ 학생 상세

  function showDetail(key) {
    selectedKey = key;
    renderTable();
    const r = rows.find((x) => x.key === key);
    const box = $('#gDetail');
    box.hidden = false;
    box.textContent = '';
    const close = el('button', 'tool-btn close-btn', '닫기 ✕');
    close.addEventListener('click', () => { box.hidden = true; selectedKey = null; renderTable(); });
    box.append(close, el('h3', '', `${r.name} (${r.studentNo})`), el('div', 'meta', `${r.course.name} · ${r.state}${r.late ? ' · 늦은 제출' : ''}`));

    if (r.json) {
      const open = el('button', 'tool-btn', '작성 기록 보기 →');
      open.addEventListener('click', () => window.PyClassReview.open(`${r.studentNo}_${r.name}.ipynb`, r.json));
      box.append(open);
    }
    if (r.error) box.append(el('p', 'assign-error', r.error));
    if (r.suspicious) box.append(el('p', 'assign-error', '채점 엔진이나 브라우저를 건드릴 수 있는 코드가 있어요. 점수 조작 가능성이 있으니 코드를 직접 확인해 주세요.'));
    const high = (r.flags || []).filter((f) => f.level !== 'low');
    if (high.length) {
      const ul = el('ul', 'flags');
      for (const f of high) ul.append(el('li', f.level, f.text));
      box.append(ul);
    }

    // 점수 수정 / 메모
    const edit = el('div', 'grade-edit');
    const auto = r.result ? `${r.result.total}/${r.result.max}` : '-';
    edit.append(el('div', 'meta', `자동 채점 ${auto}`));
    const scoreInput = el('input');
    scoreInput.type = 'number';
    scoreInput.placeholder = '수정 점수';
    scoreInput.value = r.override ?? '';
    scoreInput.addEventListener('change', () => {
      r.override = scoreInput.value === '' ? null : Number(scoreInput.value);
      saveEdit(r);
      renderTable();
      renderSummary();
    });
    const memo = el('textarea');
    memo.rows = 2;
    memo.placeholder = '메모 (시트에 함께 저장)';
    memo.value = r.memo;
    memo.addEventListener('change', () => { r.memo = memo.value; saveEdit(r); });
    edit.append(scoreInput, memo);
    box.append(edit);

    if (r.result) {
      if (r.result.setup_error) box.append(el('p', 'assign-error', `데이터 준비 오류: ${r.result.setup_error}`));
      for (const p of r.result.problems) {
        const sec = el('div', 'grade-problem');
        sec.append(el('div', 'grade-problem-head', `${p.title} ${p.score}/${p.max}`));
        if (p.error) sec.append(el('div', 'note', p.error));
        const ul = el('ul', 'grade-items');
        for (const it of p.items) {
          const li = el('li', it.score === it.max ? 'ok' : 'miss', `${it.score === it.max ? '✓' : '✗'} ${it.label}`);
          if (it.note) li.append(el('div', 'note', it.note));
          ul.append(li);
        }
        sec.append(ul);
        const code = el('details');
        code.append(el('summary', '', '학생 코드'), el('pre', 'code-view', p.code || '(비어 있음)'));
        sec.append(code);
        box.append(sec);
      }
    }
  }

  // ------------------------------------------------------------ 내보내기

  function lostItems(r) {
    if (!r.result) return '';
    return r.result.problems
      .map((p) => {
        const lost = p.items.filter((i) => i.score < i.max).map((i) => i.label);
        return lost.length ? `${p.title}: ${lost.join(', ')}` : '';
      })
      .filter(Boolean)
      .join(' / ');
  }

  function exportRows() {
    const titles = problemTitles();
    const header = ['반', '학번', '이름', '이메일', '제출 상태', '기본 점수', ...titles, '자동 점수', '수정 점수', '최종 점수', '감점 항목', '작성 기록 경고', '확인 필요 사유', '메모'];
    const out = [header];
    for (const r of rows) {
      const reasons = [r.error, r.suspicious ? '의심 코드' : '', r.late ? '늦은 제출' : ''].filter(Boolean).join(', ');
      out.push([
        r.course.name, r.studentNo, r.name, r.email, r.state + (r.late ? '(늦음)' : ''),
        r.result ? r.result.base : '',
        ...titles.map((_, i) => (r.result && r.result.problems[i] ? r.result.problems[i].score : '')),
        r.result ? r.result.total : '',
        r.override ?? '',
        finalScore(r) ?? '',
        lostItems(r),
        (r.flags || []).filter((f) => f.level !== 'low').map((f) => f.text).join(' / '),
        reasons,
        r.memo,
      ]);
    }
    return out;
  }

  $('#gCsv').addEventListener('click', () => {
    const csv = exportRows().map((row) => row.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${current.title} 채점 결과.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  $('#gToSheet').addEventListener('click', async () => {
    const msg = $('#gExportMsg');
    msg.textContent = '구글 시트에 쓰는 중…';
    try {
      const year = String(new Date().getFullYear());
      const found = await G.findFiles({ pyclassGradebook: year }, 'id,name,webViewLink');
      let sheet = found[0];
      if (!sheet) {
        const folderId = await G.ensureFolder('파이썬 노트북 과제 (문제 파일)', { pyclassFolder: 'teacher' });
        sheet = await G.createSpreadsheet(`파이썬 노트북 성적 ${year}`, { pyclassGradebook: year }, [folderId]);
      }
      const tab = current.title.replace(/[[\]:*?/\\]/g, ' ').slice(0, 90);
      await G.writeSheetTab(sheet.id, tab, exportRows());
      msg.textContent = '';
      msg.append(`구글 시트 "파이썬 노트북 성적 ${year}"의 "${tab}" 탭에 저장했어요. `);
      if (sheet.webViewLink && sheet.webViewLink !== '#') {
        const a = el('a', 'link', '시트 열기');
        a.href = sheet.webViewLink;
        a.target = '_blank';
        a.rel = 'noopener';
        msg.append(a);
      }
    } catch (err) {
      msg.textContent = `시트 저장 실패: ${err.message}`;
    }
  });

  $('#gToClassroom').addEventListener('click', async () => {
    const msg = $('#gExportMsg');
    const targets = rows.filter((r) => r.submitted && r.sub && finalScore(r) != null);
    if (!targets.length) {
      msg.textContent = '넣을 점수가 없어요.';
      return;
    }
    const max = rows.find((r) => r.result) ? rows.find((r) => r.result).result.max : null;
    const mismatched = current.items.filter(({ w }) => max != null && w.maxPoints !== max);
    if (mismatched.length) {
      const fix = confirm(`클래스룸 과제의 배점(${mismatched.map(({ w }) => w.maxPoints ?? '없음').join(', ')})이 채점 만점(${max})과 달라요.\n클래스룸 배점을 ${max}점으로 바꿀까요?\n(취소하면 배점은 그대로 두고 점수만 넣어요)`);
      if (fix) {
        for (const { course, w } of mismatched) {
          await G.setMaxPoints(course.id, w.id, max);
          w.maxPoints = max;
        }
      }
    }
    if (!confirm(`${targets.length}명의 점수를 클래스룸에 "임시 점수"로 넣을까요?\n학생에게는 아직 보이지 않아요. 클래스룸에서 확인 후 직접 돌려주세요.`)) return;
    let ok = 0;
    const failed = [];
    for (const r of targets) {
      msg.textContent = `클래스룸에 점수 넣는 중 ${ok + failed.length + 1}/${targets.length}`;
      try {
        await G.setDraftGrade(r.course.id, r.w.id, r.sub.id, finalScore(r));
        ok += 1;
      } catch (err) {
        failed.push(`${r.name}(${err.message})`);
      }
    }
    msg.textContent = `${ok}명 임시 점수를 넣었어요.${failed.length ? ` 실패 ${failed.length}명: ${failed.slice(0, 3).join(', ')}` : ''} 클래스룸 학생 과제 화면에서 확인한 뒤 "돌려주기"를 누르면 학생에게 공개돼요.`;
  });
})();
