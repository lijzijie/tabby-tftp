import * as dgram from 'dgram'
import { RemoteInfo, Socket } from 'dgram'

import {
    Opcode,
    TftpPacket,
    createAck,
    createData,
    createError,
    createRequest,
    parseNegotiatedBlockSize,
    parsePacket,
    parseTransferSize,
} from './protocol'

export interface TftpClientOptions {
    host: string
    port?: number
    remoteFilename: string
    blockSize?: number
    timeoutMs?: number
    retries?: number
}

interface NormalizedOptions {
    host: string
    port: number
    remoteFilename: string
    blockSize: number
    timeoutMs: number
    retries: number
}

export type TransferDirection = 'upload' | 'download'
export type TransferState = 'idle' | 'negotiating' | 'transferring' | 'retrying' | 'completed' | 'cancelled' | 'error'

export interface TftpProgress {
    direction: TransferDirection
    state: TransferState
    transferred: number
    total?: number
    speed: number
    attempt?: number
    message?: string
}

export interface TftpResult {
    bytes: number
    blockSize: number
    durationMs: number
}

export interface UploadSource {
    readonly size: number
    read (maximumBytes: number): Promise<Buffer>
    close (): void
    abort? (): void
    isCancelled? (): boolean
}

export interface DownloadSink {
    write (data: Buffer): Promise<void>
    close (): void
    abort? (): void
    isCancelled? (): boolean
}

export type DownloadSinkFactory = (size?: number) => Promise<DownloadSink | null>
export type ProgressHandler = (progress: TftpProgress) => void

function normalizeOptions (options: TftpClientOptions): NormalizedOptions {
    const host = options.host.trim()
    const remoteFilename = options.remoteFilename.trim()
    const port = options.port ?? 69
    const blockSize = options.blockSize ?? 1468
    const timeoutMs = options.timeoutMs ?? 3000
    const retries = options.retries ?? 5

    if (!host) throw new Error('TFTP 主机不能为空')
    if (!remoteFilename) throw new Error('远端文件名不能为空')
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('TFTP 端口必须在 1 到 65535 之间')
    if (!Number.isInteger(blockSize) || blockSize < 8 || blockSize > 65464) throw new Error('TFTP 块大小必须在 8 到 65464 之间')
    if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 60000) throw new Error('超时时间必须在 250 到 60000 毫秒之间')
    if (!Number.isInteger(retries) || retries < 0 || retries > 20) throw new Error('重试次数必须在 0 到 20 之间')

    return { host, remoteFilename, port, blockSize, timeoutMs, retries }
}

function abortError (): Error {
    const error = new Error('传输已取消')
    error.name = 'AbortError'
    return error
}

abstract class TransferSession {
    protected readonly socket: Socket
    protected readonly startedAt = Date.now()
    protected transferred = 0
    protected negotiatedBlockSize = 512

    private endpoint: { address: string; port: number } | null = null
    private lastPacket: Buffer | null = null
    private lastTarget: { address: string; port: number } | null = null
    private retryCount = 0
    private retryTimer: ReturnType<typeof setTimeout> | null = null
    private cancelPoll: ReturnType<typeof setInterval> | null = null
    private settled = false
    private queue = Promise.resolve()
    private resolvePromise!: (result: TftpResult) => void
    private rejectPromise!: (error: Error) => void

    protected constructor (
        protected readonly direction: TransferDirection,
        protected readonly options: NormalizedOptions,
        protected readonly signal?: AbortSignal,
        protected readonly onProgress?: ProgressHandler,
    ) {
        this.socket = dgram.createSocket('udp4')
    }

    protected runSession (initialPacket: Buffer): Promise<TftpResult> {
        const result = new Promise<TftpResult>((resolve, reject) => {
            this.resolvePromise = resolve
            this.rejectPromise = reject
        })

        this.socket.on('error', error => this.fail(error))
        this.socket.on('message', (message, remote) => {
            this.queue = this.queue
                .then(() => this.handleMessage(message, remote))
                .catch(error => this.fail(error instanceof Error ? error : new Error(String(error))))
        })
        this.signal?.addEventListener('abort', () => this.fail(abortError()), { once: true })
        this.cancelPoll = setInterval(() => {
            if (this.resourceCancelled()) this.fail(abortError())
        }, 250)

        this.emit('negotiating', '正在连接 TFTP 服务端')
        this.sendTracked(initialPacket, { address: this.options.host, port: this.options.port })
        return result
    }

    protected abstract onPacket (packet: TftpPacket): Promise<void>
    protected abstract releaseResource (successful: boolean): void
    protected abstract resourceCancelled (): boolean

    protected clearRetryTimer (): void {
        if (this.retryTimer) clearTimeout(this.retryTimer)
        this.retryTimer = null
        this.retryCount = 0
    }

    protected sendTracked (packet: Buffer, explicitTarget?: { address: string; port: number }): void {
        if (this.settled) return
        const target = explicitTarget ?? this.endpoint ?? { address: this.options.host, port: this.options.port }
        this.lastPacket = Buffer.from(packet)
        this.lastTarget = target
        if (this.retryTimer) clearTimeout(this.retryTimer)
        this.socket.send(packet, target.port, target.address, error => {
            if (error) this.fail(error)
        })
        this.retryTimer = setTimeout(() => this.retryLastPacket(), this.options.timeoutMs)
    }

    protected sendUntracked (
        packet: Buffer,
        explicitTarget?: { address: string; port: number },
        sent?: () => void,
    ): void {
        if (this.settled) return
        const target = explicitTarget ?? this.endpoint ?? { address: this.options.host, port: this.options.port }
        this.socket.send(packet, target.port, target.address, error => {
            if (error) this.fail(error)
            else sent?.()
        })
    }

    protected emit (state: TransferState, message?: string, total?: number): void {
        const duration = Math.max(1, Date.now() - this.startedAt)
        this.onProgress?.({
            direction: this.direction,
            state,
            transferred: this.transferred,
            total,
            speed: this.transferred * 1000 / duration,
            attempt: state === 'retrying' ? this.retryCount : undefined,
            message,
        })
    }

    protected succeed (): void {
        if (this.settled) return
        this.settled = true
        this.cleanupTimers()
        this.releaseResource(true)
        this.socket.close()
        const result = {
            bytes: this.transferred,
            blockSize: this.negotiatedBlockSize,
            durationMs: Date.now() - this.startedAt,
        }
        this.emit('completed', '传输完成', this.transferred)
        this.resolvePromise(result)
    }

    protected fail (error: Error): void {
        if (this.settled) return
        this.settled = true
        this.cleanupTimers()
        this.releaseResource(false)
        try {
            this.socket.close()
        } catch { }
        this.emit(error.name === 'AbortError' ? 'cancelled' : 'error', error.message)
        this.rejectPromise(error)
    }

    private async handleMessage (message: Buffer, remote: RemoteInfo): Promise<void> {
        if (this.settled) return
        if (this.signal?.aborted || this.resourceCancelled()) throw abortError()

        if (this.endpoint && (remote.address !== this.endpoint.address || remote.port !== this.endpoint.port)) {
            this.sendUntracked(createError(5, 'Unknown transfer ID'), { address: remote.address, port: remote.port })
            return
        }

        const packet = parsePacket(message)
        if (!this.endpoint) this.endpoint = { address: remote.address, port: remote.port }
        if (packet.opcode === Opcode.ERROR) {
            throw new Error(`TFTP 错误 ${packet.code}: ${packet.message}`)
        }
        await this.onPacket(packet)
    }

    private retryLastPacket (): void {
        if (this.settled) return
        if (this.signal?.aborted || this.resourceCancelled()) {
            this.fail(abortError())
            return
        }
        if (!this.lastPacket || !this.lastTarget || this.retryCount >= this.options.retries) {
            this.fail(new Error(`TFTP 响应超时，已重试 ${this.options.retries} 次`))
            return
        }

        this.retryCount++
        this.emit('retrying', `响应超时，正在进行第 ${this.retryCount} 次重试`)
        this.socket.send(this.lastPacket, this.lastTarget.port, this.lastTarget.address, error => {
            if (error) this.fail(error)
        })
        this.retryTimer = setTimeout(() => this.retryLastPacket(), this.options.timeoutMs)
    }

    private cleanupTimers (): void {
        if (this.retryTimer) clearTimeout(this.retryTimer)
        if (this.cancelPoll) clearInterval(this.cancelPoll)
        this.retryTimer = null
        this.cancelPoll = null
    }
}

class DownloadSession extends TransferSession {
    private expectedBlock = 1
    private sink: DownloadSink | null = null
    private totalSize: number | undefined

    constructor (
        options: NormalizedOptions,
        private readonly sinkFactory: DownloadSinkFactory,
        signal?: AbortSignal,
        onProgress?: ProgressHandler,
    ) {
        super('download', options, signal, onProgress)
    }

    run (): Promise<TftpResult> {
        const timeoutSeconds = Math.max(1, Math.min(255, Math.round(this.options.timeoutMs / 1000)))
        return this.runSession(createRequest(Opcode.RRQ, this.options.remoteFilename, {
            blksize: this.options.blockSize,
            timeout: timeoutSeconds,
            tsize: 0,
        }))
    }

    protected async onPacket (packet: TftpPacket): Promise<void> {
        if (packet.opcode === Opcode.OACK) {
            if (this.expectedBlock !== 1 || this.transferred !== 0) return
            this.clearRetryTimer()
            this.negotiatedBlockSize = parseNegotiatedBlockSize(packet.options)
            this.totalSize = parseTransferSize(packet.options)
            await this.ensureSink(this.totalSize)
            this.emit('transferring', '已协商传输参数', this.totalSize)
            this.sendTracked(createAck(0))
            return
        }
        if (packet.opcode !== Opcode.DATA) return

        if (packet.block === this.expectedBlock) {
            this.clearRetryTimer()
            if (!this.sink) {
                this.negotiatedBlockSize = 512
                await this.ensureSink(undefined)
            }
            await this.sink!.write(packet.data)
            this.transferred += packet.data.length
            this.emit('transferring', `正在接收块 ${packet.block}`, this.totalSize)

            const finalBlock = packet.data.length < this.negotiatedBlockSize
            const acknowledgement = createAck(packet.block)
            if (finalBlock) {
                this.sendUntracked(acknowledgement, undefined, () => this.succeed())
            } else {
                this.expectedBlock = (this.expectedBlock + 1) & 0xffff
                this.sendTracked(acknowledgement)
            }
            return
        }

        const previousBlock = (this.expectedBlock - 1) & 0xffff
        if (packet.block === previousBlock) {
            this.sendTracked(createAck(packet.block))
        }
    }

    protected releaseResource (successful: boolean): void {
        if (!this.sink) return
        if (successful) this.sink.close()
        else if (this.sink.abort) this.sink.abort()
        else this.sink.close()
    }

    protected resourceCancelled (): boolean {
        return this.sink?.isCancelled?.() ?? false
    }

    private async ensureSink (size?: number): Promise<void> {
        if (this.sink) return
        this.sink = await this.sinkFactory(size)
        if (!this.sink) throw abortError()
    }
}

class UploadSession extends TransferSession {
    private nextBlock = 1
    private currentBlock: number | null = null
    private currentData = Buffer.alloc(0)
    private currentFinal = false

    constructor (
        options: NormalizedOptions,
        private readonly source: UploadSource,
        signal?: AbortSignal,
        onProgress?: ProgressHandler,
    ) {
        super('upload', options, signal, onProgress)
    }

    run (): Promise<TftpResult> {
        const timeoutSeconds = Math.max(1, Math.min(255, Math.round(this.options.timeoutMs / 1000)))
        return this.runSession(createRequest(Opcode.WRQ, this.options.remoteFilename, {
            blksize: this.options.blockSize,
            timeout: timeoutSeconds,
            tsize: this.source.size,
        }))
    }

    protected async onPacket (packet: TftpPacket): Promise<void> {
        if (packet.opcode === Opcode.OACK && this.currentBlock === null) {
            this.clearRetryTimer()
            this.negotiatedBlockSize = parseNegotiatedBlockSize(packet.options)
            this.emit('transferring', '已协商传输参数', this.source.size)
            await this.sendNextBlock()
            return
        }

        if (packet.opcode !== Opcode.ACK) return
        if (packet.block === 0 && this.currentBlock === null) {
            this.clearRetryTimer()
            this.negotiatedBlockSize = 512
            this.emit('transferring', '服务端使用标准 512 字节块', this.source.size)
            await this.sendNextBlock()
            return
        }

        if (this.currentBlock !== null && packet.block === this.currentBlock) {
            this.clearRetryTimer()
            this.transferred += this.currentData.length
            this.emit('transferring', `服务端已确认块 ${packet.block}`, this.source.size)
            if (this.currentFinal) {
                this.succeed()
            } else {
                this.nextBlock = (this.nextBlock + 1) & 0xffff
                await this.sendNextBlock()
            }
            return
        }

        if (this.currentBlock !== null && packet.block === ((this.currentBlock - 1) & 0xffff)) {
            this.sendTracked(createData(this.currentBlock, this.currentData))
        }
    }

    protected releaseResource (successful: boolean): void {
        if (successful) this.source.close()
        else if (this.source.abort) this.source.abort()
        else this.source.close()
    }

    protected resourceCancelled (): boolean {
        return this.source.isCancelled?.() ?? false
    }

    private async sendNextBlock (): Promise<void> {
        if (this.signal?.aborted || this.resourceCancelled()) throw abortError()
        this.currentData = Buffer.from(await this.source.read(this.negotiatedBlockSize))
        if (this.currentData.length > this.negotiatedBlockSize) {
            throw new Error('上传数据源返回的数据超过协商块大小')
        }
        this.currentBlock = this.nextBlock
        this.currentFinal = this.currentData.length < this.negotiatedBlockSize
        this.sendTracked(createData(this.currentBlock, this.currentData))
    }
}

export class TftpClient {
    download (
        options: TftpClientOptions,
        sinkFactory: DownloadSinkFactory,
        signal?: AbortSignal,
        onProgress?: ProgressHandler,
    ): Promise<TftpResult> {
        return new DownloadSession(normalizeOptions(options), sinkFactory, signal, onProgress).run()
    }

    upload (
        options: TftpClientOptions,
        source: UploadSource,
        signal?: AbortSignal,
        onProgress?: ProgressHandler,
    ): Promise<TftpResult> {
        return new UploadSession(normalizeOptions(options), source, signal, onProgress).run()
    }
}
