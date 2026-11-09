import type * as vscode from 'vscode';
import { relUri } from './datasetScanner';
import type { Dataset } from './dataset';
import { describeError, isNotFound, type SafeFs } from './safeFs';
import { decodeCaption } from '../shared/captions';
import type { TagOpChange } from '../shared/protocol';
import { applyTagOp, validateTagOp, type TagOp } from '../shared/tagOps';
import { TaskQueue } from '../shared/taskQueue';

export interface TagBatchResult {
  changes: TagOpChange[];
  errors: { id: string; error: string }[];
}

/**
 * Applies a tag operation to the caption files as they are on disk now. With `dryRun` only the
 * planned changes are returned; otherwise changed captions are written and the dataset refreshed.
 */
export async function runTagOp(
  ctx: { dataset: Dataset; fs: SafeFs; folder: vscode.Uri; log: vscode.LogOutputChannel },
  ids: readonly string[],
  op: TagOp,
  dryRun: boolean,
): Promise<TagBatchResult> {
  const invalid = validateTagOp(op);
  if (invalid) return { changes: [], errors: [{ id: '', error: invalid }] };
  const changes: TagOpChange[] = [];
  const errors: TagBatchResult['errors'] = [];
  const written: string[] = [];
  const q = new TaskQueue(8);
  await Promise.all(
    ids.map((id, i) =>
      q
        .add(id, i, async () => {
          if (!ctx.dataset.entries.has(id)) throw new Error('Image no longer exists');
          const rel = await ctx.dataset.captionTarget(id);
          const uri = relUri(ctx.folder, rel);
          let before: string | null = null;
          try {
            before = decodeCaption(await ctx.fs.readFile(uri));
          } catch (e) {
            if (!isNotFound(e)) throw e;
          }
          const after = applyTagOp(before, op);
          if (after === undefined) return;
          if (!dryRun) {
            await ctx.fs.writeFileAtomic(uri, new TextEncoder().encode(after));
            written.push(rel);
          }
          changes.push({ id, before, after });
        })
        .catch((e: unknown) => {
          errors.push({ id, error: describeError(e) });
          ctx.log.error(`Tag operation on ${id} failed: ${describeError(e)}`);
        }),
    ),
  );
  if (written.length) await ctx.dataset.refresh(written);
  const order = new Map(ids.map((id, i) => [id, i]));
  changes.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return { changes, errors };
}
