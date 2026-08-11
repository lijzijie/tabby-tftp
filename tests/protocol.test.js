const test = require('node:test')
const assert = require('node:assert/strict')

const {
    Opcode,
    createAck,
    createData,
    createError,
    createRequest,
    parseNegotiatedBlockSize,
    parsePacket,
    parseTransferSize,
} = require('../.test-dist/protocol.js')

function oack (options) {
    const chunks = [Buffer.from([0, Opcode.OACK])]
    for (const [key, value] of Object.entries(options)) {
        chunks.push(Buffer.from(`${key}\0${value}\0`))
    }
    return Buffer.concat(chunks)
}

test('encodes an RRQ with octet mode and RFC options', () => {
    const request = createRequest(Opcode.RRQ, 'firmware.bin', { blksize: 1468, tsize: 0 })
    assert.equal(request.readUInt16BE(0), Opcode.RRQ)
    assert.equal(request.subarray(2).toString(), 'firmware.bin\0octet\0blksize\0' + '1468\0tsize\0' + '0\0')
})

test('round-trips DATA, ACK and ERROR packets', () => {
    const data = Buffer.from('hello')
    assert.deepEqual(parsePacket(createData(7, data)), { opcode: Opcode.DATA, block: 7, data })
    assert.deepEqual(parsePacket(createAck(7)), { opcode: Opcode.ACK, block: 7 })
    assert.deepEqual(parsePacket(createError(1, 'missing')), { opcode: Opcode.ERROR, code: 1, message: 'missing' })
})

test('parses and validates an OACK', () => {
    const packet = parsePacket(oack({ blksize: 1024, tsize: 12345 }))
    assert.equal(packet.opcode, Opcode.OACK)
    assert.equal(parseNegotiatedBlockSize(packet.options), 1024)
    assert.equal(parseTransferSize(packet.options), 12345)
})

test('rejects malformed packets and unsafe negotiated values', () => {
    assert.throws(() => parsePacket(Buffer.from([0, Opcode.ACK, 0])), /ACK/)
    assert.throws(() => parseNegotiatedBlockSize({ blksize: '70000' }), /块大小/)
    assert.throws(() => parseTransferSize({ tsize: '-1' }), /文件大小/)
})
