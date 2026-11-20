#include "whisper.h"
#include "ggml-backend.h"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

static uint32_t read32(const uint8_t* data) {
    return uint32_t(data[0]) | (uint32_t(data[1]) << 8) | (uint32_t(data[2]) << 16) | (uint32_t(data[3]) << 24);
}

static std::string quote(const std::string& value) {
    std::string output = "\"";
    for (unsigned char ch : value) {
        if (ch == '\\' || ch == '"') output += '\\';
        if (ch < 32) output += ' ';
        else output += static_cast<char>(ch);
    }
    return output + '"';
}

#ifdef _WIN32
static whisper_context* load_model(const wchar_t* path, whisper_context_params config) {
    auto* file = _wfopen(path, L"rb");
    if (!file) return nullptr;
    whisper_model_loader loader{
        file,
        [](void* ctx, void* out, size_t bytes) { return std::fread(out, 1, bytes, static_cast<FILE*>(ctx)); },
        [](void* ctx) { return std::feof(static_cast<FILE*>(ctx)) != 0; },
        [](void* ctx) { std::fclose(static_cast<FILE*>(ctx)); }
    };
    return whisper_init_with_params(&loader, config);
}
int wmain(int argc, wchar_t** argv) {
#else
static whisper_context* load_model(const char* path, whisper_context_params config) {
    return whisper_init_from_file_with_params(path, config);
}
int main(int argc, char** argv) {
#endif
    if (argc < 2) return 2;
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    std::ios::sync_with_stdio(false);
    std::cin.tie(nullptr);
    const bool debug = std::getenv("HORISUB_ENGINE_DEBUG") != nullptr;
    if (!debug) whisper_log_set([](enum ggml_log_level, const char*, void*) {}, nullptr);
    auto config = whisper_context_default_params();
#ifdef _WIN32
    config.use_gpu = false;
#else
    config.use_gpu = argc < 3 || std::string(argv[2]) != "cpu";
#endif
    const bool gpu = config.use_gpu && ggml_backend_dev_by_type(GGML_BACKEND_DEVICE_TYPE_GPU);
    config.use_gpu = gpu;
    config.flash_attn = gpu;
    auto* ctx = load_model(argv[1], config);
    if (!ctx && config.use_gpu) {
        config.use_gpu = false;
        config.flash_attn = false;
        ctx = load_model(argv[1], config);
    }
    if (!ctx) {
        std::cout << "{\"issue\":\"model_load\"}" << std::endl;
        return 3;
    }
    std::cout << "{\"ready\":true,\"backend\":\"" << (config.use_gpu ? "metal" : "cpu") << "\"}" << std::endl;

    std::atomic_bool cancelled{false};
    std::atomic_bool busy{false};
    std::atomic<uint32_t> running{0};
    std::mutex output;
    std::thread inference;
    const auto emit = [&](const std::string& response) {
        std::lock_guard lock(output);
        std::cout << response << std::endl;
    };

    uint8_t header[4];
    while (std::cin.read(reinterpret_cast<char*>(header), sizeof(header))) {
        const auto length = read32(header);
        if (length < 5 || length > 250000) break;
        std::vector<uint8_t> message(length);
        if (!std::cin.read(reinterpret_cast<char*>(message.data()), length)) break;
        const auto code = message[0];
        const auto job = read32(message.data() + 1);
        if (code == 3) break;
        if (code == 2) {
            if (job == running.load()) cancelled.store(true);
            continue;
        }
        if (code != 1 || message.size() < 10) continue;
        if (busy.load()) {
            emit("{\"id\":" + std::to_string(job) + ",\"issue\":\"busy\"}");
            continue;
        }
        const size_t prompt_len = uint32_t(message[7]) | (uint32_t(message[8]) << 8);
        if (prompt_len > 1024 || 9 + prompt_len >= length || (length - 9 - prompt_len) % 2) continue;
        if (inference.joinable()) inference.join();
        cancelled.store(false);
        busy.store(true);
        running.store(job);
        inference = std::thread([&, job, message = std::move(message), prompt_len] {
            const auto start = std::chrono::steady_clock::now();
            std::vector<float> samples;
            samples.reserve(message.size() / 2);
            for (size_t i = 9 + prompt_len; i + 1 < message.size(); i += 2) {
                const auto word = static_cast<int16_t>(uint16_t(message[i]) | (uint16_t(message[i + 1]) << 8));
                samples.push_back(word / 32768.0f);
            }
            const std::string prompt(message.begin() + 9, message.begin() + 9 + prompt_len);
            const std::string language = message[5] ? std::string(message.begin() + 5, message.begin() + 7) : "auto";
            auto params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
            params.language = language.c_str();
            params.initial_prompt = prompt.empty() ? nullptr : prompt.c_str();
            params.no_context = true;
            params.print_realtime = params.print_progress = params.print_timestamps = params.print_special = false;
            params.no_timestamps = true;
            params.suppress_blank = true;
            params.temperature_inc = 0;
            // Bound work on weak or repetitive input without truncating normal short utterances.
            params.max_tokens = std::clamp(18 + static_cast<int>(samples.size() / 1500), 32, 72);
            params.n_threads = std::max(1u, std::min(config.use_gpu ? 4u : 2u, std::thread::hardware_concurrency()));
            params.audio_ctx = std::max(192, static_cast<int>(samples.size() / 320) + 72);
            params.single_segment = true;
            params.abort_callback_user_data = &cancelled;
            params.abort_callback = [](void* data) { return static_cast<std::atomic_bool*>(data)->load(); };
            if (debug) std::cerr << "Running inference for " << samples.size() << " samples.\n";
            const int result = whisper_full(ctx, params, samples.data(), static_cast<int>(samples.size()));
            std::string response = "{\"id\":" + std::to_string(job);
            if (cancelled.load()) response += ",\"issue\":\"cancelled\"";
            else if (result) response += ",\"issue\":\"model_load\"";
            else {
                std::string text;
                for (int i = 0; i < whisper_full_n_segments(ctx); ++i) text += whisper_full_get_segment_text(ctx, i);
                const char* lang = whisper_lang_str(whisper_full_lang_id(ctx));
                response += ",\"text\":" + quote(text) + ",\"language\":" + quote(lang ? lang : "");
            }
            const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - start).count();
            response += ",\"ms\":" + std::to_string(elapsed) + "}";
            busy.store(false);
            emit(response);
        });
    }
    cancelled.store(true);
    if (inference.joinable()) inference.join();
    whisper_free(ctx);
}
