"use strict";

// src/pasted-file-store.js：把面板里粘贴进来的图片落成临时文件。
// 全程用假的 fs / path，不真往磁盘写。

const test = require("node:test");
const assert = require("node:assert/strict");
const nodePath = require("node:path");

const {
  MAX_PASTED_BYTES,
  extensionFor,
  toBytes,
  createPastedFileStore,
} = require("../src/pasted-file-store");

function makeFs({ failMkdir = false, failWrite = false } = {}) {
  const writes = [];
  const mkdirs = [];
  return {
    writes,
    mkdirs,
    mkdirSync: (dir) => {
      if (failMkdir) throw new Error("EACCES mkdir");
      mkdirs.push(dir);
    },
    writeFileSync: (target, bytes) => {
      if (failWrite) throw new Error("ENOSPC");
      writes.push({ target, bytes });
    },
  };
}

function makeStore(overrides = {}) {
  const fs = makeFs(overrides);
  const store = createPastedFileStore({
    fs,
    path: nodePath,
    dir: "/tmp/clawd-pastes",
    now: () => 1700000000000,
    ...overrides.options,
  });
  return { store, fs };
}

test("扩展名优先按 MIME 类型定", () => {
  assert.equal(extensionFor("shot.png", "image/png"), ".png");
  assert.equal(extensionFor(undefined, "image/jpeg"), ".jpg");
  assert.equal(extensionFor("x", "image/webp; charset=binary"), ".webp");
  // 类型不认识就退回原文件名的扩展名
  assert.equal(extensionFor("谱子.PDF", ""), ".pdf");
  assert.equal(extensionFor("备份.tar.gz", "application/gzip"), ".gz");
  // 都没有就 .bin
  assert.equal(extensionFor("noext", ""), ".bin");
  assert.equal(extensionFor("危险.exe\u0000", "application/x-bad;ext"), ".bin");
});

test("toBytes 收各种字节形态，别的一律 null", () => {
  assert.ok(toBytes(new Uint8Array([1])));
  assert.ok(toBytes(Buffer.from([1])));
  assert.ok(toBytes(new Uint8Array([1]).buffer));
  assert.ok(toBytes(new DataView(new Uint8Array([1]).buffer)));
  for (const bad of [null, undefined, "x", 42, {}, [1, 2]]) {
    assert.equal(toBytes(bad), null, String(bad));
  }
});

test("落盘：目录、文件名、内容", () => {
  const { store, fs } = makeStore();
  const result = store.save({ name: "shot.png", type: "image/png", data: new Uint8Array([1, 2, 3]) });

  assert.deepStrictEqual(result, {
    status: "ok",
    path: nodePath.join("/tmp/clawd-pastes", "clawd-paste-1700000000000-1.png"),
  });
  assert.deepStrictEqual(fs.mkdirs, ["/tmp/clawd-pastes"]);
  assert.equal(fs.writes.length, 1);
  assert.deepStrictEqual([...fs.writes[0].bytes], [1, 2, 3]);
});

test("同一毫秒内连贴两张，文件名不撞车", () => {
  const { store, fs } = makeStore();
  store.save({ name: "a.png", type: "image/png", data: new Uint8Array([1]) });
  store.save({ name: "b.png", type: "image/png", data: new Uint8Array([2]) });
  const targets = fs.writes.map((write) => write.target);
  assert.equal(new Set(targets).size, 2);
  assert.match(targets[0], /-1\.png$/);
  assert.match(targets[1], /-2\.png$/);
});

test("空内容 / 不是字节的东西一律 invalid", () => {
  const { store, fs } = makeStore();
  assert.equal(store.save({ name: "a", type: "image/png", data: new Uint8Array([]) }).status, "invalid");
  assert.equal(store.save({ name: "a", type: "image/png", data: "x" }).status, "invalid");
  assert.equal(store.save(null).status, "invalid");
  assert.equal(fs.writes.length, 0);
});

test("超过上限的直接挡掉，不落盘", () => {
  const { store, fs } = makeStore();
  const result = store.save({
    name: "big.png", type: "image/png", data: new Uint8Array(MAX_PASTED_BYTES + 1),
  });
  assert.equal(result.status, "too-large");
  assert.equal(fs.writes.length, 0);
});

test("写不进去时如实报错，不假装成功", () => {
  const broken = makeStore({ failWrite: true });
  const result = broken.store.save({ name: "a.png", type: "image/png", data: new Uint8Array([1]) });
  assert.equal(result.status, "error");
  assert.match(result.message, /ENOSPC/);

  const noDir = makeStore({ failMkdir: true });
  assert.equal(
    noDir.store.save({ name: "a.png", type: "image/png", data: new Uint8Array([1]) }).status,
    "error"
  );
});

test("没给目录就直接拒绝构造：临时文件必须落在调用方指定的地方", () => {
  assert.throws(() => createPastedFileStore({ fs: makeFs(), path: nodePath }), /dir/);
});
