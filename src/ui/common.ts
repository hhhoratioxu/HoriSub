import { ServiceError } from '../shared/errors';
import type { Reply, WorkerMessage } from '../shared/protocol';

export const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
export const input = (id: string) => element<HTMLInputElement>(id);
export const select = (id: string) => element<HTMLSelectElement>(id);
export const text = (id: string, value: string) => { element(id).textContent = value; };

export function fill(id: string, values: Record<string, string>) {
  select(id).replaceChildren(...Object.entries(values).map(([value, name]) => new Option(name, value)));
}

type UiMessage = WorkerMessage extends infer M ? M extends WorkerMessage ? Omit<M, 'target'> : never : never;
export async function send<T = void>(message: UiMessage): Promise<T> {
  const response = await chrome.runtime.sendMessage<WorkerMessage, Reply<T>>({ target: 'worker', ...message });
  if (!response?.ok) throw new ServiceError(response?.issue.code ?? 'capture', response?.issue.text);
  return response.value;
}
