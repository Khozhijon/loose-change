// A plain static server for public/, with the content types browsers insist on for
// WebAssembly and module scripts.
//
//   npm run dev        then open http://localhost:5177
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const root = path.join(import.meta.dirname, '..', 'public')
const port = Number(process.env.PORT ?? 5177)
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.csv': 'text/csv; charset=utf-8', '.onnx': 'application/octet-stream', '.bin': 'application/octet-stream', '.png': 'image/png', '.map': 'application/json',
}

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    let file = path.normalize(path.join(root, decodeURIComponent(url.pathname)))
    if (!file.startsWith(root)) return void res.writeHead(403).end()
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
    if (!fs.existsSync(file)) return void res.writeHead(404, {'content-type': 'text/plain'}).end('Not found')
    res.writeHead(200, {'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache'})
    fs.createReadStream(file).pipe(res)
  })
  .listen(port, () => console.log(`Loose Change on http://localhost:${port}`))
