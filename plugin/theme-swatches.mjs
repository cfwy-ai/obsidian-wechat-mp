// 菜单色点只采用明确确认的主题配色，不从说明文字或素材自动推断。
const SWATCHES_BY_THEME = new Map([
  ['monument-valley', ['#FFFFFF', '#90958D', '#365241']],
  ['cobalt-orbit', ['#181818', '#FFFFFF', '#909090']],
  ['simple-sketch', ['#1A1A19', '#FFFFFF', '#FFCE2E']],
  ['crayon-sketch', ['#F6C74C', '#F28A16', '#628B49']],
  ['nyx-night', ['#07080C', '#FFFFFF', '#C9A45C']],
  ['cartoon-doodle', ['#FFFFFF', '#CECECE', '#F2D16D']],
  ['feng-guo-shu-ye', ['#E6CFA8', '#6DABCB', '#9A4E3B']],
  ['deconstructed-illustration', ['#3F625E', '#923E32', '#F3EFE6']],
  ['dune-echo', ['#E8D4B8', '#EE7D15', '#251D21']],
  ['pencil-impression', ['#22221F', '#FFFFFF', '#8B8B83']],
]);

export function themeSwatches(themeId) {
  return [...(SWATCHES_BY_THEME.get(themeId) ?? [])];
}

export function themeSwatchClass(color) {
  if (color === '#FFFFFF') return 'is-white';
  if (color === '#C9A45C') return 'is-gold';
  if (color === '#F3EFE6') return 'is-paper';
  return '';
}
