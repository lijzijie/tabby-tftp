import * as dgram from 'dgram'
import { RemoteInfo, Socket } from 'dgram'
import * as fs from 'fs'
import type { FileHandle } from 'fs/promises'
import * as path from 'path'

import {
    Opcode,
    TftpPacket,
    createData,
    createError,
    parsePacket,
} from './protocol'

export interface TftpServerOptions {
    rootDirectory: string
    bindAddress?: string
    port?: number
    blockSize?: number
    timeoutMs?: number
    retries?: number
    autoStopSeconds?: number
}

interface NormalizedServerOptions {
    rootDirectory: string
    bindAddress: string
    port: number
    blockSize: number
    timeoutMs: number
    retries: number
    autoStopSeconds: number
}

export type TftpServerEventType = 'started' | 'stopped' | 'request' | 'progress' | 'completed' | 'error'

export interface TftpServerEvent {
    type: TftpServerEventType
    timestamp: number
    message: string
    peer?: string
    filename?: string
    bytes?: number
    activeTransfers: number
}

interface TftpRequest {
    opcode: Opcode.RRQ | Opcode.WRQ
    filename: string
    mode: string
    options: Record<string, string>
}

function readZeroTerminatedFields (packet: Buffer, offset: number): string[] {
    const fields: string[] = []
    let start = offset
    for (let i = offset; i < packet.length; i++) {
        if (packet[i] === 0) {
            fields.push(packet.toString('utf8', start, i))
            start = i + 1
        }
    }
    if (start !== packet.length) throw new Error('请求字段缺少结束符')
    return fields
}

export function parseRequest (packet: Buffer): TftpRequest {
    if (packet.length < 4) throw new Error('TFTP 请求过短')
    const opcode = packet.readUInt16BE(0)
    if (opcode !== Opcode.RRQ && opcode !== Opcode.WRQ) throw new Error('不是有效的读写请求')

    const fields = readZeroTerminatedFields(packet, 2)
    if (fields.length < 2 || (fields.length - 2) % 2 !== 0) throw new Error('TFTP 请求字段无效')
    const filename = fields[0]
    const mode = fields[1].toLowerCase()
    if (!filename) throw new Error('请求文件名为空')
    if (mode !== 'octet') throw new Error(`不支持的传输模式: ${mode}`)

    const options: Record<string, string> = {}
    for (let i = 2; i < fields.length; i += 2) {
        options[fields[i].toLowerCase()] = fields[i + 1]
    }
    return { opcode, filename, mode, options }
}

function createOack (options: Record<string, string | number>): Buffer {
    const header = Buffer.allocUnsafe(2)
    header.writeUInt16BE(Opcode.OACK, 0)
    const chunks: Buffer[] = [header]
    for (const [key, value] of Object.entries(options)) {
        chunks.push(Buffer.from(`${key}\0${value}\0`, 'utf8'))
    }
    return Buffer.concat(chunks)
}

function normalizeOptions (options: TftpServerOptions): NormalizedServerOptions {
    const rootDirectory = path.resolve(options.rootDirectory.trim())
    const bindAddress = (options.bindAddress ?? '0.0.0.0').trim()
    const port = options.port ?? 69
    const blockSize = options.blockSize ?? 8192
    const timeoutMs = options.timeoutMs ?? 3000
    const retries = options.retries ?? 5
    const autoStopSeconds = options.autoStopSeconds ?? 0

    if (!options.rootDirectory.trim()) throw new Error('请选择 TFTP 根目录')
    if (!bindAddress) throw new Error('监听地址不能为空')
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('监听端口必须在 1 到 65535 之间')
    if (!Number.isInteger(blockSize) || blockSize < 8 || blockSize > 65464) throw new Error('TFTP 缓冲区必须在 8 到 65464 字节之间')
    if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 60000) throw new Error('超时时间必须在 250 到 60000 毫秒之间')
    if (!Number.isInteger(retries) || retries < 0 || retries > 20) throw new Error('重试次数必须在 0 到 20 之间')
    if (!Number.isInteger(autoStopSeconds) || autoStopSeconds < 0 || autoStopSeconds > 86400) throw new Error('自动停止时间必须在 0 到 86400 秒之间')

    return { rootDirectory, bindAddress, port, blockSize, timeoutMs, retries, autoStopSeconds }
}

function resolveRequestedFile (rootDirectory: string, requestedFilename: string): string {
    const normalized = requestedFilename.replace(/\\/g, '/').replace(/^\/+/, '')
    const segments = normalized.split('/').filter(segment => segment && segment !== '.')
    if (!segments.length || segments.some(segment => segment === '..')) {
        throw new Error('拒绝不安全的文件路径')
    }

    const target = path.resolve(rootDirectory, ...segments)
    const relative = path.relative(rootDirectory, target)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('请求文件超出 TFTP 根目录')
    }
    return target
}

abstract class ServerTransfer {
    protected readonly socket: Socket
    protected blockSize = 512
    protected timeoutMs: number
    protected transferred = 0

    private lastPacket: Buffer | null = null
    private timer: ReturnType<typeof setTimeout> | null = null
    private retryCount = 0
    private settled = false
    private failing = false
    private queue = Promise.resolve()

    protected constructor (
        protected readonly request: TftpRequest,
        protected readonly remote: RemoteInfo,
        protected readonly options: NormalizedServerOptions,
        private readonly onFinish: (successful: boolean, message: string, bytes: number) => void,
    ) {
        this.timeoutMs = options.timeoutMs
        this.socket = dgram.createSocket('udp4')
    }

    start (): void {
        this.socket.on('error', error => this.fail(error.message))
        this.socket.on('message', (message, remote) => {
            this.queue = this.queue
                .then(() => this.handleMessage(message, remote))
                .catch(error => this.fail(error instanceof Error ? error.message : String(error)))
        })
        this.socket.bind(0, this.options.bindAddress, () => {
            this.begin().catch(error => this.fail(error instanceof Error ? error.message : String(error)))
        })
    }

    resendLast (): void {
        if (this.lastPacket) this.sendTracked(this.lastPacket)
    }

    cancel (): void {
        this.finish(false, '服务端已停止')
    }

    protected abstract begin (): Promise<void>
    protected abstract onPacket (packet: TftpPacket): Promise<void>
    protected abstract release (successful: boolean): Promise<void>

    protected sendTracked (packet: Buffer): void {
        if (this.settled) return
        this.lastPacket = Buffer.from(packet)
        if (this.timer) clearTimeout(this.timer)
        this.socket.send(packet, this.remote.port, this.remote.address, error => {
            if (error) this.fail(error.message)
        })
        this.timer = setTimeout(() => this.retry(), this.timeoutMs)
    }

    protected clearTimer (): void {
        if (this.timer) clearTimeout(this.timer)
        this.timer = null
        this.retryCount = 0
    }

    protected complete (message: string): void {
        this.finish(true, message)
    }

    protected fail (message: string): void {
        if (this.settled || this.failing) return
        this.failing = true
        if (this.timer) clearTimeout(this.timer)
        const errorPacket = createError(1, message)
        this.socket.send(errorPacket, this.remote.port, this.remote.address, () => this.finish(false, message))
    }

    private async handleMessage (message: Buffer, remote: RemoteInfo): Promise<void> {
        if (this.settled) return
        if (remote.address !== this.remote.address || remote.port !== this.remote.port) {
            const errorPacket = createError(5, 'Unknown transfer ID')
            this.socket.send(errorPacket, remote.port, remote.address)
            return
        }
        const packet = parsePacket(message)
        if (packet.opcode === Opcode.ERROR) throw new Error(`客户端错误 ${packet.code}: ${packet.message}`)
        await this.onPacket(packet)
    }

    private retry (): void {
        if (this.settled) return
        if (!this.lastPacket || this.retryCount >= this.options.retries) {
            this.fail(`等待客户端响应超时，已重试 ${this.options.retries} 次`)
            return
        }
        this.retryCount++
        this.socket.send(this.lastPacket, this.remote.port, this.remote.address, error => {
            if (error) this.fail(error.message)
        })
        this.timer = setTimeout(() => this.retry(), this.timeoutMs)
    }

    private finish (successful: boolean, message: string): void {
        if (this.settled) return
        this.settled = true
        if (this.timer) clearTimeout(this.timer)
        this.release(successful)
            .catch(() => undefined)
            .finally(() => {
                try { this.socket.close() } catch { }
                this.onFinish(successful, message, this.transferred)
            })
    }
}

class ReadTransfer extends ServerTransfer {
    private file: FileHandle | null = null
    private fileSize = 0
    private position = 0
    private currentBlock = 0
    private currentData = Buffer.alloc(0)
    private finalBlock = false

    constructor (
        request: TftpRequest,
        remote: RemoteInfo,
        options: NormalizedServerOptions,
        onFinish: (successful: boolean, message: string, bytes: number) => void,
    ) {
        super(request, remote, options, onFinish)
    }

    protected async begin (): Promise<void> {
        const filePath = resolveRequestedFile(this.options.rootDirectory, this.request.filename)
        const stat = await fs.promises.stat(filePath)
        if (!stat.isFile()) throw new Error('请求路径不是普通文件')
        this.fileSize = stat.size
        this.file = await fs.promises.open(filePath, 'r')

        const negotiated: Record<string, string | number> = {}
        if (this.request.options.blksize !== undefined) {
            const requested = Number(this.request.options.blksize)
            if (!Number.isInteger(requested) || requested < 8 || requested > 65464) throw new Error('客户端请求了无效的块大小')
            this.blockSize = Math.min(requested, this.options.blockSize)
            negotiated.blksize = this.blockSize
        }
        if (this.request.options.timeout !== undefined) {
            const timeoutSeconds = Number(this.request.options.timeout)
            if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 255) throw new Error('客户端请求了无效的超时时间')
            this.timeoutMs = timeoutSeconds * 1000
            negotiated.timeout = timeoutSeconds
        }
        if (this.request.options.tsize !== undefined) negotiated.tsize = this.fileSize

        if (Object.keys(negotiated).length) {
            this.sendTracked(createOack(negotiated))
        } else {
            await this.sendNextBlock()
        }
    }

    protected async onPacket (packet: TftpPacket): Promise<void> {
        if (packet.opcode !== Opcode.ACK) return
        if (this.currentBlock === 0 && packet.block === 0) {
            this.clearTimer()
            await this.sendNextBlock()
            return
        }
        if (packet.block === this.currentBlock) {
            this.clearTimer()
            this.transferred += this.currentData.length
            if (this.finalBlock) this.complete(`已发送 ${this.transferred} 字节`)
            else await this.sendNextBlock()
            return
        }
        if (packet.block === ((this.currentBlock - 1) & 0xffff)) this.resendLast()
    }

    protected async release (): Promise<void> {
        if (this.file) await this.file.close()
        this.file = null
    }

    private async sendNextBlock (): Promise<void> {
        const file = this.file
        if (!file) throw new Error('TFTP 文件尚未打开')
        const buffer = Buffer.allocUnsafe(this.blockSize)
        const result = await file.read(buffer, 0, this.blockSize, this.position)
        this.currentData = Buffer.from(buffer.subarray(0, result.bytesRead))
        this.position += result.bytesRead
        this.currentBlock = (this.currentBlock + 1) & 0xffff
        this.finalBlock = result.bytesRead < this.blockSize
        this.sendTracked(createData(this.currentBlock, this.currentData))
    }
}

export class TftpServer {
    private listener: Socket | null = null
    private options: NormalizedServerOptions | null = null
    private readonly transfers = new Map<string, ServerTransfer>()
    private autoStopTimer: ReturnType<typeof setTimeout> | null = null
    private eventHandler: ((event: TftpServerEvent) => void) | null = null

    get running (): boolean {
        return this.listener !== null
    }

    get activeTransfers (): number {
        return this.transfers.size
    }

    async start (serverOptions: TftpServerOptions, onEvent?: (event: TftpServerEvent) => void): Promise<void> {
        if (this.running) throw new Error('TFTP 服务端已经在运行')
        const options = normalizeOptions(serverOptions)
        const stat = await fs.promises.stat(options.rootDirectory)
        if (!stat.isDirectory()) throw new Error('TFTP 根目录无效')

        this.options = options
        this.eventHandler = onEvent ?? null
        const listener = dgram.createSocket('udp4')
        this.listener = listener
        listener.on('message', (message, remote) => this.handleRequest(message, remote))

        let rejectBinding: ((error: Error) => void) | null = null
        listener.on('error', error => {
            if (rejectBinding) {
                const reject = rejectBinding
                rejectBinding = null
                try { listener.close() } catch { }
                this.listener = null
                reject(error)
            } else {
                this.emit('error', error.message)
            }
        })
        await new Promise<void>((resolve, reject) => {
            rejectBinding = reject
            listener.bind(options.port, options.bindAddress, () => {
                rejectBinding = null
                resolve()
            })
        })

        this.emit('started', `TFTP 服务端已启动：${options.bindAddress}:${options.port}`)
        if (options.autoStopSeconds > 0) {
            this.autoStopTimer = setTimeout(() => this.stop('达到自动停止时间'), options.autoStopSeconds * 1000)
        }
    }

    stop (reason = '用户停止'): void {
        if (!this.listener) return
        if (this.autoStopTimer) clearTimeout(this.autoStopTimer)
        this.autoStopTimer = null
        for (const transfer of this.transfers.values()) transfer.cancel()
        this.transfers.clear()
        try { this.listener.close() } catch { }
        this.listener = null
        this.emit('stopped', `TFTP 服务端已停止：${reason}`)
    }

    private handleRequest (message: Buffer, remote: RemoteInfo): void {
        if (!this.listener || !this.options) return
        let request: TftpRequest
        try {
            request = parseRequest(message)
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            this.listener.send(createError(4, reason), remote.port, remote.address)
            this.emit('error', `拒绝来自 ${remote.address}:${remote.port} 的无效请求：${reason}`)
            return
        }

        const key = `${remote.address}:${remote.port}:${request.opcode}:${request.filename}`
        const existing = this.transfers.get(key)
        if (existing) {
            existing.resendLast()
            return
        }

        if (request.opcode === Opcode.WRQ) {
            this.listener.send(createError(2, 'Server is read-only'), remote.port, remote.address)
            this.emit('error', `拒绝 ${remote.address}:${remote.port} 上传 ${request.filename}：服务端为只读模式`, remote, request.filename)
            return
        }

        const peer = `${remote.address}:${remote.port}`
        const transfer = new ReadTransfer(request, remote, this.options, (successful, detail, bytes) => {
            this.transfers.delete(key)
            this.emit(successful ? 'completed' : 'error', `${peer} ${successful ? '下载完成' : '下载失败'} ${request.filename}：${detail}`, remote, request.filename, bytes)
        })
        this.transfers.set(key, transfer)
        this.emit('request', `${peer} 请求下载 ${request.filename}`, remote, request.filename)
        transfer.start()
    }

    private emit (type: TftpServerEventType, message: string, remote?: RemoteInfo, filename?: string, bytes?: number): void {
        this.eventHandler?.({
            type,
            timestamp: Date.now(),
            message,
            peer: remote ? `${remote.address}:${remote.port}` : undefined,
            filename,
            bytes,
            activeTransfers: this.transfers.size,
        })
    }
}
