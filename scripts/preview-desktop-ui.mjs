// Shows the one UI with invented data in a browser: no Core, no token, no Mesh.
//   node scripts/preview-desktop-ui.mjs [port]   ->  http://127.0.0.1:<port>/app/
import { createDesktopFixture } from './fixtures/desktop-control-plane.mjs'

const fixture = await createDesktopFixture({ serveRenderer: true, port: Number(process.argv[2]) || 0 })
console.log(`Xaventra UI preview (fixture data only): ${fixture.endpoint}/app/`)
process.on('SIGINT', async () => { await fixture.close(); process.exit(0) })
