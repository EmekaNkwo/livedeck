import { describe, expect, it, vi } from 'vitest'
import { quietLog } from '../test/fixtures'
import { Peer, type PeerSend } from './peer'
import { Room, RoomError } from './room'

function peer(id: string, send: PeerSend = vi.fn() as unknown as PeerSend): Peer {
  return new Peer({ id, role: 'guest', label: id, resumeToken: `t-${id}`, send, now: 1 })
}

describe('Room', () => {
  it('can be claimed once, whoever is already inside', () => {
    const room = new Room({ name: 'r', maxPeers: 4, log: quietLog })
    room.addPeer(peer('guest'))
    expect(room.claim()).toBe(true)
    expect(room.claim()).toBe(false)
  })

  it('announces joins and leaves to the others, and refuses past the cap', () => {
    const room = new Room({ name: 'r', maxPeers: 2, log: quietLog })
    const firstSend = vi.fn()
    room.addPeer(peer('a', firstSend as unknown as PeerSend))
    room.addPeer(peer('b'))
    expect(firstSend).toHaveBeenCalledWith('participantJoined', expect.objectContaining({ participant: expect.objectContaining({ id: 'b' }) }))
    expect(() => room.addPeer(peer('c'))).toThrow(RoomError)
    room.removePeer('b')
    expect(firstSend).toHaveBeenLastCalledWith('participantLeft', { participantId: 'b' })
    expect(room.participants().map((p) => p.id)).toEqual(['a'])
    room.removePeer('missing')
  })

  it('reports unknown participants with a protocol code', () => {
    const room = new Room({ name: 'r', maxPeers: 2, log: quietLog })
    expect(() => room.getPeer('nobody')).toThrow(expect.objectContaining({ code: 'unknown-participant' }))
  })

  it('tells everyone when it closes, once', () => {
    const room = new Room({ name: 'r', maxPeers: 2, log: quietLog })
    const send = vi.fn()
    const member = peer('a', send as unknown as PeerSend)
    room.addPeer(member)
    room.close('server-shutdown')
    room.close('server-shutdown')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('closed', { code: 'server-shutdown', message: 'The room was closed.' })
    expect(member.isClosed).toBe(true)
    expect(room.isEmpty).toBe(true)
    expect(room.isClosed).toBe(true)
  })
})

describe('Peer', () => {
  it('holds its place while detached and expires when nobody resumes it', () => {
    vi.useFakeTimers()
    const send = vi.fn()
    const member = peer('a', send as unknown as PeerSend)
    const expired = vi.fn()
    member.detach(expired, 1000)
    expect(member.isConnected).toBe(false)
    member.send('participantLeft', { participantId: 'x' })
    expect(send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(expired).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('a resume rebinds the socket, rotates the token and cancels the expiry', () => {
    vi.useFakeTimers()
    const member = peer('a')
    const expired = vi.fn()
    member.detach(expired, 1000)
    const next = vi.fn() as unknown as PeerSend
    member.attach(next, 'new-token')
    vi.advanceTimersByTime(2000)
    expect(expired).not.toHaveBeenCalled()
    expect(member.isAttachedTo(next)).toBe(true)
    expect(member.resumeToken).toBe('new-token')
    member.close()
    member.close()
    expect(member.isClosed).toBe(true)
    vi.useRealTimers()
  })
})
