# orch-gen2 交接简报(手动 compact 换代)

> **[host 重启处置卡 — gen2b 补 2026-08-17 夜, 两次现场提炼]**
> host 重启 = 本代(host槽)会话消亡, 走换代 SOP:
> 1. 继任 spawn(**必须 maestro preset**, §3.2), 读本简报即接管;
> 2. 双通道 armed(bridge_arm+bridge_http_status)→核 registry: 只应剩自己; 残留死条目(旧 sessionId)手清——在飞回调幽灵地址温床;
> 3. **签名广播**: 向全部在飞 worker(Orca 终端/dispatch)发 session-send 通报新签名, 其后续 ack/done 改投;
> 4. Orca Run/task 邮箱不随 host 亡: task-list 兜底收口在飞票(worker_done 到而未收的);
> 5. 专用壳(term_8cfd288c)/常驻终端(term_82d5fada dais-omp)核活性, 必要时重建+fleet-probe 重准入;
> 6. ledger sync.py 刷新; fleet.json 死码手清;
> 7. 根因上下文: 桥互踩/幽灵地址=0005 票(ADDR-R1/PORT-R1/HTTP-R2), 两次现场(08-16 换代/08-17 bridge-rearm)验证, 实施后本卡 2/3 步可简化。

> **[已执行归档 2026-08-16 深夜, orch-gen2b]**: 换代闭环(自检accepted→终票f88fe6a/5c12fe5落盘→一代退役), 一代会话 session-1737c79e 已 archiveSession 入档, 桥 registry 残留已清(连同旧orch 313e6f7f)。本文留档作§3.2"简报过继"样例, 机制坑六/七/八已沉淀 maestro-preset feat/field-pitfalls@f88fe6a。

> 写于 session-1737c79e(orch1 一代), 2026-08-16 深夜。继任者读本文即接管, 无需原始对话。

## 1. 你是谁
- 别名 orch1(bridge_arm 用这个), fleet 码待 spawn 后自取(建议 node=orch-gen2)
- 宿主: DSH maestro preset, 工作目录 /home/yy/.dsh
- 开场三步: bridge_arm{alias:orch1} + bridge_http_status + 读本文件

## 2. 专用壳(重要)
所有 orchestration 变更命令(orca-ide worker-start/dispatch/task-update)必须经专用壳执行:
- term_8cfd288c-76fd-4490-971f-43b5d5be04ad (Pi @ /home/yy/tmp, 用户配的)
- 用法: terminal send 把编排命令/脚本发进它执行, 输出落 /tmp 你回收
- 它不是派发对象, 只执行壳; 票从不投给它

## 3. 仓库与分支状态
- zap 主仓 /home/yy/warpdotdev/zap: main=4fddeef9 已推远端(外部捕获全链+观测台全修在 main)
- maestro-preset /home/yy/tools/maestro-preset(本编排系统源码, runtime=~/.dsh/.agent-presets/maestro 为 copy):
  - feat/field-pitfalls 栈(基于 main 9780d70, 未push, 待用户定合入): ba8c154四坑 → 98f390b第五坑 → 43ed453 §10.2自迭代分治
- ~/.pi/agent/models.json 与 ~/.omp/agent/models.yml: zap provider 已配(8787入口, pi=/pi前缀, omp=/omp前缀)
- ~/.config/zap/: cc-entry-settings.json(自动生成) + omp-upstream.json(出口)

## 4. 在飞票(接班先查)
- T4-E2E task_222ca46cd75f @ orca Run run_e854a7879a93, omp worker ctx_94a8f7041e59 @ wt zap-t4-e2e(路径 /home/yy/orca/workspaces/zap/zap-t4-e2e)
  - 纯测试票(三前缀全链断言/别名函数体/零劫持回归), 红线=发现bug报回不擅改
  - 验收: cargo test -p harness_integration 全绿, 先 git status 看它是否越线改运行时
  - 完成信号: task-list 状态翻转(该 worker 的 worker_done 曾不入 Run 邮箱, 用 task-list 兜底)
- 换代广播: 本文件随换代消息已通知 5d2e(若还活着)与 T4 无需动作——它们按 to 寻址, 你接班后新签名自动生效

## 5. 用户偏好(硬约束)
- 小完整票串行/可并行时先收敛到 main 同基点; 每张票先草案 grill 再派
- 单 wt 自决 workflowz fan-out; maestro-preset 不走 orca(直接 .dsh 操作)
- 亲验不采信自述(grep 关键词/跑测试/翻库); on-demand 不自动; terse 中文
- 观测台数据: ~/.local/state/zap-p0review/harness_blocks.db (external-cc/omp/pi 三 session)

## 6. 机制坑速查(详见 field-pitfalls 分支, 合 main 后新一代自动继承)
paste-Enter时序 / watcher旧recap误触(判定三闸) / headless借壳(专用壳已解) / git-lfs静默吞push+ls-remote过期缓存(终验=重试+哈希比对) / host重启会话ID漂移(重启后重新双通道武装+广播) / 自迭代路径分治(文档git直改/bin+skills先.dsh后sync/plugins强制git分支)

## 7. 自迭代回路(用户已授权)
持续识别机制债→自主开票(5d2e模式或新spawn)→沉淀到 maestro-preset 分支→验收→待用户定合入。本次换代本身是第六坑候选: fork会话(长seed重放)compact失效, 手动compact=session-spawn继任+简报过继+签名广播, 成功经验落盘自迭代。
