import type { QualityOptions } from './quality';
import type { TagOp } from './tagOps';
import type { ExistingCaptionMode, TaggerSettings } from './tagger';

export interface ImageEntry {
  /** Posix path relative to the dataset root; unique key. */
  id: string;
  /** Posix relative directory, '' for the dataset root. */
  dir: string;
  name: string;
  size: number;
  mtime: number;
  /** 0 when not known yet or unreadable. */
  w: number;
  h: number;
  /** Thumbnail cache key (file name without extension). */
  thumb: string;
  hasThumb: boolean;
  /** Caption text; null = no caption file; absent = not loaded yet. */
  caption?: string | null;
  /** Relative path of the caption file, when one exists. */
  captionFile?: string;
  /** Perceptual hashes and blur, computed from the thumbnail; absent until analysed. */
  metrics?: ImageMetrics;
}

export interface ImageMetrics {
  dhash: string;
  phash: string;
  /** imageHash.sharpness of the 256 px grayscale image. */
  sharpness: number;
}

/** Result of a tag operation for one image: the caption before and after (null = no caption file). */
export interface TagOpChange {
  id: string;
  before: string | null;
  after: string;
}

export type SortKey = 'name' | 'mtime' | 'size' | 'resolution' | 'aspect';
export type SortDir = 'asc' | 'desc';
export type ViewMode = 'folder' | 'flat' | 'grouped';

export interface GallerySettings {
  concurrency: number;
  thumbnailSize: number;
  thumbnailResolution: number;
  minResolution: number;
  captionAutosave: boolean;
  captionAutosaveDelay: number;
  brushSizeMode: 'screen' | 'image';
  jpegQuality: number;
  undoMemoryMB: number;
  snapMultiple: number;
  editorBackup: boolean;
  tagger: TaggerSettings;
  quality: QualityOptions;
}

export interface EntryPatch {
  id: string;
  w?: number;
  h?: number;
  caption?: string | null;
}

export type HostToWebview =
  | {
      type: 'init';
      folderName: string;
      /** Dataset folder URI string, kept in webview state for panel restore. */
      folderUri: string;
      /** Dataset folder as a file system path (default for the resize output folder). */
      folderPath: string;
      /** Webview URI of the dataset root, without trailing slash. */
      imageBase: string;
      /** Webview URI of the thumbnail cache directory, without trailing slash. */
      thumbBase: string;
      settings: GallerySettings;
      entries: ImageEntry[];
      scanning: boolean;
      error?: string;
      reveal?: string;
      /** Open the revealed image in the detail view. */
      open?: boolean;
    }
  /** Incremental change: new or replaced entries, and removed ids. */
  | { type: 'delta'; upserts: ImageEntry[]; removed: string[] }
  | { type: 'patch'; patches: EntryPatch[] }
  | { type: 'status'; scanning: boolean; error?: string }
  | { type: 'thumbSaved'; id: string; key: string }
  | { type: 'settings'; settings: GallerySettings }
  | { type: 'reveal'; id: string; open?: boolean }
  | { type: 'captionSaved'; id: string; text: string; error?: string }
  | { type: 'imageSaved'; id: string; mode: 'overwrite' | 'copy'; newId?: string; error?: string }
  | { type: 'taggerModel'; requestId: number; model?: TaggerModelFiles; error?: string; cancelled?: boolean }
  | { type: 'resizeWritten'; requestId: number; id: string; error?: string }
  /** Open the auto-caption dialog (command palette). */
  | { type: 'autoCaption' }
  | { type: 'captionApplied'; requestId: number; id: string; text?: string; skipped?: boolean; error?: string }
  /** Changes of a tag operation: planned (dry run) or written. */
  | { type: 'tagOpResult'; requestId: number; applied: boolean; changes: TagOpChange[]; errors: { id: string; error: string }[] };

export interface TaggerModelFiles {
  /** Webview URIs. */
  modelUrl: string;
  tagsUrl: string;
  inputSize: number;
  /** Changes when the model files change; the webview reloads the session then. */
  version: string;
  label: string;
}

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'thumbData'; id: string; key: string; data: Uint8Array; w: number; h: number }
  | { type: 'selection'; ids: string[] }
  | { type: 'delete'; ids: string[] }
  | { type: 'saveCaption'; id: string; text: string }
  | { type: 'saveImage'; id: string; mode: 'overwrite' | 'copy'; data: Uint8Array }
  | { type: 'taggerModel'; requestId: number }
  /** Writes generated tags into the caption file, combined with its current content per `mode`. */
  | { type: 'applyCaption'; requestId: number; id: string; tags: string[]; mode: ExistingCaptionMode }
  | { type: 'writeResized'; requestId: number; id: string; data: Uint8Array; output: ResizeOutput }
  /** Analysis results to persist; `key` is the entry's thumbnail key the metrics were computed for. */
  | { type: 'metrics'; items: { id: string; key: string; metrics: ImageMetrics }[] }
  /** Runs a tag operation on the caption files on disk; with `dryRun` nothing is written. */
  | { type: 'tagOp'; requestId: number; ids: string[]; op: TagOp; dryRun: boolean }
  /** Renames dataset subfolders (relative posix paths), one after another. */
  | { type: 'renameFolders'; requestId: number; renames: { from: string; to: string }[] }
  /** Moves images with their caption files into dataset folder `dir` ('' = root). */
  | { type: 'moveImages'; ids: string[]; dir: string }
  /** Selects the image in the VS Code Explorer (Sync). */
  | { type: 'revealInExplorer'; id: string }
  | { type: 'error'; message: string };

/** Batch resize target: in place (with .bak per loraDataset.editorBackup) or a folder mirroring the dataset. */
export type ResizeOutput = { kind: 'overwrite' } | { kind: 'folder'; path: string };
