# HoriSub 本机引擎

先把 HoriSub 扩展加载到桌面 Chrome。安装包与开发扩展使用同一个扩展 ID。

- Apple Silicon Mac 运行 Install.command。引擎针对 macOS 13.5 或更新版本。应用代码没有 Developer ID 签名和公证。
- Windows x64 运行 Install.cmd。若系统缺少 Microsoft Visual C++ v14 x64 运行库，请从 Microsoft Learn 安装后重试。
- 回到扩展设置，检查本机注册状态，准备当前选择的模型，并运行本地语音自检。
- 使用时在视频标签页点击 Chrome 工具栏 HoriSub，再点击「开始字幕」。Chrome 会按需启动引擎。

Repair 可重新安装和注册当前版本，模型缓存随用户保留。实际扩展 ID 与开发包不同，可给 Repair 传入 `--extension-id ID` 参数。

Uninstall 会删除引擎和注册，并询问是否清理模型。需要同时移除扩展时，在 Chrome 扩展管理页操作。

微软系统运行库说明见 [Microsoft Learn](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170)。
