import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "route_theme.py"
SPEC = importlib.util.spec_from_file_location("route_theme", SCRIPT)
route = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(route)


class ThemeRouteTests(unittest.TestCase):
    def make_theme(self, root, name="03. 简笔手绘 ✅", identity="simple-sketch", family="本次模板字库"):
        directory = root / name
        directory.mkdir(parents=True)
        (directory / "fonts").mkdir()
        (directory / "fonts" / "current.ttf").write_bytes(b"font-test-placeholder")
        manifest = {
            "theme_id": identity, "name": "简笔手绘",
            "fonts": [{"font_id": "h1", "family": family, "file": "fonts/current.ttf", "weight": 900}],
            "heading_images": [{"heading_levels": [1], "font_id": "h1"}],
        }
        (directory / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False))
        return directory

    def test_portable_catalog_contains_ten_distinct_current_names(self):
        themes = route.read_themes(None)
        self.assertEqual(len(themes), 10)
        self.assertEqual(len({data["theme_id"] for data, _ in themes}), 10)
        selected = route.resolve(themes, "暖瓷像素", "cover")
        self.assertEqual(selected["theme_id"], "feng-guo-shu-ye")
        self.assertEqual(selected["source"], "bundled-visual-guide")
        self.assertIsNone(selected["manifest"])

    def test_unknown_name_never_falls_back_to_first_theme(self):
        with self.assertRaisesRegex(ValueError, "明确选择"):
            route.resolve(route.read_themes(None), "给我最火的那个", "cover")

    def test_missing_kind_remains_unresolved(self):
        selected = route.resolve(route.read_themes(None), "沙丘版画", None)
        self.assertTrue(selected["need_kind_confirmation"])
        self.assertIsNone(selected["kind"])

    def test_current_manifest_font_overrides_reference(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.make_theme(root)
            selected = route.resolve(route.read_themes(root), "simple-sketch", "cover")
            self.assertEqual(selected["heading_fonts"][0]["family"], "本次模板字库")
            self.assertTrue(Path(selected["heading_fonts"][0]["file"]).exists())
            self.assertEqual(selected["heading_fonts"][0]["weight"], 900)
            self.assertIn("不等于", selected["font_note"])

    def test_shared_hierarchy_and_prompt_references_exist_for_each_theme(self):
        themes = route.read_themes(None)
        for data, _ in themes:
            selected = route.resolve(themes, data["theme_id"], "illustration")
            self.assertEqual(set(selected["shared_references"]), {"hierarchy_layout", "image_rules", "prompt_structure"})
            for path in selected["shared_references"].values():
                self.assertTrue(Path(path).is_file())

    def test_defaults_are_by_task_not_theme_or_historical_example_type(self):
        themes = route.read_themes(None)
        self.assertEqual(route.resolve(themes, "simple-sketch", "illustration")["default_aspect_ratios"], ["16:9"])
        self.assertEqual(route.resolve(themes, "dune-echo", "illustration")["default_aspect_ratios"], ["16:9"])
        self.assertEqual(route.resolve(themes, "simple-sketch", "cover")["default_aspect_ratios"], ["2.35:1", "1:1"])
        self.assertEqual(route.resolve(themes, "simple-sketch", None)["default_aspect_ratios"], [])

    def test_directory_rename_does_not_change_stable_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            theme = self.make_theme(root)
            before = route.resolve(route.read_themes(root), "simple-sketch", "illustration")
            theme.rename(root / "99. 新目录名字")
            after = route.resolve(route.read_themes(root), "simple-sketch", "illustration")
            self.assertEqual(before["theme_id"], after["theme_id"])
            self.assertIn("99. 新目录名字", after["manifest"])

    def test_duplicate_identity_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.make_theme(root)
            self.make_theme(root, name="another")
            with self.assertRaisesRegex(ValueError, "重复"):
                route.read_themes(root)

    def test_font_asset_may_not_escape_theme(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(ValueError, "越出"):
                route.safe_asset(root, "../private.ttf")

    def test_theme_id_may_not_escape_reference_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.make_theme(root, identity="../../private")
            with self.assertRaisesRegex(ValueError, "稳定标识"):
                route.read_themes(root)

    def test_missing_font_is_reported_as_missing_not_loaded(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            theme = self.make_theme(root)
            (theme / "fonts" / "current.ttf").unlink()
            selected = route.resolve(route.read_themes(root), "简笔手绘", "cover")
            self.assertIsNone(selected["heading_fonts"][0]["file"])


if __name__ == "__main__":
    unittest.main()
