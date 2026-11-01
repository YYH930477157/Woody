import { describe, expect, it } from 'vitest';
import { GraphLayout, graphColor, LONG_EDGE_SIZE, visualizeRow } from '@/common/git/graph';
import type { GraphRow } from '@/common/git/graphTypes';

type Commit = { hash: string; parents: string[] };

/** A small deterministic generator, so a failure names the seed that reproduces it. */
const random = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

/** Newest first, every parent below its child: the order `git log --topo-order` gives. */
function history(seed: number, size: number, reach: number): Commit[] {
  const next = random(seed);
  const commits: Commit[] = [];
  for (let index = size - 1; index >= 0; index--) {
    const older = size - 1 - index;
    const parents: string[] = [];
    if (older > 0) {
      const pick = () => `c${index + 1 + Math.floor(next() * Math.min(older, reach))}`;
      parents.push(pick());
      if (next() < 0.25) parents.push(pick());
      if (next() < 0.03) parents.push(pick());
    }
    commits.unshift({ hash: `c${index}`, parents: [...new Set(parents)] });
  }
  return commits;
}

const layOut = (commits: Commit[], known?: Set<string>) => {
  const layout = new GraphLayout(known);
  const rows = commits.map((commit) => layout.add(commit.hash, commit.parents));
  return { rows, segments: layout.segments };
};
const lanesLeaving = (row: GraphRow) => new Set(row.edges.filter((e) => e.toY === 2).map((e) => e.toLane));
const lanesEntering = (row: GraphRow) => new Set(row.edges.filter((e) => e.fromY === 0).map((e) => e.fromLane));
const sorted = (lanes: Set<number>) => [...lanes].sort((a, b) => a - b);

const expectInsideItsWidth = (row: GraphRow, context: string) => {
  expect(row.lane, context).toBeGreaterThanOrEqual(0);
  expect(row.lane, context).toBeLessThan(row.width);
  for (const edge of row.edges) {
    for (const lane of [edge.fromLane, edge.toLane]) {
      expect(Number.isInteger(lane) && lane >= 0 && lane < row.width, `${context}: lane ${lane}`).toBe(true);
    }
  }
};

const shapes = [
  ['narrow histories', 40, 3],
  ['wide histories', 120, 12],
  ['long-running branches', 200, 90],
] as const;
const seeds = Array.from({ length: 25 }, (_, seed) => seed + 1);

describe.each(shapes)('commit graph on %s', (_name, size, reach) => {
  it.each(seeds)('keeps every line inside the row (seed %i)', (seed) => {
    layOut(history(seed, size, reach)).rows.forEach((row, index) =>
      expectInsideItsWidth(row, `seed ${seed} row ${index}`)
    );
  });

  it.each(seeds)('never breaks a line between rows (seed %i)', (seed) => {
    const { rows } = layOut(history(seed, size, reach));
    rows.slice(1).forEach((row, index) => {
      expect(sorted(lanesEntering(row)), `seed ${seed} row ${index + 1}`).toEqual(sorted(lanesLeaving(rows[index])));
    });
  });

  it.each(seeds)('ends every edge on its parent (seed %i)', (seed) => {
    const commits = history(seed, size, reach);
    const row = new Map(commits.map((commit, index) => [commit.hash, index]));
    const { segments } = layOut(commits);

    // Lines that converge on a parent share a segment, so there can be fewer segments than edges.
    for (const segment of segments) expect(segment.end, `${segment.from} -> ${segment.to}`).toBe(row.get(segment.to));
  });

  it.each(seeds)('stays drawable once long edges are hidden (seed %i)', (seed) => {
    const { rows, segments } = layOut(history(seed, size, reach));
    for (const showLongEdges of [false, true]) {
      const visible = rows.map((row, index) => visualizeRow(row, index, segments, showLongEdges));
      visible.forEach((row, index) => expectInsideItsWidth(row, `seed ${seed} row ${index}`));
    }
  });

  it.each(seeds)('joins visible lines between rows once long edges are hidden (seed %i)', (seed) => {
    const { rows, segments } = layOut(history(seed, size, reach));
    const visible = rows.map((row, index) => visualizeRow(row, index, segments, false));
    visible.slice(1).forEach((row, index) => {
      const context = `seed ${seed} row ${index + 1}`;
      expect(sorted(lanesEntering(row)), context).toEqual(sorted(lanesLeaving(visible[index])));
    });
  });
});

describe('commit graph edge cases', () => {
  it('handles a single root commit', () => {
    const [row] = layOut([{ hash: 'a', parents: [] }]).rows;

    expect(row).toMatchObject({ lane: 0, width: 1, edges: [] });
  });

  it('frees a lane when a branch reaches its root', () => {
    const { rows } = layOut([
      { hash: 'a', parents: ['c'] },
      { hash: 'b', parents: [] },
      { hash: 'c', parents: [] },
    ]);

    expect(rows.map((row) => row.lane)).toEqual([0, 1, 0]);
  });

  it('draws a merge of the same parent twice as one line', () => {
    const { rows } = layOut([
      { hash: 'a', parents: ['b', 'b'] },
      { hash: 'b', parents: [] },
    ]);

    expect(rows[1].width).toBe(1);
  });

  it('keeps working when more commits are appended later', () => {
    const commits = history(7, 60, 8);
    const whole = layOut(commits).rows;
    const paged = new GraphLayout();
    const rows = [
      ...commits.slice(0, 25).map((commit) => paged.add(commit.hash, commit.parents)),
      ...commits.slice(25).map((commit) => paged.add(commit.hash, commit.parents)),
    ];

    expect(rows).toEqual(whole);
  });

  it('dashes edges to parents outside the loaded log, and only those', () => {
    const { rows } = layOut(
      [
        { hash: 'a', parents: ['b', 'gone'] },
        { hash: 'b', parents: [] },
      ],
      new Set(['a', 'b'])
    );
    const dashed = rows[0].edges.filter((edge) => edge.dashed);

    expect(dashed).toHaveLength(1);
    expect(dashed[0].toLane).toBe(1);
  });

  it('marks a collapsed run of commits dotted', () => {
    const layout = new GraphLayout();
    const rows = [layout.add('a', ['b'])];
    layout.collapse('b', 'c');
    layout.collapse('c', 'd');
    rows.push(layout.add('d', []));

    expect(layout.segments[0]).toMatchObject({ from: 'a', to: 'd', collapsed: 2, end: 1 });
    expect(visualizeRow(rows[0], 0, layout.segments, false).edges[0].dashed).toBe(true);
  });

  it('cuts a long edge and links both ends to each other', () => {
    const commits: Commit[] = [{ hash: 'tip', parents: ['c0', 'old'] }];
    for (let index = 0; index < LONG_EDGE_SIZE + 5; index++) {
      commits.push({ hash: `c${index}`, parents: [index === LONG_EDGE_SIZE + 4 ? 'old' : `c${index + 1}`] });
    }
    commits.push({ hash: 'old', parents: [] });
    const { rows, segments } = layOut(commits);
    const visible = rows.map((row, index) => visualizeRow(row, index, segments, false));
    const jumps = visible.flatMap((row) => row.edges.flatMap((edge) => edge.jump ?? []));

    expect(jumps).toContain('old');
    expect(jumps).toContain('tip');
    expect(Math.max(...visible.slice(3, -3).map((row) => row.width))).toBe(1);
  });

  it('keeps a commit row without lane data unchanged', () => {
    const row: GraphRow = { lane: 0, color: 0, edges: [], width: 1 };

    expect(visualizeRow(row, 0, [], false)).toBe(row);
  });

  it('gives adjacent branches different valid colors', () => {
    const colors = Array.from({ length: 12 }, (_, id) => graphColor(id, 0.6, 0.7));

    for (const color of colors) {
      const channels = color
        .match(/^rgb\((\d+),(\d+),(\d+)\)$/)
        ?.slice(1)
        .map(Number);
      expect(
        channels?.every((value) => value >= 0 && value <= 255),
        color
      ).toBe(true);
    }
    colors.slice(1).forEach((color, index) => expect(color).not.toBe(colors[index]));
  });
});
