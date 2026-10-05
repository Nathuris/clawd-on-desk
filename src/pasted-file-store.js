"use strict";

// ══════════════════════════════════════════════════════════════════
// 把面板里「粘贴」进来的图片/文件落成临时文件
//
// 剪贴板里的截图、网页里拷的图，只有字节、没有磁盘路径；而面板只能往终端里
// 送文字。所以先写进临时目录，再把那个路径填进输入框——Claude 读得到路径，
// 也就看得到图。
//
// 从 Finder 拷贝的文件不经过这里（它有真实路径，面板直接用它）。
// ══════════════════════════════════════════════════════════════════

// 上限 25MB：贴进来的多是截图，真有人贴大文件也不该把应用卡住。
const MAX_PASTED_BYTES = 25 * 1024 * 1024;
// 只认「点 + 字母数字」这么短的扩展名：它会被拼进文件名。
const SAFE_EXTENSION = /^\.[A-Za-z0-9]{1,8}$/;

const MIME_EXTENSIONS = Object.freeze({
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/tiff": ".tiff",
  "image/bmp": ".bmp",
  "image/heic": ".heic",
  "image/svg+xml": ".svg",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
});

// 收 Uint8Array / Buffer / ArrayBuffer / 任何 TypedArray；别的一律不认。
function toBytes(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

// 优先按 MIME 类型定扩展名；没有就看原文件名；都没有就 .bin。
function extensionFor(name, type) {
  const mime = String(type || "").toLowerCase().split(";")[0].trim();
  if (MIME_EXTENSIONS[mime]) return MIME_EXTENSIONS[mime];
  const base = String(name || "");
  const dot = base.lastIndexOf(".");
  if (dot > 0) {
    const ext = base.slice(dot);
    if (SAFE_EXTENSION.test(ext)) return ext.toLowerCase();
  }
  return ".bin";
}

function createPastedFileStore(options = {}) {
  const fs = options.fs || require("fs");
  const path = options.path || require("path");
  const dir = options.dir;
  if (!dir) throw new Error("createPastedFileStore requires a dir");
  const now = typeof options.now === "function" ? options.now : Date.now;
  const maxBytes = options.maxBytes || MAX_PASTED_BYTES;
  let seq = 0;

  // 同步写：内容有上限，一次写几十毫秒，比给调用方加一层异步简单。
  function save(payload) {
    const bytes = toBytes(payload && payload.data);
    if (!bytes) return { status: "invalid" };
    if (bytes.length === 0) return { status: "invalid" };
    if (bytes.length > maxBytes) return { status: "too-large" };

    seq += 1;
    const target = path.join(dir, `clawd-paste-${now()}-${seq}${extensionFor(payload.name, payload.type)}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(target, bytes);
    } catch (err) {
      return { status: "error", message: err && err.message };
    }
    return { status: "ok", path: target };
  }

  return { save, dir };
}

module.exports = {
  MAX_PASTED_BYTES,
  extensionFor,
  toBytes,
  createPastedFileStore,
};
