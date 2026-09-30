import { expect, test } from '@/playwright/suite';
import {
  captureVisual,
  captureVisualTarget,
  configureVisualPage,
  gotoVisualHome,
  gotoVisualWorkspace,
  prepareVisualAvatarMenu,
  prepareVisualWorkspaceFileList,
  prepareVisualWorkspacePreview,
  openSettingsDetailsFromHeader,
  VISUAL_CLI_AGENTS,
} from '@/playwright/visual';

// The shared fixture's codex entry, reused by the reasoning-readout capture
// with reasoning options bolted on (see the comment there for why they are not
// added to `VISUAL_CLI_AGENTS` itself).
const VISUAL_CODEX_AGENT = VISUAL_CLI_AGENTS.find((agent) => agent.id === 'codex')!;
const VISUAL_CODEX_REASONING_OPTIONS = [
  { id: 'default', label: 'Default' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
] as const;

test('[P2] captures the project workspace surface', async ({ page }) => {
  await configureVisualPage(page);
  await gotoVisualHome(page);
  await gotoVisualWorkspace(page);

  await prepareVisualWorkspaceFileList(page);

  await captureVisual(page, 'visual-project-workspace');
});

test('[P1] keeps the project account action host anchored to the right edge', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await configureVisualPage(page);
  await gotoVisualHome(page);
  await gotoVisualWorkspace(page);

  const accountActionsRect = await page
    .getByTestId('workspace-chrome-account-actions')
    .evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    });
  expect(accountActionsRect.left).toBeGreaterThan(1000);
  expect(1280 - accountActionsRect.right).toBeLessThanOrEqual(24);
});

test('[P2] captures the workspace staged attachments surface', async ({ page }) => {
  await configureVisualPage(page);
  await gotoVisualHome(page);
  await gotoVisualWorkspace(page);

  await prepareVisualWorkspaceFileList(page);
  // Attachments use the composer tray; `staged-contexts` is reserved for
  // run context such as skills, MCP servers, connectors, and plugins. Keep the
  // visual witness on the surface the user actually sees after an upload.
  const uploadResponse = page.waitForResponse(
    (response) => response.url().includes('/upload') && response.request().method() === 'POST',
  );
  await page.getByTestId('chat-file-input').setInputFiles({
    name: 'visual-reference.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Visual staged-context fixture.\n', 'utf8'),
  });
  expect((await uploadResponse).ok()).toBeTruthy();

  const stagedAttachments = page.getByTestId('staged-attachments');
  await expect(stagedAttachments).toBeVisible();
  // Document cards may middle-truncate their visible basename. The full file
  // name remains the stable title contract on the card.
  await expect(stagedAttachments.getByTitle('visual-reference.txt', { exact: true })).toBeVisible();

  await captureVisual(page, 'visual-workspace-staged-attachments');
});

test('[P1] @critical captures CSS hotspot workspace, preview, and settings surfaces', async ({ page }) => {
  test.setTimeout(90_000);

  await configureVisualPage(page);
  await gotoVisualHome(page);
  await gotoVisualWorkspace(page);

  await prepareVisualWorkspaceFileList(page);
  await captureVisual(page, 'visual-critical-workspace');

  await prepareVisualWorkspacePreview(page);
  await captureVisual(page, 'visual-critical-workspace-preview');

  const dialog = await openSettingsDetailsFromHeader(page);
  // Assert the section nav, not a heading — same reason `prepareVisualSettingsDialog`
  // does: the surface's own <h2> is consumed as its accessible name via
  // aria-labelledby, and opening from a project lands on the execution section
  // whose heading reads "Models & providers", so a /Settings|General|Execution
  // mode/ probe can never match either presentation.
  await expect(dialog.getByTestId('settings-nav-execution')).toBeVisible();
  await captureVisual(page, 'visual-critical-settings');
});

test('[P2] captures the topbar execution switcher surface', async ({ page }) => {
  await configureVisualPage(page);
  await gotoVisualHome(page);

  await page.getByTestId('inline-model-switcher-chip').click();
  const popover = page.getByTestId('inline-model-switcher-popover');
  await expect(popover).toBeVisible();
  // ef9c8cd8b made the home top-bar switcher `compact` (EntryShell passes the
  // flag), which hides the mode segmented control: switching execution mode is
  // configuration and lives in Settings → Execution. What the popover keeps is
  // the active agent's model list plus the route to those settings, so assert
  // that pair. `inline-model-switcher-mode-daemon` still exists in
  // InlineModelSwitcher, but only in the non-compact shape the top bar no
  // longer mounts — pin its absence so a regression that re-mounts the console
  // here is still caught.
  await expect(popover.getByTestId('inline-model-switcher-compact-model-default')).toBeVisible();
  await expect(popover.getByTestId('inline-model-switcher-mode-daemon')).toHaveCount(0);
  await expect(popover.getByTestId('inline-model-switcher-open-settings')).toBeVisible();

  await captureVisual(page, 'visual-topbar-execution-switcher');
  await captureVisualTarget(
    page,
    'visual-topbar-execution-switcher-popover',
    page.getByTestId('inline-model-switcher-popover'),
  );
});

test('[P2] captures the avatar menu surface', async ({ page }) => {
  await configureVisualPage(page);
  await gotoVisualHome(page);
  await gotoVisualWorkspace(page);

  const menu = await prepareVisualAvatarMenu(page);

  await captureVisual(page, 'visual-avatar-menu');
  await captureVisualTarget(page, 'visual-avatar-menu-panel', menu);
});

test('[P2] captures the avatar reasoning selector surface', async ({ page }) => {
  await configureVisualPage(page, {
    // AvatarMenu only draws the reasoning row for an agent that reports
    // `reasoningOptions`, and the shared `VISUAL_CLI_AGENTS` codex entry
    // declares models only. The real daemon does report them (apps/daemon/src/
    // runtimes/defs/codex.ts), so declare them here rather than widening the
    // shared fixture that the other captures in this file share.
    agents: [
      { ...VISUAL_CODEX_AGENT, reasoningOptions: VISUAL_CODEX_REASONING_OPTIONS },
      ...VISUAL_CLI_AGENTS.filter((agent) => agent.id !== 'codex'),
    ],
    config: {
      agentId: 'codex',
      agentModels: { codex: { model: 'default', reasoning: 'default' } },
    },
  });
  await gotoVisualHome(page);
  await gotoVisualWorkspace(page);

  const menu = await prepareVisualAvatarMenu(page);
  const reasoningSelect = menu.getByRole('combobox', { name: 'Reasoning' });
  await expect(reasoningSelect).toHaveCount(1);
  await expect(reasoningSelect).toHaveValue('default');
  await expect(reasoningSelect.locator('option')).toHaveText(['Default', 'Medium', 'High']);

  await captureVisual(page, 'visual-avatar-local-agent-list');
  await captureVisualTarget(page, 'visual-avatar-local-agent-list-panel', menu);
});

test('[P2] captures the avatar local agent model list surface', async ({ page }) => {
  await configureVisualPage(page, {
    agents: VISUAL_CLI_AGENTS,
    config: {
      agentId: 'claude',
      agentModels: { claude: { model: 'default', reasoning: 'default' } },
    },
  });
  await gotoVisualHome(page);
  await gotoVisualWorkspace(page);

  const menu = await prepareVisualAvatarMenu(page);
  // Always-expanded radio list — no click-to-open dropdown, no search box.
  const modelList = menu.getByTestId('avatar-model-list');
  await expect(modelList).toBeVisible();
  await expect(modelList.getByRole('radio', { name: /Sonnet \(alias\)/i })).toBeVisible();
  await expect(modelList.locator('.avatar-model-option.is-active')).toHaveCount(1);

  await captureVisual(page, 'visual-project-avatar-model-dropdown');
  await captureVisualTarget(page, 'visual-project-avatar-model-dropdown-popover', [menu, modelList]);
});
