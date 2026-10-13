import type { NormalizedRect, Size } from '@/types/geometry'

export type GuideOrientation = 'vertical' | 'horizontal'

export type SnapGuide = {
  orientation: GuideOrientation
  /** Normalized position along the perpendicular axis. */
  position: number
  kind: 'canvas-edge' | 'canvas-center' | 'item-edge' | 'item-center'
}

export type SnapResult = {
  rect: NormalizedRect
  guides: SnapGuide[]
}

type Candidate = { position: number; kind: SnapGuide['kind'] }

/**
 * Snap a dragged rect to canvas edges, canvas centre, and the edges/centres of
 * other items.
 *
 * The threshold is given in *screen pixels* and converted into normalized
 * units per axis, so snapping feels the same regardless of zoom or of the
 * canvas aspect ratio.
 */
export function snapRect(
  rect: NormalizedRect,
  others: NormalizedRect[],
  viewport: Size,
  thresholdPx: number,
): SnapResult {
  if (thresholdPx <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return { rect, guides: [] }
  }
  const thresholdX = thresholdPx / viewport.width
  const thresholdY = thresholdPx / viewport.height

  const xCandidates: Candidate[] = [
    { position: 0, kind: 'canvas-edge' },
    { position: 1, kind: 'canvas-edge' },
    { position: 0.5, kind: 'canvas-center' },
  ]
  const yCandidates: Candidate[] = [
    { position: 0, kind: 'canvas-edge' },
    { position: 1, kind: 'canvas-edge' },
    { position: 0.5, kind: 'canvas-center' },
  ]
  for (const other of others) {
    xCandidates.push(
      { position: other.x, kind: 'item-edge' },
      { position: other.x + other.width, kind: 'item-edge' },
      { position: other.x + other.width / 2, kind: 'item-center' },
    )
    yCandidates.push(
      { position: other.y, kind: 'item-edge' },
      { position: other.y + other.height, kind: 'item-edge' },
      { position: other.y + other.height / 2, kind: 'item-center' },
    )
  }

  const guides: SnapGuide[] = []
  // The three points on the moving rect that may latch onto a candidate.
  const xEdges = [rect.x, rect.x + rect.width / 2, rect.x + rect.width]
  const yEdges = [rect.y, rect.y + rect.height / 2, rect.y + rect.height]

  const bestX = findSnap(xEdges, xCandidates, thresholdX)
  const bestY = findSnap(yEdges, yCandidates, thresholdY)

  let x = rect.x
  let y = rect.y
  if (bestX) {
    x = rect.x + bestX.delta
    guides.push({ orientation: 'vertical', position: bestX.candidate.position, kind: bestX.candidate.kind })
  }
  if (bestY) {
    y = rect.y + bestY.delta
    guides.push({ orientation: 'horizontal', position: bestY.candidate.position, kind: bestY.candidate.kind })
  }

  return { rect: { ...rect, x, y }, guides }
}

type Snap = { delta: number; candidate: Candidate }

function findSnap(edges: number[], candidates: Candidate[], threshold: number): Snap | null {
  let best: Snap | null = null
  for (const edge of edges) {
    for (const candidate of candidates) {
      const delta = candidate.position - edge
      const distance = Math.abs(delta)
      if (distance > threshold) continue
      if (!best || distance < Math.abs(best.delta)) {
        best = { delta, candidate }
      }
    }
  }
  return best
}
