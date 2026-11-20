export const ERROR_TEXT = {
  config: '请检查当前模式、语言和模型设置。',
  denied: 'Chrome 未授予访问此页面或模型下载域名的权限。',
  capture: 'Chrome 无法继续捕获标签页音频。请在视频标签页重新点击开始。',
  unsupported: '没有检测到可访问的 HTML5 播放器。请在播放视频的页面打开扩展。',
  host_missing: 'Chrome 无法启动 HoriSub 本机引擎。请运行安装或修复，并检查扩展 ID。',
  host_version: '本机引擎协议或安装文件不兼容。请运行当前版本的安装器。',
  engine_exit: '本机或浏览器推理进程已断开。',
  model_missing: '所选模型尚未准备。请到设置下载当前模式所需的模型。',
  model_corrupt: '模型校验失败。请在设置中修复或重新下载。',
  model_load: '模型加载或执行失败。请校验模型，或选择较小模型和 CPU 模式。',
  download: '模型资源下载失败。请检查网络后重试。',
  disk: '可用磁盘空间不足，模型无法准备。',
  language: '当前翻译模型不覆盖该语言对。请选择多语言模型或手动指定正确的源语言。',
  timeout: '推理操作超时。可改用较轻的模型。',
  busy: '处理速度暂时跟不上，正在跳过较旧的片段。',
  slow: '本地推理速度低于语音更新节奏。已降低预览频率。',
  cancelled: '操作已取消。',
  inference: '本地模型未返回可用结果。',
  protocol: '本机引擎的响应格式与扩展协议不一致。',
  no_voice: 'Chrome 未检测到已安装的离线中文声音。请在系统设置下载中文朗读声音。',
} as const;
export type IssueCode = keyof typeof ERROR_TEXT;
export interface Issue { code: IssueCode; text: string; retry: boolean }

export class ServiceError extends Error {
  readonly issue: Issue;
  constructor(code: IssueCode, text: string = ERROR_TEXT[code]) {
    super(text);
    this.issue = { code, text, retry: ['engine_exit', 'busy', 'timeout', 'inference'].includes(code) };
  }
}
export function issueFrom(error: unknown, fallback: IssueCode = 'inference'): Issue {
  return error instanceof ServiceError ? error.issue : new ServiceError(fallback).issue;
}
