// Disposable second instance; no database and no external service calls.
import http from 'node:http'
http.createServer((_request, response) => response.end('fixture-independent-B'))
  .listen(Number(process.argv[2] || 18599), '127.0.0.1')
