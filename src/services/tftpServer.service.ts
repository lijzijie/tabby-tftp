import { Injectable } from '@angular/core'
import { BehaviorSubject } from 'rxjs'
import { NotificationsService, PlatformService } from 'tabby-core'
import * as os from 'os'

import { TftpServerSettings } from '../config'
import { TftpServer, TftpServerEvent } from '../tftp/server'

export interface TftpServerLog {
    timestamp: number
    level: 'info' | 'success' | 'error'
    message: string
}

export interface TftpServerState {
    running: boolean
    activeTransfers: number
    startedAt?: number
    logs: TftpServerLog[]
}

const sharedServer = new TftpServer()
const sharedState$ = new BehaviorSubject<TftpServerState>({
    running: false,
    activeTransfers: 0,
    logs: [],
})
let sharedSettings: TftpServerSettings | null = null

@Injectable()
export class TftpServerService {
    readonly state$ = sharedState$
    private readonly server = sharedServer

    constructor (
        private readonly notifications: NotificationsService,
        private readonly platform: PlatformService,
    ) { }

    get running (): boolean {
        return this.server.running
    }

    get activeSettings (): TftpServerSettings | null {
        return sharedSettings ? { ...sharedSettings } : null
    }

    getLocalIPv4Addresses (): string[] {
        const addresses = new Set<string>()
        const interfaces = os.networkInterfaces()
        for (const entries of Object.values(interfaces)) {
            for (const entry of entries ?? []) {
                if (entry.family === 'IPv4' && !entry.internal) addresses.add(entry.address)
            }
        }
        return Array.from(addresses).sort()
    }

    async chooseRootDirectory (): Promise<string | null> {
        const remote = require('@electron/remote')
        const result = await remote.dialog.showOpenDialog({
            title: '选择 TFTP 根目录',
            properties: ['openDirectory', 'createDirectory'],
        })
        return result.canceled ? null : (result.filePaths[0] ?? null)
    }

    openRootDirectory (directory: string): void {
        if (directory) this.platform.openPath(directory)
    }

    copyAddress (address: string): void {
        this.platform.setClipboard({ text: address })
        this.notifications.notice(`已复制本机 IP：${address}`)
    }

    async start (settings: TftpServerSettings): Promise<void> {
        sharedSettings = { ...settings }
        try {
            await this.server.start({
                rootDirectory: settings.rootDirectory,
                bindAddress: settings.bindAddress,
                port: Number(settings.port),
                blockSize: Number(settings.blockSize),
                timeoutMs: Number(settings.timeoutMs),
                retries: Number(settings.retries),
                autoStopSeconds: settings.autoStop ? Number(settings.autoStopSeconds) : 0,
            }, event => this.handleEvent(event))
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            this.appendLog('error', `启动失败：${reason}`)
            this.notifications.error('TFTP 服务端启动失败', reason)
            throw error
        }
    }

    stop (): void {
        this.server.stop()
    }

    clearLogs (): void {
        this.state$.next({ ...this.state$.value, logs: [] })
    }

    private handleEvent (event: TftpServerEvent): void {
        const level: TftpServerLog['level'] = event.type === 'completed' ? 'success' : event.type === 'error' ? 'error' : 'info'
        const current = this.state$.value
        const running = event.type === 'started' ? true : event.type === 'stopped' ? false : this.server.running
        const next: TftpServerState = {
            running,
            activeTransfers: event.activeTransfers,
            startedAt: event.type === 'started' ? event.timestamp : current.startedAt,
            logs: [...current.logs, { timestamp: event.timestamp, level, message: event.message }].slice(-300),
        }
        this.state$.next(next)

        if (event.type === 'completed' && sharedSettings?.notifyDownloads) {
            this.notifications.notice(`TFTP 下载完成：${event.filename ?? ''}`)
        } else if (event.type === 'stopped') {
            this.notifications.info('TFTP 服务端已停止')
        }
    }

    private appendLog (level: TftpServerLog['level'], message: string): void {
        const current = this.state$.value
        this.state$.next({
            ...current,
            logs: [...current.logs, { timestamp: Date.now(), level, message }].slice(-300),
        })
    }
}
