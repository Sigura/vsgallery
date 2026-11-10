import * as vscode from 'vscode';
import { GalleryPanel, type Services } from './host/galleryPanel';
import { ThumbCache } from './host/thumbCache';
import { SafeFs, describeError } from './host/safeFs';
import { ModelStore } from './host/modelStore';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('LoRA Dataset Studio', { log: true });
  const fs = new SafeFs(log);
  const cache = new ThumbCache(context.globalStorageUri, fs, log);
  await cache.init();
  const svc: Services = { context, cache, fs, log, models: new ModelStore(context.extensionUri, context.globalStorageUri, fs, log) };

  context.subscriptions.push(
    log,
    vscode.commands.registerCommand('loraDataset.openGallery', async (uri?: vscode.Uri) => {
      const folder = uri ?? (await pickFolder());
      if (folder) GalleryPanel.createOrShow(svc, folder);
    }),
    vscode.commands.registerCommand('loraDataset.openImage', (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (target) GalleryPanel.openImage(svc, target);
    }),
    vscode.commands.registerCommand('loraDataset.deleteSelected', () => GalleryPanel.deleteSelectedInActive()),
    vscode.commands.registerCommand('loraDataset.autoCaption', () => GalleryPanel.autoCaptionInActive()),
    vscode.commands.registerCommand('loraDataset.clearThumbnailCache', async () => {
      try {
        await cache.clear();
        void vscode.window.showInformationMessage('LoRA Dataset: thumbnail cache cleared.');
      } catch (e) {
        log.error(`Clearing thumbnail cache failed: ${describeError(e)}`);
        void vscode.window.showErrorMessage(`LoRA Dataset: could not clear thumbnail cache: ${describeError(e)}`);
      }
      GalleryPanel.refreshAll();
    }),
    // An image opened from the Explorer shows in the gallery's detail view.
    vscode.window.registerCustomEditorProvider('loraDataset.image', {
      openCustomDocument: (uri) => ({ uri, dispose: () => undefined }),
      // Closing this tab to hand over to a separate gallery tab makes VS Code fail with
      // "OverlayWebview has been disposed", so the tab hosts the gallery itself.
      resolveCustomEditor: (document, panel) => GalleryPanel.hostImage(svc, panel, document.uri),
    }),
    vscode.window.registerWebviewPanelSerializer(GalleryPanel.viewType, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: { folderUri?: string } | undefined) {
        if (!state?.folderUri) {
          panel.dispose();
          return;
        }
        GalleryPanel.revive(svc, panel, vscode.Uri.parse(state.folderUri));
      },
    }),
  );

  const limitMB = vscode.workspace.getConfiguration('loraDataset').get<number>('cacheSizeLimitMB', 1024);
  cache.prune(limitMB * 1024 * 1024).catch((e: unknown) => log.error(`Thumbnail cache prune failed: ${describeError(e)}`));
}

async function pickFolder(): Promise<vscode.Uri | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Open Dataset Gallery',
    defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
  });
  return picked?.[0];
}

export function deactivate(): void {}
