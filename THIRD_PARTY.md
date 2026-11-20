# 第三方依赖与模型

模型文件由用户首次准备，扩展 ZIP 与两种引擎 ZIP 均省略模型权重。下载地址、版本、字节数和校验值由 [catalog.json](src/local/catalog.json) 锁定。大文件校验 Hugging Face Git LFS SHA-256，小文件校验对应 Git blob 摘要。

| 内容 | 许可与来源 |
| --- | --- |
| whisper.cpp 1.9.5 和 ggml | MIT。Native 包带有上游许可。[whisper.cpp](https://github.com/ggml-org/whisper.cpp/tree/v1.9.5) |
| 本机 Whisper tiny、base、small Q5_1 | ggerganov/whisper.cpp 提供的量化权重。原 Whisper 源项目与此模型库为 MIT。[GGML 权重](https://huggingface.co/ggerganov/whisper.cpp) |
| 浏览器 Whisper base、tiny int8 | Xenova 转换后的 ONNX 图和 tokenizer，版本见模型目录。上游模型卡标注 Apache-2.0。[base](https://huggingface.co/Xenova/whisper-base) · [tiny](https://huggingface.co/Xenova/whisper-tiny) |
| 浏览器 Moonshine Tiny int8 | 仅英语，MIT。[ONNX 版](https://huggingface.co/onnx-community/moonshine-tiny-ONNX) |
| OPUS-MT English → Chinese | 原模型 Apache-2.0。使用 Xenova 对应量化 ONNX 转换。[Helsinki-NLP](https://huggingface.co/Helsinki-NLP/opus-mt-en-zh) · [ONNX 转换](https://huggingface.co/Xenova/opus-mt-en-zh) |
| M2M100 418M | 原模型 MIT。使用 Xenova 对应量化 ONNX 转换。[Meta](https://huggingface.co/facebook/m2m100_418M) · [ONNX 转换](https://huggingface.co/Xenova/m2m100_418M) |
| Transformers.js 3.8.1 与 ONNX Runtime | Apache-2.0 和 MIT。依赖版本见锁文件。[Transformers.js](https://github.com/huggingface/transformers.js) · [ONNX Runtime](https://github.com/microsoft/onnxruntime) |
| OpenCC-JS | MIT。处理本地简繁字形转换。[OpenCC-JS](https://github.com/nk2028/opencc-js) |
| WebRTC VAD 的 fvad WASM | 上游 BSD 风格许可。随扩展保留依赖包许可。[fvad-wasm](https://github.com/echogarden-project/fvad-wasm) |
| Node.js 24.22.3 | 官方可移植运行时。Node 和随附依赖的完整许可位于引擎包 `runtime/NODE-LICENSE.txt`。[Node.js](https://nodejs.org/) |

Windows 的 Visual C++ 运行库通过微软官方渠道提供。系统语音由用户在操作系统准备。HoriSub 包内没有系统语音模型。

语音自检使用 whisper.cpp 示例中的肯尼迪总统就职演说音频的开头片段，经本地重采样为 24 kHz PCM。[示例音频](https://github.com/ggml-org/whisper.cpp/blob/v1.9.5/samples/jfk.wav)
