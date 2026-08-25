/**
 * index.js — 窄腰共享库桶导出(唯一入口)。
 * 零逻辑、零副作用、零常量副本(SIGNALS 只在 vocabulary.js 定义)。
 * 任何 adapter 只允许从此文件或具名模块文件引入,禁止复制函数体——
 * 「四处同源」自 P1 起收敛为单一物理源。
 */
export {
  forgeMsgid, digestOf, dedupKeys, createDedupWindow, seenAny, markAll,
} from './dedup.js'
export { appendJsonl } from './jsonl.js'
export {
  parseAddress, aliasIndex,
  resolveRouting, resolveRoutingUnified, resolveHostRouting, resolveAddress,
  findFleetEntry, resolveFleetSessionId,
  sanitizeConsumers, readRegistry, writeRegistryAtomic, registerConsumer, unregisterConsumer,
} from './addressing.js'
export {
  SIGNALS, DAIS_TYPE_MAP, DSH_TYPE_MAP, ORCA_TYPE_MAP,
  normalizeType, denormalizeType, DSH_CALLBACK_TYPES, DSH_INTAKE_TYPES,
} from './vocabulary.js'
export {
  LINE_PREFIX, ENVELOPE_VERSION, V2_TYPES,
  createEnvelope, validateEnvelope, serializeLine, parseLine,
  detectVersion, upgradeV2toV3, downgradeV3toV2,
} from './envelope.js'
