import type { AspectRatioId, FrameRateId, OutputResolutionId } from '@/types/scene'
import { useStudioSettings } from '@/hooks/useStudioSettings'
import { useStudioStore } from '@/stores/studioStore'
import { resolveRelayUrl } from '@/services/signaling/relay-url'
import { Button } from '@/components/shared/Button'
import { Dialog } from '@/components/shared/Dialog'
import { NumberField, SelectField, TextField, Toggle } from '@/components/shared/Field'
import { Notice } from '@/components/shared/Status'

/**
 * Studio settings.
 *
 * Output settings here change the *real* pipeline: the program canvas is
 * resized, and the frame rate is what `canvas.captureStream(fps)` receives.
 * The warnings block shows what the current sources can actually sustain, so
 * the studio never implies quality it cannot deliver.
 */

export function SettingsDialog() {
  const dialog = useStudioStore((state) => state.dialog)
  const closeDialog = useStudioStore((state) => state.closeDialog)
  const settings = useStudioSettings()

  return (
    <Dialog
      open={dialog === 'settings'}
      onClose={closeDialog}
      title="Studio settings"
      description="Stored on this device and never uploaded. No account."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={settings.reset}>
            Restore defaults
          </Button>
          <Button variant="primary" onClick={closeDialog}>
            Done
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <section className="flex flex-col gap-3">
          <h3 className="text-xs font-semibold text-ink-100">Output quality</h3>

          <div className="grid gap-3 sm:grid-cols-3">
            <SelectField
              label="Aspect ratio"
              value={settings.settings.output.aspectRatio}
              options={[
                { value: '16:9', label: '16:9 — widescreen' },
                { value: '9:16', label: '9:16 — vertical' },
                { value: '1:1', label: '1:1 — square' },
                { value: '4:3', label: '4:3 — classic' },
              ]}
              onChange={(value) => settings.setAspectRatio(value as AspectRatioId)}
            />
            <SelectField
              label="Resolution"
              value={settings.settings.output.resolution}
              options={[
                { value: '480p', label: '480p' },
                { value: '720p', label: '720p' },
                { value: '1080p', label: '1080p' },
              ]}
              onChange={(value) => settings.setResolution(value as OutputResolutionId)}
            />
            <SelectField
              label="Frame rate"
              value={String(settings.settings.output.frameRate)}
              options={[
                { value: '24', label: '24 fps' },
                { value: '30', label: '30 fps' },
                { value: '60', label: '60 fps' },
              ]}
              onChange={(value) => settings.setFrameRate(Number(value) as FrameRateId)}
            />
          </div>

          <p className="font-mono text-[11px] text-ink-500">
            Program canvas: {settings.canvasSize.width}×{settings.canvasSize.height} at{' '}
            {settings.settings.output.frameRate} fps
          </p>

          <SelectField
            label="Preview frame rate cap"
            hint="Lower this to save CPU while editing. Recording always runs at the full output rate."
            value={String(settings.settings.previewFrameRate)}
            options={[
              { value: '24', label: '24 fps' },
              { value: '30', label: '30 fps' },
              { value: '60', label: '60 fps' },
            ]}
            onChange={(value) => settings.setPreviewFrameRate(Number(value) as FrameRateId)}
          />

          {settings.warnings.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              {settings.warnings.map((warning, index) => (
                <Notice key={index} tone={warning.severity === 'warning' ? 'warning' : 'info'}>
                  {warning.message}
                </Notice>
              ))}
            </div>
          ) : null}
        </section>

        <section className="flex flex-col gap-3 border-t border-deck-700 pt-4">
          <h3 className="text-xs font-semibold text-ink-100">Canvas editor</h3>
          <Toggle
            label="Snap to guides"
            hint="Snaps dragged sources to canvas edges, the centre, and other sources' edges."
            checked={settings.settings.snapToGuides}
            onChange={settings.setSnapToGuides}
          />
          <NumberField
            label="Snap distance"
            unit="px"
            min={0}
            max={40}
            value={settings.settings.snapThresholdPx}
            onChange={settings.setSnapThreshold}
            className="w-40"
          />
          <Toggle
            label="Show title-safe and action-safe guides"
            checked={settings.settings.showSafeAreas}
            onChange={settings.setShowSafeAreas}
          />
        </section>

        <section className="flex flex-col gap-3 border-t border-deck-700 pt-4">
          <h3 className="text-xs font-semibold text-ink-100">Accessibility</h3>
          <SelectField
            label="Interface animation"
            hint="Affects interface transitions only. Scene transitions in the program output are configured per scene."
            value={settings.settings.reducedMotion}
            options={[
              { value: 'system', label: 'Follow my system preference' },
              { value: 'always', label: 'Always reduce motion' },
              { value: 'never', label: 'Never reduce motion' },
            ]}
            onChange={(value) =>
              settings.setReducedMotion(value as 'system' | 'always' | 'never')
            }
          />
        </section>

        <section className="flex flex-col gap-3 border-t border-deck-700 pt-4">
          <h3 className="text-xs font-semibold text-ink-100">Media server</h3>
          <TextField
            label="Server address"
            hint={`Leave blank to use ${resolveRelayUrl('')} — the server in this repo. Override for one hosted elsewhere.`}
            value={settings.settings.signalingServerUrl}
            onChange={settings.setSignalingServerUrl}
          />
          {settings.signalingConfigError ? (
            <Notice tone="warning">{settings.signalingConfigError}</Notice>
          ) : null}
          <Notice>
            This server runs the room: who is in it, what each person may do, and the director&apos;s
            controls. Audio and video travel through Jitsi, which the server admits each participant
            to. Roles are decided by the server from the key in a link: a room name alone grants the
            guest role and nothing more.
          </Notice>
        </section>

      </div>
    </Dialog>
  )
}
