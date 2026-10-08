# WarOnPaper 文档索引

本目录存放 **纸上谈兵 4 / WarOnPaper** 的工程级与包级架构说明。内容以仓库内实际代码与配置为准，不替代游戏规则正文（见仓库根目录 `纸上谈兵4-规则文档.md`）。

## 工程总览

| 文档 | 内容 |
|------|------|
| [00-project-overview.md](./00-project-overview.md) | 整体架构、包边界、运行时数据流、构建与入口 |
| [01-repository-structure.md](./01-repository-structure.md) | 目录树与重要文件用途 |
| [02-config-and-tooling.md](./02-config-and-tooling.md) | 脚本、依赖、TypeScript/Vite、环境变量、版本号 |

## 包级分析（按模块）

| 包 / 路径 | 文档入口 | 说明 |
|-----------|----------|------|
| `@wop/shared` → `core/shared` | [shared/README.md](./shared/README.md) | 共享规则、协议类型、纯逻辑仿真 |
| `@wop/server` → `core/server` | [server/README.md](./server/README.md) | `GameRoom` 权威房间库与调试入口 |
| `@wop/client` → `core/client` | [client/README.md](./client/README.md) | 对局 SPA：画布、HUD、WebSocket |
| `@wop/manager` → `manager` | [manager/README.md](./manager/README.md) | 标题页 / 大厅 / 静态资源 / 多房间调度 |

包级 README 中链接的细分子文档（如 `architecture.md`、`room.md`、`lobby-ws.md`）为深入分析页；以对应源码与包 README 为准。

专项协议：[shared/tick-packets.md](./shared/tick-packets.md) — 客户端 / 服务端每 tick 的 `state` 数据包。

## 建议阅读顺序

1. [00-project-overview.md](./00-project-overview.md) — 先建立「manager 托管 + shared 规则 + GameRoom 权威」心智模型  
2. [01-repository-structure.md](./01-repository-structure.md) — 对照目录找代码  
3. [02-config-and-tooling.md](./02-config-and-tooling.md) — 本地启动、构建、环境变量  
4. [shared/README.md](./shared/README.md) → [server/README.md](./server/README.md) → [client/README.md](./client/README.md) → [manager/README.md](./manager/README.md)

## 仓库外相关

| 位置 | 用途 |
|------|------|
| `/纸上谈兵4-规则文档.md` | 游戏规则设计（非工程架构） |
| `/version.json` | 产品展示版本号（标题页 / F2 调试面板） |
| `/build.cmd`、`/start.cmd`、`/start.sh` | 根目录构建与启动入口 |

## 文档约定

- 语言：简体中文  
- 忽略展开说明：`node_modules/`、`dist/`、`.git/`、`__pycache__/`、图标二进制树细节、`_tmp_*` 临时脚本  
- 不提交敏感运行时数据：`manager/data/` 已在 `.gitignore` 中  
