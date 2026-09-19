#!/usr/bin/env python3
"""Render a real-font specimen as input to image generation, never an overlay.

Optional dependencies: Pillow, fontTools, and brotli for WOFF2 input.
The source font is read-only; no subset or modified font file is written.
"""
import argparse
from io import BytesIO
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--font", type=Path, required=True)
    parser.add_argument("--text", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        from PIL import Image, ImageDraw, ImageFont, PngImagePlugin
        from fontTools.ttLib import TTFont
    except ImportError as exc:
        print("缺少可选字体样张依赖：Pillow、fontTools（WOFF2 还需 brotli）。请使用当前工具环境已有的 Python，或在隔离环境安装这些依赖。" + str(exc), file=sys.stderr)
        return 1
    try:
        if args.output.exists():
            raise ValueError("输出已存在，请使用新的字体参照图文件名")
        if args.output.suffix.lower() != ".png":
            raise ValueError("字体参照图输出必须是 PNG")
        if not args.text.strip() or len(args.text) > 90:
            raise ValueError("参照文字应为 1—90 个字符的真实图中文字")
        font = TTFont(args.font)
        cmap = {point for table in font["cmap"].tables if table.isUnicode() for point in table.cmap}
        missing = sorted({char for char in args.text if not char.isspace() and ord(char) not in cmap})
        if missing:
            raise ValueError("字库缺少这些字符，不能使用缺字方框作参照：" + "".join(missing))
        if args.font.suffix.lower() in {".woff", ".woff2"}:
            memory = BytesIO()
            font.flavor = None
            font.save(memory)
            memory.seek(0)
            font_input = memory
        else:
            font_input = str(args.font)
        face = ImageFont.truetype(font_input, size=100)
        lines, line = [], ""
        for char in args.text:
            if char == "\n":
                lines.append(line)
                line = ""
            elif face.getlength(line + char) > 1400 and line:
                lines.append(line)
                line = char
            else:
                line += char
        if line:
            lines.append(line)
        picture = Image.new("RGB", (1600, max(300, 140 * len(lines) + 100)), "white")
        draw = ImageDraw.Draw(picture)
        for i, line in enumerate(lines):
            draw.text((100, 40 + i * 140), line, fill="#202020", font=face)
        metadata = PngImagePlugin.PngInfo()
        metadata.add_text("purpose", "font-reference-only; not a final cover or text overlay")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        picture.save(args.output, pnginfo=metadata)
        print(str(args.output.resolve()))
        return 0
    except (OSError, ValueError, KeyError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
