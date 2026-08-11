import { Injectable } from '@angular/core'
import { BehaviorSubject } from 'rxjs'
import {
    FileDownload,
    FileUpload,
    NotificationsService,
    PlatformService,
} from 'tabby-core'

import { TftpPluginSettings } from '../config'
import {
    DownloadSink,
    TftpClient,
    TftpProgress,
    TftpResult,
    UploadSource,
} from '../tftp/client'

const idleProgress: TftpProgress = {
    direction: 'download',
    state: 'idle',
    transferred: 0,
    speed: 0,
    message: '准备就绪',
}

class TabbyUploadSource implements UploadSource {
    readonly size: number
    private pending = Buffer.alloc(0)
    private ended = false

    constructor (private readonly upload: FileUpload) {
        this.size = upload.getSize()
    }

    async read (maximumBytes: number): Promise<Buffer> {
        while (!this.ended && this.pending.length < maximumBytes) {
            const chunk = await this.upload.read()
            if (!chunk.length) {
                this.ended = true
                break
            }
            this.pending = this.pending.length
                ? Buffer.concat([this.pending, Buffer.from(chunk)])
                : Buffer.from(chunk)
        }

        const result = Buffer.from(this.pending.subarray(0, maximumBytes))
        this.pending = this.pending.subarray(result.length)
        return result
    }

    close (): void {
        this.upload.close()
    }

    abort (): void {
        this.upload.cancel()
    }

    isCancelled (): boolean {
        return this.upload.isCancelled()
    }
}

class TabbyDownloadSink implements DownloadSink {
    private completed = false

    constructor (private readonly download: FileDownload, sizeKnown: boolean) {
        if (!sizeKnown) {
            // Tabby requires a size before the TFTP server has necessarily told us one.
            // Keep the transfer active until close(), then report the actual byte count.
            ;(download as any).getSize = () => this.completed
                ? download.getCompletedBytes()
                : Math.max(1, download.getCompletedBytes() + 1)
        }
    }

    write (data: Buffer): Promise<void> {
        return this.download.write(data)
    }

    close (): void {
        this.completed = true
        this.download.close()
    }

    abort (): void {
        this.download.cancel()
    }

    isCancelled (): boolean {
        return this.download.isCancelled()
    }
}

@Injectable()
export class TftpService {
    readonly progress$ = new BehaviorSubject<TftpProgress>(idleProgress)

    private controller: AbortController | null = null
    private readonly client = new TftpClient()

    constructor (
        private readonly platform: PlatformService,
        private readonly notifications: NotificationsService,
    ) { }

    get busy (): boolean {
        return this.controller !== null
    }

    async upload (settings: TftpPluginSettings): Promise<TftpResult | null> {
        this.ensureIdle()
        const uploads = await this.platform.startUpload({ multiple: false })
        const upload = uploads[0]
        if (!upload) return null

        const remoteFilename = settings.remoteFilename.trim() || upload.getName()
        const source = new TabbyUploadSource(upload)
        return this.run('upload', remoteFilename, controller => this.client.upload(
            this.toClientOptions(settings, remoteFilename),
            source,
            controller.signal,
            progress => this.progress$.next(progress),
        ))
    }

    async download (settings: TftpPluginSettings): Promise<TftpResult | null> {
        this.ensureIdle()
        const remoteFilename = settings.remoteFilename.trim()
        if (!remoteFilename) throw new Error('下载时必须填写远端文件名')

        const localName = remoteFilename.split(/[\\/]/).filter(Boolean).pop() || 'download.bin'
        return this.run('download', remoteFilename, controller => this.client.download(
            this.toClientOptions(settings, remoteFilename),
            async size => {
                const download = await this.platform.startDownload(localName, 0o644, size ?? 1)
                return download ? new TabbyDownloadSink(download, size !== undefined) : null
            },
            controller.signal,
            progress => this.progress$.next(progress),
        ))
    }

    cancel (): void {
        this.controller?.abort()
    }

    private async run (
        direction: 'upload' | 'download',
        filename: string,
        operation: (controller: AbortController) => Promise<TftpResult>,
    ): Promise<TftpResult> {
        this.ensureIdle()
        const controller = new AbortController()
        this.controller = controller
        try {
            const result = await operation(controller)
            this.notifications.notice(`TFTP ${direction === 'upload' ? '上传' : '下载'}完成：${filename}`)
            return result
        } catch (error) {
            const reason = error instanceof Error ? error : new Error(String(error))
            if (reason.name === 'AbortError') {
                this.notifications.info('TFTP 传输已取消')
            } else {
                this.notifications.error('TFTP 传输失败', reason.message)
            }
            throw reason
        } finally {
            if (this.controller === controller) this.controller = null
        }
    }

    private ensureIdle (): void {
        if (this.busy) throw new Error('已有一个 TFTP 传输正在进行')
    }

    private toClientOptions (settings: TftpPluginSettings, remoteFilename: string) {
        return {
            host: settings.host,
            port: Number(settings.port),
            remoteFilename,
            blockSize: Number(settings.blockSize),
            timeoutMs: Number(settings.timeoutMs),
            retries: Number(settings.retries),
        }
    }
}
