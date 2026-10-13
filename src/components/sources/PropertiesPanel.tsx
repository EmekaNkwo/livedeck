import {
  AlignCenter,
  AlignEndHorizontal,
  AlignHorizontalJustifyCenter,
  AlignStartHorizontal,
  AlignVerticalJustifyCenter,
  Maximize,
  Minimize,
  MousePointer2,
  RotateCcw,
  Scan,
} from 'lucide-react'
import type { AlignEdge } from '@/utils/geometry'
import { SOURCE_TYPE_LABEL } from '@/services/sources/source-factory'
import { DEFAULT_TEXT_STYLE } from '@/services/composition/compositor'
import { useSourceTransform } from '@/hooks/useSourceTransform'
import { useMediaSources } from '@/hooks/useMediaSources'
import { useStudioSettings } from '@/hooks/useStudioSettings'
import { useSourceStore } from '@/stores/sourceStore'
import { useStudioStore } from '@/stores/studioStore'
import { Button } from '@/components/shared/Button'
import { Panel } from '@/components/shared/Panel'
import { NumberField, SelectField, SliderField, TextField, Toggle } from '@/components/shared/Field'
import { EmptyState, Notice } from '@/components/shared/Status'
import { formatPercent } from '@/utils/format'

/**
 * Numeric editing for the selected source.
 *
 * THIS IS THE ACCESSIBLE PATH
 * ---------------------------
 * Everything the pointer can do on the canvas — position, size, rotation,
 * crop, layer order, lock, visibility — is here as a labelled form control.
 * Drag-and-drop is never the only way to configure a source.
 *
 * Values are shown in output pixels because that is what an operator thinks
 * in, and converted to the normalized model on the way in and out.
 */

export function PropertiesPanel() {
  const selectedSourceId = useStudioStore((state) => state.selectedSourceId)
  const collapsed = useStudioStore((state) => state.collapsedPanels.properties)
  const togglePanel = useStudioStore((state) => state.togglePanel)

  const sources = useSourceStore((state) => state.sources)
  const source = selectedSourceId ? sources[selectedSourceId] : null

  const transform = useSourceTransform(selectedSourceId)
  const { updateSettings, renameSource } = useMediaSources()
  const { canvasSize } = useStudioSettings()

  return (
    <Panel
      title="Properties"
      badge={source ? <span className="text-[10px] text-ink-500">{source.name}</span> : null}
      collapsed={collapsed}
      onToggleCollapsed={() => togglePanel('properties')}
    >
      {!source ? (
        <EmptyState
          icon={<MousePointer2 aria-hidden="true" className="h-6 w-6" />}
          title="Nothing selected"
          description="Select a source on the canvas or in the Sources list to edit its placement."
        />
      ) : (
        <div className="flex flex-col gap-4">
          <TextField
            label="Name"
            value={source.name}
            onChange={(name) => renameSource(source.id, name)}
          />

          <p className="text-[11px] text-ink-500">{SOURCE_TYPE_LABEL[source.type]}</p>

          {!transform.item ? (
            <Notice>
              This source is not placed in the active scene, so it has no position or size here.
              Add it to the scene from the Sources list to arrange it.
            </Notice>
          ) : (
            <>
              {transform.locked ? (
                <Notice tone="warning">
                  This source is locked. Position, size, rotation and crop are read-only until you
                  unlock it below.
                </Notice>
              ) : null}

              {/* ----------------------------------------------- position */}
              <fieldset
                disabled={transform.locked}
                className="flex flex-col gap-2 disabled:opacity-60"
              >
                <legend className="mb-1 text-[11px] font-semibold tracking-wide text-ink-400 uppercase">
                  Position
                </legend>
                <div className="grid grid-cols-2 gap-2">
                  <NumberField
                    label="X"
                    unit="px"
                    value={Math.round((transform.transform?.x ?? 0) * canvasSize.width)}
                    onChange={(value) => transform.setPosition({ x: value / canvasSize.width })}
                  />
                  <NumberField
                    label="Y"
                    unit="px"
                    value={Math.round((transform.transform?.y ?? 0) * canvasSize.height)}
                    onChange={(value) => transform.setPosition({ y: value / canvasSize.height })}
                  />
                </div>

                <legend className="mt-2 mb-1 text-[11px] font-semibold tracking-wide text-ink-400 uppercase">
                  Size
                </legend>
                <div className="grid grid-cols-2 gap-2">
                  <NumberField
                    label="Width"
                    unit="px"
                    min={1}
                    value={Math.round((transform.transform?.width ?? 0) * canvasSize.width)}
                    onChange={(value) => transform.setSize({ width: value / canvasSize.width })}
                  />
                  <NumberField
                    label="Height"
                    unit="px"
                    min={1}
                    value={Math.round((transform.transform?.height ?? 0) * canvasSize.height)}
                    onChange={(value) => transform.setSize({ height: value / canvasSize.height })}
                  />
                </div>

                <legend className="mt-2 mb-1 text-[11px] font-semibold tracking-wide text-ink-400 uppercase">
                  Transform
                </legend>
                <NumberField
                  label="Rotation"
                  unit="°"
                  min={0}
                  max={359}
                  value={Math.round(transform.transform?.rotation ?? 0)}
                  onChange={transform.setRotation}
                />
                <SliderField
                  label="Opacity"
                  min={0}
                  max={1}
                  step={0.01}
                  value={transform.item.opacity}
                  valueLabel={formatPercent(transform.item.opacity)}
                  onChange={transform.setOpacity}
                />
              </fieldset>

              {/* --------------------------------------------------- crop */}
              {supportsCrop(source.type) ? (
                <fieldset
                  disabled={transform.locked}
                  className="flex flex-col gap-2 disabled:opacity-60"
                >
                  <legend className="mb-1 text-[11px] font-semibold tracking-wide text-ink-400 uppercase">
                    Crop
                  </legend>
                  <p className="-mt-1 mb-1 text-[11px] text-ink-500">
                    Percentage trimmed from each edge of the source frame. Crop affects the real
                    composition and the recording, not just the preview.
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {(['top', 'right', 'bottom', 'left'] as const).map((edge) => (
                      <NumberField
                        key={edge}
                        label={edge[0]?.toUpperCase() + edge.slice(1)}
                        unit="%"
                        min={0}
                        max={95}
                        value={Math.round(transform.crop[edge] * 100)}
                        onChange={(value) => transform.setCrop({ [edge]: value / 100 })}
                      />
                    ))}
                  </div>
                  <Button variant="ghost" size="sm" onClick={transform.resetCrop}>
                    <Scan aria-hidden="true" className="h-3.5 w-3.5" />
                    Reset crop
                  </Button>
                </fieldset>
              ) : null}

              {/* ------------------------------------------------ actions */}
              <section className="flex flex-col gap-2">
                <h3 className="text-[11px] font-semibold tracking-wide text-ink-400 uppercase">
                  Arrange
                </h3>
                <div className="grid grid-cols-3 gap-1">
                  <AlignButton
                    edge="left"
                    label="Align left"
                    icon={<AlignStartHorizontal className="h-3.5 w-3.5 rotate-90" />}
                    onAlign={transform.align}
                    disabled={transform.locked}
                  />
                  <AlignButton
                    edge="center-x"
                    label="Centre horizontally"
                    icon={<AlignHorizontalJustifyCenter className="h-3.5 w-3.5" />}
                    onAlign={transform.align}
                    disabled={transform.locked}
                  />
                  <AlignButton
                    edge="right"
                    label="Align right"
                    icon={<AlignEndHorizontal className="h-3.5 w-3.5 rotate-90" />}
                    onAlign={transform.align}
                    disabled={transform.locked}
                  />
                  <AlignButton
                    edge="top"
                    label="Align top"
                    icon={<AlignStartHorizontal className="h-3.5 w-3.5" />}
                    onAlign={transform.align}
                    disabled={transform.locked}
                  />
                  <AlignButton
                    edge="center-y"
                    label="Centre vertically"
                    icon={<AlignVerticalJustifyCenter className="h-3.5 w-3.5" />}
                    onAlign={transform.align}
                    disabled={transform.locked}
                  />
                  <AlignButton
                    edge="bottom"
                    label="Align bottom"
                    icon={<AlignEndHorizontal className="h-3.5 w-3.5" />}
                    onAlign={transform.align}
                    disabled={transform.locked}
                  />
                </div>

                <div className="grid grid-cols-2 gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={transform.locked}
                    onClick={transform.fit}
                  >
                    <Minimize aria-hidden="true" className="h-3.5 w-3.5" />
                    Fit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={transform.locked}
                    onClick={transform.fill}
                  >
                    <Maximize aria-hidden="true" className="h-3.5 w-3.5" />
                    Fill
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={transform.locked}
                    onClick={transform.center}
                  >
                    <AlignCenter aria-hidden="true" className="h-3.5 w-3.5" />
                    Centre
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={transform.locked}
                    onClick={transform.resetTransform}
                  >
                    <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
                    Reset
                  </Button>
                </div>

                <SelectField
                  label="Layer order"
                  value="keep"
                  options={[
                    { value: 'keep', label: 'Move to…' },
                    { value: 'front', label: 'Bring to front' },
                    { value: 'up', label: 'Forward one layer' },
                    { value: 'down', label: 'Backward one layer' },
                    { value: 'back', label: 'Send to back' },
                  ]}
                  disabled={transform.locked}
                  onChange={(value) => {
                    if (value === 'keep') return
                    transform.moveLayer(value as 'up' | 'down' | 'front' | 'back')
                  }}
                />
              </section>

              {/* ------------------------------------------------ options */}
              <section className="flex flex-col gap-2">
                <h3 className="text-[11px] font-semibold tracking-wide text-ink-400 uppercase">
                  Options
                </h3>
                <Toggle
                  label="Mirror horizontally"
                  checked={transform.item.mirrored}
                  disabled={transform.locked}
                  onChange={transform.setMirrored}
                />
                <Toggle
                  label="Visible in this scene"
                  hint="Hidden sources stay in the scene configuration and are excluded from the recording."
                  checked={transform.item.visible}
                  onChange={transform.setVisible}
                />
                <Toggle
                  label="Lock position and size"
                  hint="Prevents accidental dragging on the canvas."
                  checked={transform.item.locked}
                  onChange={transform.setLocked}
                />
              </section>
            </>
          )}

          {/* -------------------------------------- type-specific settings */}
          {source.settings.kind === 'text' ? (
            <section className="flex flex-col gap-2">
              <h3 className="text-[11px] font-semibold tracking-wide text-ink-400 uppercase">
                Text
              </h3>
              <TextField
                label="Content"
                value={source.settings.text}
                onChange={(text) =>
                  source.settings.kind === 'text' &&
                  updateSettings(source.id, { ...source.settings, text })
                }
              />
              <NumberField
                label="Font size"
                unit="px"
                min={8}
                max={400}
                value={source.settings.style.fontSize}
                onChange={(fontSize) =>
                  source.settings.kind === 'text' &&
                  updateSettings(source.id, {
                    ...source.settings,
                    style: { ...source.settings.style, fontSize },
                  })
                }
              />
              <SelectField
                label="Alignment"
                value={source.settings.style.align}
                options={[
                  { value: 'left', label: 'Left' },
                  { value: 'center', label: 'Centre' },
                  { value: 'right', label: 'Right' },
                ]}
                onChange={(align) =>
                  source.settings.kind === 'text' &&
                  updateSettings(source.id, {
                    ...source.settings,
                    style: { ...source.settings.style, align },
                  })
                }
              />
              <ColorInput
                label="Text colour"
                value={source.settings.style.color}
                onChange={(color) =>
                  source.settings.kind === 'text' &&
                  updateSettings(source.id, {
                    ...source.settings,
                    style: { ...source.settings.style, color },
                  })
                }
              />
              <Toggle
                label="Bold"
                checked={source.settings.style.bold}
                onChange={(bold) =>
                  source.settings.kind === 'text' &&
                  updateSettings(source.id, {
                    ...source.settings,
                    style: { ...source.settings.style, bold },
                  })
                }
              />
              <Toggle
                label="Background panel behind the text"
                checked={source.settings.style.backgroundColor !== null}
                onChange={(enabled) =>
                  source.settings.kind === 'text' &&
                  updateSettings(source.id, {
                    ...source.settings,
                    style: {
                      ...source.settings.style,
                      backgroundColor: enabled ? 'rgba(6,7,10,0.72)' : null,
                    },
                  })
                }
              />
            </section>
          ) : null}

          {source.settings.kind === 'color-background' ? (
            <ColorInput
              label="Colour"
              value={source.settings.color}
              onChange={(color) =>
                source.settings.kind === 'color-background' &&
                updateSettings(source.id, { ...source.settings, color })
              }
            />
          ) : null}

          {source.settings.kind === 'video' ? (
            <Toggle
              label="Loop playback"
              checked={source.settings.loop}
              onChange={(loop) =>
                source.settings.kind === 'video' &&
                updateSettings(source.id, { ...source.settings, loop })
              }
            />
          ) : null}

          {source.settings.kind === 'camera' ? (
            <Notice>
              Camera device, resolution and mirroring are in the Capture panel. Mirroring there
              affects the preview; the per-scene “Mirror horizontally” option above affects the
              composed output.
            </Notice>
          ) : null}
        </div>
      )}
    </Panel>
  )
}

function supportsCrop(type: string): boolean {
  return ['camera', 'screen', 'remote-video', 'image', 'video'].includes(type)
}

function AlignButton({
  edge,
  label,
  icon,
  onAlign,
  disabled,
}: {
  edge: AlignEdge
  label: string
  icon: React.ReactNode
  onAlign: (edge: AlignEdge) => void
  disabled: boolean
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={disabled}
      onClick={() => onAlign(edge)}
      aria-label={label}
      title={label}
      className="justify-center"
    >
      <span aria-hidden="true">{icon}</span>
    </Button>
  )
}

/**
 * Colour picker paired with a text input.
 * The native swatch is convenient but not keyboard-friendly for entering an
 * exact value, so both are offered and kept in sync.
 */
function ColorInput({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className="flex items-end gap-2">
      <TextField label={label} value={value} onChange={onChange} className="flex-1" />
      <input
        type="color"
        value={normalizeHex(value)}
        onChange={(event) => onChange(event.target.value)}
        aria-label={`${label} swatch`}
        className="h-8 w-10 shrink-0 cursor-pointer rounded-md border border-deck-600 bg-deck-900"
      />
    </div>
  )
}

/** `<input type="color">` only accepts `#rrggbb`. */
function normalizeHex(value: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'
}

export { DEFAULT_TEXT_STYLE }
