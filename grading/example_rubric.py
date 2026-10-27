"""예시 채점 기준: docs/예시_문제.ipynb 용 (기본 2점 + 막대그래프 4점 + 합계 계산 4점 = 10점)

채점 기준 파일 만드는 법은 grading/README.md 를 보세요.
grader_core.py 의 도우미(R, figsize_is, same_color, xtick_texts, close …)를 그대로 쓸 수 있습니다.
"""

OPTIONS = {
    "ignore_case": True,  # 제목·축 이름 대소문자 차이 인정
}

CLASSES = ['1반', '2반', '3반', '4반']
STUDENTS = [28, 30, 27, 29]


def _txt(actual, expected):
    a = (actual or "").strip()
    return a.lower() == expected.lower() if OPTIONS["ignore_case"] else a == expected


def check_bar(ctx):
    ax = ctx.ax
    ok = ctx.ran_ok and ax is not None
    bars = list(ax.patches) if ok else []
    return [
        R("1. x축 반, y축 학생 수 막대그래프", ok and xtick_texts(ax) == CLASSES and numbers_equal([b.get_height() for b in bars], STUDENTS)),
        R("2. 색상 skyblue", ok and bool(bars) and all(same_color(b.get_facecolor(), "skyblue") for b in bars)),
        R("3. 제목 'Students by Class'", ok and _txt(ax.get_title(), "Students by Class")),
        R("4. 실행하여 그래프 출력", ctx.output_ok, ctx.output_note()),
    ]


def check_sum(ctx):
    # 그래프가 아닌 문제: 학생 코드가 만든 변수 값을 검사 (ctx.ns = 학생 코드 실행 후 변수들)
    total = ctx.ns.get("total")
    printed = ctx.error is None and any(
        o.get("output_type") == "stream" and "114" in "".join(o.get("text", ""))
        for c in ctx.cells for o in (c.get("outputs") or [])
    )
    return [
        R("1. 변수 total 에 전체 학생 수 저장", total == sum(STUDENTS), "" if total is None else f"total = {total!r}", points=2),
        R("2. 반복문(for) 사용", bool(re.search(r"\bfor\b", ctx.code))),
        R("3. 결과를 출력", printed, "제출 파일에 114가 출력된 결과가 없어요"),
    ]


RUBRIC = {
    "title": "예시: 반별 학생 수",
    "base": 2,
    "setup_heading": "## 1. 데이터",
    "problems": [
        {"id": "bar", "heading": "## 2. 막대 그래프", "title": "막대 그래프", "check": check_bar},
        {"id": "sum", "heading": "## 3. 합계 구하기", "title": "합계 구하기", "check": check_sum},
    ],
}
