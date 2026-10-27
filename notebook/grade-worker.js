// 채점 전용 Worker: 학생 코드를 교사 화면과 분리된 곳에서 실행한다.
// 학생 코드가 무한 루프에 빠지면 화면(grade.js)이 이 Worker를 종료하고 새로 띄운다.

let pyodide = null;
let gradeJson = null;

async function init({ pyodideUrl, coreUrl, rubricCode }) {
  try {
    importScripts(`${pyodideUrl}pyodide.js`);
    pyodide = await loadPyodide({ indexURL: pyodideUrl });
    // 학생 코드의 print 출력은 채점에 쓰지 않으므로 버린다
    pyodide.setStdout({ write: (buf) => buf.length });
    pyodide.setStderr({ write: (buf) => buf.length });
    await pyodide.loadPackage(['matplotlib', 'pandas']);
    const core = await (await fetch(coreUrl, { cache: 'no-store' })).text();
    pyodide.runPython('import warnings; warnings.filterwarnings("ignore")');
    pyodide.runPython(core);
    pyodide.runPython(rubricCode);
    if (!pyodide.globals.get('RUBRIC')) throw new Error('채점 기준 파일에 RUBRIC이 없어요');
    gradeJson = pyodide.globals.get('grade_json');
    self.postMessage({ type: 'ready' });
  } catch (err) {
    self.postMessage({ type: 'init-error', message: String((err && err.message) || err) });
  }
}

async function grade({ jobId, student, template, code }) {
  try {
    // 학생이 다른 패키지(seaborn 등)를 import 했으면 먼저 설치
    await pyodide.loadPackagesFromImports(code || '');
    const result = gradeJson(student, template);
    self.postMessage({ type: 'result', jobId, result });
  } catch (err) {
    self.postMessage({ type: 'result', jobId, error: String((err && err.message) || err).slice(-500) });
  }
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') init(msg);
  else if (msg.type === 'grade') grade(msg);
};
