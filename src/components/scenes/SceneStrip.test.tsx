import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { useSceneStore } from '@/stores/sceneStore'
import { useSourceStore } from '@/stores/sourceStore'
import { useStudioStore } from '@/stores/studioStore'
import { SceneStrip } from './SceneStrip'

/**
 * Scene switching, through the UI.
 *
 * The assertion that matters is that selecting a scene changes the
 * *application state the compositor reads* — `activeSceneId` — rather than
 * only highlighting a card. That is the difference between a working scene
 * system and a thumbnail picker.
 */

beforeEach(() => {
  useSceneStore.getState().clear()
  useSourceStore.getState().clear()
  useStudioStore.getState().selectSource(null)
})

describe('SceneStrip', () => {
  it('renders each scene as a tab and marks the active one', () => {
    const first = useSceneStore.getState().createScene('Host')
    useSceneStore.getState().createScene('Interview')

    render(<SceneStrip />)

    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false')
    expect(useSceneStore.getState().activeSceneId).toBe(first.id)
  })

  it('changes the active scene — the value the compositor reads', async () => {
    const user = userEvent.setup()
    useSceneStore.getState().createScene('Host')
    const second = useSceneStore.getState().createScene('Split')

    render(<SceneStrip />)
    await user.click(screen.getByRole('tab', { name: /Split/ }))

    expect(useSceneStore.getState().activeSceneId).toBe(second.id)
  })

  it('creates a scene from the strip', async () => {
    const user = userEvent.setup()
    useSceneStore.getState().createScene('Host')

    render(<SceneStrip />)
    // Queried by accessible name, which stays descriptive even though the
    // visible label is abbreviated to "New".
    await user.click(screen.getByRole('button', { name: /New scene/i }))

    expect(useSceneStore.getState().order).toHaveLength(2)
  })

  it('keeps the transition controls collapsed until asked for', async () => {
    // They are set once per scene, while the vertical space they occupy is
    // taken from the program output — which the operator watches constantly.
    const user = userEvent.setup()
    useSceneStore.getState().createScene('Host')

    render(<SceneStrip />)
    expect(screen.queryByLabelText(/Transition into this scene/i)).not.toBeInTheDocument()

    const disclosure = screen.getByRole('button', { name: /Transition into this scene/i })
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')

    await user.click(disclosure)
    expect(screen.getByLabelText(/Transition into this scene/i)).toBeInTheDocument()
    expect(disclosure).toHaveAttribute('aria-expanded', 'true')
  })

  it('summarises the current transition on the collapsed disclosure', () => {
    const scene = useSceneStore.getState().createScene('Host')
    useSceneStore.getState().setTransition(scene.id, { type: 'crossfade', durationMs: 400 })

    render(<SceneStrip />)
    // Readable without expanding, so the space saving costs no information.
    expect(
      screen.getByRole('button', { name: /Transition into this scene/i }),
    ).toHaveTextContent(/crossfade.*400ms/)
  })

  it('switches scenes with arrow keys for keyboard operation', async () => {
    const user = userEvent.setup()
    useSceneStore.getState().createScene('Host')
    const second = useSceneStore.getState().createScene('Split')

    render(<SceneStrip />)
    const activeTab = screen.getByRole('tab', { selected: true })
    activeTab.focus()
    await user.keyboard('{ArrowRight}')

    expect(useSceneStore.getState().activeSceneId).toBe(second.id)
  })

  it('renames a scene without changing its id', async () => {
    const user = userEvent.setup()
    const scene = useSceneStore.getState().createScene('Before')

    render(<SceneStrip />)
    await user.click(screen.getByRole('button', { name: /Rename Before/i }))

    const input = screen.getByLabelText(/Scene name/i)
    await user.clear(input)
    await user.type(input, 'After')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    // Scenes are addressed by id, so a rename must never move the reference.
    expect(useSceneStore.getState().scenes[scene.id]?.name).toBe('After')
    expect(useSceneStore.getState().activeSceneId).toBe(scene.id)
  })

  it('duplicates a scene', async () => {
    const user = userEvent.setup()
    useSceneStore.getState().createScene('Host')

    render(<SceneStrip />)
    await user.click(screen.getByRole('button', { name: /Duplicate Host/i }))

    expect(useSceneStore.getState().order).toHaveLength(2)
    expect(screen.getByText('Host copy')).toBeInTheDocument()
  })

  it('refuses to delete the last remaining scene', async () => {
    const user = userEvent.setup()
    const only = useSceneStore.getState().createScene('Only')

    render(<SceneStrip />)
    await user.click(screen.getByRole('button', { name: /Delete Only/i }))

    // The program output must always have somewhere to point.
    expect(useSceneStore.getState().scenes[only.id]).toBeDefined()
    expect(useStudioStore.getState().toast?.tone).toBe('error')
  })

  it('deletes an empty scene without a confirmation prompt', async () => {
    const user = userEvent.setup()
    useSceneStore.getState().createScene('Keep')
    const doomed = useSceneStore.getState().createScene('Empty')

    render(<SceneStrip />)
    await user.click(screen.getByRole('button', { name: /Delete Empty/i }))

    // Confirming an empty scene is friction with no benefit.
    expect(useStudioStore.getState().confirm).toBeNull()
    expect(useSceneStore.getState().scenes[doomed.id]).toBeUndefined()
  })

  it('asks for confirmation before deleting a scene with content', async () => {
    const user = userEvent.setup()
    useSceneStore.getState().createScene('Keep')
    const scene = useSceneStore.getState().createScene('Populated')
    useSceneStore.getState().addItem(scene.id, {
      sourceId: 'src_a',
      transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
      visible: true,
      locked: false,
      layer: 0,
      mirrored: false,
      opacity: 1,
    })

    render(<SceneStrip />)
    await user.click(screen.getByRole('button', { name: /Delete Populated/i }))

    expect(useStudioStore.getState().confirm).not.toBeNull()
    // Still present until the user confirms.
    expect(useSceneStore.getState().scenes[scene.id]).toBeDefined()
  })

  it('edits the active scene’s transition and disables duration for a cut', async () => {
    const user = userEvent.setup()
    const scene = useSceneStore.getState().createScene('Host')

    render(<SceneStrip />)
    // Collapsed by default — open it before editing.
    await user.click(screen.getByRole('button', { name: /Transition into this scene/i }))

    const typeSelect = screen.getByLabelText(/Transition into this scene/i)
    await user.selectOptions(typeSelect, 'crossfade')
    expect(useSceneStore.getState().scenes[scene.id]?.transition.type).toBe('crossfade')

    const duration = screen.getByLabelText(/Duration/i)
    expect(duration).not.toBeDisabled()

    await user.selectOptions(typeSelect, 'cut')
    // A cut has no duration to configure.
    expect(screen.getByLabelText(/Duration/i)).toBeDisabled()
  })

  it('shows an on-air marker on the live scene only', () => {
    useSceneStore.getState().createScene('Host')
    useSceneStore.getState().createScene('Other')

    render(<SceneStrip />)

    const activeTab = screen.getByRole('tab', { selected: true })
    expect(within(activeTab).getByText(/On air/i)).toBeInTheDocument()
    expect(screen.getAllByText(/On air/i)).toHaveLength(1)
  })
})
