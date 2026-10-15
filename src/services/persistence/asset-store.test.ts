/// <reference types="node" />
import 'fake-indexeddb/auto'
import { Blob as NodeBlob } from 'node:buffer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('Blob', NodeBlob)
import { resetCapabilitiesCache } from '@/lib/capabilities'
import { dataUrlToBlob, deleteAsset, getAsset, listAssetIds, pruneAssets, putAsset, resetAssetStore } from './asset-store'

beforeEach(async () => {
  resetAssetStore()
  resetCapabilitiesCache()
  for (const id of await listAssetIds()) await deleteAsset(id)
})

describe('asset store', () => {
  it('stores a blob under a generated id and reads it back', async () => {
    const stored = await putAsset({ kind: 'image', name: 'logo.png', type: 'image/png', size: 3, blob: new Blob(['abc']) })
    expect(stored.id).toMatch(/^asset_/)
    const loaded = await getAsset(stored.id)
    expect(loaded?.name).toBe('logo.png')
    expect(await loaded?.blob.text()).toBe('abc')
  })

  it('prunes assets nothing references', async () => {
    const keep = await putAsset({ kind: 'image', name: 'k', type: 'image/png', size: 1, blob: new Blob(['k']) })
    await putAsset({ kind: 'video', name: 'drop', type: 'video/webm', size: 1, blob: new Blob(['d']) })
    expect(await pruneAssets(new Set([keep.id]))).toBe(1)
    expect(await listAssetIds()).toEqual([keep.id])
  })

  it('decodes base64 and percent-encoded data URLs', async () => {
    const base64 = dataUrlToBlob('data:text/plain;base64,aGVsbG8=')
    expect(base64?.type).toBe('text/plain')
    expect(await base64?.text()).toBe('hello')
    const plain = dataUrlToBlob('data:text/plain,hi%20there')
    expect(await plain?.text()).toBe('hi there')
    expect(dataUrlToBlob('not a data url')).toBeNull()
  })
})
