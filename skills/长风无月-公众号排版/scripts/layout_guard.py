#!/usr/bin/env python3
"""Insert Markdown layout markers without changing a byte of source content.

Use a source-hashed, exact-anchor plan. Verification rebuilds the output;
it never erases punctuation or whitespace to manufacture equivalence.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path
import re
import sys


class LayoutError(ValueError):
    pass


OPS = {"line_after", "paragraph_after", "heading", "quote", "bold", "bullet", "rule_before"}
BLOCK_OPS = {"heading", "quote", "bullet"}
ENDERS = "。！？!?；;：:"
CLOSERS = "」』”’）)]】\"'"


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def read_utf8(path: Path) -> str:
    # newline='' retains CRLF exactly; encoding='utf-8' retains any BOM.
    with path.open("r", encoding="utf-8", newline="") as handle:
        return handle.read()


def protected_ranges(source: str) -> list[tuple[int, int, str]]:
    ranges = []
    lines = source.splitlines(keepends=True)
    offsets = []
    position = 0
    for line in lines:
        offsets.append(position)
        position += len(line)

    start_line = 0
    if lines and lines[0].lstrip("\ufeff").strip() == "---":
        for i in range(1, len(lines)):
            if lines[i].strip() in {"---", "..."}:
                ranges.append((0, offsets[i] + len(lines[i]), "frontmatter"))
                start_line = i + 1
                break
        else:
            ranges.append((0, len(source), "unclosed frontmatter"))
            return ranges

    fence = None
    fence_start = 0
    for i, line in enumerate(lines):
        if i < start_line:
            continue
        clean = line.rstrip("\r\n")
        fm = re.match(r"^ {0,3}(`{3,}|~{3,})", clean)
        if fence is not None:
            closing = re.match(r"^ {0,3}" + re.escape(fence[0]) + "{" + str(len(fence)) + r",}\s*$", clean)
            if closing:
                ranges.append((fence_start, offsets[i] + len(line), "fenced code"))
                fence = None
            continue
        if fm:
            fence, fence_start = fm.group(1), offsets[i]
            continue
        if re.match(r"^( {4}|\t)", clean):
            ranges.append((offsets[i], offsets[i] + len(line), "indented code"))
        if re.match(r"^ {0,3}(?:#{1,6}\s|>\s?|[-+*]\s|\d+[.)]\s|\[[^\]]+\]:)", clean):
            ranges.append((offsets[i], offsets[i] + len(line), "existing Markdown block"))
        if "|" in clean or re.match(r"^\s*(?:[-*_]\s*){3,}$", clean):
            ranges.append((offsets[i], offsets[i] + len(line), "table or rule"))
        if i > 0 and re.match(r"^\s*(?:=+|-+)\s*$", clean):
            ranges.append((offsets[i - 1], offsets[i] + len(line), "setext heading"))
    if fence is not None:
        ranges.append((fence_start, len(source), "unclosed code fence"))

    patterns = [
        (r"(`+)(?:(?!\1)[\s\S])*?\1", "inline code"),
        (r"!?\[\[[\s\S]*?\]\]", "wikilink or embed"),
        (r"!?\[[^\]\n]*\]\[[^\]\n]*\]", "reference link"),
        (r"\[\^[^\]\n]+\]", "footnote"),
        (r"https?://[^\s<>]+", "URL"),
        (r"<!--[\s\S]*?-->|%%[\s\S]*?%%", "comment"),
        (r"<([A-Za-z][\w:-]*)\b[^<>]*>[\s\S]*?</\1\s*>", "HTML element"),
        (r"<[^<>\n]+>", "HTML tag or autolink"),
        (r"\$\$[\s\S]*?\$\$|(?<!\$)\$[^$\n]+\$(?!\$)", "math"),
        (r"\*\*[^*\n]+\*\*|__[^_\n]+__|==[^=\n]+==|~~[^~\n]+~~", "existing inline style"),
        (r"\\[^\w\s]", "escape"),
    ]
    for pattern, kind in patterns:
        ranges.extend((m.start(), m.end(), kind) for m in re.finditer(pattern, source))

    # Balanced destinations preserve links such as [label](https://host/a_(b)).
    for match in re.finditer(r"!?\[[^\]\n]*\]\(", source):
        depth, j = 1, match.end()
        while j < len(source) and depth:
            if source[j] == "\\":
                j += 2
                continue
            if source[j] == "(":
                depth += 1
            elif source[j] == ")":
                depth -= 1
            j += 1
        ranges.append((match.start(), j, "Markdown link or image"))
    return sorted(set(ranges))


def locate(source: str, operation: dict) -> tuple[int, int]:
    anchor = operation.get("anchor")
    if not isinstance(anchor, str) or not anchor or anchor != anchor.strip():
        raise LayoutError("anchor 必须是非空原文片段，且不能以空白开头或结尾")
    found = [m.start() for m in re.finditer(re.escape(anchor), source)]
    if not found:
        raise LayoutError("找不到精确 anchor：" + repr(anchor[:50]))
    occurrence = operation.get("occurrence")
    if occurrence is None and len(found) != 1:
        raise LayoutError("anchor 多次出现，请用 occurrence 指定原文中的第几次")
    if occurrence is not None and (type(occurrence) is not int or not 1 <= occurrence <= len(found)):
        raise LayoutError("occurrence 必须是有效的从 1 开始的整数")
    start = found[(occurrence or 1) - 1]
    return start, start + len(anchor)


def sentence_start(source: str, index: int) -> bool:
    before = source[:index]
    if not before or not before.rsplit("\n", 1)[-1].strip():
        return True
    before = before.rstrip()
    while before and before[-1] in CLOSERS:
        before = before[:-1]
    return not before or before[-1] in ENDERS


def sentence_end(source: str, index: int) -> bool:
    after = source[index:]
    if not after or not after.split("\n", 1)[0].strip():
        return True
    before = source[:index].rstrip()
    while before and before[-1] in CLOSERS:
        before = before[:-1]
    return bool(before) and before[-1] in ENDERS


def compile_plan(source: str, plan: dict) -> tuple[str, dict]:
    if not isinstance(plan, dict) or set(plan) - {"source_sha256", "operations"}:
        raise LayoutError("计划只接受 source_sha256 与 operations")
    if plan.get("source_sha256") != digest(source):
        raise LayoutError("原文 SHA-256 不匹配；请重读当前原文，不得沿用旧计划")
    operations = plan.get("operations")
    if not isinstance(operations, list):
        raise LayoutError("operations 必须是数组")
    protected = protected_ranges(source)
    chosen = []
    signatures = set()
    for operation in operations:
        if not isinstance(operation, dict):
            raise LayoutError("每个操作必须是对象")
        op = operation.get("op")
        if op not in OPS:
            raise LayoutError("不允许的操作：" + repr(op))
        allowed_keys = {"op", "anchor", "occurrence"} | ({"level"} if op == "heading" else set())
        if set(operation) - allowed_keys:
            raise LayoutError("操作含未知字段；不接受 replace、text 或任意插入内容")
        start, end = locate(source, operation)
        if (op, start, end) in signatures:
            raise LayoutError("同一个排版操作重复出现")
        signatures.add((op, start, end))
        for a, b, kind in protected:
            if start < b and end > a:
                raise LayoutError("anchor 涉及保护内容：" + kind + "；请保留该区域")
        if op in BLOCK_OPS or op == "rule_before":
            if not sentence_start(source, start):
                raise LayoutError("块标记必须从完整原句或现成独立行开始")
        if op in BLOCK_OPS and not sentence_end(source, end):
            raise LayoutError("不能把半句话裁成标题、引用或列表项")
        if op in {"heading", "bullet"} and ("\n" in operation["anchor"] or "\r" in operation["anchor"]):
            raise LayoutError("标题和列表项 anchor 不能跨行")
        if op in {"line_after", "paragraph_after"} and not sentence_end(source, end):
            raise LayoutError("请在原句末尾断行；脚本不改标点")
        if op == "heading" and (type(operation.get("level")) is not int or operation["level"] not in (1, 2, 3)):
            raise LayoutError("level 只接受 1、2、3")
        if op == "bold":
            if any(c in operation["anchor"] for c in "\r\n*_`[]<>|" + ENDERS):
                raise LayoutError("只对普通短词加粗；完整金句使用 quote")
        chosen.append((op, start, end, operation))

    styled = [item for item in chosen if item[0] in BLOCK_OPS or item[0] == "bold"]
    for i, first in enumerate(styled):
        for second in styled[i + 1:]:
            if first[1] < second[2] and first[2] > second[1]:
                raise LayoutError("标题、引用、列表与加粗范围不能重叠；金句只用引用")

    insertions = defaultdict(list)
    def add(position: int, priority: int, text: str) -> None:
        insertions[position].append((priority, text))

    newline = "\r\n" if "\r\n" in source and "\n" not in source.replace("\r\n", "") else "\n"
    paragraph = newline * 2
    def before_breaks(position: int) -> str:
        if position == 0:
            return ""
        existing = len(re.search(r"(?:\r?\n)*$", source[:position]).group()) // len(newline)
        return newline * max(0, 2 - existing)

    def after_breaks(position: int, count: int = 2) -> str:
        remaining = source[position:]
        if not remaining or remaining.isspace():
            return ""
        existing = len(re.match(r"(?:\r?\n)*", remaining).group()) // len(newline)
        return newline * max(0, count - existing)

    for op, start, end, operation in chosen:
        if op == "line_after":
            add(end, 20, after_breaks(end, 1))
        elif op == "paragraph_after":
            add(end, 20, after_breaks(end))
        elif op == "heading":
            add(start, 30, before_breaks(start) + "#" * operation["level"] + " ")
            add(end, 20, after_breaks(end))
        elif op == "quote":
            add(start, 30, before_breaks(start) + "> ")
            for match in re.finditer(r"\r?\n", source[start:end]):
                if start + match.end() < end:
                    add(start + match.end(), 30, "> ")
            add(end, 20, after_breaks(end))
        elif op == "bullet":
            add(start, 30, before_breaks(start) + "- ")
            add(end, 20, after_breaks(end))
        elif op == "bold":
            add(start, 40, "**")
            add(end, 10, "**")
        elif op == "rule_before":
            if start == 0:
                raise LayoutError("文章开头不插分割线，避免被误读为 YAML")
            add(start, 25, before_breaks(start) + "---" + paragraph)

    parts, last = [], 0
    for position in sorted(insertions):
        parts.append(source[last:position])
        addition = "".join(text for _, text in sorted(insertions[position], key=lambda item: item[0]))
        # Only collapse newly inserted breaks, never source whitespace.
        addition = re.sub(r"(?:\r?\n){3,}", paragraph, addition)
        parts.append(addition)
        last = position
    parts.append(source[last:])
    output = "".join(parts)
    return output, {
        "passed": True,
        "source_sha256": digest(source),
        "output_sha256": digest(output),
        "operations": len(chosen),
        "source_bytes": len(source.encode("utf-8")),
        "inserted_bytes": len(output.encode("utf-8")) - len(source.encode("utf-8")),
        "proof": "Every source byte retained in original order; only validated layout markers inserted.",
        "visual_check": "not_performed",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="command", required=True)
    inspect = subs.add_parser("inspect")
    inspect.add_argument("source", type=Path)
    apply = subs.add_parser("apply")
    apply.add_argument("source", type=Path)
    apply.add_argument("plan", type=Path)
    apply.add_argument("--output", type=Path, required=True)
    verify = subs.add_parser("verify")
    verify.add_argument("source", type=Path)
    verify.add_argument("output", type=Path)
    verify.add_argument("--plan", type=Path, required=True)
    args = parser.parse_args()
    try:
        source = read_utf8(args.source)
        if args.command == "inspect":
            kinds = sorted({kind for _, _, kind in protected_ranges(source)})
            result = {"source_sha256": digest(source), "source_bytes": len(source.encode("utf-8")), "protected_content_types": kinds}
        else:
            plan = json.loads(read_utf8(args.plan))
            expected, result = compile_plan(source, plan)
            if args.command == "apply":
                if args.source.resolve() == args.output.resolve():
                    raise LayoutError("输出不能覆盖原文；先输出新文件并完成验证")
                if args.output.exists():
                    raise LayoutError("输出文件已存在；请使用新的候选文件名")
                args.output.parent.mkdir(parents=True, exist_ok=True)
                with args.output.open("w", encoding="utf-8", newline="") as handle:
                    handle.write(expected)
            else:
                actual = read_utf8(args.output)
                if actual != expected:
                    difference = next((i for i, (a, b) in enumerate(zip(actual, expected)) if a != b), min(len(actual), len(expected)))
                    raise LayoutError("成品与合法计划不一致，首个差异位置 " + str(difference) + "；原文或输出被改动")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (OSError, UnicodeError, json.JSONDecodeError, LayoutError) as exc:
        print(json.dumps({"passed": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
