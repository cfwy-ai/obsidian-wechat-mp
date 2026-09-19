export function getScrollRatio(element) {
  if (!element) return 0;
  const range = Math.max(0, element.scrollHeight - element.clientHeight);
  return range === 0 ? 0 : Math.min(1, Math.max(0, element.scrollTop / range));
}

export function setScrollRatio(element, ratio) {
  if (!element) return;
  const range = Math.max(0, element.scrollHeight - element.clientHeight);
  element.scrollTop = range * Math.min(1, Math.max(0, Number(ratio) || 0));
}

export function syncScrollPosition(source, target) {
  setScrollRatio(target, getScrollRatio(source));
}
