# 附录: 拦截式 harness 启动别名表(alias-transparent 契约,2026-08-23)

别名武装在每个新 shell 的 bootstrap(dais 外部捕获开关开时);`new-terminal`
只开 tab 返回 `session_<sid>`,启动 harness = 注入别名命令:

| 别名 | 等效 | 凭据/标记 | 注入模板(实测) |
|---|---|---|---|
| `omp-dais` | `omp` + 流量过 8787(env ZHIPU_CODING_PLAN_BASE_URL,零模型篡改) | models.yml 传输覆盖(!jq ANTHROPIC_AUTH_TOKEN + x-dais-instance: !printenv DAIS_INSTANCE_TAG) | `dais orchestration inject-prompt session_<sid> omp-dais --force`(8 字节起 TUI,状态栏=用户 config default 原样) |
| `cc-dais` | `claude --settings ~/.config/dais/cc-entry-settings.json`(env 透传+BASE_URL→/cc) | ANTHROPIC_CUSTOM_HEADERS(x-dais-instance) | 同上注入 `cc-dais` |
| `pi-dais` | `pi`(env 暂 no-op,待上游 env 约定) | DAIS_INSTANCE_TAG | 同上注入 `pi-dais` |

依赖 PATH(默认不在 DSH/cron/spawned shell 的 PATH 上,先引导一次):
`export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"`
`omp`→`~/.bun/bin/omp`(bun)、`pi`→nvm node、`claude`→`~/.local/bin/claude`。
模型选择零干预: 用户 config 里选的模型/effort 原样生效(实测 glm-5.3:max)。
