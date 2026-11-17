# 部署与发布（DEPLOY）

> 阶段 4「安装与发布」文档。目标：**在一台没有开发环境的 Windows 机器上**完成安装 → 导入 → 阅读 → 翻译 → 导出。

## 1. Python 边车（sidecar）的提供方式

当前决策：**Python 由外部提供**（不内置解释器）。
- 运行机需求：**Python ≥ 3.10** + 依赖 `python/requirements.txt`（版本已锁定）。
- 安装依赖：`python -m pip install -r python/requirements.txt`。
- 也可用 `PAPERDESK_PYTHON` 环境变量指定解释器路径（便于使用虚拟环境/独立发行版）。

> 打包配置（`package.json` 的 `build.extraResources`）会把 `python/` 目录**随包分发**到应用的 `resources/`，
> 但**解释器本身**仍来自运行机。若要做到“零外部依赖”，后续可内置 embeddable Python 或 PyInstaller 产物——列为后续项。

## 2. 资源路径

应用按是否打包决定 sidecar 的工作目录：
- 开发：`<repo>/python`（`join(__dirname, '../..')/python`）。
- 打包：`<安装目录>/resources/python`（`process.resourcesPath`）。

两者都由 `src/main/sidecar/manager.ts` 的 `pythonDir()` 统一处理。

## 3. 原生依赖（better-sqlite3）

- `better-sqlite3` 是原生模块，**必须针对 Electron 的 ABI 重建**：
  - 安装时：`postinstall` → `electron-builder install-app-deps` 自动处理；
  - 手动重建：`npm run rebuild`。
- 若报 `NODE_MODULE_VERSION` 不匹配，几乎总是这一步没做。

## 4. 构建与打包

```bash
npm ci
npm run typecheck            # 类型检查
npm run ci                   # 一键：类型检查 + 单测 + 坐标 + Python 单测 + 冒烟
npm run preflight            # 安装预检：Node/Python/依赖/sidecar 能否起来
npm run dist                 # electron-vite build + electron-builder → release/
```
- 打包产物：`release/`（Windows NSIS 安装包）。`release/` 已 gitignore。
- `extraResources` 会把 `python/` 放进 `resources/python`。

## 5. 升级

- 覆盖安装即可；**用户数据不受影响**（见下）。
- 数据库列级迁移在启动时自动执行（`src/main/db/migrate.ts`）：旧库缺列会自动补，**不丢数据**。

## 6. 用户数据位置与卸载

- 数据根目录：`%APPDATA%/paperdesk/data`（Linux: `~/.config/paperdesk/data`，macOS: `~/Library/Application Support/paperdesk/data`）。
  - SQLite：`library.sqlite`；附件：`storage/`；笔记：`notes/`；译文产物：`translated/`；批处理产物：`batch/`；自动备份：`backups/`。
  - 可用环境变量 `PAPERDESK_DATA` 覆盖（测试/便携模式）。
- **卸载**：卸载程序会删除安装目录与快捷方式；**用户数据目录默认保留**（避免误删论文/笔记）。如需彻底清除，请手动删除上面的数据目录。
- 建议：重要数据请用「设置 → 数据安全 → 备份数据库」，备份文件（`*.sqlite`）可随时「从备份恢复」（恢复前会自动安全备份当前库）。

## 7. 预检与排障

- **预检**：`npm run preflight` —— 逐项检查 Node ≥22.18、Python ≥3.10、依赖可导入、sidecar 能启动并响应 `/health`。
- 缺 Python：应用会**立即**给出「未找到 Python…（请安装 Python 3.10+，或通过 PAPERDESK_PYTHON 指定）」而不是干等。
- 依赖缺失：先把 `python/requirements.txt` 装齐；`preflight` 会直接指出缺哪个包。

## 8. 已知缺口（本阶段未完成）

- 安装包**未签名**、无自动更新（需证书/更新服务器）。
- 未内置 Python 运行时（需运行机安装 Python）。
- 仅在 Windows 上验证过打包链路；macOS/Linux 打包未验证。
- 「无开发环境的真实机器」端到端安装验证需要在**干净机器**上人工执行（见 `docs/TRIAL.md`）。
