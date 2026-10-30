/**
 * Adapted from IdeaGitTool src/git/logStream.ts and repository.ts (upstream declares Apache-2.0).
 * Source commit: 8bd81d26dbb2997d021465f16fec6fc3656c3f38.
 * Host dependencies removed; see resources/third-party/ideagittool.
 */
import type {
  GitBlameLine,
  GitCommitFile,
  GitHistoryCommit,
  GitWorkbenchRef,
} from '@/common/types/sourceControl/workbenchTypes';

export const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%D', '%s'].join('%x00') + '%x01';

export function parseHistory(output: string): GitHistoryCommit[] {
  return output.split('\x01').flatMap((record) => {
    const fields = record.replace(/^\r?\n/, '').split('\0');
    if (fields.length < 10) return [];
    const refs = fields[8]
      .split(', ')
      .filter(Boolean)
      .flatMap((ref) => {
        if (ref.startsWith('HEAD -> ')) return ['HEAD', ref.slice(8)];
        return [ref.replace(/^tag: /, '')];
      });
    return [
      {
        hash: fields[0],
        parents: fields[1] ? fields[1].split(' ') : [],
        authorName: fields[2],
        authorEmail: fields[3],
        authorDate: Number(fields[4]),
        committerName: fields[5],
        committerEmail: fields[6],
        commitDate: Number(fields[7]),
        refs,
        subject: fields[9],
      },
    ];
  });
}

export const REF_FORMAT = [
  '%(refname)',
  '%(objectname)',
  '%(*objectname)',
  '%(upstream:short)',
  '%(upstream:track,nobracket)',
  '%(HEAD)',
].join('%00');

export function parseRefs(output: string): GitWorkbenchRef[] {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      const [fullName, object, peeled, upstream, track, head] = line.split('\0');
      if (fullName.startsWith('refs/remotes/') && fullName.endsWith('/HEAD')) return [];
      const type = fullName.startsWith('refs/heads/')
        ? 'local'
        : fullName.startsWith('refs/remotes/')
          ? 'remote'
          : 'tag';
      return [
        {
          fullName,
          name: fullName.replace(/^refs\/(heads|remotes|tags)\//, ''),
          type,
          hash: peeled || object,
          objectHash: object,
          current: head === '*',
          upstream: upstream || undefined,
          ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
          behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
        },
      ];
    });
}

/** Parse NUL-delimited paths so tabs, Unicode and spaces are preserved. */
export function parseFiles(output: string): GitCommitFile[] {
  const records = output.split('\0');
  const files: GitCommitFile[] = [];
  for (let index = 0; index < records.length; ) {
    const status = records[index++].trim();
    if (!status) continue;
    const first = records[index++];
    if (first === undefined) throw new Error('Incomplete Git file record');
    if (/^[RC]/.test(status)) {
      const target = records[index++];
      if (target === undefined) throw new Error('Incomplete Git rename record');
      files.push({ status: status[0], oldPath: first, path: target });
    } else files.push({ status, path: first });
  }
  return files;
}

/** Parse line-porcelain without losing tabs or arbitrary UTF-8 content. */
export function parseBlame(output: string): GitBlameLine[] {
  const lines: GitBlameLine[] = [];
  const records = output.split('\n');
  for (let index = 0; index < records.length; ) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(records[index++] ?? '');
    if (!header) continue;
    let author: string | undefined;
    let authorTime: number | undefined;
    while (index < records.length && !records[index].startsWith('\t')) {
      const field = records[index++];
      if (field.startsWith('author ')) author = field.slice(7);
      else if (field.startsWith('author-time ')) authorTime = Number(field.slice(12));
    }
    if (index >= records.length) break;
    const content = records[index++].slice(1);
    lines.push({
      line: Number(header[2]),
      hash: header[1],
      committed: !/^0+$/.test(header[1]),
      author,
      authorTime,
      content,
    });
  }
  return lines;
}
