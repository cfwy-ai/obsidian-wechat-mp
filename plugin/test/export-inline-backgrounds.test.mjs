import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareExportInlineBackgrounds } from '../plugin/export-inline-backgrounds.mjs';

const fixture = (styles = [{}]) => {
  const fragments = [];
  const base = { display: 'inline', writingMode: 'horizontal-tb', direction: 'ltr',
    backgroundImage: 'none', backgroundColor: 'rgb(255, 206, 46)',
    borderTopLeftRadius: '3px', borderTopRightRadius: '3px',
    borderBottomLeftRadius: '3px', borderBottomRightRadius: '3px' };
  const parent = { style: {}, scrollLeft: 5, scrollTop: 7,
    getBoundingClientRect: () => ({ left: 100, top: 200 }), append: node => fragments.push(node) };
  const elements = styles.map(style => ({ style: { ...style }, parentElement: parent,
    textContent: '跨行高亮',
    getClientRects: () => [
      { left: 120, top: 230, width: 60, height: 20 },
      { left: 100, top: 260, width: 30, height: 20 },
    ] }));
  const root = { querySelectorAll: () => elements, ownerDocument: {
    defaultView: { getComputedStyle: node => node === parent
      ? { display: 'block', position: 'static', zIndex: 'auto', borderLeftWidth: '2px', borderTopWidth: '3px', ...parent.style }
      : { ...base, ...node.style } },
    createElement: () => ({ style: {}, attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } }),
  } };
  parent.parentElement = root;
  return { root, elements, parent, fragments };
};

test('跨行高亮只画真实两块背景，不绘制包围整行的大矩形，不修改正文', () => {
  const f = fixture();
  assert.equal(prepareExportInlineBackgrounds(f.root), 2);
  assert.equal(f.elements[0].textContent, '跨行高亮');
  assert.equal(f.elements[0].style.backgroundColor, 'transparent');
  assert.match(f.fragments[0].style.cssText, /left:23px;top:34px;width:60px;height:20px/);
  assert.match(f.fragments[1].style.cssText, /width:30px;height:20px/);
  assert.match(f.fragments[0].style.cssText, /border-radius:3px 0 0 3px/);
  assert.match(f.fragments[1].style.cssText, /border-radius:0 3px 3px 0/);
  assert.ok(f.fragments.every(node => node.attrs['aria-hidden'] === 'true' && node.style.cssText.includes('z-index:-1')));
  assert.equal(prepareExportInlineBackgrounds(f.root), 0);
});

test('单行、透明、图片背景、非行内或竖排元素保持原样', () => {
  for (const style of [
    { backgroundColor: 'transparent' }, { backgroundColor: 'rgba(255, 0, 0, 0)' },
    { backgroundImage: 'url(test.png)' }, { display: 'inline-block' }, { writingMode: 'vertical-rl' },
  ]) {
    const f = fixture([style]);
    assert.equal(prepareExportInlineBackgrounds(f.root), 0);
    assert.equal(f.fragments.length, 0);
    assert.deepEqual(f.elements[0].style, style);
  }
  const f = fixture();
  f.elements[0].getClientRects = () => [{ left: 120, top: 230, width: 60, height: 20 }];
  assert.equal(prepareExportInlineBackgrounds(f.root), 0);
});

test('嵌套底色按外到内顺序绘制，RTL及clone圆角保留对应边缘', () => {
  const f = fixture([{ backgroundColor: 'yellow' }, { backgroundColor: 'blue', direction: 'rtl' }]);
  assert.equal(prepareExportInlineBackgrounds(f.root), 4);
  assert.match(f.fragments[0].style.cssText, /background-color:yellow/);
  assert.match(f.fragments[2].style.cssText, /background-color:blue/);
  assert.match(f.fragments[2].style.cssText, /border-radius:0 3px 3px 0/);
  const clone = fixture([{ boxDecorationBreak: 'clone' }]);
  prepareExportInlineBackgrounds(clone.root);
  assert.ok(clone.fragments.every(node => node.style.cssText.includes('border-radius:3px 3px 3px 3px')));
});

test('马赛克下划线按每行宽度绘制，保留纹理连续性与正文', () => {
  const f = fixture([{
    backgroundColor: 'transparent', backgroundImage: 'url("mosaic.png")',
    backgroundRepeat: 'repeat-x', backgroundPositionY: '100%', backgroundSize: '42px 4px',
  }]);
  assert.equal(prepareExportInlineBackgrounds(f.root), 2);
  assert.equal(f.elements[0].textContent, '跨行高亮');
  assert.equal(f.elements[0].style.backgroundImage, 'none');
  assert.match(f.fragments[0].style.cssText, /width:60px;height:20px/);
  assert.match(f.fragments[1].style.cssText, /width:30px;height:20px/);
  assert.match(f.fragments[0].style.cssText, /background-position:0px bottom/);
  assert.match(f.fragments[1].style.cssText, /background-position:-60px bottom/);
  assert.ok(f.fragments.every(node => node.style.cssText.includes('background-image:url("mosaic.png")')));
  assert.equal(prepareExportInlineBackgrounds(f.root), 0);
});

test('铅笔删除线跨行时分别保持在每行中部，不穿过整段空白', () => {
  const f = fixture([{
    backgroundColor: 'transparent', backgroundImage: 'url("strike.png")',
    backgroundRepeat: 'repeat-x', backgroundPositionY: '50%', backgroundSize: '180px 60px',
  }]);
  assert.equal(prepareExportInlineBackgrounds(f.root), 2);
  assert.match(f.fragments[0].style.cssText, /width:60px;height:20px/);
  assert.match(f.fragments[1].style.cssText, /width:30px;height:20px/);
  assert.ok(f.fragments.every(node => node.style.cssText.includes('px center')));
  assert.equal(f.elements[0].textContent, '跨行高亮');
  assert.equal(prepareExportInlineBackgrounds(f.root), 0);
});
