# PaperDesk v0.1.0

本地论文研究工作台，将文献管理、PDF 阅读与批注、翻译、笔记和知识整理放在一个桌面应用中。

[下载 Windows 安装包](https://github.com/JackieYuwhu/paperdesk/releases/latest) · [安装与部署](docs/DEPLOY.md) · [版本说明](docs/RELEASE-v0.1.0.md) · [反馈问题](https://github.com/JackieYuwhu/paperdesk/issues)

![PaperDesk 文库工作区（示例数据）](docs/assets/workspace-library.png)

## 主要功能

- **文献管理**：导入 PDF、文件夹或文献链接，使用多级分组、分组说明和标签整理文库。
- **阅读与批注**：PDF 阅读、目录、文内查找、彩色高亮、批注和原文定位。
- **翻译与问答**：划词翻译、整篇翻译、原文与译文对照、基于论文内容的问答与拆解。
- **笔记与知识整理**：Markdown 笔记、批注引用、知识库与思维地图。
- **文献研究**：元数据识别、相关论文、文献检索和领域调研。
- **批量任务**：按选中文献、分组或标签执行翻译、拆解等任务，查看进度并取消或重试。

界面分为「文库、阅读、知识、研究、任务」五个工作区；设置按模型服务、阅读与翻译、AI 与自动化、检索与知识、提示词与技能、数据与集成、外观与诊断分类管理。

## 下载安装

当前提供 **Windows x64** 安装包。

1. 在 [Releases](https://github.com/JackieYuwhu/paperdesk/releases/latest) 下载 `PaperDesk-0.1.0-x64-Setup.exe`，安装并启动。
2. 安装 Python 3.10+（建议 3.13），并安装下方所需依赖。**安装包尚未内置 Python。**
3. 导入一篇 PDF；如需模型翻译和问答，在设置中配置自己的模型服务。

Python 依赖清单位于安装目录的 `resources/python/requirements.txt`。在 PowerShell 中将 `$appDir` 改为实际安装目录后执行：

```powershell
$appDir = 'D:\Apps\PaperDesk'
python -m pip install -r "$appDir\resources\python\requirements.txt"
```

应用默认调用 `python`。若使用虚拟环境或电脑上有多个解释器，可通过 `PAPERDESK_PYTHON` 指定完整路径，详见 [安装与部署](docs/DEPLOY.md)。完成后，可在「设置 → 外观与诊断 → 服务自检」检测解析服务。

安装包附带 `SHA256SUMS.txt` 校验文件；当前版本尚未进行发布者证书签名。

## 配置模型服务

打开「设置 → 模型服务」：

1. 选择服务提供的接口协议。
2. 填写 Base URL、API Key 和准确的模型 ID。
3. 点击「保存并测试连接」。

| 接口协议 | 官方服务地址示例 | 请求接口 |
|---|---|---|
| OpenAI Chat Completions | `https://api.openai.com/v1` | `/chat/completions` |
| Anthropic Messages | `https://api.anthropic.com/v1` | `/messages` |

兼容网关请填写其提供的地址并选择对应协议，模型 ID 以服务商说明为准。程序支持填写服务根地址、`/v1` 地址或完整接口地址；本版本不支持 OpenAI Responses 接口。

- 对话和翻译可分别指定模型；翻译模型留空时复用对话模型。
- 图像识别需要所选模型支持图片输入。
- 远程向量检索需要 OpenAI 兼容的 `/embeddings` 接口；使用 Anthropic 时采用本地哈希向量。
- 未配置模型服务时，可以使用本地文库与阅读功能；离线占位结果不代表真实模型翻译或回答。
- 部分学术检索功能需要联网或单独配置相应服务。

## 数据与隐私

文库默认保存在 Windows 的 `%APPDATA%\paperdesk\data`，包含数据库、PDF 附件、笔记和译文产物，与程序安装目录分开。需要更改数据目录时，可设置 `PAPERDESK_DATA`。

模型 Key 在 Windows 下优先使用系统加密存储；设置界面仅返回是否已配置，设置导出会移除 API Key。使用远程模型时，相关提问、论文文本或图片会发送给你配置的服务商，请按文献内容选择适合的服务。

可在「设置 → 数据与集成」备份数据库。数据库备份不等于完整文库备份，迁移或重要升级前请同时保存 PDF、笔记和其他文库文件。

## 从源码运行

开发环境需要 Node.js 22.18+（建议 24）、npm、Python 3.10+，以及 Windows 原生模块构建工具。CI 在 Windows 上运行。

```powershell
git clone https://github.com/JackieYuwhu/paperdesk.git
cd paperdesk
npm ci
python -m pip install -r python/requirements.txt
npm run dev
```

`npm ci` 会为 Electron 准备原生数据库模块。若遇到 ABI 不匹配，可运行 `npm run rebuild`。

### 测试与构建

```powershell
npm test                 # 类型检查、单元测试、坐标测试、Python 测试和数据库冒烟测试
npm run test:settings    # 隔离文库中的设置界面与模型协议测试
npm run test:workspace   # 隔离文库中的工作区界面测试
npm run build            # 构建程序资源
npm run dist             # 生成 Windows 安装包，输出到 release/
```

界面测试使用临时文库和模拟服务，不需要个人文库或真实付费 API Key。测试通过不代表外部服务可用性或模型输出质量已得到验证。

维护者可在 **Actions → Release Windows → Run workflow** 运行完整测试并发布对应版本的安装包与 SHA-256 校验文件。已有版本不会被覆盖。详细说明见 [部署文档](docs/DEPLOY.md)。

### 项目结构

```text
src/main/       Electron 主进程、数据库与业务服务
src/preload/    主进程与界面的通信桥接
src/renderer/   React 界面
src/shared/     共享类型、协议和纯函数
python/         PDF 解析、翻译等 Python 服务与测试
scripts/        构建辅助脚本与测试入口
docs/           部署、扩展和技术文档
```

技术资料：[代码索引](docs/CODE-MAP.md) · [扩展指南](docs/EXTENDING.md)。

## 当前限制

- 尚未内置 Python；解析等功能需要额外安装解释器与依赖。
- 仅验证 Windows x64，macOS 和 Linux 尚未完成打包验收。
- 安装包尚未签名，暂不支持自动更新。
- 复杂版式、扫描件、公式与表格的翻译效果受解析引擎和所选模型影响，重要内容需要人工核对。
- 模型服务的兼容性、费用、速率限制及数据处理规则由所配置的服务商决定。

## 反馈与许可

请通过 [Issues](https://github.com/JackieYuwhu/paperdesk/issues) 提交问题，附上程序版本、复现步骤和必要的脱敏截图或日志。请勿提交 API Key 或完整私人文库。

本项目采用 [MIT License](LICENSE)。
