/**
 * The relay's landing page.
 *
 * Exists so that opening the server in a browser explains what it is rather
 * than 404-ing, and so the WebSocket path is discoverable. The signaling itself
 * is not HTTP — see `src/signaling.ts`.
 */
export default function Page() {
  return (
    <main style={{ maxWidth: 680, margin: '0 auto', padding: '3rem 1.25rem', lineHeight: 1.6 }}>
      <h1 style={{ fontSize: '1.25rem', marginBottom: '0.25rem' }}>LiveDeck signaling relay</h1>
      <p style={{ color: '#8a94a6', fontSize: '0.875rem', marginTop: 0 }}>
        Running. This process relays WebRTC connection setup between peers who name the same room.
      </p>

      <ul style={{ fontSize: '0.875rem', color: '#b4bccb', paddingLeft: '1.1rem' }}>
        <li>
          WebSocket endpoint: <code style={{ color: '#5aa9ff' }}>/signal</code>
        </li>
        <li>
          Health: <code style={{ color: '#5aa9ff' }}>/healthz</code>
        </li>
      </ul>

      <p style={{ fontSize: '0.8125rem', color: '#8a94a6' }}>
        It never sees media — audio and video flow directly between browsers. It stores nothing:
        rooms live in memory, so a restart drops them and clients re-join.
      </p>
      <p style={{ fontSize: '0.8125rem', color: '#ffcc55' }}>
        A room name is not a credential. Anyone who knows it can join. Put real authentication in
        front of this if you need private rooms.
      </p>
    </main>
  )
}
