// 과제 모드(학생): 클래스룸 과제 링크(?c=반ID&t=문제파일ID)로 들어왔을 때
// 로그인 → 과제 찾기 → 학생 드라이브의 작업 파일 불러오기(없으면 문제 파일로 새로 만들기)
// → 자동 저장 → 제출(클래스룸 첨부 + 제출) / 제출 취소
//
// 수업 자료 모드(?m=문제파일ID): 클래스룸 과제 없이 실습 파일만 드라이브에 만들고 자동 저장 (제출 없음)
(() => {
  'use strict';

  const App = window.PyClassApp;
  if (!App || !App.assignment) return;
  const G = window.PyClassGoogle;
  const I = window.PyClassIntegrity;
  const { courseId, templateId } = App.assignment;
  const PRACTICE = App.assignment.mode === 'practice';
  const ROLE = PRACTICE ? 'practice' : 'student';

  const SAVE_DELAY = 3000;
  const STUDENT_FOLDER = { pyclassFolder: 'student' };
  const PRACTICE_FOLDER = { pyclassFolder: 'practice' };

  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  const state = {
    user: null, cw: null, sub: null, fileId: null,
    ready: false, preview: false, dirty: false, savePromise: null, saveTimer: null, busy: false,
  };

  // ------------------------------------------------------------ 화면

  document.body.classList.add('assign-loading');
  const bar = el('div', 'assign-bar');
  bar.hidden = true;
  $('.toolbar').after(bar);
  const panel = el('div', 'assign-panel');
  $('#notebook').before(panel);

  function showPanel(...children) {
    panel.textContent = '';
    const card = el('div', 'assign-card');
    card.append(...children);
    panel.append(card);
    panel.hidden = false;
  }

  function showSignIn(message) {
    const btn = el('button', 'primary', '학교 Google 계정으로 로그인');
    btn.addEventListener('click', start);
    showPanel(
      el('h2', '', PRACTICE ? '수업 실습' : '클래스룸 과제'),
      el('p', '', PRACTICE
        ? '학교 Google 계정으로 로그인하면 실습 파일을 불러와요. 내 Google 드라이브에 자동 저장되어 다음 시간에 어느 컴퓨터에서든 이어서 할 수 있어요.'
        : '학교 Google 계정으로 로그인하면 과제를 불러와요. 작성한 내용은 내 Google 드라이브에 자동으로 저장돼요.'),
      ...(message ? [el('p', 'assign-error', message)] : []),
      btn,
      ...(G.isDemo ? [el('p', 'assign-note', '데모 모드: 실제 구글 계정 대신 연습용 계정을 써요.')] : []),
    );
  }

  function showLoading(text) {
    showPanel(el('div', 'assign-spinner'), el('p', '', text));
  }

  function fmtDue(cw) {
    if (!cw.dueDate) return null;
    const { year, month, day } = cw.dueDate;
    const { hours = 0, minutes = 0 } = cw.dueTime || {};
    return new Date(Date.UTC(year, month - 1, day, hours, minutes));
  }

  const timeText = (d) => d.toLocaleString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

  function setStatus(text) {
    App.setSaveText(text);
  }

  function renderBar() {
    bar.textContent = '';
    bar.hidden = false;
    const info = el('div', 'assign-info');
    info.append(el('span', 'assign-title', state.cw ? state.cw.title : '과제'));
    const due = state.cw && fmtDue(state.cw);
    if (due) {
      const late = due < new Date() && !isTurnedIn();
      info.append(el('span', `assign-due${late ? ' late' : ''}`, `마감 ${timeText(due)}${late ? ' · 마감 지남' : ''}`));
    }
    if (state.user) info.append(el('span', 'assign-user', state.user.displayName));
    bar.append(info);

    const actions = el('div', 'assign-actions');
    if (PRACTICE) {
      actions.append(el('span', 'assign-state', '수업 실습 · 제출하지 않아요'));
    } else if (state.preview) {
      actions.append(el('span', 'assign-state', '미리보기 · 저장·제출되지 않아요'));
    } else if (isTurnedIn()) {
      actions.append(el('span', 'assign-state done', '✓ 제출 완료'));
      const undo = el('button', 'tool-btn', '제출 취소');
      undo.disabled = state.busy;
      undo.addEventListener('click', unsubmit);
      actions.append(undo);
    } else {
      if (state.sub && state.sub.state === 'RETURNED') actions.append(el('span', 'assign-state', '선생님이 돌려준 과제예요. 고쳐서 다시 제출할 수 있어요'));
      const submitBtn = el('button', 'primary', state.busy ? '제출 중…' : '제출');
      submitBtn.disabled = state.busy;
      submitBtn.addEventListener('click', submit);
      actions.append(submitBtn);
    }
    bar.append(actions);
  }

  const isTurnedIn = () => !!state.sub && state.sub.state === 'TURNED_IN';

  function applySubmissionState() {
    App.setLocked(isTurnedIn() || !state.ready);
    renderBar();
  }

  function handleError(err) {
    console.error(err);
    if (err instanceof G.AuthError) {
      if (state.ready) {
        setStatus('로그인 만료 · 저장 안 됨');
        const again = el('button', 'tool-btn', '다시 로그인');
        again.addEventListener('click', async () => {
          try {
            await G.signIn(ROLE);
            again.remove();
            state.dirty = true;
            await saveToDrive();
          } catch (e) { App.toast(e.message); }
        });
        bar.querySelector('.assign-actions').prepend(again);
      } else {
        showSignIn(err.message);
      }
      return;
    }
    if (!state.ready) showSignIn(friendlyMessage(err));
    else App.toast(friendlyMessage(err));
  }

  function friendlyMessage(err) {
    if (err instanceof G.ApiError) {
      if (PRACTICE && (err.status === 403 || err.status === 404)) return `실습 파일을 열 수 없어요. 학교 계정으로 로그인했는지, 선생님이 준 링크가 맞는지 확인해 주세요. (${err.message})`;
      if (err.status === 403) return `권한이 없어요. 이 반의 학생 계정으로 로그인했는지 확인해 주세요. (${err.message})`;
      if (err.status === 404) return `과제나 파일을 찾을 수 없어요. 클래스룸의 과제 링크로 다시 들어와 주세요. (${err.message})`;
      return `구글 서버 오류(${err.status}): ${err.message}`;
    }
    return err.message || String(err);
  }

  // ------------------------------------------------------------ 불러오기

  function linkMatches(url) {
    try {
      const u = new URL(url);
      return u.searchParams.get('t') === templateId && u.searchParams.get('c') === courseId;
    } catch {
      return false;
    }
  }

  function fromTemplate(template, title, policy) {
    const next = App.fromIpynb(template, `${title}.ipynb`);
    for (const c of next.cells) {
      c.outputs = [];
      c.execCount = null;
    }
    next.metadata.pyclass = { version: 1, policy };
    I.ensureMeta(next); // 문제 파일 내용을 기록 시작점(baseline)으로 저장
    return next;
  }

  async function start() {
    try {
      if (!G.isSignedIn()) await G.signIn(ROLE);
      if (PRACTICE) await loadPractice();
      else await loadAssignment();
    } catch (err) {
      handleError(err);
    }
  }

  async function loadAssignment() {
    showLoading('과제를 불러오는 중…');
    state.user = await G.me();
    const works = await G.listPublishedCourseWork(courseId);
    state.cw = works.find((w) => (w.materials || []).some((m) => m.link && linkMatches(m.link.url))) || null;
    if (!state.cw) throw new Error('이 과제를 찾을 수 없어요. 클래스룸의 과제 링크로 다시 들어와 주세요.');

    const template = JSON.parse(await G.readFile(templateId));
    const policy = { ...I.defaultPolicy(), ...((template.metadata && template.metadata.pyclass && template.metadata.pyclass.policy) || {}), allowFileOpen: false };

    state.sub = await G.mySubmission(courseId, state.cw.id);
    if (!state.sub) {
      // 선생님 계정 등 제출 대상이 아닌 경우: 미리보기
      state.preview = true;
      const next = fromTemplate(template, `${state.cw.title} (미리보기)`, policy);
      App.load(next);
      finishLoading();
      return;
    }

    const attached = ((state.sub.assignmentSubmission && state.sub.assignmentSubmission.attachments) || [])
      .map((a) => a.driveFile && a.driveFile.id).filter(Boolean);
    const files = await G.findFiles({ pyclassCw: state.cw.id });
    const file = files.find((f) => attached.includes(f.id)) || files[0];

    let next;
    if (file) {
      next = App.fromIpynb(JSON.parse(await G.readFile(file.id)), file.name);
      state.fileId = file.id;
    } else {
      showLoading('내 드라이브에 과제 파일을 만드는 중…');
      next = fromTemplate(template, `${state.cw.title} - ${state.user.displayName}`, policy);
      const folderId = await G.ensureFolder('파이썬 노트북 과제', STUDENT_FOLDER);
      const created = await G.createFile({
        name: `${next.title}.ipynb`,
        parents: [folderId],
        appProperties: { pyclassCw: state.cw.id, pyclassCourse: courseId, pyclassTemplate: templateId },
        content: JSON.stringify(App.toIpynb(next)),
      });
      state.fileId = created.id;
    }
    // 과제 설정은 항상 교사의 문제 파일 기준으로 다시 적용한다 (학생 파일의 설정은 믿지 않음)
    next.metadata.pyclass = { ...(next.metadata.pyclass || {}), policy };
    App.load(next);
    App.recorder.log('session', { assignment: state.cw.id });
    finishLoading();
  }

  // 수업 자료: 클래스룸을 거치지 않고 문제 파일 → 내 드라이브 실습 파일
  async function loadPractice() {
    showLoading('실습 파일을 불러오는 중…');
    state.user = await G.me();
    const template = JSON.parse(await G.readFile(templateId));
    const meta = (template.metadata && template.metadata.pyclass) || {};
    const title = meta.title || '파이썬 실습';
    state.cw = { title };
    const policy = { ...I.defaultPolicy(), record: false, ...(meta.policy || {}), allowFileOpen: false };

    const files = await G.findFiles({ pyclassPractice: templateId });
    let next;
    if (files.length) {
      next = App.fromIpynb(JSON.parse(await G.readFile(files[0].id)), files[0].name);
      state.fileId = files[0].id;
    } else {
      showLoading('내 드라이브에 실습 파일을 만드는 중…');
      next = fromTemplate(template, `${title} - ${state.user.displayName}`, policy);
      const folderId = await G.ensureFolder('파이썬 노트북 수업', PRACTICE_FOLDER);
      const created = await G.createFile({
        name: `${next.title}.ipynb`,
        parents: [folderId],
        appProperties: { pyclassPractice: templateId },
        content: JSON.stringify(App.toIpynb(next)),
      });
      state.fileId = created.id;
    }
    next.metadata.pyclass = { ...(next.metadata.pyclass || {}), policy };
    App.load(next);
    App.recorder.log('session', { practice: templateId });
    finishLoading();
  }

  function finishLoading() {
    state.ready = true;
    panel.hidden = true;
    document.body.classList.remove('assign-loading');
    App.refreshEditors();
    setStatus(state.preview ? '미리보기' : '드라이브에 저장됨');
    applySubmissionState();
  }

  // ------------------------------------------------------------ 드라이브 자동 저장

  App.onSave(() => {
    if (!state.ready || state.preview || isTurnedIn()) return;
    state.dirty = true;
    setStatus('저장 대기 중…');
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => saveToDrive().catch(() => {}), SAVE_DELAY);
  });

  async function saveToDrive() {
    clearTimeout(state.saveTimer);
    if (state.savePromise) await state.savePromise.catch(() => {});
    if (!state.dirty) return;
    state.dirty = false;
    setStatus('드라이브에 저장 중…');
    state.savePromise = G.updateFile(state.fileId, JSON.stringify(App.toIpynb()));
    try {
      await state.savePromise;
      setStatus(`드라이브에 저장됨 ${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}`);
    } catch (err) {
      state.dirty = true;
      if (err instanceof G.AuthError) {
        handleError(err);
      } else {
        setStatus('저장 실패 · 잠시 후 다시 시도');
        state.saveTimer = setTimeout(() => saveToDrive().catch(() => {}), 15000);
      }
      throw err;
    } finally {
      state.savePromise = null;
    }
  }

  window.addEventListener('beforeunload', (e) => {
    if (state.dirty || state.savePromise) {
      App.saveNow();
      e.preventDefault();
      e.returnValue = '';
    }
  });
  window.addEventListener('pagehide', () => {
    if (state.dirty && state.fileId && !isTurnedIn()) {
      G.updateFile(state.fileId, JSON.stringify(App.toIpynb()), { keepalive: true }).catch(() => {});
    }
  });

  // ------------------------------------------------------------ 제출

  async function submit() {
    const ok = App.recorder.withoutAwayTracking(() => confirm('과제를 제출할까요?\n제출하면 수정할 수 없어요. (필요하면 "제출 취소" 후 다시 고칠 수 있어요)'));
    if (!ok) return;
    state.busy = true;
    renderBar();
    try {
      App.recorder.log('submit');
      App.saveNow();
      state.dirty = true;
      await saveToDrive();
      const attached = ((state.sub.assignmentSubmission && state.sub.assignmentSubmission.attachments) || [])
        .some((a) => a.driveFile && a.driveFile.id === state.fileId);
      if (!attached) await G.attachFile(courseId, state.cw.id, state.sub.id, state.fileId);
      await G.turnIn(courseId, state.cw.id, state.sub.id);
      state.sub = await G.mySubmission(courseId, state.cw.id);
      setStatus('제출됨');
      App.toast('제출했어요. 클래스룸에서도 "제출함"으로 보여요.');
    } catch (err) {
      handleError(err);
    } finally {
      state.busy = false;
      applySubmissionState();
    }
  }

  async function unsubmit() {
    const ok = App.recorder.withoutAwayTracking(() => confirm('제출을 취소할까요? 고친 뒤에는 꼭 다시 제출해야 해요.'));
    if (!ok) return;
    state.busy = true;
    renderBar();
    try {
      await G.reclaim(courseId, state.cw.id, state.sub.id);
      state.sub = await G.mySubmission(courseId, state.cw.id);
      App.recorder.log('unsubmit');
      setStatus('제출 취소됨 · 다시 제출해야 해요');
    } catch (err) {
      handleError(err);
    } finally {
      state.busy = false;
      applySubmissionState();
    }
  }

  // ------------------------------------------------------------ 시작

  if (G.isSignedIn()) start();
  else showSignIn();
})();
