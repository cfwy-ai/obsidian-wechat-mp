// 从图片文件头读取固有尺寸，不解码整张图片。
//
// 公众号画廊只需要宽高比。这个模块同时供 Obsidian 运行时的二进制
// 兜底与 Node 主题审计使用，避免把图片体积或具体主题写进排版规则。

const bytesOf = (input) => {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return null;
};

const ascii = (bytes, start, length) =>
  String.fromCharCode(...bytes.subarray(start, start + length));

const dimensions = (width, height) => {
  const w = Number(width);
  const h = Number(height);
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0
    ? { width: w, height: h }
    : null;
};

const uint24le = (bytes, offset) =>
  bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);

const readPng = (bytes, view) => {
  if (
    bytes.length < 24 ||
    ascii(bytes, 1, 3) !== 'PNG' ||
    ascii(bytes, 12, 4) !== 'IHDR'
  ) return null;
  return dimensions(view.getUint32(16), view.getUint32(20));
};

const readGif = (bytes, view) => {
  if (bytes.length < 10 || !/^GIF8[79]a$/.test(ascii(bytes, 0, 6))) return null;
  return dimensions(view.getUint16(6, true), view.getUint16(8, true));
};

const readBmp = (bytes, view) => {
  if (bytes.length < 26 || ascii(bytes, 0, 2) !== 'BM') return null;
  const dibSize = view.getUint32(14, true);
  if (dibSize === 12) {
    return dimensions(view.getUint16(18, true), view.getUint16(20, true));
  }
  return dimensions(view.getInt32(18, true), Math.abs(view.getInt32(22, true)));
};

const JPEG_SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

const readJpeg = (bytes, view) => {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let cursor = 2;
  while (cursor + 3 < bytes.length) {
    while (cursor < bytes.length && bytes[cursor] !== 0xff) cursor += 1;
    while (cursor < bytes.length && bytes[cursor] === 0xff) cursor += 1;
    if (cursor >= bytes.length) break;
    const marker = bytes[cursor];
    cursor += 1;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 ||
        (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (cursor + 1 >= bytes.length) break;
    const length = view.getUint16(cursor);
    if (length < 2 || cursor + length > bytes.length) break;
    if (JPEG_SOF.has(marker) && length >= 7) {
      return dimensions(view.getUint16(cursor + 5), view.getUint16(cursor + 3));
    }
    cursor += length;
  }
  return null;
};

const readWebp = (bytes, view) => {
  if (
    bytes.length < 30 ||
    ascii(bytes, 0, 4) !== 'RIFF' ||
    ascii(bytes, 8, 4) !== 'WEBP'
  ) return null;

  let cursor = 12;
  while (cursor + 8 <= bytes.length) {
    const kind = ascii(bytes, cursor, 4);
    const length = view.getUint32(cursor + 4, true);
    const data = cursor + 8;
    if (data + length > bytes.length) return null;

    if (kind === 'VP8X' && length >= 10) {
      return dimensions(
        uint24le(bytes, data + 4) + 1,
        uint24le(bytes, data + 7) + 1,
      );
    }
    if (kind === 'VP8L' && length >= 5 && bytes[data] === 0x2f) {
      const bits = view.getUint32(data + 1, true);
      return dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (
      kind === 'VP8 ' && length >= 10 &&
      bytes[data + 3] === 0x9d && bytes[data + 4] === 0x01 && bytes[data + 5] === 0x2a
    ) {
      return dimensions(
        view.getUint16(data + 6, true) & 0x3fff,
        view.getUint16(data + 8, true) & 0x3fff,
      );
    }
    cursor = data + length + (length % 2);
  }
  return null;
};

const readSvg = (bytes) => {
  const sample = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
  const root = /<svg\b([^>]*)>/i.exec(sample)?.[1];
  if (!root) return null;
  const length = (name) => {
    const raw = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(root)?.[1];
    const match = /^\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?)\s*(?:px)?\s*$/i.exec(raw ?? '');
    return match ? Number(match[1]) : null;
  };
  const explicit = dimensions(length('width'), length('height'));
  if (explicit) return explicit;
  const viewBox = /\bviewBox\s*=\s*["']\s*[-+\d.e]+[ ,]+[-+\d.e]+[ ,]+([-+\d.e]+)[ ,]+([-+\d.e]+)\s*["']/i.exec(root);
  if (viewBox) {
    const value = dimensions(viewBox[1], viewBox[2]);
    if (value) return value;
  }
  return null;
};

/**
 * @param {ArrayBuffer|ArrayBufferView} input
 * @returns {{width: number, height: number}|null}
 */
export function readImageDimensions(input) {
  const bytes = bytesOf(input);
  if (!bytes || bytes.length < 10) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return readPng(bytes, view) ??
    readGif(bytes, view) ??
    readJpeg(bytes, view) ??
    readWebp(bytes, view) ??
    readBmp(bytes, view) ??
    readSvg(bytes);
}
