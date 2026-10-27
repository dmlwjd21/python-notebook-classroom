// 교사용: 클래스룸에 과제 / 수업 자료 배포
// 문제 파일을 교사 드라이브에 올려 학교 도메인에 읽기 공유 → 고른 반마다 클래스룸 과제 생성
// (과제에는 "파이썬 노트북에서 열기" 링크가 붙는다: index.html?c=반ID&t=문제파일ID)
// 수업 자료는 클래스룸 "자료"로 올리거나 링크만 만든다: index.html?m=실습파일ID
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

  const APP_BASE = CFG.appUrl || new URL('.', location.href).href;
  const studentLink = (courseId, templateId) => `${APP_BASE}index.html?c=${encodeURIComponent(courseId)}&t=${encodeURIComponent(templateId)}`;
  const practiceLink = (templateId) => `${APP_BASE}index.html?m=${encodeURIComponent(templateId)}`;
  const isOurLink = (url) => {
    try {
      const u = new URL(url);
      return url.startsWith(APP_BASE) && u.searchParams.get('c') && u.searchParams.get('t');
    } catch {
      return false;
    }
  };

  const NOTE = '\n\n[안내] 아래 링크를 눌러 "파이썬 노트북"에서 과제를 하세요. 학교 계정으로 로그인하면 내 드라이브에 자동 저장되고, 화면 위쪽의 "제출" 버튼으로 제출할 수 있어요. 작성 과정(붙여넣기, 다른 탭·창 이동, 코드 입력 과정)이 함께 기록돼요.';
  const NOTE_PRACTICE = '\n\n[안내] 아래 링크를 눌러 "파이썬 노트북"에서 실습하세요. 학교 계정으로 로그인하면 내 드라이브 "파이썬 노트북 수업" 폴더에 자동 저장되어, 다음 시간에 같은 링크로 들어오면 이어서 할 수 있어요.';

  const kind = () => document.querySelector('input[name="dKind"]:checked').value;
  function applyKind() {
    const material = kind() === 'material';
    document.querySelectorAll('.assignment-only').forEach((n) => { n.hidden = material; });
    document.querySelectorAll('.material-only').forEach((n) => { n.hidden = !material; });
    $('#deployBtn').textContent = material ? '수업 자료 만들기' : '클래스룸에 과제 만들기';
  }
  document.querySelectorAll('input[name="dKind"]').forEach((r) => r.addEventListener('change', applyKind));

  function copyBox(url) {
    const box = el('div', 'link-box');
    const input = el('input');
    input.readOnly = true;
    input.value = url;
    const copy = el('button', 'tool-btn', '링크 복사');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(url); } catch { input.select(); document.execCommand('copy'); }
      copy.textContent = '복사됨 ✓';
    });
    box.append(input, copy);
    return box;
  }

  let me = null;
  let courses = [];

  if (G.isDemo) {
    $('#demoBadge').hidden = false;
    $('#demoBadge').title = 'config.js에 googleClientId를 넣기 전까지는 연습용 데이터로 동작해요';
  }

  // ------------------------------------------------------------ 로그인

  $('#teacherSignIn').addEventListener('click', async () => {
    $('#signinError').hidden = true;
    try {
      await G.signIn('teacher');
      await afterSignIn();
    } catch (err) {
      $('#signinError').textContent = err.message;
      $('#signinError').hidden = false;
    }
  });

  async function afterSignIn() {
    me = await G.me();
    courses = await G.listTeacherCourses();
    $('#deploySignin').hidden = true;
    $('#deployMain').hidden = false;
    $('#teacherInfo').textContent = `${me.displayName} (${me.emailAddress}) · 담당 반 ${courses.length}개${G.isDemo ? ' · 데모 모드' : ''}`;
    if (!G.isDemo && /^(localhost|127\.0\.0\.1)$/.test(new URL(APP_BASE).hostname)) {
      $('#urlWarning').textContent = `지금 주소(${APP_BASE})는 이 컴퓨터에서만 열려요. 학생에게 배포하기 전에 배포 주소를 config.js의 appUrl에 넣어 주세요.`;
      $('#urlWarning').hidden = false;
    }
    renderCourses();
    refreshList();
    window.dispatchEvent(new CustomEvent('pyclass:teacher-signed-in'));
  }

  // 채점 탭(grade.js)과 로그인 상태·목록을 함께 쓴다
  window.PyClassTeacher = {
    get me() { return me; },
    get courses() { return courses; },
    signIn: async () => {
      await G.signIn('teacher');
      await afterSignIn();
    },
    // 이 플랫폼으로 만든 과제들 [{ course, w, link, templateId }]
    async listOurAssignments() {
      const rows = [];
      for (const course of courses) {
        const works = await G.listCourseWork(course.id);
        for (const w of works) {
          const link = (w.materials || []).map((mm) => mm.link && mm.link.url).find((u) => u && isOurLink(u));
          if (link) rows.push({ course, w, link, templateId: new URL(link).searchParams.get('t') });
        }
      }
      return rows;
    },
  };

  function renderCourses() {
    const box = $('#courseList');
    box.textContent = '';
    if (!courses.length) {
      box.append(el('p', 'meta', '담당하는 활성 클래스룸 반이 없어요.'));
      return;
    }
    for (const c of courses) {
      const label = el('label', 'check');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.value = c.id;
      label.append(cb, ` ${c.name}${c.section ? ` · ${c.section}` : ''}`);
      box.append(label);
    }
  }

  // ------------------------------------------------------------ 배포

  function log(text, level = '') {
    const li = el('li', level, text);
    $('#deployLog').append(li);
    return li;
  }

  function dueFields() {
    const date = $('#dDueDate').value;
    if (!date) return {};
    const time = $('#dDueTime').value || '23:59';
    const local = new Date(`${date}T${time}:00`);
    return {
      dueDate: { year: local.getUTCFullYear(), month: local.getUTCMonth() + 1, day: local.getUTCDate() },
      dueTime: { hours: local.getUTCHours(), minutes: local.getUTCMinutes() },
    };
  }

  $('#deployForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const material = kind() === 'material';
    const selected = [...document.querySelectorAll('#courseList input:checked')].map((cb) => courses.find((c) => c.id === cb.value));
    if (!selected.length && !material) return log('반을 하나 이상 골라 주세요.', 'error');
    const title = $('#dTitle').value.trim();
    const file = $('#dFile').files[0];
    if (!title || !file) return;

    let template;
    try {
      template = JSON.parse(await file.text());
      if (!Array.isArray(template.cells)) throw new Error('노트북 형식이 아니에요');
    } catch (err) {
      return log(`문제 파일을 읽을 수 없어요: ${err.message}`, 'error');
    }

    // 문제 파일 정리: 실행 결과와 작성 기록을 지우고 과제 설정을 넣는다
    template.metadata = template.metadata || {};
    template.metadata.pyclass = {
      version: 1,
      title,
      kind: material ? 'material' : 'assignment',
      policy: {
        blockPaste: $('#dBlockPaste').checked,
        allowFileOpen: false,
        record: material ? $('#dRecord').checked : true,
      },
    };
    for (const c of template.cells) {
      if (c.cell_type === 'code') {
        c.outputs = [];
        c.execution_count = null;
      }
    }

    const btn = $('#deployBtn');
    btn.disabled = true;
    $('#deployLog').textContent = '';
    try {
      const step = log('문제 파일을 드라이브에 올리는 중…');
      const folderId = await G.ensureFolder('파이썬 노트북 과제 (문제 파일)', { pyclassFolder: 'teacher' });
      const created = await G.createFile({
        name: `${material ? '[수업]' : '[문제]'} ${title}.ipynb`,
        parents: [folderId],
        appProperties: { pyclassTemplate: '1', pyclassKind: material ? 'material' : 'assignment' },
        content: JSON.stringify(template),
      });
      await G.shareForStudents(created.id, me.emailAddress);
      step.textContent = `${material ? '실습' : '문제'} 파일을 드라이브에 올리고 학생들이 읽을 수 있게 공유했어요.`;
      step.className = 'ok';

      if (material) {
        await postMaterial(title, created.id, selected);
        $('#deployForm').reset();
        $('#dDueTime').value = '23:59';
        applyKind();
        refreshList();
        return;
      }

      const points = $('#dPoints').value.trim();
      const state = document.querySelector('input[name="dState"]:checked').value;
      let okCount = 0;
      for (const course of selected) {
        const line = log(`${course.name}: 과제 만드는 중…`);
        try {
          const body = {
            title,
            description: ($('#dDesc').value.trim() + NOTE).trim(),
            workType: 'ASSIGNMENT',
            state,
            materials: [{ link: { url: studentLink(course.id, created.id) } }],
            ...(points ? { maxPoints: Number(points) } : {}),
            ...dueFields(),
          };
          await G.createCourseWork(course.id, body);
          line.textContent = `${course.name}: ${state === 'DRAFT' ? '초안으로 저장했어요' : '게시했어요'}`;
          line.className = 'ok';
          okCount += 1;
        } catch (err) {
          line.textContent = `${course.name}: 실패 (${err.message})`;
          line.className = 'error';
        }
      }
      log(`${selected.length}개 반 중 ${okCount}개 반에 과제를 만들었어요.`, okCount === selected.length ? 'ok' : 'error');
      if (okCount) {
        $('#deployForm').reset();
        $('#dDueTime').value = '23:59';
      }
      refreshList();
    } catch (err) {
      log(`실패: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  // 수업 자료: 고른 반의 클래스룸 "자료"로 올리고, 어디든 붙일 수 있는 링크도 보여준다
  async function postMaterial(title, templateId, selected) {
    const url = practiceLink(templateId);
    const state = document.querySelector('input[name="dState"]:checked').value;
    let okCount = 0;
    for (const course of selected) {
      const line = log(`${course.name}: 수업 자료 올리는 중…`);
      try {
        await G.createMaterial(course.id, {
          title,
          description: ($('#dDesc').value.trim() + NOTE_PRACTICE).trim(),
          state,
          materials: [{ link: { url } }],
        });
        line.textContent = `${course.name}: ${state === 'DRAFT' ? '초안으로 저장했어요' : '클래스룸 자료로 게시했어요'}`;
        line.className = 'ok';
        okCount += 1;
      } catch (err) {
        line.textContent = `${course.name}: 실패 (${err.message})`;
        line.className = 'error';
      }
    }
    const done = log(selected.length
      ? `${selected.length}개 반 중 ${okCount}개 반에 올렸어요. 아래 링크는 다른 곳(스트림, 칠판 등)에 붙여도 돼요.`
      : '수업 자료 링크를 만들었어요. 클래스룸 스트림이나 칠판 등에 붙여 학생에게 알려주세요.', 'ok');
    done.append(copyBox(url));
  }

  // ------------------------------------------------------------ 만든 과제 목록

  $('#refreshList').addEventListener('click', refreshList);

  async function refreshList() {
    const box = $('#assignList');
    box.textContent = '';
    box.append(el('p', 'meta', '불러오는 중…'));
    try {
      const rows = await window.PyClassTeacher.listOurAssignments();
      rows.sort((a, b) => String(b.w.creationTime).localeCompare(String(a.w.creationTime)));
      // 수업 자료는 클래스룸에 안 올린(링크만 만든) 것도 있으므로 드라이브의 실습 파일로 목록을 만든다
      const materials = await G.findFiles({ pyclassKind: 'material' }, 'id,name,modifiedTime');
      box.textContent = '';
      if (!rows.length && !materials.length) {
        box.append(el('p', 'meta', '아직 만든 과제나 수업 자료가 없어요.'));
        return;
      }
      const table = el('table', 'timeline');
      const head = el('tr');
      for (const h of ['종류', '반', '제목', '마감', '상태', '']) head.append(el('th', '', h));
      table.append(head);
      for (const f of materials) {
        const tr = el('tr');
        const url = practiceLink(f.id);
        tr.append(el('td', '', '수업 자료'), el('td', '', '-'), el('td', '', f.name.replace(/^\[수업\]\s*/, '').replace(/\.ipynb$/i, '')), el('td', 'time', '-'), el('td', '', '-'));
        const td = el('td');
        const copy = el('a', 'link', '링크 복사');
        copy.href = '#';
        copy.addEventListener('click', async (e) => {
          e.preventDefault();
          try { await navigator.clipboard.writeText(url); copy.textContent = '복사됨 ✓'; } catch { prompt('링크를 복사하세요', url); }
        });
        const open = el('a', 'link', '학생 화면');
        open.href = url;
        open.target = '_blank';
        open.rel = 'noopener';
        td.append(copy, ' · ', open);
        tr.append(td);
        table.append(tr);
      }
      for (const { course, w, link } of rows) {
        const tr = el('tr');
        tr.append(el('td', '', '과제'), el('td', '', course.name), el('td', '', w.title));
        let due = '-';
        if (w.dueDate) {
          const { year, month, day } = w.dueDate;
          const { hours = 0, minutes = 0 } = w.dueTime || {};
          due = new Date(Date.UTC(year, month - 1, day, hours, minutes)).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
        }
        tr.append(el('td', 'time', due), el('td', '', w.state === 'DRAFT' ? '초안' : '게시됨'));
        const links = el('td');
        const open = el('a', 'link', '클래스룸');
        open.href = w.alternateLink || '#';
        open.target = '_blank';
        open.rel = 'noopener';
        const preview = el('a', 'link', '학생 화면');
        preview.href = link;
        preview.target = '_blank';
        preview.rel = 'noopener';
        links.append(open, ' · ', preview);
        tr.append(links);
        table.append(tr);
      }
      box.append(table);
    } catch (err) {
      box.textContent = '';
      box.append(el('p', 'assign-error', `목록을 불러오지 못했어요: ${err.message}`));
    }
  }

  // 데모 모드는 새로고침해도 로그인 상태가 남아 있다
  if (G.isDemo && G.isSignedIn()) afterSignIn().catch(() => {});
})();
