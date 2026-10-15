import { describe, expect, it } from 'vitest'
import { parseIceServerUrls } from './ice-servers'

describe('parseIceServerUrls', () => {
  it('accepts bare STUN and TURN URLs and skips junk', () => {
    expect(parseIceServerUrls(['stun:stun.example.com:3478', '', 'http://nope', ' turns:relay:5349 '])).toEqual([
      { urls: ['stun:stun.example.com:3478'] },
      { urls: ['turns:relay:5349'] },
    ])
  })

  it('splits credentials on the first pipe and first colon only', () => {
    expect(parseIceServerUrls(['turn:relay:3478|user:pa:ss|word'])).toEqual([
      { urls: ['turn:relay:3478'], username: 'user', credential: 'pa:ss|word' },
    ])
    expect(parseIceServerUrls(['turn:relay:3478|onlyuser'])).toEqual([{ urls: ['turn:relay:3478'], username: 'onlyuser' }])
  })
})
