# 调试：玩家行动日志

源文件：`core/shared/src/debug/actionLog.ts`

供客户端 F2 调试面板与服务端「行动结果」回包共用。

---

## 类型

| 类型 | 含义 |
|------|------|
| `PlayerActionCategory` | `system` / `capital` / `build` / `liaison` / `building` / `unit` / `train` / `combat` / `chat` / `ui` |
| `PlayerActionStatus` | `pending` \| `ok` \| `fail` |
| `PlayerActionSource` | `client` \| `server` |
| `PlayerActionLogEntry` | 环形缓冲中的一条：时间、tick、玩家、分类、摘要、成败、原因 |
| `PlayerActionResultMsg` | `ServerToClient` 成员：`type: "action_result"`，权威成功/失败 |
| `PlayerActionLogPush` | 写入日志的入参子集 |

中文标签：`PLAYER_ACTION_CATEGORY_LABEL` / `PLAYER_ACTION_STATUS_LABEL`。

---

## 主要 API

| 符号 | 作用 |
|------|------|
| `shouldLogClientAction(type)` | 跳过 `ping`/`hello`/房间匹配类消息 |
| `categoryForAction` | 由消息 type 映射分类 |
| `summarizeClientAction` | 生成人类可读摘要（查建筑/联络/兵种名） |
| `formatActionStamp` / `formatCostDelta` | UI 时间戳与费用增量文案 |
| `PlayerActionLog` | 默认容量 200 的环形缓冲：`push` / `entries` / `clear` 等 |

客户端可先记 `pending`，收到 `action_result` 后更新为 `ok`/`fail`。
