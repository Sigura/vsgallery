import { joinTags, parseTags, tagKey } from './captions';

export type TagOp =
  /** Renames `from` to `to`; when `to` is already present the two are merged into one. */
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'remove'; tag: string }
  /** Adds the tag at the start or end unless it is already present. */
  | { kind: 'add'; tag: string; at: 'start' | 'end' }
  /** Puts the tag first: moves it there, or inserts it when missing. */
  | { kind: 'first'; tag: string };

function clean(tag: string): string {
  return tag.replace(/\s+/g, ' ').trim();
}

/** Problem with the operation itself (empty tag, renaming a tag to itself), or undefined when it is valid. */
export function validateTagOp(op: TagOp): string | undefined {
  if (op.kind === 'rename') {
    if (!clean(op.from) || !clean(op.to)) return 'Both tags are required';
    if (op.from.includes(',') || op.to.includes(',')) return 'A tag cannot contain a comma';
    if (clean(op.from) === clean(op.to)) return 'The new name is the same as the old one';
    return undefined;
  }
  if (!clean(op.tag)) return 'The tag is required';
  if (op.tag.includes(',')) return 'A tag cannot contain a comma';
  return undefined;
}

/** Whether the operation creates a caption for an image that has no caption file. */
export function tagOpCreates(op: TagOp): boolean {
  return op.kind === 'add' || op.kind === 'first';
}

/**
 * Applies the operation to a caption. Returns the new text, or undefined when the tags do not
 * change (the file is then left untouched, whatever its formatting). `null` is a missing caption.
 */
export function applyTagOp(text: string | null, op: TagOp): string | undefined {
  if (text === null && !tagOpCreates(op)) return undefined;
  const tags = parseTags(text ?? '');
  const keys = tags.map(tagKey);
  let out: string[];
  switch (op.kind) {
    case 'rename': {
      const from = tagKey(clean(op.from));
      const to = clean(op.to);
      if (!keys.includes(from)) return undefined;
      const toKey = tagKey(to);
      const at = Math.min(keys.indexOf(from), keys.includes(toKey) ? keys.indexOf(toKey) : Infinity);
      out = [];
      tags.forEach((t, i) => {
        if (keys[i] === from || keys[i] === toKey) {
          if (i === at) out.push(to);
        } else out.push(t);
      });
      break;
    }
    case 'remove': {
      const k = tagKey(clean(op.tag));
      out = tags.filter((_, i) => keys[i] !== k);
      break;
    }
    case 'add': {
      const t = clean(op.tag);
      if (keys.includes(tagKey(t))) return undefined;
      out = op.at === 'start' ? [t, ...tags] : [...tags, t];
      break;
    }
    case 'first': {
      const t = clean(op.tag);
      const k = tagKey(t);
      const rest = tags.filter((_, i) => keys[i] !== k);
      out = [keys.includes(k) ? tags[keys.indexOf(k)] : t, ...rest];
      break;
    }
  }
  const next = joinTags(out);
  return next === joinTags(tags) ? undefined : next;
}
