/**
 * jsonl.js — 窄腰共享库: 键序锁定 JSONL 追加(P2.3/R-S29)。
 *
 * 语义对齐旧 bin append_jsonl(bin/session-send:68-73):
 *   自动 mkdirs(dirname(path)) → 追加单行 JSON.stringify(obj) + '\n'
 *   (键序锁定序列化: 调用方按键序构造对象,JSON.stringify 保字符串键插入序,
 *   库不得排序/重排键)→ flush + fsync。
 */
import { openSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** 追加单行(键序锁定)并 fsync;dirname 不存在时自动创建。 */
export function appendJsonl(path, obj) {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const line = `${JSON.stringify(obj)}\n`
  const fd = openSync(path, 'a')
  try {
    writeSyncAll(fd, line)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

import { writeSync, fsyncSync, closeSync } from 'node:fs'

function writeSyncAll(fd, text) {
  let off = 0
  while (off < text.length) {
    off += writeSync(fd, text, off)
  }
}
