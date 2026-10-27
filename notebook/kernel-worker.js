// 파이썬 커널: Web Worker 안에서 Pyodide를 실행한다.
// 화면(app.js)과 분리되어 있어서 무한 루프가 돌아도 화면이 멈추지 않고,
// "중단" 시에는 이 워커를 통째로 종료한 뒤 새로 띄운다.

let pyodide = null;
let currentRunId = null;
let inputUrl = '';

const BOOTSTRAP = String.raw`
import sys, os, io, base64, json, traceback, builtins, warnings, linecache
os.environ["MPLBACKEND"] = "AGG"
warnings.filterwarnings("ignore", message=".*non-interactive.*")
warnings.filterwarnings("ignore", message=".*FigureCanvasAgg.*")
warnings.filterwarnings("ignore", message=r"(?s).*Pyarrow will become a required dependency")

import js
from pyodide.code import eval_code_async

_user_ns = {"__name__": "__main__", "__builtins__": builtins}

def _emit(output):
    js.emitOutput(json.dumps(output))

def _mime(value):
    data = {"text/plain": repr(value)}
    to_html = getattr(value, "_repr_html_", None)
    if callable(to_html):
        try:
            html = to_html()
            if html:
                data["text/html"] = html
        except Exception:
            pass
    return data

def display(*values):
    for value in values:
        _emit({"output_type": "display_data", "data": _mime(value), "metadata": {}})

_user_ns["display"] = display

def _input(prompt=""):
    sys.stdout.flush()
    sys.stderr.flush()
    return js.requestInputSync(str(prompt))

builtins.input = _input

def _flush_figures():
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return
    for num in plt.get_fignums():
        fig = plt.figure(num)
        buf = io.BytesIO()
        fig.savefig(buf, format="png", bbox_inches="tight", dpi=100)
        _emit({
            "output_type": "display_data",
            "data": {
                "image/png": base64.b64encode(buf.getvalue()).decode("ascii"),
                "text/plain": f"<Figure {num}>",
            },
            "metadata": {},
        })
    plt.close("all")

_KOREAN_FONT_URL = "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/nanumgothic/NanumGothic-Regular.ttf"
_korean_font_ready = False

async def _load_korean_font():
    # 그래프 제목·축 이름에 한글을 쓰면 네모로 깨지지 않도록 나눔고딕을 한 번만 내려받아 등록한다.
    global _korean_font_ready
    if _korean_font_ready:
        return
    _korean_font_ready = True
    try:
        from pyodide.http import pyfetch
        import matplotlib
        from matplotlib import font_manager
        resp = await pyfetch(_KOREAN_FONT_URL)
        path = "/tmp/NanumGothic-Regular.ttf"
        with open(path, "wb") as f:
            f.write(await resp.bytes())
        font_manager.fontManager.addfont(path)
        matplotlib.rcParams["font.family"] = font_manager.FontProperties(fname=path).get_name()
        matplotlib.rcParams["axes.unicode_minus"] = False
    except Exception:
        pass

async def _prepare_matplotlib():
    import matplotlib
    matplotlib.use("AGG")
    import matplotlib.pyplot as plt
    await _load_korean_font()
    if not getattr(plt.show, "_pyclass", False):
        def show(*args, **kwargs):
            sys.stdout.flush()
            _flush_figures()
        show._pyclass = True
        plt.show = show

def _format_exc(e):
    # 플랫폼 내부 프레임은 숨기고 학생이 쓴 셀 코드부터 보여준다.
    tb = e.__traceback__
    while tb is not None and not tb.tb_frame.f_code.co_filename.startswith("<셀"):
        tb = tb.tb_next
    return "".join(traceback.format_exception(type(e), e, tb))

async def _pyclass_run(code, filename):
    linecache.cache[filename] = (len(code), None, code.splitlines(True), filename)
    try:
        if "matplotlib" in code:
            await _prepare_matplotlib()
        result = await eval_code_async(code, _user_ns, filename=filename)
    except BaseException as e:
        sys.stdout.flush()
        sys.stderr.flush()
        _flush_figures()
        _emit({
            "output_type": "error",
            "ename": type(e).__name__,
            "evalue": str(e),
            "traceback": [_format_exc(e)],
        })
        return False
    sys.stdout.flush()
    sys.stderr.flush()
    _flush_figures()
    if result is not None:
        _user_ns["_"] = result
        _emit({"output_type": "execute_result", "data": _mime(result), "metadata": {}})
    return True
`;

function post(msg) {
  self.postMessage(msg);
}

function progress(text) {
  post({ type: 'progress', runId: currentRunId, text });
}

function makeWriter(name) {
  const decoder = new TextDecoder();
  return {
    write(buf) {
      const text = decoder.decode(buf, { stream: true });
      if (text) post({ type: 'output', runId: currentRunId, output: { output_type: 'stream', name, text } });
      return buf.length;
    },
  };
}

function makeId() {
  return (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
}

// input(): 화면에 입력칸을 띄우고, 서비스 워커를 거친 동기 요청으로 학생이 입력한 값을 받아온다.
function requestInputSync(prompt) {
  const id = makeId();
  post({ type: 'input-request', runId: currentRunId, id, prompt });
  for (;;) {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `${inputUrl}?id=${encodeURIComponent(id)}&t=${Date.now()}`, false);
    try {
      xhr.send(null);
    } catch (err) {
      throw new Error('입력값을 받지 못했어요. 페이지를 새로고침한 뒤 다시 실행해 주세요.');
    }
    if (xhr.status === 200) return xhr.responseText;
    if (xhr.status === 204) continue; // 아직 입력 전: 다시 기다린다
    throw new Error(`입력 연결 오류(${xhr.status}). 페이지를 새로고침한 뒤 다시 실행해 주세요.`);
  }
}

self.requestInputSync = requestInputSync;
self.emitOutput = (json) => post({ type: 'output', runId: currentRunId, output: JSON.parse(json) });

async function init(msg) {
  inputUrl = msg.inputUrl;
  try {
    progress('파이썬 런타임 내려받는 중… (처음 한 번은 10~20초)');
    importScripts(msg.pyodideUrl + 'pyodide.js');
    pyodide = await loadPyodide({ indexURL: msg.pyodideUrl });
    pyodide.setStdout(makeWriter('stdout'));
    pyodide.setStderr(makeWriter('stderr'));
    progress('파이썬 초기화 중…');
    await pyodide.runPythonAsync(BOOTSTRAP);
    const pyVersion = pyodide.runPython('import sys; sys.version.split()[0]');
    post({ type: 'ready', pythonVersion: pyVersion });
  } catch (err) {
    post({ type: 'init-error', message: String(err && err.message || err) });
  }
}

// 코랩식 명령(!pip install, %matplotlib inline 등)을 처리한다.
function preprocess(code) {
  const pipPackages = [];
  const unsupported = [];
  const lines = code.split('\n').map((line) => {
    const pip = line.match(/^(\s*)[!%]pip\s+install\s+(.+)$/);
    if (pip) {
      pip[2].split(/\s+/).filter((p) => p && !p.startsWith('-')).forEach((p) => pipPackages.push(p));
      return `${pip[1]}pass`;
    }
    const magic = line.match(/^(\s*)%/);
    if (magic) return `${magic[1]}pass`;
    const shell = line.match(/^(\s*)!(.*)$/);
    if (shell) {
      unsupported.push(shell[2].trim());
      return `${shell[1]}pass`;
    }
    return line;
  });
  return { code: lines.join('\n'), pipPackages, unsupported };
}

async function run(msg) {
  currentRunId = msg.runId;
  let ok = false;
  try {
    const prepared = preprocess(msg.code);
    if (prepared.unsupported.length) {
      post({
        type: 'output', runId: currentRunId,
        output: {
          output_type: 'error', ename: 'ShellCommandError', evalue: '',
          traceback: [`이 노트북에서는 셸 명령(!)을 쓸 수 없어요: !${prepared.unsupported[0]}`],
        },
      });
      return;
    }
    if (prepared.pipPackages.length) {
      progress(`패키지 설치 중: ${prepared.pipPackages.join(', ')}`);
      await pyodide.loadPackage('micropip');
      const micropip = pyodide.pyimport('micropip');
      await micropip.install(prepared.pipPackages);
      micropip.destroy();
      post({
        type: 'output', runId: currentRunId,
        output: { output_type: 'stream', name: 'stdout', text: `설치 완료: ${prepared.pipPackages.join(', ')}\n` },
      });
    }
    await pyodide.loadPackagesFromImports(prepared.code, {
      messageCallback: (m) => { if (/^Loading /.test(m)) progress(`패키지 불러오는 중: ${m.replace(/^Loading /, '')}`); },
      errorCallback: () => {},
    });
    progress('');
    const runCell = pyodide.globals.get('_pyclass_run');
    try {
      ok = await runCell(prepared.code, msg.filename);
    } finally {
      runCell.destroy();
    }
  } catch (err) {
    post({
      type: 'output', runId: currentRunId,
      output: { output_type: 'error', ename: 'Error', evalue: String(err.message || err), traceback: [String(err.message || err)] },
    });
    ok = false;
  } finally {
    post({ type: 'done', runId: msg.runId, ok });
  }
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') init(msg);
  else if (msg.type === 'run') run(msg);
};
