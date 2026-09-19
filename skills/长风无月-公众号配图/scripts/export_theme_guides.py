#!/usr/bin/env python3
"""Export concise, portable theme guides for a distribution snapshot."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

SKILL = Path(__file__).resolve().parents[1]


def section_map(text):
    matches = list(re.finditer(r"(?m)^# (.+)$", text))
    result = {}
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        body = text[match.end():end].strip()
        if body.endswith("---"):
            body = body[:-3].rstrip()
        result[match.group(1)] = body
    return result


def compose(question, titles, sections):
    intro = "本文档只回答一件事：" + question + "。\n\n先读取同目录的 `1. 视觉风格总则.md`，字体文件以当前 `manifest.json` 为准。\n"
    return intro + "".join("\n---\n\n# " + title + "\n\n" + sections[title] + "\n" for title in titles)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()
    try:
        common = SKILL / "references" / "配图规则.md"
        sections = section_map(common.read_text(encoding="utf-8"))
        themes = json.loads((SKILL / "references" / "theme-catalog.json").read_text(encoding="utf-8"))["themes"]
        files = []
        source_hashes = {str(common.relative_to(SKILL)): hashlib.sha256(common.read_bytes()).hexdigest()}
        for theme in themes:
            source = SKILL / "references" / "themes" / (theme["theme_id"] + ".md")
            source_hashes[str(source.relative_to(SKILL))] = hashlib.sha256(source.read_bytes()).hexdigest()
            target = args.output / theme["theme_id"] / "主题视觉规范"
            content = {
                "1. 视觉风格总则.md": source.read_text(encoding="utf-8"),
                "2. 文章封图规范.md": compose("怎样为「" + theme["name"] + "」生成清楚的公众号封面", ["封面", "缩图与遮挡", "字体、画材与事实", "交付", "参数依据"], sections),
                "3. 正文配图规范.md": compose("怎样为「" + theme["name"] + "」生成有信息层级的正文配图", ["正文图的信息层级", "字体、画材与事实", "交付"], sections),
            }
            for name, body in content.items():
                path = target / name
                if path.exists() and not args.overwrite:
                    raise ValueError("已有文件，需明确 --overwrite：" + str(path))
                files.append((path, body))
        for path, body in files:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(body, encoding="utf-8")
        print(json.dumps({"themes": len(themes), "files": len(files), "source_sha256": source_hashes}, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, KeyError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
