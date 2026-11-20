import { ERROR_TEXT, ServiceError } from '../shared/errors';
import type { IssueCode } from '../shared/errors';

export interface HostInfo { protocol: number; version: string; platform: string; engine: string; translation: string; path: string }
export interface EngineReply {
  id: number;
  value?: unknown;
  code?: string;
  event?: 'progress';
  bytes?: number;
  total?: number;
}
interface Connection {
  send(value: unknown, transfer?: Transferable[]): void;
  disconnect(): void;
  onReply(fn: (reply: EngineReply) => void, onClose: (issue?: IssueCode) => void): void;
}
interface Pending {
  resolve(value: unknown): void;
  reject(error: ServiceError): void;
  progress?(bytes: number, total: number): void;
}

function normalize(code: string): IssueCode { return Object.hasOwn(ERROR_TEXT, code) ? code as IssueCode : 'inference'; }

export class EngineRpc {
  private id = 0;
  private readonly pending = new Map<number, Pending>();
  private closed = false;

  constructor(private readonly connection: Connection) {
    connection.onReply(answer => {
      if (answer.id === 0 && answer.code) {
        this.close(normalize(answer.code));
        return;
      }
      const pending = this.pending.get(answer.id);
      if (!pending) return;
      if (answer.event === 'progress') pending.progress?.(answer.bytes ?? 0, answer.total ?? 0);
      else if (answer.code) pending.reject(new ServiceError(normalize(answer.code)));
      else pending.resolve(answer.value);
    }, code => this.close(code ?? 'engine_exit'));
  }

  notify(op: string, args?: Record<string, unknown>) {
    if (!this.closed) this.connection.send({ id: ++this.id, op, args });
  }

  call<T>(op: string, args?: Record<string, unknown>, options: {
    signal?: AbortSignal; timeout?: number; transfer?: Transferable[]; progress?: (bytes: number, total: number) => void;
  } = {}): Promise<T> {
    if (this.closed) return Promise.reject(new ServiceError('engine_exit'));
    if (this.pending.size >= 6) return Promise.reject(new ServiceError('busy'));
    if (options.signal?.aborted) return Promise.reject(new ServiceError('cancelled'));
    const id = ++this.id;
    const stop = (code: IssueCode) => {
      this.notify('cancel', { id, job: args?.job });
      this.pending.get(id)?.reject(new ServiceError(code));
    };
    const cancel = () => stop('cancelled');
    let timer: ReturnType<typeof setTimeout>;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject, progress: options.progress });
      options.signal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => stop('timeout'), options.timeout ?? 15_000);
      this.connection.send({ id, op, args }, options.transfer);
    }).finally(() => {
      clearTimeout(timer);
      this.pending.delete(id);
      options.signal?.removeEventListener('abort', cancel);
    });
  }

  close(code: IssueCode = 'cancelled') {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new ServiceError(code));
    this.pending.clear();
    this.connection.disconnect();
  }
}

export function nativeRpc(): EngineRpc {
  const port = chrome.runtime.connect({ name: 'horisub-native-v1' });
  return new EngineRpc({
    send: value => port.postMessage(value),
    disconnect: () => port.disconnect(),
    onReply(fn, onClose) {
      port.onMessage.addListener(fn);
      port.onDisconnect.addListener(() => { void chrome.runtime.lastError; onClose('engine_exit'); });
    },
  });
}

export async function probeHost(rpc: EngineRpc) {
  const info = await rpc.call<HostInfo>('hello', undefined, { timeout: 18_000 });
  if (info?.protocol !== 1) throw new ServiceError('host_version');
  return info;
}

export function browserRpc(base: string): EngineRpc {
  const worker = new Worker(base + 'language-worker.js', { type: 'module' });
  return new EngineRpc({
    send: (message, transfer) => worker.postMessage(message, transfer ?? []),
    disconnect: () => worker.terminate(),
    onReply(fn, onClose) {
      worker.onmessage = event => fn(event.data);
      worker.onerror = () => onClose('model_load');
    },
  });
}
