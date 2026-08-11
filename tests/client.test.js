const test = require('node:test')
const assert = require('node:assert/strict')
const dgram = require('node:dgram')

const { TftpClient } = require('../.test-dist/client.js')
const { Opcode, createAck, createData, parsePacket } = require('../.test-dist/protocol.js')

function makeOack (options) {
    const chunks = [Buffer.from([0, Opcode.OACK])]
    for (const [key, value] of Object.entries(options)) {
        chunks.push(Buffer.from(`${key}\0${value}\0`))
    }
    return Buffer.concat(chunks)
}

function listen (socket) {
    return new Promise(resolve => socket.bind(0, '127.0.0.1', resolve))
}

test('downloads through option negotiation and a server transfer ID', async () => {
    const requestServer = dgram.createSocket('udp4')
    const transferServer = dgram.createSocket('udp4')
    await Promise.all([listen(requestServer), listen(transferServer)])
    const port = requestServer.address().port
    assert.notEqual(transferServer.address().port, port)
    const expected = Buffer.from('0123456789abcdefghijklmnop')
    let clientAddress
    let state = 'ack0'

    const serverDone = new Promise((resolve, reject) => {
        requestServer.on('error', reject)
        transferServer.on('error', reject)
        requestServer.on('message', (message, remote) => {
            try {
                clientAddress = remote
                assert.equal(message.readUInt16BE(0), Opcode.RRQ)
                transferServer.send(makeOack({ blksize: 16, tsize: expected.length }), remote.port, remote.address)
            } catch (error) {
                reject(error)
            }
        })
        transferServer.on('message', (message, remote) => {
            try {
                const packet = parsePacket(message)
                if (state === 'ack0') {
                    assert.deepEqual(packet, { opcode: Opcode.ACK, block: 0 })
                    state = 'ack1'
                    transferServer.send(createData(1, expected.subarray(0, 16)), remote.port, remote.address)
                } else if (state === 'ack1') {
                    assert.deepEqual(packet, { opcode: Opcode.ACK, block: 1 })
                    state = 'ack2'
                    transferServer.send(createData(2, expected.subarray(16)), remote.port, remote.address)
                } else if (state === 'ack2') {
                    assert.deepEqual(packet, { opcode: Opcode.ACK, block: 2 })
                    resolve()
                }
            } catch (error) {
                reject(error)
            }
        })
    })

    const chunks = []
    let announcedSize
    let closed = false
    const client = new TftpClient()
    const result = await client.download({
        host: '127.0.0.1', port, remoteFilename: 'firmware.bin', blockSize: 16, timeoutMs: 500, retries: 2,
    }, async size => {
        announcedSize = size
        return {
            async write (chunk) { chunks.push(Buffer.from(chunk)) },
            close () { closed = true },
        }
    })

    await serverDone
    requestServer.close()
    transferServer.close()
    assert.ok(clientAddress)
    assert.equal(announcedSize, expected.length)
    assert.deepEqual(Buffer.concat(chunks), expected)
    assert.equal(result.bytes, expected.length)
    assert.equal(result.blockSize, 16)
    assert.equal(closed, true)
})

test('uploads data and emits a final short block', async () => {
    const server = dgram.createSocket('udp4')
    await listen(server)
    const port = server.address().port
    const expected = Buffer.from('abcdefghijklmnopqrstuvwxyz')
    const received = []
    let state = 'request'

    const serverDone = new Promise((resolve, reject) => {
        server.on('error', reject)
        server.on('message', (message, remote) => {
            try {
                if (state === 'request') {
                    assert.equal(message.readUInt16BE(0), Opcode.WRQ)
                    state = 'data'
                    server.send(makeOack({ blksize: 16, tsize: expected.length }), remote.port, remote.address)
                    return
                }
                const packet = parsePacket(message)
                assert.equal(packet.opcode, Opcode.DATA)
                received.push(Buffer.from(packet.data))
                server.send(createAck(packet.block), remote.port, remote.address)
                if (packet.data.length < 16) resolve()
            } catch (error) {
                reject(error)
            }
        })
    })

    let offset = 0
    let closed = false
    const source = {
        size: expected.length,
        async read (maximumBytes) {
            const result = expected.subarray(offset, offset + maximumBytes)
            offset += result.length
            return Buffer.from(result)
        },
        close () { closed = true },
    }

    const client = new TftpClient()
    const result = await client.upload({
        host: '127.0.0.1', port, remoteFilename: 'firmware.bin', blockSize: 16, timeoutMs: 500, retries: 2,
    }, source)

    await serverDone
    server.close()
    assert.deepEqual(Buffer.concat(received), expected)
    assert.equal(result.bytes, expected.length)
    assert.equal(result.blockSize, 16)
    assert.equal(closed, true)
})

test('retries the request after a timeout', async () => {
    const server = dgram.createSocket('udp4')
    await listen(server)
    const port = server.address().port
    let requests = 0

    server.on('message', (message, remote) => {
        if (message.readUInt16BE(0) === Opcode.RRQ) {
            requests++
            if (requests === 2) server.send(createData(1, Buffer.from('ok')), remote.port, remote.address)
        }
    })

    const chunks = []
    const states = []
    const result = await new TftpClient().download({
        host: '127.0.0.1', port, remoteFilename: 'retry.bin', timeoutMs: 250, retries: 2,
    }, async () => ({
        async write (chunk) { chunks.push(Buffer.from(chunk)) },
        close () { },
    }), undefined, progress => states.push(progress.state))

    server.close()
    assert.equal(requests, 2)
    assert.equal(Buffer.concat(chunks).toString(), 'ok')
    assert.equal(result.bytes, 2)
    assert.ok(states.includes('retrying'))
})
