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
  /**
   * Give this tile most of the space.
   *
   * For a screen share or a composed program: content that is only useful
   * large, next to faces that stay readable small.
   */
  featured?: boolean
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

export function CallGrid({ tiles }: { tiles: CallTile[] }) {
  const featured = tiles.find((tile) => tile.featured)
  const rest = tiles.filter((tile) => tile !== featured)

  if (featured) {
    return (
      /*
       * Featured plus a rail.
       *
       * Stacked on a narrow screen, side by side from `lg` — a 3fr/1fr split,
       * so the featured cell gets three quarters of the width and the rail
       * stays wide enough for a face to be recognisable. The rail scrolls
       * rather than shrinking its tiles, so a tenth participant does not make
       * the other nine unreadable.
       */
      <div className="grid min-h-0 flex-1 grid-rows-[1fr_auto] gap-2 lg:grid-cols-[3fr_1fr] lg:grid-rows-1">
        <VideoTile {...featured} className="min-h-0" />
        {rest.length > 0 ? (
          <div className="flex min-h-0 gap-2 overflow-auto lg:flex-col">
            {rest.map((tile) => (
              <VideoTile
                {...tile}
                key={tile.key}
                className="aspect-video h-24 shrink-0 sm:h-28 lg:h-auto lg:w-full"
              />
            ))}
          </div>
        ) : null}
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
