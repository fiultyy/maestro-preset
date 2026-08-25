/**
 * registry.js — 原位 re-export 窄腰库(P4.2,R-B09/R-B14/D-N1)。
 * 原导出名与签名逐字保留(五函数);写链语义(唯一 tmp + 按路径串行化)随库继承。
 * 单一物理源 = plugins/_narrow-waist/addressing.js registry 段。
 */
export {
  sanitizeConsumers, readRegistry, writeRegistryAtomic,
  registerConsumer, unregisterConsumer,
} from '../../_narrow-waist/addressing.js'
