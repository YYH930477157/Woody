import { z } from 'zod';
import { hashSchema, revisionSchema } from '../validation';

export const operationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

const name = revisionSchema.refine((value) => !/[~^:?*[\\\s]|\.\.|@\{|\/$|^\//.test(value), 'Invalid ref name');
const remote = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
const stash = z.string().regex(/^stash@\{(?:0|[1-9][0-9]{0,5})\}$/);
/** Only native transports and filesystem URLs; never remote helpers or URL credentials. */
export const remoteUrlSchema = z
  .string()
  .min(1)
  .max(8192)
  .refine((value) => {
    if (/^[\s-]|::/.test(value) || [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
      return false;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        return (
          ['https:', 'http:', 'ssh:', 'git:', 'file:'].includes(url.protocol) &&
          !url.password &&
          (!url.username || url.protocol === 'ssh:') &&
          !url.search &&
          !url.hash
        );
      } catch {
        return false;
      }
    }
    return !/^[a-z][a-z0-9+.-]*:/i.test(value) || /^[A-Za-z]:[\\/]/.test(value) || /^[^@\s]+@[^:\s]+:.+/.test(value);
  }, 'Unsupported or credential-bearing remote URL');
const expectedHead = { expectedHead: hashSchema };
const expectedRef = { expectedRef: hashSchema };
const confirmed = { confirmed: z.literal(true) };
const message = z
  .string()
  .min(1)
  .max(1024 * 1024)
  .refine((value) => !value.includes('\0') && value.trim().length > 0);
const commits = z
  .array(hashSchema)
  .min(1)
  .max(200)
  .refine((values) => new Set(values).size === values.length);
export const operationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inspect') }).strict(),
  z
    .object({
      kind: z.literal('history.reword'),
      commit: hashSchema,
      message,
      expectedBranch: name,
      ...expectedHead,
      ...confirmed,
    })
    .strict(),
  z
    .object({
      kind: z.literal('history.squash'),
      commits: commits.refine((values) => values.length >= 2),
      message: message.optional(),
      expectedBranch: name,
      ...expectedHead,
      ...confirmed,
    })
    .strict(),
  z
    .object({
      kind: z.literal('history.fixup'),
      commits: commits.refine((values) => values.length >= 2),
      expectedBranch: name,
      ...expectedHead,
      ...confirmed,
    })
    .strict(),
  z.object({ kind: z.literal('history.drop'), commits, expectedBranch: name, ...expectedHead, ...confirmed }).strict(),
  z
    .object({ kind: z.literal('merge'), target: hashSchema, expectedBranch: name, ...expectedHead, ...confirmed })
    .strict(),
  z
    .object({ kind: z.literal('cherry-pick'), target: hashSchema, expectedBranch: name, ...expectedHead, ...confirmed })
    .strict(),
  z
    .object({ kind: z.literal('revert'), target: hashSchema, expectedBranch: name, ...expectedHead, ...confirmed })
    .strict(),
  z
    .object({ kind: z.literal('rebase'), target: hashSchema, expectedBranch: name, ...expectedHead, ...confirmed })
    .strict(),
  z
    .object({
      kind: z.literal('history.continue'),
      operation: z.enum(['merge', 'cherry-pick', 'revert', 'rebase']),
      expectedBranch: name.nullable(),
      ...expectedHead,
      ...confirmed,
    })
    .strict(),
  z
    .object({
      kind: z.literal('history.abort'),
      operation: z.enum(['merge', 'cherry-pick', 'revert', 'rebase']),
      expectedBranch: name.nullable(),
      ...expectedHead,
      ...confirmed,
    })
    .strict(),
  z.object({ kind: z.literal('branch.create'), name, startPoint: revisionSchema, ...expectedHead }).strict(),
  z.object({ kind: z.literal('branch.switch'), name, ...expectedHead }).strict(),
  z
    .object({ kind: z.literal('branch.rename'), name, newName: name, ...expectedHead, ...expectedRef, ...confirmed })
    .strict(),
  z.object({ kind: z.literal('branch.delete'), name, ...expectedHead, ...expectedRef, ...confirmed }).strict(),
  z.object({ kind: z.literal('tag.create'), name, target: revisionSchema }).strict(),
  z.object({ kind: z.literal('tag.delete'), name, ...expectedRef, ...confirmed }).strict(),
  z.object({ kind: z.literal('fetch'), remote }).strict(),
  z.object({ kind: z.literal('pull'), remote, branch: name, ...expectedHead }).strict(),
  z.object({ kind: z.literal('push'), remote, branch: name, ...expectedHead, ...confirmed }).strict(),
  z.object({ kind: z.literal('remote.list') }).strict(),
  z.object({ kind: z.literal('remote.add'), name: remote, url: remoteUrlSchema }).strict(),
  z
    .object({
      kind: z.literal('remote.setUrl'),
      name: remote,
      url: remoteUrlSchema,
      expectedUrl: remoteUrlSchema,
      ...confirmed,
    })
    .strict(),
  z.object({ kind: z.literal('remote.remove'), name: remote, expectedUrl: remoteUrlSchema, ...confirmed }).strict(),
  z.object({ kind: z.literal('worktree.list') }).strict(),
  z.object({ kind: z.literal('stash.list') }).strict(),
  z
    .object({
      kind: z.literal('stash.save'),
      message: z
        .string()
        .max(4096)
        .refine((s) => !s.includes('\0')),
      includeUntracked: z.boolean(),
      ...expectedHead,
    })
    .strict(),
  z.object({ kind: z.literal('stash.apply'), ref: stash, ...expectedRef, ...expectedHead }).strict(),
  z.object({ kind: z.literal('stash.pop'), ref: stash, ...expectedRef, ...expectedHead, ...confirmed }).strict(),
  z.object({ kind: z.literal('stash.drop'), ref: stash, ...expectedRef, ...confirmed }).strict(),
  z.object({ kind: z.literal('stash.show'), ref: stash, ...expectedRef }).strict(),
]);
