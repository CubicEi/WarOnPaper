# 建筑矢量图标

图标文件名 = 规则文档中的 **ID**。

路径：`buildings/<category>/<ID>.svg`

详见 `manifest.json` 与 `纸上谈兵4-规则文档.md` 第 7 节。

从 `new_assets/icons/buildings - black/` 同步并生成各颜色变体：

```bash
python core/assets/icons/sync_building_svgs.py
```

`command/commander.svg` 不会生成（仅使用 `settlement/commander.svg`）。

```bash
npx --yes serve assets/icons
```
