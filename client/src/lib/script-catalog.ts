import type { RawScript } from './types';

export interface ScriptOption {
  id: string;
  title: string;
  author?: string;
  description: string;
  path: string;
}

const runtimeEnv = (import.meta as ImportMeta & {
  env?: {
    BASE_URL?: string;
  };
}).env;

export const SCRIPT_OPTIONS: readonly ScriptOption[] = [
  {
    id: 'finale-di-partita',
    title: 'Finale di partita',
    author: 'Samuel Beckett',
    description: 'The default rehearsal text.',
    path: 'script.json',
  },
  {
    id: 'processo-al-potere',
    title: 'Processo al Potere',
    description: 'Courtroom ensemble text imported from the PDF.',
    path: 'scripts/processo-al-potere.json',
  },
] as const;

export const DEFAULT_SCRIPT_ID = SCRIPT_OPTIONS[0].id;

export function getScriptOptionById(scriptId: unknown): ScriptOption {
  if (typeof scriptId !== 'string') {
    return SCRIPT_OPTIONS[0];
  }

  return SCRIPT_OPTIONS.find((option) => option.id === scriptId) ?? SCRIPT_OPTIONS[0];
}

export function buildScriptAssetUrl(
  option: ScriptOption,
  baseUrl: string = runtimeEnv?.BASE_URL ?? '/',
): string {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return `${normalizedBaseUrl}${option.path}`;
}

export async function fetchRawScript(
  option: ScriptOption,
  fetcher: typeof fetch = fetch,
  baseUrl?: string,
): Promise<RawScript> {
  const response = await fetcher(buildScriptAssetUrl(option, baseUrl));
  if (!response.ok) {
    throw new Error(`Failed to load ${option.title}`);
  }

  return (await response.json()) as RawScript;
}
