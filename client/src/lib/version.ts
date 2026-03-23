export interface VersionMetadata {
  version: string;
  releasedAt?: string;
}

const runtimeEnv = (import.meta as ImportMeta & {
  env?: {
    VITE_APP_VERSION?: string;
    BASE_URL?: string;
  };
}).env;

export const APP_VERSION = runtimeEnv?.VITE_APP_VERSION ?? 'dev';

function normalizeVersion(version: unknown): string | null {
  if (typeof version !== 'string') {
    return null;
  }

  const normalized = version.trim();
  return normalized ? normalized : null;
}

export function isUpdateAvailable(currentVersion: string, latestVersion: string | null): boolean {
  const normalizedCurrent = normalizeVersion(currentVersion);
  const normalizedLatest = normalizeVersion(latestVersion);

  if (!normalizedCurrent || !normalizedLatest) {
    return false;
  }

  return normalizedCurrent !== normalizedLatest;
}

export async function fetchLatestVersion(
  fetcher: typeof fetch = fetch,
  baseUrl: string = runtimeEnv?.BASE_URL ?? '/',
): Promise<VersionMetadata | null> {
  try {
    const versionUrl = `${baseUrl}version.json?ts=${Date.now()}`;
    const response = await fetcher(versionUrl, { cache: 'no-store' });

    if (!response.ok) {
      return null;
    }

    const payload = await response.json() as Partial<VersionMetadata>;
    const parsedVersion = normalizeVersion(payload.version);

    if (!parsedVersion) {
      return null;
    }

    return {
      version: parsedVersion,
      releasedAt: typeof payload.releasedAt === 'string' ? payload.releasedAt : undefined,
    };
  } catch {
    return null;
  }
}
