# 存档下载与读档恢复

权威存档由 **GameRoom** 导出明文，**manager** 用 `WOP_SAVE_KEY` 做 AES-256-GCM 封包为 `.wopsave`。密钥永不下发客户端。

## 配置 `WOP_SAVE_KEY`

密钥**只在启动脚本**中设置（`start.js` / `.env` 不提供默认值）：

| 入口 | 行为 |
|------|------|
| [`start.cmd`](../../start.cmd) | 未设置时写入示例 `WOP_SAVE_KEY` |
| [`manager/start.sh`](../../manager/start.sh)（根目录 `start.sh` 转调） | `${WOP_SAVE_KEY:-<示例>}` |

示例密钥（base64，32 字节）：

```
WOP_SAVE_KEY=jvFkO2ewJAkSp5Gu67q2VKjdkFsq95GPd1JmK/SwuiY=
```

直接跑 `start.cmd` / `start.sh` 即可。若用 `node manager/dist/index.js` 等绕过启动脚本，需自行导出该变量，否则导出/读档会 `SAVE_KEY_MISSING`。

**生产请更换脚本内密钥**；不同密钥加密的 `.wopsave` 无法互相读档。

| 形式 | 行为 |
|------|------|
| Base64 解码后恰好 32 字节 | 直接作 AES-256 密钥 |
| 64 位十六进制 | 解码为 32 字节密钥 |
| 其它非空字符串 | `SHA-256(utf8)` 派生 32 字节密钥 |
| 未设置 / 空 | **拒绝** `export_save` 与带 `saveBlob` 的 `create_room`（不回退明文） |

错误码：`SAVE_KEY_MISSING`。

## 文件格式 `.wopsave`

```
magic "WOPS" (4) | version u16 LE (=1) | iv (12) | ciphertext | authTag (16)
```

明文为 JSON `SaveDocument`（见 `@wop/shared` `save.ts`）：`formatVersion`、`gameVersion`、`savedAt`、`saverPlayerId` / `saverName`、房间选项、完整 `buildings` / `liaisons` / `units` / `pollutionZones` / 资源层、以及 `connectedByOwner`、`knownCapitalOwners`、`spectatorIds`、各玩家 HUD。

## 协议

| 方向 | `type` | 说明 |
|------|--------|------|
| C→S | `export_save` | 对局中请求下载；manager 调 `exportPlainSave` 后加密，回 `save_export` |
| S→C | `save_export` | `blob`（base64 密文）、`filename?` |
| C→S | `create_room` + `saveBlob?` | 仅自定义建房可读档；manager 解密后 `createRoom({ restore, holderPlayerId })` |
| C→S | `set_ready` | `{ ready: boolean }` — 读档准备大厅 |
| C→S | `inherit_identity` | `{ savePlayerId }` — 继承未占用存档身份 |
| C→S | `abandon_capital` | 读档大厅放弃首都以便重选 / 换身份 |

**禁止**对局中注入存档。

## 身份映射

1. 创建者（持有 `.wopsave` 者）→ `saverPlayerId`（永不选都，只准备）。
2. 其余：`liveId === saveId` 直接占用。
3. 若剩余存档身份与剩余玩家均为 1 → 排除法绑定。
4. 否则开局前用 `inherit_identity` 或点击未占用首都继承；也可新建都。

映射成功即接管该存档玩家全部资产与 HUD。

## `restore_lobby`

- 阶段名：`restore_lobby`（快照 `restoreMode: true`）。
- **全图卫星**展示建筑 / 联络线；**无直接视野**，直至全员准备并进入 `playing`。
- 禁止战斗 / 建造；可选都（若需要）、继承身份、组队（若仍开放）、准备切换。
- 已映射且有首都者可 `abandon_capital` 后重选。
- 当前房内 **所有人 ready**、`playerCount >= 2`、且非持有者/非观战者均已有首都 → `playing`，开始 tick。
- `allowRespawn` / 地图等沿用存档。

## UI

- 游玩端：首都血量环下方「下载存档」按钮，其下为组队按钮；与左下角高级视图按钮同宽（36px）并左缘对齐。
- 标题大厅「创建房间」：可选上传 `.wopsave`；校验失败显示错误。

## 相关源码

- `core/shared/src/save.ts` — 明文类型
- `core/server/src/room.ts` / `saveRestore.ts` — 导出与恢复
- `manager/src/saveCrypto.ts` — 加解密
- `manager/src/index.ts` — `export_save` / `create_room.saveBlob`
- `core/client` — 下载钮、准备条、卫星大厅
- `manager/client` — 标题屏上传
