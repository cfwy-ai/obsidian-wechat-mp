#!/usr/bin/env python3
"""Re-encode four broken glyph records without changing their original outlines."""
import argparse
import hashlib
import json
from pathlib import Path

import fontTools
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

SOURCE_SHA256 = "977dede6dd36112d941f9823d120f77a0481f309045422ee0393ec710a58a3b2"
REPAIR_CHARACTERS = "喔检版远"


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--coverage", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--output-coverage", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    if sha256(args.source) != SOURCE_SHA256:
        raise ValueError("This conversion applies only to the verified Wenxin source font.")
    if args.source.resolve() == args.output.resolve() or args.coverage.resolve() == args.output_coverage.resolve():
        raise ValueError("Original font and coverage files must be retained.")
    original = TTFont(args.source, recalcTimestamp=False)
    converted = TTFont(args.source, recalcTimestamp=False)
    original_glyphs = original.getGlyphSet()
    converted_glyphs = converted.getGlyphSet()
    cmap = original.getBestCmap()
    repaired = []
    for char in REPAIR_CHARACTERS:
        name = cmap[ord(char)]
        pen = TTGlyphPen(converted_glyphs)
        converted_glyphs[name].draw(pen)
        converted["glyf"][name] = pen.glyph()
        repaired.append({"character": char, "codepoint": ord(char), "glyph": name})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    converted.save(args.output)
    result = TTFont(args.output, recalcTimestamp=False)
    result_glyphs = result.getGlyphSet()
    # Compare every decomposed outline, including unchanged composite glyphs.
    for name in original.getGlyphOrder():
        before = DecomposingRecordingPen(original_glyphs)
        after = DecomposingRecordingPen(result_glyphs)
        original_glyphs[name].draw(before)
        result_glyphs[name].draw(after)
        if before.value != after.value:
            raise ValueError(f"Original outline changed: {name}")
    if original["cmap"].compile(original) != result["cmap"].compile(result):
        raise ValueError("Character mapping changed")
    if original["hmtx"].metrics != result["hmtx"].metrics:
        raise ValueError("Glyph advances changed")
    if original["name"].compile(original) != result["name"].compile(result):
        raise ValueError("Font family or naming changed")
    coverage = json.loads(args.coverage.read_text())
    removed = []
    for cp in coverage:
        if chr(cp).isspace():
            continue
        glyph = cmap.get(cp)
        pen = BoundsPen(original_glyphs)
        if glyph:
            original_glyphs[glyph].draw(pen)
        if pen.bounds is None:
            removed.append({"character": chr(cp), "codepoint": cp, "glyph": glyph})
    excluded = {row["codepoint"] for row in removed}
    result_coverage = [cp for cp in coverage if cp not in excluded]
    args.output_coverage.write_text(json.dumps(result_coverage) + "\n")
    report = {
        "schema_version": 1,
        "operation": "reencode-original-outlines",
        "tool": {"name": "fontTools", "version": fontTools.__version__},
        "source": {"file": args.source.name, "sha256": sha256(args.source)},
        "output": {"file": args.output.name, "sha256": sha256(args.output)},
        "source_coverage": {"file": args.coverage.name, "sha256": sha256(args.coverage)},
        "output_coverage": {"file": args.output_coverage.name, "sha256": sha256(args.output_coverage)},
        "reencoded_glyphs": repaired,
        "excluded_empty_nonwhitespace_glyphs": removed,
        "verification": {"glyphs_compared": len(original.getGlyphOrder()), "all_outlines_equal": True,
                         "cmap_equal": True, "advance_widths_equal": True, "names_equal": True},
    }
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"font_sha256": sha256(args.output), "reencoded_glyphs": len(repaired),
                      "excluded_empty_glyphs": len(removed), "glyphs_compared": len(original.getGlyphOrder())}))


if __name__ == "__main__":
    main()
