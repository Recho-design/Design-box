import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readAppConfig, validateProxyPrefs, writeAppConfig } from '../src/app-config.js';
import {
  proxyEnvFromPrefs,
  spawnEnvForAgent,
} from '../src/runtimes/env.js';
import {
  applyProxyEnvKeys,
  applyProxyPrefsToProcess,
  snapshotInheritedProxyEnv,
  type ProxyEnvSnapshot,
} from '../src/services/proxy-apply.js';

const VALID_PROXY: { enabled: boolean; url: string; noProxy?: string } = {
  enabled: true,
  url: 'http://127.0.0.1:7890',
};

describe('validateProxyPrefs', () => {
  it('接受 enabled=true 的 http(s) 代理并将 url 收敛为 trim 后的值', () => {
    expect(validateProxyPrefs({ ...VALID_PROXY, url: '  http://127.0.0.1:7890  ' })).toEqual(VALID_PROXY);
    expect(validateProxyPrefs({ ...VALID_PROXY, url: 'https://proxy.example.com:8443' })).toEqual({
      ...VALID_PROXY,
      url: 'https://proxy.example.com:8443',
    });
  });

  it('接受可选 noProxy 并丢弃空值', () => {
    expect(validateProxyPrefs({ ...VALID_PROXY, noProxy: ' localhost, .internal ' })).toEqual({
      ...VALID_PROXY,
      noProxy: 'localhost, .internal',
    });
    const withoutNoProxy = validateProxyPrefs({ ...VALID_PROXY, noProxy: '' });
    expect(withoutNoProxy).toEqual(VALID_PROXY);
  });

  it('enabled=false 时 url 只要求非空，不要求 http(s) 前缀', () => {
    expect(validateProxyPrefs({ enabled: false, url: 'socks5://127.0.0.1:1080' })).toEqual({
      enabled: false,
      url: 'socks5://127.0.0.1:1080',
    });
  });

  it('拒绝非对象、enabled 非 boolean、url 为空、enabled=true 且非 http(s) 的 url', () => {
    expect(validateProxyPrefs(null)).toBeUndefined();
    expect(validateProxyPrefs('http://127.0.0.1:7890')).toBeUndefined();
    expect(validateProxyPrefs(['a'])).toBeUndefined();
    expect(validateProxyPrefs({ enabled: 'true', url: 'http://127.0.0.1:7890' })).toBeUndefined();
    expect(validateProxyPrefs({ enabled: true })).toBeUndefined();
    expect(validateProxyPrefs({ enabled: true, url: '  ' })).toBeUndefined();
    expect(validateProxyPrefs({ enabled: true, url: 'ftp://127.0.0.1:21' })).toBeUndefined();
    expect(validateProxyPrefs({ enabled: true, url: '127.0.0.1:7890' })).toBeUndefined();
  });
});

describe('app-config 里的 proxyPrefs 键', () => {
  it('writeAppConfig 落盘合法的 proxyPrefs，丢弃整体非法的值', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'od-app-config-proxy-'));
    try {
      await writeAppConfig(dataDir, { proxyPrefs: { enabled: true, url: 'http://127.0.0.1:7890', noProxy: 'localhost' } });
      let config = await readAppConfig(dataDir);
      expect(config.proxyPrefs).toEqual({ enabled: true, url: 'http://127.0.0.1:7890', noProxy: 'localhost' });

      // 非法值（enabled=true 且非 http(s) URL）整体丢弃。
      await writeAppConfig(dataDir, { proxyPrefs: { enabled: true, url: '127.0.0.1:7890' } });
      config = await readAppConfig(dataDir);
      expect(config.proxyPrefs).toBeUndefined();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe('proxyEnvFromPrefs', () => {
  it('enabled=true 时注入 canonical 代理键', () => {
    expect(proxyEnvFromPrefs(VALID_PROXY)).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      ALL_PROXY: 'http://127.0.0.1:7890',
      NODE_USE_ENV_PROXY: '1',
    });
    expect(proxyEnvFromPrefs({ ...VALID_PROXY, noProxy: 'localhost,.internal' })).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      ALL_PROXY: 'http://127.0.0.1:7890',
      NODE_USE_ENV_PROXY: '1',
      NO_PROXY: 'localhost,.internal',
    });
  });

  it('disabled、缺省或 url 非法时完全不注入', () => {
    expect(proxyEnvFromPrefs(undefined)).toEqual({});
    expect(proxyEnvFromPrefs({ enabled: false, url: 'http://127.0.0.1:7890' })).toEqual({});
    expect(proxyEnvFromPrefs({ enabled: true, url: 'socks5://127.0.0.1:1080' })).toEqual({});
    expect(proxyEnvFromPrefs({ enabled: true, url: '  ' })).toEqual({});
  });
});

describe('spawnEnvForAgent 的代理 env 优先级', () => {
  it('userProxyEnv 优先于 baseEnv 与 systemProxyEnv', () => {
    const env = spawnEnvForAgent(
      'claude',
      { PATH: '/bin', HTTP_PROXY: 'http://base:1' },
      {},
      { HTTP_PROXY: 'http://system:0' },
      {},
      proxyEnvFromPrefs(VALID_PROXY),
    );
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7890');
    expect(env.NODE_USE_ENV_PROXY).toBe('1');
  });

  it('baseEnv 优先于 systemProxyEnv（无 userProxyEnv 时）', () => {
    const env = spawnEnvForAgent(
      'claude',
      { PATH: '/bin', HTTP_PROXY: 'http://base:1' },
      {},
      { HTTP_PROXY: 'http://system:0' },
    );
    expect(env.HTTP_PROXY).toBe('http://base:1');
  });

  it('userProxyEnv 缺省时行为与未配置全局代理完全一致', () => {
    const env = spawnEnvForAgent(
      'claude',
      { PATH: '/bin', HTTP_PROXY: 'http://base:1' },
      {},
      {},
    );
    expect(env.HTTP_PROXY).toBe('http://base:1');
  });
});

describe('proxy-apply 的应用 / 恢复 / 删除语义', () => {
  const snapshot: ProxyEnvSnapshot = {
    entries: new Map([
      ['http_proxy', { key: 'http_proxy', value: 'http://inherited:8080' }],
    ]),
  };

  it('enabled 时写入期望键（大小写变体清干净）', () => {
    const env: Record<string, string | undefined> = {
      http_proxy: 'http://old:1',
      OTHER: 'keep',
    };
    applyProxyEnvKeys(env, proxyEnvFromPrefs(VALID_PROXY), snapshot);
    expect(env.OTHER).toBe('keep');
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7890');
    expect(env.https_proxy).toBeUndefined();
    expect(env.NODE_USE_ENV_PROXY).toBe('1');
  });

  it('disabled 时恢复快照值，快照没有的键删除，不粗暴清空', () => {
    const env: Record<string, string | undefined> = {
      HTTP_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: 'localhost',
      NODE_USE_ENV_PROXY: '1',
      OTHER: 'keep',
    };
    applyProxyEnvKeys(env, {}, snapshot);
    // 快照里原有的小写 http_proxy 以原始键名/值恢复。
    expect(env.http_proxy).toBe('http://inherited:8080');
    // 快照里没有的键：NO_PROXY / NODE_USE_ENV_PROXY 删除。
    expect(env.NO_PROXY).toBeUndefined();
    expect(env.NODE_USE_ENV_PROXY).toBeUndefined();
    expect(env.OTHER).toBe('keep');
  });

  it('applyProxyPrefsToProcess 沿用启动快照作用于 process.env', () => {
    const probeValue = 'http://od-probe-inherited:1';
    const originalHttp = process.env.HTTP_PROXY;
    const originalNoProxy = process.env.NO_PROXY;
    try {
      // 控制快照内容：HTTP_PROXY 有值、NO_PROXY 无值。
      process.env.HTTP_PROXY = probeValue;
      delete process.env.NO_PROXY;
      snapshotInheritedProxyEnv();

      applyProxyPrefsToProcess(VALID_PROXY);
      expect(process.env.HTTP_PROXY).toBe('http://127.0.0.1:7890');
      expect(process.env.NO_PROXY).toBeUndefined();

      applyProxyPrefsToProcess({ enabled: false, url: VALID_PROXY.url });
      // 恢复快照值；快照里没有的键（NO_PROXY）删除而非清空其他键。
      expect(process.env.HTTP_PROXY).toBe(probeValue);
      expect(process.env.NO_PROXY).toBeUndefined();
    } finally {
      if (originalHttp === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = originalHttp;
      if (originalNoProxy === undefined) delete process.env.NO_PROXY;
      else process.env.NO_PROXY = originalNoProxy;
    }
  });
});
