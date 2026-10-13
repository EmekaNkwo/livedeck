import { Lock } from 'lucide-react'
import { useMemo } from 'react'
import type { Size } from '@/types/geometry'
import type { SceneItem } from '@/types/source'
import type { SnapGuide } from '@/utils/snapping'
import type { CropHandleId, HandleId } from '@/services/composition/interaction-controller'
import { cursorForHandle, handlePlacements } from '@/services/composition/interaction-controller'
import { cn } from '@/lib/cn'

/**
 * The editor chrome layered over the program canvas.
 *
 * Deliberately a DOM layer, not drawn into the canvas: selection boxes, resize
 * handles and snap guides must never appear in the recording. Because the
 * compositor owns the canvas and this owns the overlay, that separation is
 * structural rather than something that has to be remembered.
 *
 * The whole layer is `aria-hidden`: it is a pointer affordance, and the
 * keyboard-accessible route to the same operations is the properties panel's
 * numeric controls.
 */

export type CanvasOverlayProps = {
  items: SceneItem[]
  selectedSourceId: string | null
  viewport: Size
  guides: SnapGuide[]
  showSafeAreas: boolean
  dragging: boolean
  activeHandle: HandleId | CropHandleId | null
  /** True while cropping, which swaps the handle set. */
  cropMode: boolean
  sourceNames: Record<string, string>
  onPointerDownItem: (event: React.PointerEvent, sourceId: string) => void
  onPointerDownHandle: (
    event: React.PointerEvent,
    sourceId: string,
    handle: HandleId | CropHandleId,
  ) => void
}

export function CanvasOverlay({
  items,
  selectedSourceId,
  viewport,
  guides,
  showSafeAreas,
  dragging,
  activeHandle,
  cropMode,
  sourceNames,
  onPointerDownItem,
  onPointerDownHandle,
}: CanvasOverlayProps) {
  const ready = viewport.width > 0 && viewport.height > 0

  // Back-to-front, so the topmost item's box sits above the others.
  const ordered = useMemo(
    () => [...items].filter((item) => item.visible).sort((a, b) => a.layer - b.layer),
    [items],
  )

  const selected = ordered.find((item) => item.sourceId === selectedSourceId) ?? null

  if (!ready) return null

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      {showSafeAreas ? <SafeAreas /> : null}

      {/* Hit targets for every visible item. The background handler also
          hit-tests, but these give each item a correct cursor. */}
      {ordered.map((item) => {
        const isSelected = item.sourceId === selectedSourceId
        return (
          <div
            key={item.sourceId}
            onPointerDown={(event) => onPointerDownItem(event, item.sourceId)}
            style={boxStyle(item, viewport)}
            className={cn(
              'pointer-events-auto absolute',
              item.locked ? 'cursor-not-allowed' : 'cursor-move',
              isSelected
                ? 'ring-2 ring-accent-400'
                : 'ring-1 ring-transparent hover:ring-1 hover:ring-accent-500/40',
            )}
          >
            {/* Name tag, pinned to the top-left of the box. Hidden mid-drag so
                it does not obscure the composition being judged. */}
            {!dragging ? (
              <span
                className={cn(
                  'absolute -top-5 left-0 flex max-w-full items-center gap-1 rounded px-1 py-px',
                  'text-[10px] font-medium whitespace-nowrap',
                  isSelected ? 'bg-accent-500 text-deck-950' : 'bg-deck-900/85 text-ink-400',
                )}
              >
                {item.locked ? <Lock className="h-2.5 w-2.5 shrink-0" /> : null}
                <span className="truncate">{sourceNames[item.sourceId] ?? 'Source'}</span>
              </span>
            ) : null}
          </div>
        )
      })}

      {/* Handles for the selection. Locked items get no handles at all — the
          absence is itself the affordance. */}
      {selected && !selected.locked ? (
        cropMode ? (
          <CropHandles
            item={selected}
            viewport={viewport}
            activeHandle={activeHandle}
            onPointerDownHandle={onPointerDownHandle}
          />
        ) : (
          <TransformHandles
            item={selected}
            viewport={viewport}
            activeHandle={activeHandle}
            onPointerDownHandle={onPointerDownHandle}
          />
        )
      ) : null}

      {/* Snap guides, only while dragging. */}
      {guides.map((guide) => (
        <Guide key={`${guide.orientation}-${guide.position}-${guide.kind}`} guide={guide} />
      ))}
    </div>
  )
}

/**
 * Position a box in the overlay.
 *
 * Rotation is applied with a CSS transform about the centre, matching exactly
 * what the compositor does with `ctx.rotate`, so the box always frames the
 * rendered pixels.
 */
function boxStyle(item: SceneItem, viewport: Size): React.CSSProperties {
  return {
    left: `${item.transform.x * viewport.width}px`,
    top: `${item.transform.y * viewport.height}px`,
    width: `${item.transform.width * viewport.width}px`,
    height: `${item.transform.height * viewport.height}px`,
    transform: item.transform.rotation ? `rotate(${item.transform.rotation}deg)` : undefined,
    transformOrigin: 'center',
  }
}

function TransformHandles({
  item,
  viewport,
  activeHandle,
  onPointerDownHandle,
}: {
  item: SceneItem
  viewport: Size
  activeHandle: HandleId | CropHandleId | null
  onPointerDownHandle: CanvasOverlayProps['onPointerDownHandle']
}) {
  const placements = handlePlacements(item.transform, viewport)

  return (
    <>
      {placements.map((placement) => {
        const isRotate = placement.id === 'rotate'
        return (
          <div
            key={placement.id}
            onPointerDown={(event) => onPointerDownHandle(event, item.sourceId, placement.id)}
            style={{
              left: `${placement.x}px`,
              top: `${placement.y}px`,
              cursor: cursorForHandle(placement.id, item.transform.rotation),
            }}
            className={cn(
              'pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2',
              // Generous hit area (touch) around a small visual dot.
              'flex h-5 w-5 items-center justify-center',
              activeHandle === placement.id && 'scale-125',
            )}
          >
            <span
              className={cn(
                'block border border-deck-950 bg-accent-400 shadow',
                isRotate ? 'h-3 w-3 rounded-full' : 'h-2.5 w-2.5 rounded-[2px]',
              )}
            />
          </div>
        )
      })}
    </>
  )
}

/** Crop handles: one per edge, inset so they read as "trim", not "resize". */
function CropHandles({
  item,
  viewport,
  activeHandle,
  onPointerDownHandle,
}: {
  item: SceneItem
  viewport: Size
  activeHandle: HandleId | CropHandleId | null
  onPointerDownHandle: CanvasOverlayProps['onPointerDownHandle']
}) {
  const rect = {
    left: item.transform.x * viewport.width,
    top: item.transform.y * viewport.height,
    width: item.transform.width * viewport.width,
    height: item.transform.height * viewport.height,
  }
  const crop = item.transform.crop ?? { top: 0, right: 0, bottom: 0, left: 0 }

  // The crop handles sit on the *cropped* edges, which is where the visible
  // boundary actually is.
  const edges: Array<{ id: CropHandleId; style: React.CSSProperties; cursor: string }> = [
    {
      id: 'crop-n',
      style: {
        left: `${rect.left + rect.width / 2}px`,
        top: `${rect.top + rect.height * crop.top}px`,
      },
      cursor: 'ns-resize',
    },
    {
      id: 'crop-s',
      style: {
        left: `${rect.left + rect.width / 2}px`,
        top: `${rect.top + rect.height * (1 - crop.bottom)}px`,
      },
      cursor: 'ns-resize',
    },
    {
      id: 'crop-w',
      style: {
        left: `${rect.left + rect.width * crop.left}px`,
        top: `${rect.top + rect.height / 2}px`,
      },
      cursor: 'ew-resize',
    },
    {
      id: 'crop-e',
      style: {
        left: `${rect.left + rect.width * (1 - crop.right)}px`,
        top: `${rect.top + rect.height / 2}px`,
      },
      cursor: 'ew-resize',
    },
  ]

  return (
    <>
      <div
        style={{
          left: `${rect.left + rect.width * crop.left}px`,
          top: `${rect.top + rect.height * crop.top}px`,
          width: `${rect.width * (1 - crop.left - crop.right)}px`,
          height: `${rect.height * (1 - crop.top - crop.bottom)}px`,
          transform: item.transform.rotation
            ? `rotate(${item.transform.rotation}deg)`
            : undefined,
        }}
        className="absolute border-2 border-dashed border-warn-400"
      />
      {edges.map((edge) => (
        <div
          key={edge.id}
          onPointerDown={(event) => onPointerDownHandle(event, item.sourceId, edge.id)}
          style={{ ...edge.style, cursor: edge.cursor }}
          className={cn(
            'pointer-events-auto absolute flex h-5 w-5 -translate-x-1/2 -translate-y-1/2',
            'items-center justify-center',
            activeHandle === edge.id && 'scale-125',
          )}
        >
          <span className="block h-3 w-3 rounded-sm border border-deck-950 bg-warn-400 shadow" />
        </div>
      ))}
    </>
  )
}

function Guide({ guide }: { guide: SnapGuide }) {
  const isCenter = guide.kind === 'canvas-center' || guide.kind === 'item-center'
  const color = isCenter ? 'bg-live-400' : 'bg-accent-400'
  return guide.orientation === 'vertical' ? (
    <div
      style={{ left: `${guide.position * 100}%` }}
      className={cn('absolute inset-y-0 w-px', color)}
    />
  ) : (
    <div
      style={{ top: `${guide.position * 100}%` }}
      className={cn('absolute inset-x-0 h-px', color)}
    />
  )
}

/**
 * Title-safe (80%) and action-safe (90%) guides.
 * Standard broadcast margins — useful when a production might be shown on a
 * display that overscans.
 */
function SafeAreas() {
  return (
    <>
      <div className="absolute inset-[5%] border border-dashed border-ink-500/30" />
      <div className="absolute inset-[10%] border border-dashed border-ink-500/40" />
      <div className="absolute top-1/2 right-0 left-0 h-px bg-ink-500/15" />
      <div className="absolute top-0 bottom-0 left-1/2 w-px bg-ink-500/15" />
    </>
  )
}
