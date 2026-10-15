import { Image as ImageIcon, Palette, Type, Video } from 'lucide-react'
import { useRef, useState } from 'react'
import { DEFAULT_TEXT_STYLE } from '@/services/composition/compositor'
import { useMediaSources } from '@/hooks/useMediaSources'
import { MAX_ASSET_BYTES, putAsset } from '@/services/persistence/asset-store'
import { useStudioStore } from '@/stores/studioStore'
import { Button } from '@/components/shared/Button'
import { Dialog } from '@/components/shared/Dialog'
import { TextField } from '@/components/shared/Field'
import { Notice } from '@/components/shared/Status'

/**
 * Add a non-capture source: image, local video, text or a colour background.
 *
 * Files are read into data URLs and kept entirely in memory for the session —
 * nothing is uploaded, and nothing is written to disk by the app. Large files
 * are rejected up front with a clear reason rather than silently exhausting
 * memory.
 */


export function AddSourceDialog() {
  const dialog = useStudioStore((state) => state.dialog)
  const closeDialog = useStudioStore((state) => state.closeDialog)
  const showToast = useStudioStore((state) => state.showToast)
  const { addSource } = useMediaSources()

  const [textContent, setTextContent] = useState('Lower third')
  const [color, setColor] = useState('#101826')
  const [fileError, setFileError] = useState<string | null>(null)
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const videoInputRef = useRef<HTMLInputElement | null>(null)

  const open = dialog === 'add-source'

  const handleFile = async (file: File | undefined, kind: 'image' | 'video') => {
    setFileError(null)
    if (!file) return

    if (file.size > MAX_ASSET_BYTES) {
      setFileError(
        `“${file.name}” is ${Math.round(file.size / 1_000_000)} MB. The limit is ${Math.round(MAX_ASSET_BYTES / 1_000_000)} MB.`,
      )
      return
    }

    try {
      // The bytes go to IndexedDB; the production only carries the id.
      const asset = await putAsset({ kind, name: file.name, type: file.type, size: file.size, blob: file })
      addSource({
        name: file.name.replace(/\.[^.]+$/, ''),
        type: kind,
        settings:
          kind === 'image'
            ? { kind: 'image', assetId: asset.id, fit: 'contain' }
            : { kind: 'video', assetId: asset.id, loop: true, fit: 'contain' },
        // A local video can carry audio, which the mixer picks up from the
        // decoded element once a channel exists.
        addToMixer: kind === 'video',
        mixerKind: 'media',
      })
      showToast(`Added “${file.name}”.`, 'success')
      closeDialog()
    } catch {
      setFileError(
        'The file could not be stored in this browser. Storage may be full or unavailable in private browsing.',
      )
    }
  }

  return (
    <Dialog
      open={open}
      onClose={closeDialog}
      title="Add a source"
      description="Camera, microphone and screen capture live in the Capture panel."
      size="md"
    >
      <div className="flex flex-col gap-4">
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-ink-100">From a file</h3>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" onClick={() => imageInputRef.current?.click()}>
              <ImageIcon aria-hidden="true" className="h-4 w-4" />
              Image
            </Button>
            <Button variant="outline" onClick={() => videoInputRef.current?.click()}>
              <Video aria-hidden="true" className="h-4 w-4" />
              Video
            </Button>
          </div>

          {/* Hidden inputs — the visible buttons are the labelled controls. */}
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            className="sr-only"
            aria-label="Choose an image file"
            onChange={(event) => {
              void handleFile(event.target.files?.[0], 'image')
              event.target.value = ''
            }}
          />
          <input
            ref={videoInputRef}
            type="file"
            accept="video/*"
            className="sr-only"
            aria-label="Choose a video file"
            onChange={(event) => {
              void handleFile(event.target.files?.[0], 'video')
              event.target.value = ''
            }}
          />

          {fileError ? <Notice tone="error">{fileError}</Notice> : null}

          <Notice>
            Files stay on your device. They are held in memory for this session and are not
            uploaded or saved anywhere.
          </Notice>
        </section>

        <section className="flex flex-col gap-2 border-t border-deck-700 pt-4">
          <h3 className="text-xs font-semibold text-ink-100">Text</h3>
          <TextField label="Content" value={textContent} onChange={setTextContent} />
          <Button
            variant="secondary"
            className="self-start"
            disabled={!textContent.trim()}
            onClick={() => {
              addSource({
                name: textContent.slice(0, 24) || 'Text',
                type: 'text',
                settings: { kind: 'text', text: textContent, style: { ...DEFAULT_TEXT_STYLE } },
                addToMixer: false,
              })
              closeDialog()
            }}
          >
            <Type aria-hidden="true" className="h-4 w-4" />
            Add text source
          </Button>
        </section>

        <section className="flex flex-col gap-2 border-t border-deck-700 pt-4">
          <h3 className="text-xs font-semibold text-ink-100">Colour background</h3>
          <div className="flex items-end gap-2">
            <TextField label="Colour" value={color} onChange={setColor} className="flex-1" />
            <input
              type="color"
              value={/^#[0-9a-f]{6}$/i.test(color) ? color : '#101826'}
              onChange={(event) => setColor(event.target.value)}
              aria-label="Colour swatch"
              className="h-8 w-10 shrink-0 cursor-pointer rounded-md border border-deck-600 bg-deck-900"
            />
          </div>
          <Button
            variant="secondary"
            className="self-start"
            onClick={() => {
              addSource({
                name: 'Background',
                type: 'color-background',
                settings: { kind: 'color-background', color },
                addToMixer: false,
              })
              closeDialog()
            }}
          >
            <Palette aria-hidden="true" className="h-4 w-4" />
            Add background
          </Button>
          <Notice>
            Backgrounds are placed behind everything else automatically, filling the whole frame.
          </Notice>
        </section>
      </div>
    </Dialog>
  )
}
