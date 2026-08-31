// elk.js — 薄 ESM 包装（spec-pm-web-canvas §3，唯一允许的附属文件）：
// elkjs 0.12.0 UMD 单文件的 ESM 引入通道。app 代码不触全局 ——
// import { ELK } from './elk.js'。宪章例外条款见 README「Vendor 例外」节；
// 本文件绝不修改 elk.bundled.js 本身（改一字即例外失效）。
// 注：spec 原名 elk.mjs —— PW-001 静态面 MIME 表无 .mjs（模块脚本必须
// JS MIME），且 PMW2-2 红线 service.mjs 冻结，故落为 .js（内容同）。
import './elk.bundled.js'
export const ELK = globalThis.ELK
