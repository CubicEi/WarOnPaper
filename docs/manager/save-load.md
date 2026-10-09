# 存档下载与读档恢复

权威存档由 **GameRoom** 导出明文，**manager** 用 `config.json` 的 `saveKey`（或可选环境变量 `WOP_SAVE_KEY`）做 AES-256-GCM 封包为 `.wopsave`。密钥永不下发客户端。

## 配置存档密钥

**主来源**：仓库根 [`config.json`](../../config.json) 字段 `saveKey`（仅 manager / 服务端读取；Vite 客户端别名 `@config.json` 只暴露 `version`，不打包密钥）。

可选覆盖：启动前设置环境变量 `WOP_SAVE_KEY`（优先于 `config.json`）。启动脚本不再写入默认密钥。

示例（与仓库示例 `config.json` 一致，base64 32 字节）：

```json
{
  "version": "…",
  "saveKey": ""
}
```

直接跑 `start.cmd` / `start.sh` 即可（读取 `config.json`）。若用 `node manager/dist/index.js` 等绕过启动器，仍须保证进程能读到仓库根 `config.json`，或自行导出 `WOP_SAVE_KEY`，否则导出/读档会 `SAVE_KEY_MISSING`。

**生产请更换 `saveKey`**；不同密钥加密的 `.wopsave` 无法互相读档。

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
| C→S | `set_ready` | `{ ready: boolean }` — 开局准备大厅（新开局 `ready_lobby` / 读档 `restore_lobby`） |
| C→S | `inherit_identity` | `{ savePlayerId }` — 继承未占用存档身份（仅读档） |
| C→S | `abandon_capital` | 准备大厅放弃首都以便重选 / 换身份 |

**禁止**对局中注入存档。

## 身份映射

1. 创建者（持有 `.wopsave` 者）→ `saverPlayerId`（永不选都，只准备）。
2. 其余：`liveId === saveId` 直接占用。
3. 若剩余存档身份与剩余玩家均为 1 → 排除法绑定。
4. 否则开局前用 `inherit_identity` 或点击未占用首都继承；也可新建都。

映射成功即接管该存档玩家全部资产与 HUD。

## 开局准备：`ready_lobby` / `restore_lobby`

新开局与读档共用同一套准备门闸（`set_ready` / 全员 ready → `playing`）：

### 新开局 `ready_lobby`

- 玩家先 `pick_capital` 选都，选完后进入 `ready_lobby`（同一套 Ready UI）。
- 可 `abandon_capital`（放弃首都，重新选择）后再选都。
- **组队模式**在准备阶段仍允许放弃重选；组队仅禁止对局中首都沦陷后的再选都（观战）。
- 当前房内 **所有人 ready**、`playerCount >= 2`、且非观战者均已有首都 → `playing`。

### 读档 `restore_lobby`

- 阶段名：`restore_lobby`（快照 `restoreMode: true`）。
- **全图卫星**展示建筑 / 联络线；**无直接视野**，直至全员准备并进入 `playing`。
- 禁止战斗 / 建造；可选都（若需要）、继承身份、组队（若仍开放）、准备切换。
- 已映射且有首都者可 `abandon_capital` 后重选；存档持有者不可放弃/重选都。
- 当前房内 **所有人 ready**、`playerCount >= 2`、且非持有者/非观战者均已有首都 → `playing`，开始 tick。
- `allowRespawn` / 地图等沿用存档。

## UI

- 游玩端：首都血量环下方「下载存档」按钮，其下为组队按钮；与左下角高级视图按钮同宽（36px）并左缘对齐。
- 标题大厅「创建房间」：可选上传 `.wopsave`；校验失败显示错误。

## 相关源码

- `core/shared/src/save.ts` — 明文类型
- `core/server/src/room.ts` / `saveRestore.ts` — 导出与恢复
- `manager/src/saveCrypto.ts` — 加解密（读 `config.json`）
- `manager/src/index.ts` — `export_save` / `create_room.saveBlob`
- `core/client` — 下载钮、准备条、卫星大厅
- `manager/client` — 标题屏上传
