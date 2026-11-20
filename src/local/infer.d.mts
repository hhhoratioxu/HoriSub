export function configureInference(options: {root?: string; cache?: Cache; base?: string}): void;
export class LocalInference {
  device: string;
  constructor(catalog: unknown, device: string);
  prepare(key: string): Promise<{backend: string}>;
  recognize(job: {model: string; audio: Float32Array; source: string}): Promise<{text: string; language: string; backend: string}>;
  translate(job: {model: string; text: string; source: string; target: string; glossary: string; context: string[]}):
    Promise<{text: string; backend: string}>;
  dispose(): Promise<void>;
}
