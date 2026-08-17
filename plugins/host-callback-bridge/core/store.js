/**
 * store.js — bridgeDir 布局 + state.json 分节原子写。
 * 逐行平移自 maestro-preset plugins/callback-bridge/core/store.js(pump.js:274-360);
 * 本 lane 自包含副本(见 README"路径分治")。host lane 的持久分节是顶层 hostBridge
 * (计数/游标/bind),分节合并写不触碰 consumers.* 既有分节。
 */
import { createHash } from 'node:crypto'
import * as fsp from 'node:fs/promises'

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** id → 游标文件名安全形式。 */
export function fileSafeSid(sessionId) {
  if (/^[A-Za-z0-9._-]+$/.test(sessionId)) return sessionId
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 8)
  return `${sessionId.replace(/[^A-Za-z0-9._-]+/g, '_')}-${hash}`
}

export function createBridgeStore({ bridgeDir }) {
  if (typeof bridgeDir !== 'string' || bridgeDir.length === 0) {
    throw new TypeError('createBridgeStore: bridgeDir is required')
  }
  const paths = {
    dir: bridgeDir,
    inbox: `${bridgeDir}/inbox.log`,
    rotated: `${bridgeDir}/inbox.log.1`,
    dead: `${bridgeDir}/dead.log`,
    echo: `${bridgeDir}/echo.log`,
    state: `${bridgeDir}/state.json`,
    registry: `${bridgeDir}/registry.json`,
    hostLaneLog: `${bridgeDir}/host-lane.log`,
    cursorFor: (sessionId) => `${bridgeDir}/.cursor.${fileSafeSid(sessionId)}`,
  }

  /** 读取 state.json 根对象(缺失/损坏返回 {})。 */
  async function readState() {
    try {
      const txt = await fsp.readFile(paths.state, 'utf8')
      const parsed = JSON.parse(txt)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // 首次运行或损坏: 从零计起,不阻塞消费。
    }
    return {}
  }

  // 并发写串行化(进程内写链 + 唯一 tmp),跨进程 last-writer-wins 竞窗与 v3.5 相同,
  // 分节合并写把损害局限在自身分节。
  let writeChain = Promise.resolve()
  let writeSeq = 0

  /** 读-改-写 state.json(tmp + rename 原子落盘);失败仅记日志,不阻断投递主路径。 */
  function saveState(mutate) {
    const run = writeChain.then(async () => {
      const root = await readState()
      mutate(root)
      const tmp = `${paths.state}.tmp-${process.pid}-${++writeSeq}`
      await fsp.writeFile(tmp, `${JSON.stringify(root, null, 2)}\n`)
      await fsp.rename(tmp, paths.state)
    })
    writeChain = run.catch(() => {})
    return run
  }

  return { paths, readState, saveState }
}
