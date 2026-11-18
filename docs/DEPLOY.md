# 安装、部署与发布

本文适用于 PaperDesk v0.1.1 的 Windows x64 版本。

## 安装程序

从 [Releases](https://github.com/JackieYuwhu/paperdesk/releases/latest) 下载 `PaperDesk-0.1.1-x64-Setup.exe`，运行安装向导并选择安装目录。程序包不包含 Python 解释器。

PDF 解析等功能需要 Python 3.10+，建议使用已在发布流程中验证的 Python 3.13。安装 Python 后，在 PowerShell 中设置实际的程序安装目录并安装依赖：

```powershell
$appDir = 'D:\Apps\PaperDesk'
python --version
python -m pip install -r "$appDir\resources\python\requirements.txt"
```

`D:\Apps\PaperDesk` 是示例路径，请替换为实际安装目录。安装完成后重新启动 PaperDesk，在「设置 → 外观与诊断 → 服务自检」点击「检测解析服务」。

### 指定 Python 解释器

应用默认调用 `python`。如需使用虚拟环境或指定解释器，可在 PowerShell 中设置环境变量，再从同一窗口启动程序：

```powershell
$appDir = 'D:\Apps\PaperDesk'
$env:PAPERDESK_PYTHON = 'D:\Python313\python.exe'
& $env:PAPERDESK_PYTHON -m pip install -r "$appDir\resources\python\requirements.txt"
& "$appDir\PaperDesk.exe"
```

以上路径均为示例。该设置仅对当前 PowerShell 及其启动的程序生效；从开始菜单启动时，需要在用户环境变量中配置同名变量，或确保 `python` 指向已安装依赖的解释器。

### 校验安装包

下载发布页中的 `SHA256SUMS.txt`，并将下面命令的输出与文件中的值比较：

```powershell
Get-FileHash .\PaperDesk-0.1.1-x64-Setup.exe -Algorithm SHA256
```

当前安装包未进行发布者证书签名；SHA-256 用于检查文件是否与发布附件一致。

## 数据、升级与备份

程序默认将文库保存在 `%APPDATA%\paperdesk\data`，与安装目录分开：

| 内容 | 路径 |
|---|---|
| 文库数据库 | `library.sqlite` |
| PDF 附件 | `storage/` |
| Markdown 笔记 | `notes/` |
| 翻译产物 | `translated/` |
| 批处理产物 | `batch/` |

`PAPERDESK_DATA` 可覆盖默认文库目录，需在程序启动前设置。

升级前建议关闭程序并备份整个文库目录。设置中的数据库备份只保存数据库，迁移时还需保存附件、笔记和其他文件。卸载程序默认保留文库，重新安装后可继续使用。

使用系统加密保存的模型密钥与 Windows 用户的加密环境关联。更换电脑或 Windows 账户后可能需要重新填写 API Key。提交问题时，请先移除日志或截图中的敏感内容。

## 从源码构建

需要 Node.js 22.18+（建议 24）、npm、Python 3.10+ 和 Windows 原生模块构建工具。

```powershell
npm ci
python -m pip install -r python/requirements.txt
npm test
npm run build
npm run dist
```

安装包输出到 `release/`。打包内容包括 Electron 程序资源、运行依赖和 `resources/python` 下的 Python 源码及依赖清单；解释器由运行环境提供。

`better-sqlite3` 必须匹配 Electron 的 ABI，安装依赖时会自动处理。若出现 `NODE_MODULE_VERSION` 不匹配，可执行 `npm run rebuild` 后重试。

## 发布流程

1. 更新程序版本号和 `docs/RELEASE-v<版本号>.md` 发布说明。
2. 将变更同步到仓库的 `main` 分支。
3. 在 **Actions → Release Windows → Run workflow** 启动发布。

工作流在干净的 Windows 环境中安装依赖、运行 `npm test`、构建安装包并生成 SHA-256 校验文件。构建成功后，发布作业创建版本标签和 GitHub Release。已有同版本 Release 时保持原样，不覆盖附件；发布新版本需先更新版本号。

发布工作流文件首次添加或变更时也会自动触发。构建作业只读取仓库内容，发布作业使用 GitHub 提供的短期令牌写入 Release，无需在仓库保存个人 API Key。

## 常见问题

- **找不到 Python**：确认 `python --version` 可用，或设置 `PAPERDESK_PYTHON` 为实际解释器路径。
- **提示缺少模块**：使用应用所调用的同一个 Python 解释器安装 `requirements.txt` 中的依赖。
- **模型连接失败**：核对协议、Base URL、模型 ID 和 API Key，再点击「保存并测试连接」。
- **原生数据库模块无法加载**：源码开发环境执行 `npm run rebuild`；安装版请提供程序版本和错误信息。
- **解析服务失败**：在设置中运行服务自检，并检查文库默认目录下的 `logs/sidecar.log`；反馈前先脱敏。

当前仅验证 Windows x64，尚未内置 Python、发布者证书签名或自动更新。复杂文献的解析与翻译结果仍需人工核对。
