#!/usr/bin/env python3
"""Resolve one theme by its manifest identity; no developer-specific paths."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys

SKILL = Path(__file__).resolve().parents[1]


def clean_name(value):
    return re.sub(r"^\d+[.、]\s*", "", value.strip()).removesuffix("✅").strip()


def builtin_catalog():
    return json.loads((SKILL / "references" / "theme-catalog.json").read_text(encoding="utf-8"))["themes"]


def choose_root(args):
    if args.templates:
        root = args.templates
    elif args.vault:
        root = args.vault / ".obsidian" / "plugins" / "changfeng-wechat-mp" / "templates"
    elif args.project:
        root = args.project / "templates"
    else:
        candidate = SKILL.parent.parent / "templates"
        return candidate.resolve() if candidate.is_dir() else None
    if not root.is_dir():
        raise ValueError("模板目录不存在：" + str(root))
    return root.resolve()


def read_themes(root):
    if root is None:
        return [(theme, None) for theme in builtin_catalog()]
    entries = [root] if (root / "manifest.json").is_file() else sorted(path for path in root.iterdir() if path.is_dir())
    themes, ids = [], set()
    for directory in entries:
        manifest = directory / "manifest.json"
        if not manifest.is_file():
            continue
        data = json.loads(manifest.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("主题 manifest 必须是对象")
        identity = data.get("theme_id")
        if not identity:
            continue
        if not isinstance(identity, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", identity):
            raise ValueError("theme_id 不是有效的稳定标识")
        if not isinstance(data.get("name", identity), str):
            raise ValueError("主题 name 必须是字符串")
        if identity in ids:
            raise ValueError("重复 theme_id：" + identity + "；请指定唯一模板根")
        ids.add(identity)
        themes.append((data, directory))
    if not themes:
        raise ValueError("未发现含 theme_id 的主题 manifest")
    return themes


def safe_asset(directory, relative):
    if not isinstance(relative, str) or not relative:
        return None
    candidate = (directory / relative).resolve()
    if not candidate.is_relative_to(directory.resolve()):
        raise ValueError("模板资源越出主题目录：" + relative)
    return str(candidate) if candidate.is_file() else None


def resolve(themes, query, kind):
    normalized = clean_name(query)
    matches = [(data, directory) for data, directory in themes if query == data["theme_id"] or normalized == clean_name(data.get("name", "")) or (directory and normalized == clean_name(directory.name))]
    if len(matches) != 1:
        choices = [data.get("name", data["theme_id"]) for data, _ in themes]
        raise ValueError("模板名称未知或不唯一，请明确选择：" + "、".join(choices))
    data, directory = matches[0]
    identity = data["theme_id"]
    profile = SKILL / "references" / "themes" / (identity + ".md")
    result = {
        "theme_id": identity,
        "name": data.get("name", identity),
        "kind": kind,
        "need_kind_confirmation": kind is None,
        "source": "manifest" if directory else "bundled-visual-guide",
        "visual_guide": str(profile) if profile.is_file() else None,
        "manifest": str(directory / "manifest.json") if directory else None,
        "theme_documents": [],
        "heading_fonts": [],
        "shared_references": {
            "hierarchy_layout": str(SKILL / "references" / "信息层级与排版.md"),
            "image_rules": str(SKILL / "references" / "配图规则.md"),
            "prompt_structure": str(SKILL / "references" / "完整图文提示结构.md"),
        },
        "default_aspect_ratios": {"cover": ["2.35:1", "1:1"], "illustration": ["16:9"]}.get(kind, []),
        "aspect_ratio_note": "只做用户要求的用途与画幅；正文配图统一16:9，仅用户明确指定其他比例时才可调整。",
    }
    if not directory:
        result["font_note"] = "仅有字形方向；未读取实际字体文件，不宣称已加载字库。"
        return result
    names = ["1. 视觉风格总则.md"]
    if kind:
        names.append("2. 文章封图规范.md" if kind == "cover" else "3. 正文配图规范.md")
    result["theme_documents"] = [str(directory / "主题视觉规范" / name) for name in names if (directory / "主题视觉规范" / name).is_file()]
    fonts = {font["font_id"]: font for font in data.get("fonts", [])}
    for level in (1, 2):
        rule = next((item for item in data.get("heading_images", []) if level in item.get("heading_levels", [])), None)
        if not rule:
            result["heading_fonts"].append({"level": level, "family": "按所选主题视觉规范的系统字体", "file": None})
            continue
        font = fonts.get(rule.get("font_id"), {})
        result["heading_fonts"].append({
            "level": level, "font_id": rule.get("font_id"), "family": font.get("family"),
            "file": safe_asset(directory, font.get("file")),
            "sha256": font.get("sha256"),
            "weight": font.get("weight", 400),
            "style": font.get("style", "normal"),
            "fallback_font_ids": rule.get("fallback_font_ids", []),
            "color": rule.get("color"),
        })
    result["font_note"] = "manifest 和文件供真实字形参照；文件存在不等于生成模型精确调用了字库。"
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["list", "resolve"])
    parser.add_argument("theme", nargs="?")
    parser.add_argument("--kind", choices=["cover", "illustration"])
    location = parser.add_mutually_exclusive_group()
    location.add_argument("--templates", type=Path)
    location.add_argument("--vault", type=Path)
    location.add_argument("--project", type=Path)
    args = parser.parse_args()
    try:
        themes = read_themes(choose_root(args))
        if args.command == "list":
            result = [{"theme_id": data["theme_id"], "name": data.get("name", data["theme_id"])} for data, _ in themes]
        elif not args.theme:
            raise ValueError("请先告诉用户选择模板，resolve 不能猜测默认模板")
        else:
            result = resolve(themes, args.theme, args.kind)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, KeyError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
