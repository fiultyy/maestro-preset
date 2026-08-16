# 0004 — fleet 准入探测:termid 回报验证后才入编排列表

> 状态: IMPLEMENTED(E2E 通过: 冷终端探测→verified 入册→ledger 落账;伪造回报→mismatch 不入册;回归 13/13 绿)

## 问题

编排列表(fleet.json)的入册目前只有 spawn 时的单向登记,Orca 终端条目没有准入验证:

1. **handle 是 runtime-scoped**:Orca 重启后全批作废,fleet 里攒僵尸条目(orch1 事故
   的教训之一——死条目卡轮转闸门、误导派发);
2. **派发前不知终端里有没有活 agent**:terminal send 进死终端/空 shell 无声无息,
   要等握手超时才发现;
3. **身份对不上才发现错联**:消息发错终端、终端被复用,都要到任务跑歪才暴露。

## 洞察(本方案的支点)

`$ORCA_TERMINAL_HANDLE` 是 OMP 注入的**进程级 env,启动即有、恒定不变、进程私有**——
只有坐在那个终端里的 agent 自己读得到(orcard skill 封装:一条命令输出身份表卡)。
所以「回报 termid 正确」一探三验:

- **终端活**(handle 有效,消息送达);
- **agent 活**(有会读 env、会跑命令的 agent 在场,冷启动也能探出能力);
- **回调链路通**(回报经 cb-send 走的是正式回调通道,顺手验证了后续握手的地基)。

## 方案

### 1. 探测命令 `bin/fleet-probe`

```bash
fleet-probe <termid> [--wait <secs>]     # 探测;--wait 轮询 fleet.json 等验证结果
fleet-probe --reverify                    # 批量重探所有 verified 条目(stale 巡检)
```

流程:
1. `terminal read --terminal <termid> --limit 1` 快检(handle 无效立即 fail,不浪费探测);
2. `terminal send` 探测消息(见下),ref = `probe:<termid>`;
3. fleet.json upsert 条目:`{handle, status: probing, probedAt, alias: null}`;
4. 回调回合验证(编排者侧,非脚本):回报 `from == termid` → `status: verified`,
   记 `verifiedAt` + ledger 落账(p2p 节点,refs 存 termid);不符 → `mismatch`;
5. `--wait` 模式轮询 fleet.json 至状态离开 probing(或超时 → `unresponsive` 由 sweep 判)。

探测消息模板(自包含,不依赖对端已有任何 skill):

```
[ref:probe:term_xxx] 编排准入探测(一次性,完成后无后续动作):
1) 读你的终端身份: echo $ORCA_TERMINAL_HANDLE
   (或 bash ~/.agents/skills/orcard/scripts/self-id.sh 出完整表卡)
2) 立即回调: ~/.dsh/.agent-presets/maestro/bin/cb-send ack <上面读到的值> \
     <orch签名> probe:term_xxx "probe ok, handle=<同上>"
3) 除此之外不要做任何事。
```

### 2. fleet 条目形态(Orca 终端类)

key 直接用 termid(与 4 位码/sessionId 键并存,resolve 已兼容任意键):

```json
"term_bb23...": {
  "kind": "orca-terminal", "handle": "term_bb23...", "status": "verified",
  "alias": "dev1", "probedAt": "...", "verifiedAt": "...", "lastSeenAt": "..."
}
```

状态机:`probing → verified | mismatch | unresponsive`;verified 经 --reverify 失败 →
`stale`(不入删除,人工处置)。**只有 verified 可作为派发目标**(session-spawn 派发
守卫 + persona 决策线补一句)。

### 3. 复用与巡检

- 派发时 ref 直接关联 fleet 条目(termid 即 node_id 或其 refs),done 回调自动回填
  `lastSeenAt`;
- 每轮 sweep 对 `probing` 超 10 分钟 → `unresponsive`;周期 `--reverify` 防 stale。

## 验收

- [ ] 冷 claude 终端: fleet-probe → 回调匹配 → fleet 条目 verified + ledger 有账;
- [ ] 错联场景: 对 A 终端探测、伪造 B 的回报(手 POST from=B)→ mismatch,不入册;
- [ ] 死 handle: terminal read 快检即 fail,不发探测消息;
- [ ] --wait 模式同步拿到验证结果;--reverify 全绿;
- [ ] 现有测试不回归(22+3+10)。

## 边界与不做

- **非密码学身份**: HTTP 回调的 from 是自报的,本机回环信任模型内有效(与共享 skill
  同前提);termid 私有性(env 进程私有)使外部伪造需登入那台机,威胁模型可接受;
- 不动 DSH 侧插件(纯 bin 脚本 + fleet schema 扩展 + 文档);
- zap 会话不在本票(其 handle 体系不同,后续另票)。

## 规模预估

bin/fleet-probe(~120 行 python) + fleet schema 扩展 + persona 两行 + USAGE §7 +
文档。1 小时级。
