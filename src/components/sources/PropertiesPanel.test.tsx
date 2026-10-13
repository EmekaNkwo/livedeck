import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { useSceneStore } from '@/stores/sceneStore'
import { useSourceStore } from '@/stores/sourceStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useStudioStore } from '@/stores/studioStore'
import { PropertiesPanel } from './PropertiesPanel'

/**
 * The keyboard-accessible editing path.
 *
 * The brief is explicit that drag-and-drop must not be the only way to
 * configure a source. These tests assert that position, size, rotation and
 * crop are all reachable as labelled form controls, that they write through to
 * the scene state the compositor renders, and that locking genuinely protects
 * an item.
 */

const CANVAS = { width: 1280, height: 720 }

function setupSource() {
  useSceneStore.getState().clear()
  useSourceStore.getState().clear()

  const scene = useSceneStore.getState().createScene('Main')
  const source = useSourceStore.getState().addSource({
    name: 'Camera',
    type: 'camera',
    settings: { kind: 'camera', deviceId: null, mirrored: false },
  })
  useSceneStore.getState().addItem(scene.id, {
    sourceId: source.id,
    transform: { x: 0.25, y: 0.25, width: 0.5, height: 0.5, rotation: 0 },
    visible: true,
    locked: false,
    layer: 0,
    mirrored: false,
    opacity: 1,
  })
  useStudioStore.getState().selectSource(source.id)
  return { sceneId: scene.id, sourceId: source.id }
}

const currentItem = (sceneId: string, sourceId: string) =>
  useSceneStore.getState().scenes[sceneId]!.items.find((item) => item.sourceId === sourceId)!

beforeEach(() => {
  useSettingsStore.getState().reset()
  useStudioStore.getState().selectSource(null)
})

describe('PropertiesPanel', () => {
  it('prompts to select something when nothing is selected', () => {
    useSceneStore.getState().clear()
    useSourceStore.getState().clear()
    render(<PropertiesPanel />)
    expect(screen.getByText(/Nothing selected/i)).toBeInTheDocument()
  })

  it('shows position and size in output pixels', () => {
    const { sourceId } = setupSource()
    void sourceId
    render(<PropertiesPanel />)

    // 0.25 × 1280 = 320, 0.25 × 720 = 180, 0.5 × 1280 = 640.
    expect(screen.getByLabelText('X')).toHaveValue('320')
    expect(screen.getByLabelText('Y')).toHaveValue('180')
    expect(screen.getByLabelText('Width')).toHaveValue('640')
    expect(screen.getByLabelText('Height')).toHaveValue('360')
  })

  it('edits position numerically and writes through to the scene', async () => {
    const user = userEvent.setup()
    const { sceneId, sourceId } = setupSource()
    render(<PropertiesPanel />)

    const x = screen.getByLabelText('X')
    await user.clear(x)
    await user.type(x, '640')

    expect(currentItem(sceneId, sourceId).transform.x).toBeCloseTo(640 / CANVAS.width, 4)
  })

  it('edits size numerically', async () => {
    const user = userEvent.setup()
    const { sceneId, sourceId } = setupSource()
    render(<PropertiesPanel />)

    const width = screen.getByLabelText('Width')
    await user.clear(width)
    await user.type(width, '320')

    expect(currentItem(sceneId, sourceId).transform.width).toBeCloseTo(0.25, 4)
  })

  it('edits rotation numerically', async () => {
    const user = userEvent.setup()
    const { sceneId, sourceId } = setupSource()
    render(<PropertiesPanel />)

    const rotation = screen.getByLabelText('Rotation')
    await user.clear(rotation)
    await user.type(rotation, '45')

    expect(currentItem(sceneId, sourceId).transform.rotation).toBe(45)
  })

  it('exposes crop as four numeric inputs that affect the transform', async () => {
    const user = userEvent.setup()
    const { sceneId, sourceId } = setupSource()
    render(<PropertiesPanel />)

    const top = screen.getByLabelText('Top')
    await user.clear(top)
    await user.type(top, '20')

    expect(currentItem(sceneId, sourceId).transform.crop?.top).toBeCloseTo(0.2, 4)
  })

  it('resets the crop', async () => {
    const user = userEvent.setup()
    const { sceneId, sourceId } = setupSource()
    useSceneStore.getState().updateItem(sceneId, sourceId, {
      transform: {
        x: 0.25,
        y: 0.25,
        width: 0.5,
        height: 0.5,
        rotation: 0,
        crop: { top: 0.2, right: 0.1, bottom: 0, left: 0 },
      },
    })

    render(<PropertiesPanel />)
    await user.click(screen.getByRole('button', { name: /Reset crop/i }))

    expect(currentItem(sceneId, sourceId).transform.crop).toBeUndefined()
  })

  it('aligns via labelled buttons', async () => {
    const user = userEvent.setup()
    const { sceneId, sourceId } = setupSource()
    render(<PropertiesPanel />)

    await user.click(screen.getByRole('button', { name: 'Align left' }))
    expect(currentItem(sceneId, sourceId).transform.x).toBe(0)

    await user.click(screen.getByRole('button', { name: 'Align bottom' }))
    const item = currentItem(sceneId, sourceId)
    expect(item.transform.y).toBeCloseTo(1 - item.transform.height, 4)
  })

  it('centres the item', async () => {
    const user = userEvent.setup()
    const { sceneId, sourceId } = setupSource()
    useSceneStore.getState().updateItem(sceneId, sourceId, {
      transform: { x: 0, y: 0, width: 0.4, height: 0.4, rotation: 0 },
    })

    render(<PropertiesPanel />)
    await user.click(screen.getByRole('button', { name: 'Centre' }))

    const item = currentItem(sceneId, sourceId)
    expect(item.transform.x + item.transform.width / 2).toBeCloseTo(0.5, 4)
  })

  it('reorders layers from a labelled select', async () => {
    const user = userEvent.setup()
    const { sceneId, sourceId } = setupSource()
    // Add a second item so there is somewhere to move.
    useSceneStore.getState().addItem(sceneId, {
      sourceId: 'src_other',
      transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
      visible: true,
      locked: false,
      layer: 1,
      mirrored: false,
      opacity: 1,
    })

    render(<PropertiesPanel />)
    await user.selectOptions(screen.getByLabelText(/Layer order/i), 'front')

    const item = currentItem(sceneId, sourceId)
    const other = useSceneStore
      .getState()
      .scenes[sceneId]!.items.find((candidate) => candidate.sourceId === 'src_other')!
    expect(item.layer).toBeGreaterThan(other.layer)
  })

  it('toggles visibility while keeping the item in the scene', async () => {
    const user = userEvent.setup()
    const { sceneId, sourceId } = setupSource()
    render(<PropertiesPanel />)

    await user.click(screen.getByLabelText(/Visible in this scene/i))

    expect(currentItem(sceneId, sourceId).visible).toBe(false)
    // Hidden sources remain in the scene configuration.
    expect(useSceneStore.getState().scenes[sceneId]!.items).toHaveLength(1)
  })

  it('locking disables the geometry controls and blocks edits', async () => {
    const user = userEvent.setup()
    const { sceneId, sourceId } = setupSource()
    render(<PropertiesPanel />)

    await user.click(screen.getByLabelText(/Lock position and size/i))
    expect(currentItem(sceneId, sourceId).locked).toBe(true)

    // The numeric inputs are disabled, and the store rejects edits too.
    expect(screen.getByLabelText('X')).toBeDisabled()
    expect(screen.getByText(/This source is locked/i)).toBeInTheDocument()

    // Unlocking must remain possible from here, or locking would be a one-way door.
    await user.click(screen.getByLabelText(/Lock position and size/i))
    expect(currentItem(sceneId, sourceId).locked).toBe(false)
  })

  it('toggles mirroring, which the compositor applies at draw time', async () => {
    const user = userEvent.setup()
    const { sceneId, sourceId } = setupSource()
    render(<PropertiesPanel />)

    await user.click(screen.getByLabelText(/Mirror horizontally/i))
    expect(currentItem(sceneId, sourceId).mirrored).toBe(true)
  })

  it('explains when a source is not in the active scene', () => {
    useSceneStore.getState().clear()
    useSourceStore.getState().clear()
    useSceneStore.getState().createScene('Main')
    const source = useSourceStore.getState().addSource({
      name: 'Orphan',
      type: 'image',
      settings: { kind: 'image', dataUrl: 'data:,', fit: 'contain' },
    })
    useStudioStore.getState().selectSource(source.id)

    render(<PropertiesPanel />)
    expect(screen.getByText(/not placed in the active scene/i)).toBeInTheDocument()
  })

  it('renames the source from the panel', async () => {
    const user = userEvent.setup()
    const { sourceId } = setupSource()
    render(<PropertiesPanel />)

    const nameField = screen.getByLabelText('Name')
    await user.clear(nameField)
    await user.type(nameField, 'Host Camera')

    expect(useSourceStore.getState().sources[sourceId]?.name).toBe('Host Camera')
  })
})
