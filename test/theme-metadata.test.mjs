import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  themeMatchesQuery,
  themeMetadata,
} from '../plugin/theme-metadata.mjs';

test('字符串元数据清理首尾与重复空白并生成副文案', () => {
  assert.deepEqual(
    themeMetadata({
      theme_palette: '  雾蓝   × 暖白  ',
      theme_style: '  版画  ',
      theme_elements: '  纸纹、轨道线  ',
      theme_scenes: '  教程、科普、知识长文  ',
    }),
    {
      palette: '雾蓝 × 暖白',
      style: '版画',
      elements: '纸纹、轨道线',
      scenes: '教程、科普、知识长文',
      summary: '雾蓝 × 暖白｜版画｜教程、科普、知识长文',
    },
  );
});

test('数组元数据逐项清理、忽略空项并用顿号连接', () => {
  assert.deepEqual(
    themeMetadata({
      theme_palette: [' 莫兰迪蓝 ', '', ' 纸灰 '],
      theme_scenes: [' 随笔 ', '  ', '知识   长文'],
    }),
    {
      palette: '莫兰迪蓝、纸灰',
      style: '',
      elements: '',
      scenes: '随笔、知识 长文',
      summary: '莫兰迪蓝、纸灰｜随笔、知识 长文',
    },
  );
});

test('缺失字段返回空字符串，summary 只连接非空项', () => {
  assert.deepEqual(themeMetadata(), { palette: '', style: '', elements: '', scenes: '', summary: '' });
  assert.deepEqual(themeMetadata(null), { palette: '', style: '', elements: '', scenes: '', summary: '' });
  assert.deepEqual(
    themeMetadata({ theme_palette: '亮蓝 × 冰白' }),
    { palette: '亮蓝 × 冰白', style: '', elements: '', scenes: '', summary: '亮蓝 × 冰白' },
  );
  assert.deepEqual(
    themeMetadata({ theme_scenes: ['教程', '科普'] }),
    { palette: '', style: '', elements: '', scenes: '教程、科普', summary: '教程、科普' },
  );
});

test('搜索对空查询放行，并匹配名称、配色与场景', () => {
  const theme = {
    name: '微信读书 WeRead 风格',
    palette: '莫兰迪蓝 × 纸灰',
    style: '颗粒版画',
    elements: ['书页', '手写线'],
    scenes: ['随笔', '书评', '知识长文'],
  };

  assert.equal(themeMatchesQuery(theme, ''), true);
  assert.equal(themeMatchesQuery(theme, '   '), true);
  assert.equal(themeMatchesQuery(theme, '微信读书'), true);
  assert.equal(themeMatchesQuery(theme, 'weread'), true);
  assert.equal(themeMatchesQuery(theme, '纸灰'), true);
  assert.equal(themeMatchesQuery(theme, '颗粒版画'), true);
  assert.equal(themeMatchesQuery(theme, '手写线'), true);
  assert.equal(themeMatchesQuery(theme, '  书评  '), true);
  assert.equal(themeMatchesQuery(theme, '测评'), false);
  assert.equal(themeMatchesQuery(null, '读书'), false);
});
