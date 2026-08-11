const test = require('node:test')
const assert = require('node:assert/strict')
const dgram = require('node:dgram')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { TftpClient } = require('../.test-dist/client.js')
const { TftpServer } = require('../.test-dist/server.js')

async function freeUdpPort () {
    const socket = dgram.createSocket('udp4')
    await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve))
    const port = socket.address().port
    await new Promise(resolve => socket.close(resolve))
    return port
}

function createTemporaryRoot () {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tabby-tftp-test-'))
}

function removeTemporaryRoot (directory) {
    const relative = path.relative(os.tmpdir(), directory)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Refusing to remove unsafe test directory: ${directory}`)
    }
    fs.rmSync(directory, { recursive: true, force: true })
}

test('serves firmware from the configured root using an ephemeral transfer port', async () => {
    const root = createTemporaryRoot()
    const firmware = Buffer.from('firmware-image-for-serial-bootloader')
    fs.writeFileSync(path.join(root, 'firmware.bin'), firmware)
    const port = await freeUdpPort()
    const events = []
    const server = new TftpServer()

    try {
        await server.start({
            rootDirectory: root,
            bindAddress: '127.0.0.1',
            port,
            blockSize: 16,
            timeoutMs: 500,
            retries: 2,
        }, event => events.push(event))

        const chunks = []
        const result = await new TftpClient().download({
            host: '127.0.0.1',
            port,
            remoteFilename: 'firmware.bin',
            blockSize: 16,
            timeoutMs: 500,
            retries: 2,
        }, async size => {
            assert.equal(size, firmware.length)
            return {
                async write (chunk) { chunks.push(Buffer.from(chunk)) },
                close () { },
            }
        })

        await new Promise(resolve => setTimeout(resolve, 20))
        assert.deepEqual(Buffer.concat(chunks), firmware)
        assert.equal(result.bytes, firmware.length)
        assert.ok(events.some(event => event.type === 'request'))
        assert.ok(events.some(event => event.type === 'completed' && event.filename === 'firmware.bin'))
    } finally {
        server.stop('测试结束')
        removeTemporaryRoot(root)
    }
})

test('rejects path traversal outside the firmware root', async () => {
    const root = createTemporaryRoot()
    const port = await freeUdpPort()
    const server = new TftpServer()

    try {
        await server.start({ rootDirectory: root, bindAddress: '127.0.0.1', port, timeoutMs: 250, retries: 1 })
        await assert.rejects(
            new TftpClient().download({
                host: '127.0.0.1', port, remoteFilename: '../secret.bin', timeoutMs: 250, retries: 1,
            }, async () => ({ async write () { }, close () { } })),
            /拒绝不安全的文件路径|TFTP 错误/,
        )
    } finally {
        server.stop('测试结束')
        removeTemporaryRoot(root)
    }
})
