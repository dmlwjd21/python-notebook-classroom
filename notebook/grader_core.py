"""자동 채점 엔진 (Pyodide 안에서 실행)

학생 노트북의 문제별 코드를 다시 실행하고, 코드 글자가 아니라 **실행 결과(그래프 객체)**를 검사해 채점한다.
그래서 color='olive'와 color='#808000'처럼 쓰는 방식이 달라도 결과가 같으면 같은 점수를 받는다.

채점 기준(RUBRIC)은 과제마다 따로 만들고 이 엔진에 넘긴다. 기준 파일은 정답 정보를 담고 있으므로
배포 폴더(notebook/)에 두지 않는다.

RUBRIC = {
    "title": "...",
    "base": 10,                          # 기본 점수
    "setup_heading": "## 1.데이터",      # 이 제목 아래 코드는 교사 문제 파일의 코드로 실행 (학생이 고쳐도 무시)
    "problems": [
        {"id": "q2", "heading": "## 2.막대", "title": "막대 그래프", "check": 함수},
        ...
    ],
}
check(ctx) 는 [(항목 이름, 점수, 만점, 설명), ...] 를 돌려준다.
"""
import json
import re
import traceback

import matplotlib

matplotlib.use("AGG")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.colors import to_rgba  # noqa: E402


# ------------------------------------------------------------------ 노트북 다루기

def _src(cell):
    s = cell.get("source", "")
    return "".join(s) if isinstance(s, list) else s


def _norm(text):
    return re.sub(r"\s+", "", text)


def split_sections(nb):
    """마크다운 제목(## ...)을 기준으로 노트북을 구역으로 나눈다: [(제목 문단, [코드 셀...])]"""
    sections = []
    current = ("", [])
    for cell in nb.get("cells", []):
        if cell.get("cell_type") == "markdown":
            text = _src(cell)
            if re.search(r"^\s*#{1,6}\s", text, re.M):
                sections.append(current)
                current = (text, [])
            continue
        if cell.get("cell_type") == "code":
            current[1].append(cell)
    sections.append(current)
    return sections


def find_section(sections, heading):
    key = _norm(heading)
    for text, cells in sections:
        if key and key in _norm(text):
            return cells
    return None


def has_image_output(cells):
    for c in cells:
        for o in c.get("outputs", []) or []:
            if o.get("output_type") in ("display_data", "execute_result") and "image/png" in (o.get("data") or {}):
                return True
    return False


def has_error_output(cells):
    return any(o.get("output_type") == "error" for c in cells for o in (c.get("outputs") or []))


# ------------------------------------------------------------------ 실행

def _no_input(prompt=""):
    # 채점 중에는 입력을 기다리지 않는다
    return ""


def run_code(code, ns):
    """학생 코드를 실행하고 만들어진 그래프들을 돌려준다.
    plt.show()가 불리면 주피터처럼 그 시점의 그래프를 확정하고 닫는다."""
    plt.close("all")
    ns.setdefault("input", _no_input)
    shown = []
    original_show = plt.show

    def fake_show(*args, **kwargs):
        for n in plt.get_fignums():
            shown.append(plt.figure(n))
        plt.close("all")

    plt.show = fake_show
    error = None
    try:
        exec(compile(code, "<학생 코드>", "exec"), ns)
    except BaseException as e:  # SystemExit 등도 채점은 계속
        error = f"{type(e).__name__}: {e}"
    finally:
        plt.show = original_show
    figs = shown + [plt.figure(n) for n in plt.get_fignums()]
    for f in figs:
        try:
            f.canvas.draw()  # 눈금 이름·격자 같은 값은 그려야 확정된다
        except Exception:
            pass
    return figs, error


def _content_score(fig):
    n = 0
    for ax in fig.axes:
        n += len(ax.patches) + len(ax.lines) + len(ax.collections)
    return n


class Ctx:
    """채점 함수가 쓰는 정보 묶음"""

    def __init__(self, code, cells, figs, error, ns):
        self.code = code
        self.cells = cells
        self.figs = figs
        self.error = error
        self.ns = ns
        self.fig = max(figs, key=_content_score) if figs else None
        self.ax = self.fig.axes[0] if self.fig is not None and self.fig.axes else None
        # 오류가 나도 그 전까지 그린 그래프는 채점한다 (코랩도 오류 전까지 그린 그래프를 보여줌)
        self.ran_ok = self.fig is not None and _content_score(self.fig) > 0
        # "실행하여 출력" 항목: 오류 없이 실행됐고, 제출 파일에 그래프 출력이 남아 있어야 함
        self.output_ok = error is None and has_image_output(cells) and not has_error_output(cells)

    def output_note(self):
        if self.error:
            return f"실행 중 오류: {self.error}"
        if not has_image_output(self.cells):
            return "제출 파일에 실행 결과(그래프)가 없어요"
        if has_error_output(self.cells):
            return "제출 파일의 실행 결과에 오류가 있어요"
        return ""


# ------------------------------------------------------------------ 검사 도우미 (채점 기준에서 사용)

def same_color(a, b):
    try:
        return all(abs(x - y) < 0.01 for x, y in zip(to_rgba(a)[:3], to_rgba(b)[:3]))
    except (ValueError, TypeError):
        return False


def close(a, b, tol=1e-6):
    try:
        return abs(float(a) - float(b)) <= tol
    except (TypeError, ValueError):
        return False


def figsize_is(ctx, w, h):
    if ctx.fig is None:
        return False
    fw, fh = ctx.fig.get_size_inches()
    return close(fw, w, 0.01) and close(fh, h, 0.01)


def text_is(actual, expected):
    return (actual or "").strip() == expected


def xtick_texts(ax):
    return [t.get_text() for t in ax.get_xticklabels() if t.get_text()]


def xtick_rotation_is(ax, deg):
    labels = [t for t in ax.get_xticklabels() if t.get_text()]
    return bool(labels) and all(close(t.get_rotation() % 360, deg % 360, 0.5) for t in labels)


def grid_state(ax, axis):
    """(보이는지, 투명도) - axis는 'x' 또는 'y'"""
    lines = ax.get_xgridlines() if axis == "x" else ax.get_ygridlines()
    visible = [l for l in lines if l.get_visible()]
    if not visible:
        return False, None
    return True, visible[0].get_alpha()


def as_list(values):
    try:
        return list(values)
    except TypeError:
        return []


def line_xy(line):
    xs = [str(x) for x in as_list(line.get_xdata(orig=True))]
    ys = as_list(line.get_ydata(orig=True))
    return xs, ys


def numbers_equal(a, b):
    a, b = as_list(a), as_list(b)
    return len(a) == len(b) and all(close(x, y, 1e-6) for x, y in zip(a, b))


# ------------------------------------------------------------------ 채점 실행

def _result(label, ok, note="", points=1):
    ok = bool(ok)
    return {"label": label, "score": points if ok else 0, "max": points, "note": "" if ok else note}


def grade(student_json, template_json, rubric):
    """학생 노트북 하나를 채점해 결과(dict)를 돌려준다."""
    student = json.loads(student_json) if isinstance(student_json, str) else student_json
    template = json.loads(template_json) if isinstance(template_json, str) else template_json
    s_sections = split_sections(student)
    t_sections = split_sections(template)

    # 앞 학생이 바꾼 그래프 기본 설정(rcParams)이 다음 학생에게 이어지지 않도록 초기화
    matplotlib.rcdefaults()
    ns = {"__name__": "__main__"}
    setup_cells = find_section(t_sections, rubric["setup_heading"]) or []
    setup_code = "\n".join(_src(c) for c in setup_cells)
    _, setup_error = run_code(setup_code, ns)

    problems = []
    total = rubric.get("base", 0)
    max_total = rubric.get("base", 0)
    for p in rubric["problems"]:
        cells = find_section(s_sections, p["heading"])
        entry = {"id": p["id"], "title": p["title"], "items": [], "error": None, "code": ""}
        if cells is None:
            entry["error"] = "문제 칸을 찾지 못했어요 (문제 제목이 지워졌을 수 있어요)"
            cells = []
        code = "\n".join(_src(c) for c in cells).strip()
        entry["code"] = code
        matplotlib.rcdefaults()
        local_ns = dict(ns)
        figs, error = run_code(code, local_ns) if code else ([], None)
        if error:
            entry["error"] = error
        ctx = Ctx(code, cells, figs, error, local_ns)
        try:
            items = p["check"](ctx)
        except Exception:
            items = []
            entry["error"] = "채점 중 오류: " + traceback.format_exc(limit=1)
        entry["items"] = items
        entry["score"] = sum(i["score"] for i in items)
        entry["max"] = p.get("max", sum(i["max"] for i in items))
        total += entry["score"]
        max_total += entry["max"]
        problems.append(entry)
        plt.close("all")

    return {
        "title": rubric.get("title", ""),
        "base": rubric.get("base", 0),
        "total": total,
        "max": max_total,
        "problems": problems,
        "setup_error": setup_error,
    }


_SNAPSHOT = None
_FINGERPRINT = None


def _watched():
    """채점이 기대는 라이브러리 부분: 학생 코드가 여기 함수를 바꾸면(예: Axes.get_title을 항상 정답으로)
    그 학생과 이후 학생들의 채점 결과가 틀어진다."""
    import builtins
    import matplotlib.axes
    import matplotlib.axis
    import matplotlib.collections
    import matplotlib.colors
    import matplotlib.figure
    import matplotlib.legend
    import matplotlib.lines
    import matplotlib.patches
    import matplotlib.text
    targets = {
        "builtins": builtins, "json": json, "re": re, "pyplot": plt, "matplotlib": matplotlib,
        "colors": matplotlib.colors,
    }
    for cls in (
        matplotlib.axes.Axes, matplotlib.figure.Figure, matplotlib.figure.FigureBase,
        matplotlib.lines.Line2D, matplotlib.patches.Patch, matplotlib.patches.Rectangle,
        matplotlib.text.Text, matplotlib.collections.Collection, matplotlib.collections.PathCollection,
        matplotlib.legend.Legend, matplotlib.axis.Axis, matplotlib.axis.XAxis, matplotlib.axis.YAxis,
        matplotlib.axis.Tick, matplotlib.artist.Artist,
    ):
        targets[f"{cls.__module__}.{cls.__name__}"] = cls
    for base in matplotlib.axes.Axes.__mro__:
        targets.setdefault(f"{base.__module__}.{base.__name__}", base)
    return targets


def _warm_up():
    # 처음 그래프를 그릴 때 matplotlib가 내부 값을 한 번 채우므로, 기준을 잡기 전에 미리 한 번 그려 둔다
    fig = plt.figure(figsize=(2, 2), dpi=50)
    plt.bar(["a", "b"], [1, 2], color="olive")
    plt.plot(["a", "b"], [2, 1], label="x")
    plt.scatter([1, 2], [1, 2])
    plt.title("t"); plt.xlabel("x"); plt.ylabel("y"); plt.legend(); plt.grid(alpha=0.5); plt.xticks(rotation=30)
    fig.canvas.draw()
    plt.close("all")
    matplotlib.rcdefaults()


def _fingerprint():
    fp = {}
    for prefix, obj in _watched().items():
        for name, value in list(vars(obj).items()):
            fp[f"{prefix}.{name}"] = id(value)
    return fp


def grade_json(student_json, template_json):
    """채점 Worker에서 부르는 진입점: 결과를 JSON 문자열로 돌려준다 (RUBRIC은 기준 파일이 만든다)

    학생 코드가 채점 함수(close, same_color 등)나 matplotlib·파이썬 기본 함수를 바꿔치기하면
    그 학생뿐 아니라 다음 학생 채점까지 망가질 수 있다. 채점 전후를 비교해 바뀐 것이 있으면 결과에 표시하고,
    이 파일의 이름들은 되돌린다. (라이브러리 쪽이 바뀌면 채점 화면이 엔진을 새로 띄운다)"""
    global _SNAPSHOT, _FINGERPRINT
    g = globals()
    if _SNAPSHOT is None:
        _warm_up()
        _SNAPSHOT = dict(g)
        _FINGERPRINT = _fingerprint()
    result = grade(student_json, template_json, g["RUBRIC"])
    changed = [k for k, v in _SNAPSHOT.items() if k not in ("_SNAPSHOT", "_FINGERPRINT") and g.get(k) is not v]
    added = [k for k in list(g) if k not in _SNAPSHOT]
    for k in changed:
        g[k] = _SNAPSHOT[k]
    for k in added:
        del g[k]
    now = _fingerprint()
    lib_changed = sorted(k for k in set(_FINGERPRINT) | set(now) if _FINGERPRINT.get(k) != now.get(k))
    result["tampered"] = changed + added + lib_changed[:10]
    return json.dumps(result, ensure_ascii=False)


R = _result  # 채점 기준 파일에서 짧게 쓰기 위한 이름
