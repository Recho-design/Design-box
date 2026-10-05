// @vitest-environment jsdom

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { GenerateView } from '../src/components/GenerateView';
import { I18nProvider } from '../src/i18n';
import type { PlaygroundGeneration } from '@open-design/contracts';

// Mock registry functions
vi.mock('../src/providers/registry', () => ({
  invalidateProjectFilesCache: vi.fn(),
  projectFileUrl: (projectId: string, fileName: string) => `/api/projects/${projectId}/files/${fileName}`,
}));

describe('GenerateView component', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
  });

  it('renders initial view with scratch target and empty state', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/media/models')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ image: [{ id: 'model-a' }, { id: 'model-b' }] }),
        });
      }
      if (url.includes('/api/media/playground/generations')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ generations: [], nextBefore: null }),
        });
      }
      return Promise.reject(new Error(`Unhandled url: ${url}`));
    });

    render(
      <I18nProvider>
        <GenerateView />
      </I18nProvider>,
    );

    expect(screen.getByTestId('generate-view')).toBeDefined();
    await waitFor(() => {
      expect(screen.getByTestId('generate-empty-state')).toBeDefined();
    });

    const targetSelect = screen.getByTestId('generate-target-select') as HTMLSelectElement;
    expect(targetSelect.value).toBe('scratch');
  });

  it('filters out team workspace projects per D7', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/media/models')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ image: [] }),
        });
      }
      if (url.includes('/api/media/playground/generations')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ generations: [], nextBefore: null }),
        });
      }
      return Promise.reject(new Error(`Unhandled url: ${url}`));
    });

    const mockProjects: any[] = [
      { id: 'proj-local', name: 'Personal Project', workspaceVisibility: 'personal' },
      { id: 'proj-team', name: 'Team Project', workspaceVisibility: 'team' },
    ];

    render(
      <I18nProvider>
        <GenerateView projects={mockProjects} />
      </I18nProvider>,
    );

    const targetSelect = screen.getByTestId('generate-target-select') as HTMLSelectElement;
    const options = Array.from(targetSelect.options).map((o) => o.value);
    expect(options).toContain('scratch');
    expect(options).toContain('proj-local');
    expect(options).not.toContain('proj-team');
  });

  it('renders generation card and triggers optimistic rendering on submit', async () => {
    let generationsCallCount = 0;
    const mockGen: PlaygroundGeneration = {
      id: 'gen-123',
      targetProjectId: null,
      surface: 'image',
      model: 'custom-image',
      modelOverride: 'dall-e-3',
      prompt: 'A futuristic city',
      params: { aspect: '16:9', quality: 'standard', count: 1 },
      status: 'done',
      files: [{ name: 'gen-123-1.png' }],
      createdAt: 1000,
    };

    global.fetch = vi.fn().mockImplementation((url: string, opts?: any) => {
      if (url.includes('/api/media/models')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ image: [] }),
        });
      }
      if (url.includes('/api/media/playground/generations') && !opts) {
        generationsCallCount++;
        return Promise.resolve({
          ok: true,
          json: async () => ({
            generations: [mockGen],
            nextBefore: null,
          }),
        });
      }
      if (url.includes('/api/media/playground/generate')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            ...mockGen,
            id: 'gen-new-456',
            prompt: 'sunset over mountain',
          }),
        });
      }
      return Promise.reject(new Error(`Unhandled url: ${url}`));
    });

    render(
      <I18nProvider>
        <GenerateView />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('generate-card-gen-123')).toBeDefined();
    });

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'sunset over mountain' } });

    const submitBtn = screen.getByTestId('generate-submit-button');
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByTestId('generate-card-gen-new-456')).toBeDefined();
    });
  });
});
