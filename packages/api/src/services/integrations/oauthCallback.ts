import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

let activeServer: Server | null = null;

export function startCallbackServer(): Promise<{ port: number; code: Promise<string> }> {
  if (activeServer) {
    throw new Error('OAuth callback server is already running');
  }

  let resolveCode: (code: string) => void;
  let rejectCode: (err: Error) => void;

  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1`);
    const codeParam = url.searchParams.get('code');
    const errorParam = url.searchParams.get('error');

    if (errorParam) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h1>Authorization failed</h1><p>You can close this tab.</p></body></html>');
      setImmediate(() => {
        rejectCode!(new Error(`OAuth error: ${errorParam}`));
        shutdown();
      });
      return;
    }

    if (codeParam) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h1>Authorization successful</h1><p>You can close this tab and return to Orcy.</p></body></html>');
      setImmediate(() => {
        resolveCode!(codeParam);
        shutdown();
      });
      return;
    }

    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end('<html><body><h1>Missing authorization code</h1></body></html>');
  });

  activeServer = server;

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to get server address'));
        return;
      }

      const timeout = setTimeout(() => {
        rejectCode!(new Error('OAuth callback timed out after 5 minutes'));
        shutdown();
      }, CALLBACK_TIMEOUT_MS);

      code.catch(() => {}).finally(() => clearTimeout(timeout));

      resolve({ port: addr.port, code });
    });

    server.on('error', (err) => {
      reject(err);
      shutdown();
    });
  });
}

export function stopCallbackServer(): void {
  shutdown();
}

function shutdown(): void {
  if (activeServer) {
    activeServer.close();
    activeServer = null;
  }
}
