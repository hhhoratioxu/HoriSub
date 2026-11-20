# 实际测试记录

测试机为 MacBook Pro Apple M1 Pro、32 GB、macOS 27.3。各轮使用独立 Chrome 配置。受控媒体由回环地址提供，Chrome 禁止解析外部域名。浏览器推理用预载的固定版本权重；扩展的推理 Worker 拒绝访问外部 URL。本机命令行另用 macOS 进程沙箱禁止网络。公共站点测试只在独立联网配置中播放公开页面。

## 0.2.1 内存对照

Chrome for Testing 159.0.8154.6 从同一 HTML5 播放器采集同一段英语语音。两版都使用 Whisper base Q5_1、OPUS-MT 和 CPU，设置页保持开启。从第一条双语字幕开始每 10 秒取样，比较首分钟共 7 个样本的峰值。RSS 为进程驻留内存，相加可能包含共享页面。

| 采样指标 | 0.2.0 | 0.2.1 |
| --- | ---: | ---: |
| 本机宿主与识别进程峰值 RSS 合计 | 1,373 MiB | 1,110 MiB |
| 隔离 Chrome 进程组峰值 RSS（含本机引擎） | 2,761 MiB | 2,511 MiB |
| 空闲设置页保留的本机宿主 | 1 个，51 MiB | 0 个 |
| 播放期间的本机宿主数量 | 2 个 | 1 个 |

本机引擎峰值下降约 19%。设置页在最后一个查询完成后释放连接。本机翻译直接从已准备的文件载入模型，减少启动时的内存复制和分配预留。第一轮 0.2.1 播放器在 75.6 秒处暂停，首分钟对照取样已完成，连续稳定性另用本地实时音频流验证。

另用分发包播放一分钟实时音频流。停止并等待 3 秒后，设置页仍开着，宿主和识别进程都退出，标签页也无活动或待处理的音频捕获。0.2.0 停止后仍有一个设置页宿主，采样 RSS 为 50 MiB。

原始运行日志保存在测试工作区的 `test-results/`，公开仓库保留可复现的测试入口和汇总结果。

### 0.2.1 本机模式连续 60 分钟

分发版扩展和 macOS 引擎从首条双语字幕开始计时。Chrome 直接采集本地播放器的实时 MediaStream，使用 Whisper base Q5_1、OPUS-MT 和 CPU。长测期间将监听输出设为静音，原声链路由单独的短测验证。

| 指标 | 实测结果 |
| --- | --- |
| 播放与字幕 | 连续采样 3,600 秒，媒体时间推进 3,600.010 秒，另显示 1,094 条译文。保留的 1,097 条字幕条目都有译文，片段 ID 唯一，未检测到测试短句超出分段长度的整句重复。 |
| 延迟与队列 | 结束前最近 180 条，语音结束到译文渲染 p50 709 ms、p95 762 ms。首分钟之后的最高滚动 p95 为 1,016 ms。翻译队列峰值 2，诊断丢弃数 0。 |
| 内存 | 本机宿主和识别进程的采样峰值为 1,090 MiB。第 10 分钟到测试结束之间为 633–636 MiB，末次 636 MiB。隔离 Chrome 进程组末次采样为 1,715 MiB。 |
| 资源释放 | 停止后的采样中本机宿主与识别进程均退出。标签页无活动或待处理捕获，字幕层消失，设置页继续开启。 |

### 0.2.1 功能复测

- **本机引擎**。macOS 禁止进程联网后，分发包从语音生成英译简繁和日译简繁。Chrome 实际采集并显示双语，系统完成一次中文朗读。关闭弹窗后继续出字幕。原声回放节点测到实际信号，影院、播放器全屏、画中画和独立字幕窗都显示了译文。字幕可导出为 TXT、SRT 和 VTT。设置页使用默认的「自动选择」后端，实际用 Metal 完成本地语音自检。
- **浏览器本地**。独立 Chrome 没有注册本机引擎，Whisper tiny 通过 WASM 识别完整英语语句并显示译文。Moonshine Tiny 和 OPUS-MT 运行 300.089 秒，显示 91 条新译文，语音结束到译文显示 p50 721 ms、p95 770 ms，队列峰值为 1，停止后释放捕获。另测跳转、变速、播放器替换、32 秒静音后恢复、后台任务回收后继续和原生 TextTrack 翻译。首次浏览器短测拦截到截断音频的识别结果，另一次生命周期测试的第二次捕获未启动。复测等到完整短句并通过连续播放及原生字幕用例。
- **异常与构建**。强制关闭本机引擎后，同一字幕会话自动恢复。缺少本机安装时，设置页每个并行查询都给出安装提示。取消实际下载后删除了临时文件和下载锁。浏览器模型管理发现了相同长度的损坏文件。5 项单元测试和 TypeScript 检查通过。从干净的源码目录重新安装依赖，扩展 ZIP 与待发布文件的字节一致。三份 ZIP 的完整性与 SHA-256 都通过。Windows 启动器、Node、Whisper 和 ONNX Runtime DLL 为 x64，Windows 实机仍待验证。
- **常用 Chrome 安装**。分发包加载并固定在工具栏，现有语音和翻译模型均显示已准备。设置页自检返回英中双语。再从工具栏启动本地实时音频样本，采样时已显示 11 条译文，停止后 Chrome 的音频共享状态清除。

### 0.2.1 公开播放器抽测

本机模式在公开的 YouTube 点播、YouTube Shorts、Twitch 片段和 B 站点播均从音频得到过原文和译文。YouTube 直播额外关闭了该站的 CC，确认播放器的 TextTrack 数为零，再从音频生成字幕。向后拖动至约 32 秒前及返回直播边缘，两个位置均产生新字幕。各站仅抽查下列公开样本，译文可见且存在分段及词语误差。

- [YouTube Al Jazeera English 直播](https://www.youtube.com/watch?v=gCNeDWCI0vo)、[YouTube 点播](https://www.youtube.com/watch?v=jNQXAC9IVRw)、[NASA YouTube Shorts](https://www.youtube.com/shorts/k5Z7sFwFF7Q)
- [Twitch 片段](https://www.twitch.tv/gamesdonequick/clip/SpicyViscousAnteaterOSsloth-K6CSwwztylETGXVW)、[哔哩哔哩点播](https://www.bilibili.com/video/BV15uzXBvEMp/?p=3)

## 0.2.0 功能基线

| 场景 | 实测 |
| --- | --- |
| 本机离线语音识别与英译简繁 | 在禁止网络的进程运行当前安装引擎，whisper.cpp base Q5_1 识别受控英语样本。OPUS-MT 产出简体和繁体，系统朗读实际简体译文。该次识别 3,929 ms，首次简体翻译 5,552 ms，同进程随后繁体翻译 215 ms。`test-results/native-final-deny-network.log` |
| 从浏览器音频到中文播报 | 禁止普通外网域名解析的 Chrome 实际采集英语音频，显示译文并触发 macOS 本地声音完成播报。设置读出 18 个中文系统声音，测试选择 `zh-CN` 声音，停止后结束采集会话。独立浏览器模式只使用 Chrome 标记为本地的声音，测试 Chrome 未报告本地中文声音。`test-results/speech-window-final.log` · `test-results/browser-offline-voices.log` |
| 本机日语到中文 | 手动选日语，真实转写本地语音样本，M2M100 生成简体和繁体。首次翻译加载及推理共 23,242 ms，随后繁体翻译 8,438 ms。`test-results/native-ja.log` |
| 本机韩语到简体、繁体和英文 | 当前包在禁止网络的进程中实际转写韩语语音，M2M100 输出三种目标语言。该次直接调用保留了模型的重复原文，三次翻译各耗时约 39–47 秒。Chrome 字幕链路另有整句重复保护。多语言模型的实时性还需随设备和内容验证。`test-results/native-korean-current.log` |
| 浏览器本地模式 | Chrome for Testing 159.0.8154.6。两种模型均从 Chrome `tabCapture` 取得实际音频，并用 OPUS-MT 显示双语。Whisper tiny WASM 单次端到端样本 18,223 ms，Moonshine Tiny WASM 样本 4,124 ms。两轮停止后活动捕获和播放器字幕层均已清除。`test-results/browser-final.log` · `test-results/browser-moonshine-final.log` |
| 播放器生命周期 | 浏览器本地模式通过 1.25 倍速和跳转后恢复、同页路由和视频元素替换、32 秒静音期间保持空字幕及随后恢复、强制回收 service worker 后继续同一会话，并读取和翻译真实 TextTrack。同源 iframe 也显示过双语字幕，离开页面后结束捕获。`test-results/lifecycle-browser.log` · `test-results/embed.log` |
| 播放、原声、画中画和记录 | 当前包在普通、影院和容器全屏显示双语，关闭弹窗后继续识别。独立原声增益节点在单位增益时测到实际音频。Document PiP 镜像视频和字幕，关闭后源播放器继续，独立字幕窗也显示真实译文。另验证暂停和恢复、记录搜索、复制选中、TXT/SRT/VTT 下载、开启历史持久化后保存与清空。`test-results/features-window-final.log` |
| macOS 安装、修复、卸载 | 执行卸载并保留下载权重，再重新安装。移走注册文件后使用修复脚本重新创建，确认 `allowed_origins` 只含当前包 ID，引擎可运行自检。当前版本引擎已注册到测试机账户。`test-results/install-macos.log` · `test-results/install-macos-current.log` |
| 设置页的安装后自检 | Chrome 从已注册的当前包读到版本与准备状态。点击「运行本地语音自检」后，随包英语测试音频产生原文和译文。该轮 CPU 识别 2,663 ms，翻译 1,120 ms。`test-results/setup-selftest-current.log` |
| 模型下载和修复 | 在临时缓存中真实下载 59,707,625 字节的 base Q5_1 权重。将同大小文件的字节改坏后，校验发现损坏，重新下载通过摘要检查。 |
| 浏览器模型管理 | 设置页对真权重识别出同大小文件的损坏，并删除选中的模型、更新缓存状态。隔离浏览器的附加主机授权没有完成，浏览器内直接联网修复暂未确认。`test-results/browser-model-cache-current.log` · `test-results/browser-models-desktop.log` |
| 权限与断线恢复 | Chrome 内部页在启动采集前被拒绝。在默认本机模式的隔离测试手动暂停识别子进程，扩展取消该任务、重建引擎，并在同一会话内恢复实际字幕。`test-results/native-recovery-stall.log` |
| 单元测试 | 44.1／48／96 kHz PCM、长静音和有界语音分段、跳转后合法字幕导出、本地默认设置，以及整句重复的回归用例，5 个测试通过。 |
| 产物完整性 | 三个 ZIP 实测通过 CRC 和 SHA-256 校验，扩展 ZIP 内所有文件与 `dist/` 一致。Windows 启动器、Whisper 和 Node 执行文件的 PE 架构为 x64，原生运行依赖随包保存。`test-results/deliverable-integrity.log` |
| Windows x64 | 已交叉编译 PE32+ x86-64 启动器和 whisper.cpp，引擎 ZIP 包含 Node、ONNX Runtime 和安装脚本。当前没有 Windows 实机测试安装、SAPI、注册表或浏览器集成。 |

初次压力测试同时运行了多个额外推理任务，约 4 分钟后持续超时。后续测试仍发现过采集持续、译文数停滞的区间，原始采样保留在 `test-results/soak-steady.jsonl`。加入超时恢复后的第一次重测在预热阶段超时。`test-results/soak-native-verified.jsonl`

在同一个受控英语样本上，base Q5_1 使用 CPU 注意力且关闭 Flash Attention，重复两次的识别墙钟时间为 2,735 和 4,919 ms，两次都转写出单句。启用 Flash Attention、四线程时约 27.4 秒，并重复输出同一短句。最终构建使用两线程 CPU 识别，保留 Metal 侧的 Flash Attention。取消无响应时清理识别子进程，自动重连有上限。另测三个英译中短句时，单线程 OPUS-MT 的推理时间为 204–355 ms，作为默认本地文字翻译配置。`test-results/native-cpu-benchmark.log` · `test-results/native-translation-benchmark.log`

20:00 开始的运行在并行站点测试时发现整句被模型在一个分段内重复多次，翻译因此持续超时。诊断证实识别和视频仍在推进。该轮在取得证据后停止，已释放捕获。`test-results/soak-delivery-60m.jsonl` · `test-results/soak-delivery-diagnostic.json`

最终版本只为真实重叠的分段传递前句提示，对解码末尾的多次整句重复做去重，按原文规模限制翻译生成长度。使用 macOS 分发引擎和交付版本的采集、识别及翻译代码，从 20:21:35（北京时间）持续运行 3,600.298 秒。独立字幕窗修复后单独运行了真实浏览器复测，交付包与长跑扩展的构建差异仅为该窗口的 HTML 与脚本。`test-results/soak-stable-60m.jsonl` · `test-results/deliverable-integrity.log`

| 60 分钟本机长跑 | 实测结果 |
| --- | --- |
| 输入 | Chrome for Testing 159.0.8154.6，从 HTML5 播放器的受控英语音频真实采集。默认本机模式、自动源语言、Whisper base Q5_1、OPUS-MT，实际使用 CPU。扬声器监听支路在长跑中接到静音输出，短测另验证原声回放节点。 |
| 播放进度与译文 | 视频推进 3,599.619 秒。每轮采样都观察到新译文，计时后共显示 925 条新译文。941 条留存记录中 939 条有译文，片段 ID 唯一，受控样本未出现超出该片段时长的整句重复。 |
| 延迟 | 语音结束到译文显示，结束时最近 180 条的 p50 为 705 ms、p95 为 2,069 ms。并行测试期间，滚动 p95 的最高采样为 15,143 ms。 |
| 资源 | 翻译队列峰值 3，诊断记录 146 次丢弃。Chrome 进程组 RSS 从 2,645 MiB 降到 1,782 MiB，其中本机引擎从 1,354 MiB 降到 627 MiB。Offscreen JS 堆采样约 3.5–8.7 MiB。 |
| 结束 | 停止后会话结束，Chrome 无活动或待处理的标签页捕获，播放器字幕层已移除。 |

最终浏览器本地模式运行 304.215 秒。测试配置无 Native Messaging 注册。WebGPU 推理超时后自动回退到 WASM，随后 Moonshine Tiny 和 OPUS-MT 显示 90 条新译文，翻译队列峰值为 1。最后采样端到端 p50 2,572 ms、p95 4,234 ms。捕获和字幕层均在停止后清除。`test-results/soak-browser-release-5m.jsonl`

## 0.2.0 公共网站尝试

这些结果不计入本地端到端测试。Chrome 158.0.8127.36 打开了下列公开页面。结果依赖试验时的网站直播、访问和页面状态。

| 网站 | 实测结果 |
| --- | --- |
| YouTube Al Jazeera English、DW News、France 24 直播 | 前两者曾开始播放，随后站点显示播放错误。Al Jazeera 的对照测试在未启动采集时也复现了同一错误，带界面的 Chrome 复测仍遇到播放错误。France 24 未达到播放用例条件。无原生字幕的直播、持续双语及直播回看均未完成公开站点验收。`test-results/sites-stable-release.jsonl` · `test-results/sites-live-playback-control.jsonl` |
| YouTube 普通视频 | 浏览器模式从 3Blue1Brown 视频音轨显示双语。本机模式也在带界面的 Chrome 中对《Me at the zoo》显示双语，两条样本均有识别误差。这两个点播样本都存在 CC 控件。`test-results/sites-english-audio.jsonl` · `test-results/sites-desktop-final.jsonl` |
| YouTube 有字幕视频 | 3Blue1Brown 视频开启了 CC，选择优先原生后实际回退到音频并显示双语。该轮未验证从 YouTube 读取原生 CC。通用播放器 TextTrack 已测试。`test-results/sites-dw-cc.jsonl` |
| YouTube Shorts | NASA 的《Become a NASA Astronaut!》通过浏览器本地模式输出 “The universe is calling. Will you answer?” 和中文译文。音频识别来源，CC 控件当时隐藏且未启用，`textTracks` 为零。该条译文实测 6,309 ms。`test-results/sites-browser.jsonl` |
| Twitch | GamesDoneQuick 页面曾开始播放并返回音乐标签与译文，后续复测只收到短时音轨后播放器暂停。公开 Twitch 语音双语尚未通过。`test-results/sites-desktop-final.jsonl` · `test-results/sites-stable-release.jsonl` |
| B站 | 公开新闻英语视频可开始播放并被适配器识别，测试中播放器随后暂停，语音双语尚未通过。`test-results/sites-stable-release.jsonl` |

同源 iframe 已通过。跨域公开嵌入依赖所在站点授予访问权限，当前没有完成公网站点验收，跨域受限时可在独立标签页打开播放器。视频元素原生全屏和加密画面受浏览器限制，可在允许采集音轨时使用独立字幕窗。实机休眠、音频设备拔插和 Chrome 116 旧版实机兼容性未覆盖。本机长跑实际使用 CPU，Metal 推理未取得实测通过；浏览器 WebGPU 回退到 WASM 已验证。

## 复现入口

```bash
npm test
npm run test:native
npm run test:chrome -- --browser
node tests/features.mjs
node tests/speech.mjs --audio
node tests/recovery.mjs --stall
HORISUB_TEST_BROWSER_MODEL=browser-english node tests/models-browser.mjs
npm run test:soak -- 60
HORISUB_TEST_BROWSER_MODEL=browser-english npm run test:soak -- 5 --browser
```

在 macOS 上生成内存对照与长测使用的同一句英语，并观察设置页保持开启时的资源。

```bash
clip_dir=$(mktemp -d)
say -v Daniel -o "$clip_dir/speech.aiff" 'This is a test of live captions.'
afconvert -f WAVE -d LEI16@24000 -c 1 "$clip_dir/speech.aiff" "$clip_dir/speech.wav"
HORISUB_TEST_WAV="$clip_dir/speech.wav" HORISUB_TEST_CPU=1 \
  HORISUB_TEST_REPEAT_PHRASE='This is a test of live captions' \
  npm run test:soak -- 60 --memory --expect-host-exit --stream
```

浏览器测试使用 Playwright 的 Chrome for Testing。先运行 `npx playwright install chromium --no-shell`，然后安装对应引擎并准备模型。测试通过调试协议触发普通扩展工具栏操作并使用已打包扩展页面。断网测试加载本机已校验模型，开发测试服务器只提供本地音视频和权重字节。现场版本与原始结果记录在 `test-results/`。公网用例由 `HORISUB_CHROME_ONLINE=1 node tests/sites.mjs` 执行。
