/**
 * Derived from IdeaGitTool, PGshen/vs-idea-gittool (upstream declares Apache-2.0).
 * Source commit: 8bd81d26dbb2997d021465f16fec6fc3656c3f38.
 * See resources/third-party/ideagittool for license and provenance.
 */

export interface GraphRow {
  /** Lane of the commit circle. */
  lane: number;
  color: number;
  /** Edges drawn in the row. y: 0 top, 1 middle, 2 bottom. */
  edges: GraphEdge[];
  /** Total lane count in this row, used for column width. */
  width: number;
  /** Segment id per lane at the row top / bottom boundary (-1 = free). Used by the long edge pass. */
  top?: number[];
  bottom?: number[];
}

export interface GraphEdge {
  fromLane: number;
  fromY: 0 | 1;
  toLane: number;
  toY: 1 | 2;
  color: number;
  /** Dashed edge, for an edge that goes to a commit not loaded / filtered out. */
  dashed?: boolean;
  /** Edge segment (child commit -> parent commit) this part belongs to. */
  seg?: number;
  /** Long edge stub: arrow at the middle of the row pointing down (to the parent) or up (to the child). */
  arrow?: 'down' | 'up';
  /** Hash of the commit at the other end of a long edge stub (click to jump). */
  jump?: string;
}
