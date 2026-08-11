export enum Opcode {
    RRQ = 1,
    WRQ = 2,
    DATA = 3,
    ACK = 4,
    ERROR = 5,
    OACK = 6,
}

export type TftpPacket =
    | { opcode: Opcode.DATA; block: number; data: Buffer }
    | { opcode: Opcode.ACK; block: number }
    | { opcode: Opcode.ERROR; code: number; message: string }
    | { opcode: Opcode.OACK; options: Record<string, string> }

function zeroTerminated (value: string): Buffer {
    if (value.includes('\0')) {
        throw new Error('TFTP 字段不能包含空字符')
    }
    return Buffer.concat([Buffer.from(value, 'utf8'), Buffer.from([0])])
}

export function createRequest (
    opcode: Opcode.RRQ | Opcode.WRQ,
    filename: string,
    options: Record<string, string | number> = {},
): Buffer {
    if (!filename.trim()) {
        throw new Error('远端文件名不能为空')
    }

    const header = Buffer.allocUnsafe(2)
    header.writeUInt16BE(opcode, 0)
    const parts = [header, zeroTerminated(filename), zeroTerminated('octet')]

    for (const [key, rawValue] of Object.entries(options)) {
        parts.push(zeroTerminated(key.toLowerCase()))
        parts.push(zeroTerminated(String(rawValue)))
    }
    return Buffer.concat(parts)
}

export function createData (block: number, data: Buffer): Buffer {
    const packet = Buffer.allocUnsafe(4 + data.length)
    packet.writeUInt16BE(Opcode.DATA, 0)
    packet.writeUInt16BE(block & 0xffff, 2)
    data.copy(packet, 4)
    return packet
}

export function createAck (block: number): Buffer {
    const packet = Buffer.allocUnsafe(4)
    packet.writeUInt16BE(Opcode.ACK, 0)
    packet.writeUInt16BE(block & 0xffff, 2)
    return packet
}

export function createError (code: number, message: string): Buffer {
    const packet = Buffer.allocUnsafe(4)
    packet.writeUInt16BE(Opcode.ERROR, 0)
    packet.writeUInt16BE(code & 0xffff, 2)
    return Buffer.concat([packet, zeroTerminated(message)])
}

function parsePairs (packet: Buffer, offset: number): Record<string, string> {
    const values: string[] = []
    let start = offset
    for (let i = offset; i < packet.length; i++) {
        if (packet[i] === 0) {
            values.push(packet.toString('utf8', start, i))
            start = i + 1
        }
    }
    if (start !== packet.length || values.length % 2 !== 0) {
        throw new Error('无效的 TFTP 选项响应')
    }

    const options: Record<string, string> = {}
    for (let i = 0; i < values.length; i += 2) {
        options[values[i].toLowerCase()] = values[i + 1]
    }
    return options
}

export function parsePacket (packet: Buffer): TftpPacket {
    if (packet.length < 2) {
        throw new Error('TFTP 数据包过短')
    }
    const opcode = packet.readUInt16BE(0)

    switch (opcode) {
        case Opcode.DATA:
            if (packet.length < 4) throw new Error('无效的 DATA 数据包')
            return { opcode, block: packet.readUInt16BE(2), data: packet.subarray(4) }
        case Opcode.ACK:
            if (packet.length !== 4) throw new Error('无效的 ACK 数据包')
            return { opcode, block: packet.readUInt16BE(2) }
        case Opcode.ERROR: {
            if (packet.length < 5 || packet[packet.length - 1] !== 0) {
                throw new Error('无效的 ERROR 数据包')
            }
            return {
                opcode,
                code: packet.readUInt16BE(2),
                message: packet.toString('utf8', 4, packet.length - 1),
            }
        }
        case Opcode.OACK:
            return { opcode, options: parsePairs(packet, 2) }
        default:
            throw new Error(`不支持的 TFTP 操作码: ${opcode}`)
    }
}

export function parseNegotiatedBlockSize (options: Record<string, string>, fallback = 512): number {
    if (!options.blksize) return fallback
    const value = Number(options.blksize)
    if (!Number.isInteger(value) || value < 8 || value > 65464) {
        throw new Error(`服务端返回了无效的块大小: ${options.blksize}`)
    }
    return value
}

export function parseTransferSize (options: Record<string, string>): number | undefined {
    if (options.tsize === undefined) return undefined
    const value = Number(options.tsize)
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`服务端返回了无效的文件大小: ${options.tsize}`)
    }
    return value
}
