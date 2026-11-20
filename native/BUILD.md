# 引擎可复现构建

扩展代码和引擎协议版本 1 共用同一个模型目录。交付包包含每个平台的 Node 24.22.3、锁定的生产依赖和各自的 whisper.cpp 可执行文件，用户端无需开发工具。

开发机准备 CMake、C/C++ 编译器、Node.js 和 npm。跨编译使用 llvm-mingw。源版本固定为 whisper.cpp v1.9.5，下载并解压上游 release 源码后，将目录记为 `WHISPER_CPP_DIR`。本次构建使用 CMake 4.5.0 和 llvm-mingw 20261117 UCRT。

macOS arm64 构建示例

```bash
cmake -S native/whisper -B build/mac -DWHISPER_CPP_DIR=/absolute/path/whisper.cpp-1.9.5 \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_DEPLOYMENT_TARGET=13.5 \
  -DGGML_METAL=OFF -DGGML_ACCELERATE=ON
cmake --build build/mac --config Release --parallel 4 --target horisub-whisper
mkdir -p bin
cp build/mac/horisub-whisper bin/
cmake -S native/whisper -B build/metal -DWHISPER_CPP_DIR=/absolute/path/whisper.cpp-1.9.5 \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_DEPLOYMENT_TARGET=13.5 \
  -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_ACCELERATE=ON
cmake --build build/metal --config Release --parallel 4 --target horisub-whisper
cp build/metal/horisub-whisper bin/horisub-whisper-metal
swiftc -swift-version 5 -O -target arm64-apple-macosx13.5 native/speech.swift -o bin/horisub-speech
```

Windows x64 从 macOS 交叉编译示例

```bash
cmake -S native/whisper -B build/win -DWHISPER_CPP_DIR=/absolute/path/whisper.cpp-1.9.5 \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_SYSTEM_NAME=Windows -DCMAKE_SYSTEM_PROCESSOR=x86_64 \
  -DCMAKE_C_COMPILER=x86_64-w64-mingw32-clang -DCMAKE_CXX_COMPILER=x86_64-w64-mingw32-clang++ \
  -DCMAKE_EXE_LINKER_FLAGS=-static -DGGML_AVX=OFF -DGGML_AVX2=OFF -DGGML_FMA=OFF \
  -DGGML_F16C=OFF -DGGML_BMI2=OFF -DGGML_LLAMAFILE=OFF -DGGML_CPU_REPACK=OFF
cmake --build build/win --config Release --parallel 4 --target horisub-whisper
cp build/win/horisub-whisper.exe bin/
x86_64-w64-mingw32-clang -O2 -municode -mwindows -static native/whisper/launcher.c -o bin/horisub-engine.exe
```

将 Node 官方对应文件 `node-v24.22.3-darwin-arm64.tar.gz`、`node-v24.22.3-win-x64.zip` 以及对应 `SHASUMS256.txt` 放在同一目录。由 macOS 或安装了 `zip`、`unzip` 和 `tar` 的构建机运行

```bash
export HORISUB_NODE_ARCHIVES=/absolute/path/node-archives
export HORISUB_WHISPER_SOURCE=/absolute/path/whisper.cpp-1.9.5
node scripts/package-native.mjs darwin-arm64
node scripts/package-native.mjs win-x64
```

打包脚本检查 Node 归档摘要、生成与扩展公开键匹配的 ID、按平台安装生产依赖，输出 ZIP 与 SHA-256。包内保留 `Install`、`Repair`、`Uninstall`、注册信息和引擎运行文件。Windows 包的 VC++ Runtime 是微软的系统前置库。构建机使用已锁定的 npm 依赖和固定模型版本。发布商店无需也未使用当前开发用的私钥。正式扩展由发布方确定商店 ID，由安装参数明确指定。
