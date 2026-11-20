# HoriSub 架构与数据流

```text
Chrome 工具栏 → Service worker（固定 tabId 和 frameId）
                    │ tabCapture.getMediaStreamId
                    ▼
标签页音频 → Offscreen MediaStream → AudioContext
                    ├─ 原声监听增益 → 系统播放
                    └─ AudioWorklet → 24 kHz PCM → WebRTC VAD → 有界语音分段
                                                        │
         ┌──────────────────────────────────────────────┴─────────────────────┐
         │ 本机引擎模式                                                        │ 浏览器本地
         │ 16 kHz PCM 小块 + seq → Native Messaging → whisper.cpp               │ Transformers.js Worker
         │                                └─ ONNX CPU 本地文字翻译               │ ONNX WebGPU / WASM 本地文字翻译
         └──────────────────────────────────┬──────────────────────────────────┘
                                            ▼
                    字幕版本校验 → Shadow DOM / Document PiP / 独立字幕窗
                                ├─ 当前会话记录 / TXT、SRT、VTT
                                └─ 用户启用时 → 本机系统 TTS
```

Offscreen 用 `USER_MEDIA`，负责捕获和活动会话。Service worker 在 `storage.session` 保留当前会话身份。Chrome 回收 worker 时，可以重新查询 offscreen。Native Messaging 有自己的持久端口。关闭 popup 不会终止采集。页面越权或 track 结束时释放。休眠后音频出现时间或包序号断点时，清空旧分段和字幕版本。需要重新授权时由用户重新点击工具栏。

音频分为原声监控和分析支路。监控使用单个独立增益节点，ASR 支路的工作节点只输出静音。本机模式的可选 TTS 由操作系统语音合成。浏览器模式只选 Chrome 报告为本地的声音。两者的输出均位于捕获标签页之外。拖动字幕、适配全屏和镜像 PiP 不更改网站的视频音轨。

分段用 40 ms PCM 帧、最多 8 个 worklet 传输配额、约 240 ms 预卷和 360 ms 结束窗口。连续语音的片段上限约 4.4 秒，强制切段保留 240 ms 重叠并对文字去重。每次推理最多一个活动识别和一个候选 final。算力不足时减少 partial，过期语音优先丢弃。自动语言检测在连续两个长度足够的同语种结果后锁定，换视频或切时间轴时重新检测。译文只处理确认后的片段。译文队列限定一个活动和最多三个等待，使用 session、generation、segmentId 和版本匹配。

Native Messaging 使用 little-endian 32 位 JSON 帧长度，协议版本 1。支持握手、模型管理、会话控制、带序号 PCM、识别与翻译、本机朗读、取消和退出。Chrome 启动原生主机，后者在会话里保留 whisper.cpp 模型进程和翻译 Worker。CPU 后端限制短片段的解码预算，Metal 后端使用 GPU 注意力核。取消后识别子进程持续无响应时会被终止，扩展按退避间隔重新连接。接收上限小于 92 KB 每消息，每个 PCM 消息小于 16 KB，每条推理音频小于 230 KB。标准输出用于协议帧，生产连接走管道。

浏览器本地使用专用 Worker。模型加载时只查校验后的缓存，ONNX JavaScript 和 WASM 由扩展随包提供。WebGPU 可用时优先，初始化异常或识别超时可回退 WASM。模型提供者不会联网完成推理。主动下载时访问固定版本的 Hugging Face 仓库和其 CDN，校验文件字节数及内容摘要。语音和字幕不作为下载请求参数。

计时中，分段时长用首尾 PCM 采集时间。推理从提交到返回识别任务，提交至确认含排队。翻译含 final 进入队列至译文就绪。渲染从结果发出至播放器的第二次绘制回调。端到端从最后被 VAD 判为有声的帧到译文首次渲染。时间来自本机时钟，媒体时间由观察到的播放位置和倍速估算。每项 p50 和 p95 取最多最近 180 个样本。累计已显示译文数单独保留，可以区分采集继续与字幕继续更新。浏览器支持时记录 JS Heap，长跑脚本另记 Chrome 子进程 RSS。
