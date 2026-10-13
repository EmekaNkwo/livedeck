import {
  Camera,
  CameraOff,
  FlipHorizontal,
  Mic,
  MicOff,
  RefreshCw,
} from 'lucide-react'
import type { CaptureStatus } from '@/types/media'
import { useCamera, CAMERA_RESOLUTIONS } from '@/hooks/useCamera'
import { useMediaDevices } from '@/hooks/useMediaDevices'
import { useMicrophone } from '@/hooks/useMicrophone'
import { useAudioMixer } from '@/hooks/useAudioMixer'
import { detectCapabilities } from '@/lib/capabilities'
import { useAudioStore } from '@/stores/audioStore'
import { Button } from '@/components/shared/Button'
import { Panel } from '@/components/shared/Panel'
import { SelectField, Toggle } from '@/components/shared/Field'
import { Notice, StatusDot } from '@/components/shared/Status'
import type { StatusTone } from '@/components/shared/Status'

/**
 * Camera and microphone capture controls.
 *
 * No screen share. The control room's job is to conduct and structure scenes
 * out of what the room sends it; the material itself comes from participants.
 * A guest shares their screen from the guest view, and it arrives here as that
 * guest's feed like any other.
 *
 * Every status shown here is derived from the real capture state, so the panel
 * cannot display an active device that is not running. Permission-denied and
 * device-unavailable states each come with the specific recovery actions that
 * apply, rather than a generic retry.
 */

export function CaptureControls() {
  const capabilities = detectCapabilities()
  const devices = useMediaDevices()
  const camera = useCamera()
  const microphone = useMicrophone()
  const mixer = useAudioMixer()
  const programMonitoring = useAudioStore((state) => state.programMonitoring)

  return (
    <Panel title="Capture" className="shrink-0">
      <div className="flex flex-col gap-4">
        {/* ------------------------------------------------------ camera */}
        <section className="flex flex-col gap-2" aria-label="Camera">
          <div className="flex items-center gap-2">
            <Camera aria-hidden="true" className="h-3.5 w-3.5 text-ink-400" />
            <h3 className="text-[11px] font-semibold tracking-wide text-ink-300 uppercase">
              Camera
            </h3>
            <StatusDot
              {...captureStatusProps(camera.status, camera.active)}
              className="ml-auto"
            />
          </div>

          <SelectField
            label="Device"
            srOnlyLabel
            value={camera.deviceId ?? ''}
            disabled={devices.cameras.length === 0}
            options={[
              { value: '', label: devices.cameras.length ? 'System default' : 'No camera found' },
              ...devices.cameras.map((device) => ({
                value: device.deviceId,
                label: device.label,
              })),
            ]}
            onChange={(deviceId) => {
              if (!deviceId) return
              void (camera.active ? camera.switchDevice(deviceId) : camera.start(deviceId))
            }}
          />

          <div className="flex gap-1.5">
            {camera.active ? (
              <Button variant="secondary" size="sm" onClick={camera.stop} className="flex-1">
                <CameraOff aria-hidden="true" className="h-3.5 w-3.5" />
                Stop camera
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                disabled={!capabilities.getUserMedia}
                onClick={() => void camera.start()}
                className="flex-1"
              >
                <Camera aria-hidden="true" className="h-3.5 w-3.5" />
                {camera.status === 'requesting' ? 'Starting…' : 'Start camera'}
              </Button>
            )}

            <Button
              variant="ghost"
              size="icon-sm"
              active={camera.mirrored}
              aria-pressed={camera.mirrored}
              disabled={!camera.source}
              onClick={() => camera.setMirrored(!camera.mirrored)}
              aria-label="Mirror the camera preview"
              title="Mirror horizontally"
            >
              <FlipHorizontal aria-hidden="true" className="h-3.5 w-3.5" />
            </Button>
          </div>

          {camera.active ? (
            <SelectField
              label="Resolution preference"
              value="720p"
              options={CAMERA_RESOLUTIONS.map((resolution) => ({
                value: resolution.label,
                label: resolution.label,
              }))}
              onChange={(label) => {
                const resolution = CAMERA_RESOLUTIONS.find(
                  (candidate) => candidate.label === label,
                )
                if (resolution) void camera.setResolution(resolution)
              }}
              hint="A preference, not a guarantee — the camera settles on the closest mode it supports."
            />
          ) : null}

          {camera.status === 'denied' ? (
            <RecoveryNotice
              message="Camera permission was denied. Allow it for this site in your browser’s address-bar controls, then retry."
              onRetry={() => void camera.retry()}
            />
          ) : null}
          {camera.status === 'unavailable' ? (
            <RecoveryNotice
              message="No camera is available, or it was taken by another application. Close other apps using the camera, or choose a different device."
              onRetry={() => void camera.retry()}
              onRefreshDevices={() => void devices.refresh()}
            />
          ) : null}
          {camera.status === 'error' ? (
            <RecoveryNotice
              message="The camera could not be started. You can continue without it."
              onRetry={() => void camera.retry()}
            />
          ) : null}
        </section>

        {/* -------------------------------------------------- microphone */}
        <section className="flex flex-col gap-2" aria-label="Microphone">
          <div className="flex items-center gap-2">
            <Mic aria-hidden="true" className="h-3.5 w-3.5 text-ink-400" />
            <h3 className="text-[11px] font-semibold tracking-wide text-ink-300 uppercase">
              Microphone
            </h3>
            <StatusDot
              {...microphoneStatusProps(microphone.status, microphone.active, microphone.muted)}
              className="ml-auto"
            />
          </div>

          <SelectField
            label="Device"
            srOnlyLabel
            value={microphone.deviceId ?? ''}
            disabled={devices.microphones.length === 0}
            options={[
              {
                value: '',
                label: devices.microphones.length ? 'System default' : 'No microphone found',
              },
              ...devices.microphones.map((device) => ({
                value: device.deviceId,
                label: device.label,
              })),
            ]}
            onChange={(deviceId) => {
              if (!deviceId) return
              void (microphone.active
                ? microphone.switchDevice(deviceId)
                : microphone.start(deviceId))
            }}
          />

          <div className="flex gap-1.5">
            {microphone.active ? (
              <>
                <Button
                  variant={microphone.muted ? 'live' : 'secondary'}
                  size="sm"
                  onClick={microphone.toggleMuted}
                  aria-pressed={microphone.muted}
                  className="flex-1"
                >
                  {microphone.muted ? (
                    <MicOff aria-hidden="true" className="h-3.5 w-3.5" />
                  ) : (
                    <Mic aria-hidden="true" className="h-3.5 w-3.5" />
                  )}
                  {microphone.muted ? 'Unmute input' : 'Mute input'}
                </Button>
                <Button variant="ghost" size="sm" onClick={microphone.stop}>
                  Stop
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                size="sm"
                disabled={!capabilities.getUserMedia}
                onClick={async () => {
                  // Starting a mic is a user gesture, which is exactly when the
                  // AudioContext is allowed to start — so initialise the mixer
                  // here rather than hoping it happens later.
                  await mixer.initialize()
                  await microphone.start()
                }}
                className="flex-1"
              >
                <Mic aria-hidden="true" className="h-3.5 w-3.5" />
                {microphone.status === 'requesting' ? 'Starting…' : 'Start microphone'}
              </Button>
            )}
          </div>

          {microphone.active ? (
            <Notice>
              <strong className="text-ink-200">Mute input</strong> disables the track itself, so
              nothing is captured or recorded. To keep capturing but drop the channel from the
              program mix, use the mixer’s mute instead.
            </Notice>
          ) : null}

          {microphone.status === 'denied' ? (
            <RecoveryNotice
              message="Microphone permission was denied. Allow it for this site, then retry."
              onRetry={() => void microphone.retry()}
            />
          ) : null}
          {microphone.status === 'unavailable' ? (
            <RecoveryNotice
              message="No microphone is available. Connect one, or continue without audio."
              onRetry={() => void microphone.retry()}
              onRefreshDevices={() => void devices.refresh()}
            />
          ) : null}
        </section>

        {/* ------------------------------------------------------- audio */}
        {mixer.contextStatus !== 'running' ? (
          <section className="flex flex-col gap-2" aria-label="Audio engine">
            <Notice tone={mixer.contextStatus === 'unavailable' ? 'warning' : 'info'}>
              {mixer.contextStatus === 'unavailable'
                ? 'The Web Audio API is unavailable, so audio mixing, meters and recorded audio are not supported in this browser.'
                : 'The audio engine has not started. Browsers require a click before audio can run.'}
            </Notice>
            {mixer.contextStatus !== 'unavailable' ? (
              <Button variant="outline" size="sm" onClick={() => void mixer.initialize()}>
                Enable audio engine
              </Button>
            ) : null}
          </section>
        ) : null}

        <Toggle
          label="Monitor program audio through my speakers"
          hint="Off by default — with a live microphone this creates an acoustic feedback loop unless you are wearing headphones."
          checked={programMonitoring}
          disabled={mixer.contextStatus !== 'running'}
          onChange={(enabled) => mixer.setProgramMonitoring(enabled)}
        />
      </div>
    </Panel>
  )
}

function captureStatusProps(
  status: CaptureStatus,
  active: boolean,
): { tone: StatusTone; label: string } {
  if (active) return { tone: 'active', label: 'Active' }
  switch (status) {
    case 'requesting':
      return { tone: 'pending', label: 'Requesting' }
    case 'denied':
      return { tone: 'error', label: 'Permission denied' }
    case 'unavailable':
      return { tone: 'warning', label: 'No device' }
    case 'error':
      return { tone: 'error', label: 'Error' }
    default:
      return { tone: 'idle', label: 'Idle' }
  }
}

function microphoneStatusProps(
  status: CaptureStatus,
  active: boolean,
  muted: boolean,
): { tone: StatusTone; label: string } {
  if (active && muted) return { tone: 'warning', label: 'Muted' }
  return captureStatusProps(status, active)
}

function RecoveryNotice({
  message,
  onRetry,
  onRefreshDevices,
}: {
  message: string
  onRetry: () => void
  onRefreshDevices?: () => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <Notice tone="error">{message}</Notice>
      <div className="flex gap-1.5">
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw aria-hidden="true" className="h-3 w-3" />
          Retry
        </Button>
        {onRefreshDevices ? (
          <Button variant="ghost" size="sm" onClick={onRefreshDevices}>
            Rescan devices
          </Button>
        ) : null}
      </div>
    </div>
  )
}
