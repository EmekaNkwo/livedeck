import type { AspectRatioId, FrameRateId, OutputResolutionId } from '@/types/scene'
import { useStudioSettings } from '@/hooks/useStudioSettings'
import { useStudioStore } from '@/stores/studioStore'
import { DEFAULT_STUN_URLS } from '@/services/webrtc/ice'
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
      description="Stored on this device. No account, no server."
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
          <h3 className="text-xs font-semibold text-ink-100">ICE servers</h3>
          <TextField
            label="STUN / TURN URLs"
            hint="One per line. For TURN, append credentials as turn:host:port|username:password."
            value={settings.settings.iceServerUrls.join('\n')}
            onChange={(value) =>
              settings.setIceServerUrls(
                value
                  .split('\n')
                  .map((line) => line.trim())
                  .filter(Boolean),
              )
            }
          />
          <Notice>
            STUN discovers your public address, which is enough for most home and office networks.
            It does <strong className="text-ink-200">not</strong> relay media, so two peers behind
            symmetric NAT or a UDP-blocking firewall will still fail to connect — that needs a TURN
            server, which this project does not host. Changing these affects connections created
            from now on; existing ones keep the configuration they started with.
          </Notice>
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() => settings.setIceServerUrls([...DEFAULT_STUN_URLS])}
          >
            Restore default STUN servers
          </Button>
        </section>
      </div>
    </Dialog>
  )
}
