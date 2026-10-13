import { VideoTile, type VideoTileProps } from '@/components/guests/VideoTile'

/**
 * The call layout: everyone in one grid, with an optional featured cell.
 *
 * WHY A SINGLE GRID
 * -----------------
 * This replaced a stage-plus-strip arrangement, where the director's program
 * was the whole view and every participant was demoted to a small tile pinned
 * to an edge. With a director whose program happened to be empty — no camera
 * started, so a black canvas — the result was a screen that was almost
 * entirely black rectangle, with the two people in the call tucked into the
 * bottom corners. The layout was describing the *roles* rather than what was
 * worth looking at.
 *
 * So: one grid, everybody in it, and one cell allowed to be bigger when
 * something genuinely deserves the room.
 *
 * A shared screen is not in here at all — it gets its own region above the
 * grid (`SharedScreenView`), because a screen is a different kind of thing
 * from a face and should not resize everybody else when it starts and stops.
 *
 * SIZING
 * ------
 * Columns come from the tile count rather than being fixed, so two people get
 * half the width each instead of a strip, and nine do not end up in a single
 * column. `grid-auto-rows: 1fr` makes rows share the height evenly — without
 * it, rows size to content and a grid of 16:9 tiles leaves a band of dead
 * space under the last row.
 */

export type CallTile = VideoTileProps & {
  key: string
}

/**
 * Columns for an un-featured grid.
 *
 * Roughly square, which keeps tiles as large as possible for a given count —
 * four people in a 2×2 beats four in a row, because each cell is then limited
 * by width *and* height rather than width alone.
 */
function columnsFor(count: number): number {
  if (count <= 1) return 1
  if (count <= 4) return 2
  if (count <= 9) return 3
  return 4
}

export function CallGrid({
  tiles,
  compact,
}: {
  tiles: CallTile[]
  /**
   * Yield most of the height to something above — a shared screen.
   *
   * A strip rather than a squashed grid: faces stay a readable size and the
   * row scrolls sideways instead of every tile shrinking as the room grows.
   */
  compact?: boolean
}) {
  if (compact) {
    return (
      <div className="flex shrink-0 gap-2 overflow-x-auto pb-1">
        {tiles.map((tile) => (
          <VideoTile
            {...tile}
            key={tile.key}
            className="aspect-video h-24 shrink-0 sm:h-28"
          />
        ))}
      </div>
    )
  }

  return (
    <div
      className="grid min-h-0 flex-1 gap-2"
      style={{
        gridTemplateColumns: `repeat(${columnsFor(tiles.length)}, minmax(0, 1fr))`,
        // Even rows. `auto` would size each row to its content and leave the
        // grid short of the space it was given.
        gridAutoRows: 'minmax(0, 1fr)',
      }}
    >
      {tiles.map((tile) => (
        <VideoTile {...tile} key={tile.key} className="min-h-0" />
      ))}
    </div>
  )
}
