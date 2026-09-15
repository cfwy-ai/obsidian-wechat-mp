import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readImageDimensions } from '../src/image-dimensions.mjs';

/** 为本地回归工具提供与 Obsidian resolver 相同的尺寸字段。 */
export function createFilesystemImageResolver(imageDirectory) {
  const root = realpathSync(resolve(imageDirectory));
  const cache = new Map();
  return (target) => {
    const requestedPath = resolve(root, target);
    const requestedRelative = relative(root, requestedPath);
    if (
      requestedRelative === '..' ||
      requestedRelative.startsWith(`..${sep}`) ||
      isAbsolute(requestedRelative) ||
      !existsSync(requestedPath)
    ) return null;
    let filePath;
    try {
      filePath = realpathSync(requestedPath);
    } catch {
      return null;
    }
    const realRelative = relative(root, filePath);
    if (
      realRelative === '..' ||
      realRelative.startsWith(`..${sep}`) ||
      isAbsolute(realRelative)
    ) return null;
    if (!cache.has(filePath)) {
      let value = null;
      try {
        value = readImageDimensions(readFileSync(filePath));
      } catch {
        value = null;
      }
      cache.set(filePath, value);
    }
    return {
      url: pathToFileURL(filePath).href,
      filePath,
      ...(cache.get(filePath) ?? {}),
    };
  };
}
