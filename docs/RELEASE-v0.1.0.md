# PaperDesk v0.1.0

Windows x64 首个公开版本。

- 论文阅读、批注、翻译、笔记、知识库和文献检索。
- 设置页按七个分类重新组织，支持 OpenAI Chat Completions 和 Anthropic Messages。
- 支持流式问答、视觉请求与 Python 翻译协议适配。
- 模型密钥使用 Windows 系统加密保存，设置导出不包含密钥。

## 安装

下载并运行 PaperDesk-0.1.0-x64-Setup.exe，可选择安装目录。
公开包不包含个人文库、API Key 或缓存。首次使用请在设置中配置自己的服务。

Python 解析服务需要另外安装 Python 3.10+ 及程序资源目录 resources/python/requirements.txt 中的依赖；当前版本未内置 Python。可通过 PAPERDESK_PYTHON 指定解释器。

## 说明

- Windows 安装包尚未进行发布者证书签名，也没有自动更新。
- 仅验证 Windows x64；尚未在全新、无开发环境的电脑上完成安装验收。
- 模型协议与界面已通过本地隔离测试；未使用个人付费 API 做外网模型验收。
- 源码及许可证：https://github.com/JackieYuwhu/paperdesk
- SHA-256 校验值见 SHA256SUMS.txt。
