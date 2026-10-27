// 구글 클래스룸·드라이브 API 클라이언트.
// config.js에 googleClientId가 없으면(또는 주소에 ?demo가 있으면) 같은 API를 흉내 내는
// 데모 저장소(브라우저 localStorage)를 대신 써서, 설정 전에도 전체 흐름을 시험할 수 있다.
(function () {
  'use strict';

  const CFG = window.PYCLASS_CONFIG;
  const DEMO = !CFG.googleClientId || new URLSearchParams(location.search).has('demo');

  const CLS = 'https://classroom.googleapis.com/v1';
  const DRV = 'https://www.googleapis.com/drive/v3';
  const UPL = 'https://www.googleapis.com/upload/drive/v3';
  const SHT = 'https://sheets.googleapis.com/v4/spreadsheets';
  const NOTEBOOK_MIME = 'application/vnd.google.colaboratory';

  const SCOPES = {
    student: [
      'https://www.googleapis.com/auth/classroom.coursework.me',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
    // 수업 자료: 클래스룸 권한 없이 드라이브만 (문제 파일 읽기 + 내 실습 파일 저장)
    practice: [
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
    teacher: [
      'https://www.googleapis.com/auth/classroom.courses.readonly',
      'https://www.googleapis.com/auth/classroom.coursework.students',
      'https://www.googleapis.com/auth/classroom.courseworkmaterials',
      'https://www.googleapis.com/auth/classroom.rosters.readonly',
      'https://www.googleapis.com/auth/classroom.profile.emails',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  };

  class AuthError extends Error {
    constructor() { super('로그인이 만료되었어요. 다시 로그인해 주세요.'); this.name = 'AuthError'; }
  }

  class ApiError extends Error {
    constructor(status, message) { super(message); this.name = 'ApiError'; this.status = status; }
  }

  // ------------------------------------------------------------ 로그인 (Google Identity Services)

  let token = null;
  let tokenExp = 0;
  let gisPromise = null;

  function loadGis() {
    if (!gisPromise) {
      gisPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.onload = resolve;
        s.onerror = () => reject(new Error('구글 로그인 스크립트를 불러오지 못했어요'));
        document.head.append(s);
      });
    }
    return gisPromise;
  }

  // 로그인 팝업이 차단되지 않도록 버튼 클릭 직후에 호출해야 한다.
  async function signIn(role) {
    if (DEMO) return Mock.signIn(role);
    await loadGis();
    const scopes = SCOPES[role];
    return new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: CFG.googleClientId,
        scope: scopes.join(' '),
        hosted_domain: CFG.allowedDomain || undefined,
        callback: (resp) => {
          if (resp.error) return reject(new Error(resp.error_description || resp.error));
          if (!google.accounts.oauth2.hasGrantedAllScopes(resp, ...scopes)) {
            return reject(new Error('필요한 권한을 모두 허용해야 해요. 다시 로그인하면서 모든 항목에 체크해 주세요.'));
          }
          token = resp.access_token;
          tokenExp = Date.now() + (Number(resp.expires_in) - 60) * 1000;
          resolve();
        },
        error_callback: (err) => reject(new Error({
          popup_closed: '로그인 창이 닫혔어요. 다시 눌러 주세요.',
          popup_failed_to_open: '로그인 창이 열리지 않았어요. 브라우저 주소창 오른쪽의 팝업 차단을 풀고 다시 눌러 주세요.',
        }[err.type] || err.message || '로그인 실패')),
      });
      client.requestAccessToken({ prompt: '' });
    });
  }

  function isSignedIn() {
    if (DEMO) return Mock.isSignedIn();
    return !!token && Date.now() < tokenExp;
  }

  // ------------------------------------------------------------ 공통 요청

  async function api(method, url, opts = {}) {
    if (DEMO) return Mock.handle(method, url, opts);
    if (!isSignedIn()) throw new AuthError();
    const u = new URL(url);
    for (const [k, v] of Object.entries(opts.query || {})) if (v != null) u.searchParams.set(k, v);
    const headers = { Authorization: `Bearer ${token}`, ...(opts.headers || {}) };
    let body = opts.body;
    if (body != null && typeof body !== 'string' && !(body instanceof Blob)) {
      body = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(u, { method, headers, body, keepalive: !!opts.keepalive });
    if (res.status === 401) {
      token = null;
      throw new AuthError();
    }
    if (!res.ok) {
      let message = res.statusText;
      try {
        const j = await res.json();
        message = (j.error && j.error.message) || message;
      } catch { /* 본문 없음 */ }
      throw new ApiError(res.status, message);
    }
    if (opts.raw) return res.text();
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  async function paginate(url, query, key) {
    const items = [];
    let pageToken;
    do {
      const r = await api('GET', url, { query: { ...query, pageToken } });
      items.push(...(r[key] || []));
      pageToken = r.nextPageToken;
    } while (pageToken);
    return items;
  }

  function multipartBody(metadata, content, mimeType) {
    const boundary = `pyclass${Math.random().toString(36).slice(2)}`;
    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(metadata),
      `--${boundary}`,
      `Content-Type: ${mimeType}`,
      '',
      content,
      `--${boundary}--`,
      '',
    ].join('\r\n');
    return { body, contentType: `multipart/related; boundary=${boundary}` };
  }

  const escapeQ = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  // ------------------------------------------------------------ 클래스룸 / 드라이브 기능

  const G = {
    isDemo: DEMO,
    AuthError,
    ApiError,
    signIn,
    isSignedIn,
    NOTEBOOK_MIME,

    async me() {
      const r = await api('GET', `${DRV}/about`, { query: { fields: 'user(displayName,emailAddress)' } });
      return r.user;
    },

    listTeacherCourses: () => paginate(`${CLS}/courses`, { teacherId: 'me', courseStates: 'ACTIVE' }, 'courses'),
    getCourse: (courseId) => api('GET', `${CLS}/courses/${courseId}`),
    listCourseWork: (courseId) => paginate(`${CLS}/courses/${courseId}/courseWork`, { courseWorkStates: 'PUBLISHED,DRAFT' }, 'courseWork'),
    listPublishedCourseWork: (courseId) => paginate(`${CLS}/courses/${courseId}/courseWork`, {}, 'courseWork'),
    createCourseWork: (courseId, body) => api('POST', `${CLS}/courses/${courseId}/courseWork`, { body }),
    // 수업 자료 (클래스룸 "자료")
    createMaterial: (courseId, body) => api('POST', `${CLS}/courses/${courseId}/courseWorkMaterials`, { body }),
    listMaterials: (courseId) => paginate(`${CLS}/courses/${courseId}/courseWorkMaterials`, { courseWorkMaterialStates: 'PUBLISHED,DRAFT' }, 'courseWorkMaterial'),

    async mySubmission(courseId, courseWorkId) {
      const r = await api('GET', `${CLS}/courses/${courseId}/courseWork/${courseWorkId}/studentSubmissions`, { query: { userId: 'me' } });
      return (r.studentSubmissions || [])[0] || null;
    },
    attachFile: (courseId, courseWorkId, subId, fileId) => api('POST',
      `${CLS}/courses/${courseId}/courseWork/${courseWorkId}/studentSubmissions/${subId}:modifyAttachments`,
      { body: { addAttachments: [{ driveFile: { id: fileId } }] } }),
    turnIn: (courseId, courseWorkId, subId) => api('POST',
      `${CLS}/courses/${courseId}/courseWork/${courseWorkId}/studentSubmissions/${subId}:turnIn`, { body: {} }),
    reclaim: (courseId, courseWorkId, subId) => api('POST',
      `${CLS}/courses/${courseId}/courseWork/${courseWorkId}/studentSubmissions/${subId}:reclaim`, { body: {} }),

    // ---- 채점용 (교사)
    listStudents: (courseId) => paginate(`${CLS}/courses/${courseId}/students`, {}, 'students'),
    listSubmissions: (courseId, courseWorkId) => paginate(`${CLS}/courses/${courseId}/courseWork/${courseWorkId}/studentSubmissions`, {}, 'studentSubmissions'),
    setDraftGrade: (courseId, courseWorkId, subId, grade) => api('PATCH',
      `${CLS}/courses/${courseId}/courseWork/${courseWorkId}/studentSubmissions/${subId}`,
      { query: { updateMask: 'draftGrade' }, body: { draftGrade: grade } }),
    setMaxPoints: (courseId, courseWorkId, maxPoints) => api('PATCH',
      `${CLS}/courses/${courseId}/courseWork/${courseWorkId}`,
      { query: { updateMask: 'maxPoints' }, body: { maxPoints } }),

    // ---- 구글 시트
    async createSpreadsheet(name, appProperties, parents) {
      return api('POST', `${DRV}/files`, {
        query: { fields: 'id,webViewLink' },
        body: { name, mimeType: 'application/vnd.google-apps.spreadsheet', appProperties, parents },
      });
    },
    async writeSheetTab(spreadsheetId, title, rows) {
      const meta = await api('GET', `${SHT}/${spreadsheetId}`, { query: { fields: 'sheets.properties' } });
      const exists = (meta.sheets || []).some((s) => s.properties.title === title);
      if (!exists) {
        await api('POST', `${SHT}/${spreadsheetId}:batchUpdate`, { body: { requests: [{ addSheet: { properties: { title } } }] } });
      }
      const range = `'${title.replace(/'/g, "''")}'`;
      await api('POST', `${SHT}/${spreadsheetId}/values/${encodeURIComponent(range)}:clear`, { body: {} });
      await api('PUT', `${SHT}/${spreadsheetId}/values/${encodeURIComponent(`${range}!A1`)}`, {
        query: { valueInputOption: 'RAW' },
        body: { values: rows },
      });
    },

    async findFiles(appProps, fields = 'id,name,modifiedTime') {
      const conds = Object.entries(appProps).map(([k, v]) => `appProperties has { key='${escapeQ(k)}' and value='${escapeQ(v)}' }`);
      conds.push('trashed = false');
      const r = await api('GET', `${DRV}/files`, { query: { q: conds.join(' and '), fields: `files(${fields})`, spaces: 'drive', pageSize: 100 } });
      return r.files || [];
    },

    async ensureFolder(name, appProps) {
      const found = await G.findFiles(appProps, 'id,name');
      if (found.length) return found[0].id;
      const r = await api('POST', `${DRV}/files`, {
        query: { fields: 'id' },
        body: { name, mimeType: 'application/vnd.google-apps.folder', appProperties: appProps },
      });
      return r.id;
    },

    async createFile({ name, parents, appProperties, content, mimeType = NOTEBOOK_MIME }) {
      const contentMime = mimeType === NOTEBOOK_MIME ? 'application/json' : mimeType;
      const { body, contentType } = multipartBody({ name, parents, appProperties, mimeType }, content, contentMime);
      return api('POST', `${UPL}/files`, {
        query: { uploadType: 'multipart', fields: 'id,name,webViewLink' },
        headers: { 'Content-Type': contentType },
        body,
      });
    },

    // 내용만 바꾼다. Content-Type을 파일 종류와 맞춰야 드라이브가 파일 형식을 바꾸지 않는다
    updateFile: (fileId, content, { keepalive, mimeType = NOTEBOOK_MIME } = {}) => api('PATCH', `${UPL}/files/${fileId}`, {
      query: { uploadType: 'media', fields: 'id,modifiedTime' },
      headers: { 'Content-Type': mimeType },
      body: content,
      keepalive,
    }),

    readFile: (fileId) => api('GET', `${DRV}/files/${fileId}`, { query: { alt: 'media' }, raw: true }),

    // 문제 파일을 학교 도메인 사람들만 링크로 볼 수 있게 공유 (개인 Gmail이면 링크가 있는 모든 사람)
    shareForStudents(fileId, email) {
      const domain = String(email).split('@')[1] || '';
      const perm = domain && domain !== 'gmail.com'
        ? { role: 'reader', type: 'domain', domain, allowFileDiscovery: false }
        : { role: 'reader', type: 'anyone', allowFileDiscovery: false };
      return api('POST', `${DRV}/files/${fileId}/permissions`, { body: perm });
    },
  };

  // ------------------------------------------------------------ 데모 저장소

  const Mock = (() => {
    if (!DEMO) return null;
    const KEY = 'pyclass:demo:store';
    const USER_KEY = 'pyclass:demo:user';

    const TEACHER = { id: 'T1', name: '김정보 선생님', email: 'teacher@demo.school' };
    const STUDENTS = [
      { id: 'S1', name: '홍길동', email: '10101@demo.school' },
      { id: 'S2', name: '이영희', email: '10102@demo.school' },
      { id: 'S3', name: '박철수', email: '10201@demo.school' },
    ];
    const USERS = [TEACHER, ...STUDENTS];

    function seed() {
      return {
        seq: 100,
        courses: [
          { id: 'C1', name: '1학년 1반 정보', section: '2학기', ownerId: 'T1', teachers: ['T1'], students: ['S1', 'S2'], alternateLink: 'https://classroom.google.com/' },
          { id: 'C2', name: '1학년 2반 정보', section: '2학기', ownerId: 'T1', teachers: ['T1'], students: ['S3'], alternateLink: 'https://classroom.google.com/' },
        ],
        courseWork: [],
        submissions: [],
        files: [],
      };
    }

    const load = () => {
      try { return JSON.parse(localStorage.getItem(KEY)) || seed(); } catch { return seed(); }
    };
    const save = (db) => localStorage.setItem(KEY, JSON.stringify(db));
    const currentUser = () => USERS.find((u) => u.id === sessionStorage.getItem(USER_KEY)) || null;
    const nextId = (db, prefix) => `${prefix}${++db.seq}`;
    const fail = (status, msg) => { throw new ApiError(status, msg); };
    const delay = () => new Promise((r) => setTimeout(r, 120));

    function signIn(role) {
      if (role === 'teacher') {
        sessionStorage.setItem(USER_KEY, TEACHER.id);
        return Promise.resolve();
      }
      // 학생 데모: 누구로 로그인할지 고르는 창
      return new Promise((resolve, reject) => {
        const back = document.createElement('div');
        back.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);display:grid;place-items:center;z-index:100';
        const box = document.createElement('div');
        box.style.cssText = 'background:var(--surface);color:var(--text);border-radius:10px;padding:20px;min-width:260px;box-shadow:var(--shadow)';
        box.innerHTML = '<div style="font-weight:500;margin-bottom:4px">데모 로그인</div><div style="font-size:12px;color:var(--text-muted);margin-bottom:12px">어떤 학생으로 로그인할까요?</div>';
        for (const s of STUDENTS.concat([TEACHER])) {
          const b = document.createElement('button');
          b.textContent = `${s.name} (${s.email})`;
          b.style.cssText = 'display:block;width:100%;text-align:left;margin:4px 0;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:none;cursor:pointer';
          b.onclick = () => { sessionStorage.setItem(USER_KEY, s.id); back.remove(); resolve(); };
          box.append(b);
        }
        const cancel = document.createElement('button');
        cancel.textContent = '취소';
        cancel.style.cssText = 'margin-top:8px;border:0;background:none;color:var(--text-muted);cursor:pointer';
        cancel.onclick = () => { back.remove(); reject(new Error('로그인 창이 닫혔어요')); };
        box.append(cancel);
        back.append(box);
        document.body.append(back);
      });
    }

    function canSeeFile(f, user, db) {
      if (f.owner === user.id) return true;
      if (f.shared) return true; // 도메인 공유
      if ((f.readers || []).includes(user.id)) return true;
      // 클래스룸 제출물에 첨부된 파일은 그 반 선생님이 볼 수 있음
      return db.submissions.some((s) => s.assignmentSubmission.attachments.some((a) => a.driveFile.id === f.id)
        && db.courses.some((c) => c.id === s.courseId && c.teachers.includes(user.id)));
    }

    function parseAppProps(q) {
      const out = {};
      const re = /appProperties has \{ key='([^']*)' and value='([^']*)' \}/g;
      let m;
      while ((m = re.exec(q))) out[m[1]] = m[2];
      return out;
    }

    function parseMultipart(body) {
      const first = body.indexOf('\r\n\r\n');
      const metaEnd = body.indexOf('\r\n--', first);
      const meta = JSON.parse(body.slice(first + 4, metaEnd));
      const contentStart = body.indexOf('\r\n\r\n', metaEnd) + 4;
      const contentEnd = body.lastIndexOf('\r\n--');
      return { meta, content: body.slice(contentStart, contentEnd) };
    }

    async function handle(method, url, opts) {
      await delay();
      const user = currentUser();
      if (!user) throw new AuthError();
      const db = load();
      const u = new URL(url);
      for (const [k, v] of Object.entries(opts.query || {})) if (v != null) u.searchParams.set(k, v);
      const path = decodeURIComponent(u.pathname).replace(/^\/(v1|v4|drive\/v3|upload\/drive\/v3)\//, '');
      const body = typeof opts.body === 'string' && !u.pathname.startsWith('/upload') ? JSON.parse(opts.body) : opts.body;
      let m;

      // ---- 구글 시트
      if (u.hostname === 'sheets.googleapis.com') {
        db.sheets = db.sheets || {};
        if ((m = path.match(/^spreadsheets\/([^/:]+)$/))) {
          const tabs = Object.keys(db.sheets[m[1]] || { '시트1': [] });
          return { sheets: tabs.map((title) => ({ properties: { title } })) };
        }
        if ((m = path.match(/^spreadsheets\/([^/:]+):batchUpdate$/))) {
          const book = db.sheets[m[1]] || (db.sheets[m[1]] = {});
          for (const r of body.requests || []) if (r.addSheet) book[r.addSheet.properties.title] = [];
          save(db);
          return {};
        }
        if ((m = path.match(/^spreadsheets\/([^/]+)\/values\/'(.+)'(!A1)?(:clear)?$/))) {
          const book = db.sheets[m[1]] || (db.sheets[m[1]] = {});
          const title = m[2].replace(/''/g, "'");
          book[title] = m[4] ? [] : body.values;
          save(db);
          return {};
        }
      }

      // ---- 드라이브
      if (u.hostname === 'www.googleapis.com') {
        if (path === 'about') return { user: { displayName: user.name, emailAddress: user.email } };
        if (path === 'files' && method === 'GET') {
          const props = parseAppProps(u.searchParams.get('q') || '');
          const files = db.files.filter((f) => f.owner === user.id && !f.trashed
            && Object.entries(props).every(([k, v]) => (f.appProperties || {})[k] === v));
          return { files: files.map(({ id, name, modifiedTime }) => ({ id, name, modifiedTime })) };
        }
        if (path === 'files' && method === 'POST' && !u.pathname.startsWith('/upload')) {
          const f = { id: nextId(db, 'F'), name: body.name, mimeType: body.mimeType, appProperties: body.appProperties || {}, owner: user.id, content: '', modifiedTime: new Date().toISOString() };
          db.files.push(f);
          save(db);
          return { id: f.id, webViewLink: '#' };
        }
        if (path === 'files' && method === 'POST') {
          const { meta, content } = parseMultipart(opts.body);
          const f = { id: nextId(db, 'F'), name: meta.name, mimeType: meta.mimeType, appProperties: meta.appProperties || {}, parents: meta.parents, owner: user.id, content, modifiedTime: new Date().toISOString() };
          db.files.push(f);
          save(db);
          return { id: f.id, name: f.name, webViewLink: '#' };
        }
        if ((m = path.match(/^files\/([^/]+)\/permissions$/))) {
          const f = db.files.find((x) => x.id === m[1]);
          if (!f || f.owner !== user.id) fail(404, 'File not found');
          f.shared = true;
          save(db);
          return { id: 'P1' };
        }
        if ((m = path.match(/^files\/([^/]+)$/))) {
          const f = db.files.find((x) => x.id === m[1]);
          if (!f || !canSeeFile(f, user, db)) fail(404, `File not found: ${m[1]}`);
          if (method === 'PATCH') {
            if (f.owner !== user.id || f.locked) fail(403, '이 파일을 수정할 권한이 없어요');
            f.content = opts.body;
            f.modifiedTime = new Date().toISOString();
            save(db);
            return { id: f.id, modifiedTime: f.modifiedTime };
          }
          if (u.searchParams.get('alt') === 'media') return f.content;
          return { id: f.id, name: f.name };
        }
      }

      // ---- 클래스룸
      if (path === 'courses' && method === 'GET') {
        return { courses: db.courses.filter((c) => c.teachers.includes(user.id)).map(({ id, name, section, alternateLink }) => ({ id, name, section, alternateLink, courseState: 'ACTIVE' })) };
      }
      if ((m = path.match(/^courses\/([^/]+)\/courseWorkMaterials$/))) {
        const c = db.courses.find((x) => x.id === m[1]);
        if (!c || !c.teachers.includes(user.id)) fail(403, 'The caller does not have permission');
        db.materials = db.materials || [];
        if (method === 'POST') {
          const mat = { ...body, id: nextId(db, 'M'), courseId: c.id, creationTime: new Date().toISOString(), alternateLink: 'https://classroom.google.com/' };
          db.materials.push(mat);
          save(db);
          return mat;
        }
        return { courseWorkMaterial: db.materials.filter((x) => x.courseId === c.id) };
      }
      if ((m = path.match(/^courses\/([^/]+)\/students$/))) {
        const c = db.courses.find((x) => x.id === m[1]);
        if (!c || !c.teachers.includes(user.id)) fail(403, 'The caller does not have permission');
        return {
          students: c.students.map((sid) => {
            const s = STUDENTS.find((x) => x.id === sid);
            return { userId: s.id, profile: { id: s.id, name: { fullName: s.name }, emailAddress: s.email } };
          }),
        };
      }
      if ((m = path.match(/^courses\/([^/]+)\/courseWork\/([^/:]+)$/)) && method === 'PATCH') {
        const w = db.courseWork.find((x) => x.id === m[2]);
        if (!w) fail(404, 'Requested entity was not found.');
        Object.assign(w, body);
        save(db);
        return w;
      }
      if ((m = path.match(/^courses\/([^/]+)\/courseWork\/([^/]+)\/studentSubmissions\/([^/:]+)$/)) && method === 'PATCH') {
        const s = db.submissions.find((x) => x.id === m[3]);
        const c = db.courses.find((x) => x.id === m[1]);
        if (!s || !c.teachers.includes(user.id)) fail(403, 'The caller does not have permission');
        s.draftGrade = body.draftGrade;
        save(db);
        return s;
      }
      if ((m = path.match(/^courses\/([^/]+)$/))) {
        const c = db.courses.find((x) => x.id === m[1]);
        if (!c || !(c.teachers.includes(user.id) || c.students.includes(user.id))) fail(404, 'Requested entity was not found.');
        return { id: c.id, name: c.name, section: c.section };
      }
      if ((m = path.match(/^courses\/([^/]+)\/courseWork$/))) {
        const c = db.courses.find((x) => x.id === m[1]);
        if (!c) fail(404, 'Requested entity was not found.');
        const isTeacher = c.teachers.includes(user.id);
        if (!isTeacher && !c.students.includes(user.id)) fail(403, 'The caller does not have permission');
        if (method === 'POST') {
          if (!isTeacher) fail(403, 'The caller does not have permission');
          const cw = { ...body, id: nextId(db, 'W'), courseId: c.id, creationTime: new Date().toISOString(), alternateLink: 'https://classroom.google.com/' };
          db.courseWork.push(cw);
          for (const sid of c.students) {
            db.submissions.push({ id: nextId(db, 'SUB'), courseId: c.id, courseWorkId: cw.id, userId: sid, state: 'CREATED', assignmentSubmission: { attachments: [] } });
          }
          save(db);
          return cw;
        }
        return { courseWork: db.courseWork.filter((w) => w.courseId === c.id && (isTeacher || w.state === 'PUBLISHED')) };
      }
      if ((m = path.match(/^courses\/([^/]+)\/courseWork\/([^/]+)\/studentSubmissions$/))) {
        const subs = db.submissions.filter((s) => s.courseId === m[1] && s.courseWorkId === m[2]
          && (u.searchParams.get('userId') !== 'me' || s.userId === user.id));
        return { studentSubmissions: subs };
      }
      if ((m = path.match(/^courses\/([^/]+)\/courseWork\/([^/]+)\/studentSubmissions\/([^/:]+):(\w+)$/))) {
        const s = db.submissions.find((x) => x.id === m[3]);
        if (!s || s.userId !== user.id) fail(403, 'The caller does not have permission');
        const action = m[4];
        if (action === 'modifyAttachments') {
          for (const a of body.addAttachments || []) {
            const f = db.files.find((x) => x.id === a.driveFile.id);
            s.assignmentSubmission.attachments.push({ driveFile: { id: f.id, title: f.name, alternateLink: '#' } });
          }
        } else if (action === 'turnIn') {
          if (s.state === 'TURNED_IN') fail(400, 'Precondition check failed.');
          s.state = 'TURNED_IN';
          for (const a of s.assignmentSubmission.attachments) {
            const f = db.files.find((x) => x.id === a.driveFile.id);
            if (f) f.locked = true; // 클래스룸처럼 제출 후에는 학생이 파일을 수정할 수 없음
          }
        } else if (action === 'reclaim') {
          if (s.state !== 'TURNED_IN') fail(400, 'Precondition check failed.');
          s.state = 'RECLAIMED_BY_STUDENT';
          for (const a of s.assignmentSubmission.attachments) {
            const f = db.files.find((x) => x.id === a.driveFile.id);
            if (f) f.locked = false;
          }
        }
        save(db);
        return action === 'modifyAttachments' ? s : {};
      }
      fail(404, `데모 모드에서 지원하지 않는 요청: ${method} ${path}`);
      return null;
    }

    return {
      signIn,
      isSignedIn: () => !!currentUser(),
      handle,
      reset: () => { localStorage.removeItem(KEY); sessionStorage.removeItem(USER_KEY); },
    };
  })();

  G.demoReset = DEMO ? Mock.reset : null;
  window.PyClassGoogle = G;
})();
