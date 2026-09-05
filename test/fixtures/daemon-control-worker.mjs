// Disposable child used only by isolated cross-platform lifecycle tests.
const { startDaemonControl } = await import(process.argv[2])
await startDaemonControl(process.argv[3], () => {
    process.stdout.write('STOPPING\n', () => process.exit(0))
})
process.stdout.write('READY\n')
