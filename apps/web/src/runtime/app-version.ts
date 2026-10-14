import { useEffect, useState } from 'react';

export const APP_VERSION_PLACEHOLDER = '0.0.0';

export function isResolvedAppVersion(version: string | null | undefined): boolean {
  if (version == null) return false;
  const trimmed = version.trim();
  return trimmed.length > 0 && trimmed !== APP_VERSION_PLACEHOLDER;
}

let runtimeAppVersion: string | null = null;
let runtimeAppVersionPromise: Promise<string | null> | null = null;

async function loadRuntimeAppVersion(): Promise<string | null> {
  if (runtimeAppVersion) return runtimeAppVersion;
  if (!runtimeAppVersionPromise) {
    runtimeAppVersionPromise = (async () => {
      try {
        const res = await fetch('/api/version');
        if (!res.ok) return null;
        const body = (await res.json()) as {
          version?: { version?: string; channel?: string };
        };
        const next = body?.version?.version;
        if (!next) return null;
        runtimeAppVersion = next;
        return next;
      } catch {
        return null;
      } finally {
        if (!runtimeAppVersion) runtimeAppVersionPromise = null;
      }
    })();
  }
  return runtimeAppVersionPromise;
}

export function useAppVersion(): string {
  const [version, setVersion] = useState(APP_VERSION_PLACEHOLDER);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await loadRuntimeAppVersion();
      if (!cancelled && next) setVersion(next);
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return version;
}
