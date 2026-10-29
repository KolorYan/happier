import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

// Bun's built-in `ws` ignores createConnection. The npm alias keeps the real library;
// a static import includes it in standalone binaries without runtime node_modules.
import WebSocket from 'ws-node';

export type CodexWebSocket = WebSocket;

export function createCodexWebSocket(createStream: () => Duplex, maxJsonLineChars: number): CodexWebSocket {
    return new WebSocket('ws://localhost/', {
        // ws and Node HTTP accept Duplex streams; @types/ws narrows this external
        // extension point to net.Socket, excluding the native proxy's binary stdio.
        createConnection: createStream as () => Socket,
        // Codex's tungstenite endpoint rejects the HTTP upgrade if this extension is offered.
        perMessageDeflate: false,
        // UTF-8 uses at most three bytes per UTF-16 code unit (a surrogate pair
        // uses four bytes for two units). The JSON reader owns the exact char limit.
        maxPayload: maxJsonLineChars * 3,
    });
}
