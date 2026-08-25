/**
 * dedup.js — 原位 re-export 窄腰库(P4.2,R-B09)。
 * 原导出名与签名逐字保留: digestOf(line,parsed) 兼容层 + createDedupWindow。
 * 单一物理源 = plugins/_narrow-waist/dedup.js(含双键/双记扩展,单键调用面零改动)。
 */
export { digestOf, createDedupWindow } from '../../_narrow-waist/dedup.js'
