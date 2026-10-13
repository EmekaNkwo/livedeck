import type { ReactNode } from 'react'

export const metadata = {
  title: 'LiveDeck signaling',
  description: 'Room-based WebRTC signaling relay for LiveDeck Studio.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          background: '#0a0c10',
          color: '#dfe4ec',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        }}
      >
        {children}
      </body>
    </html>
  )
}
