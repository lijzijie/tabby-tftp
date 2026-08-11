import { ChangeDetectorRef, Component, NgZone, OnDestroy, OnInit } from '@angular/core'
import { Subscription } from 'rxjs'
import { ConfigService } from 'tabby-core'

import { defaultTftpServerSettings, TftpServerSettings } from '../config'
import { TftpServerService, TftpServerState } from '../services/tftpServer.service'

const serverSettingsStorageKey = 'tabby-tftp-server-settings-v1'

@Component({
    selector: 'tabby-tftp-server',
    template: `
        <div class="alert alert-info py-2 small">
            串口负责给 Bootloader 下命令；本服务端通过网口向设备提供固件。服务端为只读模式，设备不能覆盖电脑文件。
        </div>

        <div class="form-group">
            <label>TFTP 根目录</label>
            <div class="input-group">
                <input class="form-control" [(ngModel)]="settings.rootDirectory" placeholder="固件所在目录" [disabled]="state.running">
                <div class="input-group-append">
                    <button class="btn btn-outline-secondary" (click)="chooseDirectory()" [disabled]="state.running" title="选择目录">
                        <i class="fa fa-folder-open"></i>
                    </button>
                    <button class="btn btn-outline-secondary" (click)="server.openRootDirectory(settings.rootDirectory)" [disabled]="!settings.rootDirectory" title="打开目录">
                        <i class="fa fa-external-link-alt"></i>
                    </button>
                </div>
            </div>
        </div>

        <div class="form-row">
            <div class="form-group col-md-5">
                <label>监听地址</label>
                <select class="form-control" [(ngModel)]="settings.bindAddress" [disabled]="state.running">
                    <option value="0.0.0.0">0.0.0.0（所有网卡）</option>
                    <option *ngFor="let address of localAddresses" [value]="address">{{ address }}</option>
                </select>
            </div>
            <div class="form-group col-md-3">
                <label>监听端口</label>
                <input class="form-control" type="number" min="1" max="65535" [(ngModel)]="settings.port" [disabled]="state.running">
            </div>
            <div class="form-group col-md-4">
                <label>TFTP 缓冲区</label>
                <div class="input-group">
                    <input class="form-control" type="number" min="8" max="65464" [(ngModel)]="settings.blockSize" [disabled]="state.running">
                    <div class="input-group-append"><span class="input-group-text">Bytes</span></div>
                </div>
            </div>
        </div>

        <div class="local-addresses mb-3">
            <span class="text-muted mr-2">设备可访问的本机 IP：</span>
            <button class="btn btn-sm btn-outline-info mr-1" *ngFor="let address of localAddresses" (click)="server.copyAddress(address)" title="点击复制">
                {{ address }}
            </button>
            <span class="text-warning small" *ngIf="!localAddresses.length">未检测到可用 IPv4 地址</span>
        </div>

        <div class="form-row align-items-center mb-3">
            <div class="col-md-5">
                <div class="custom-control custom-checkbox">
                    <input type="checkbox" class="custom-control-input" id="tftp-auto-stop" [(ngModel)]="settings.autoStop" [disabled]="state.running">
                    <label class="custom-control-label" for="tftp-auto-stop">自动停止服务端</label>
                </div>
            </div>
            <div class="col-md-3">
                <div class="input-group input-group-sm">
                    <input class="form-control" type="number" min="1" max="86400" [(ngModel)]="settings.autoStopSeconds" [disabled]="state.running || !settings.autoStop">
                    <div class="input-group-append"><span class="input-group-text">秒</span></div>
                </div>
            </div>
            <div class="col-md-4">
                <div class="custom-control custom-checkbox">
                    <input type="checkbox" class="custom-control-input" id="tftp-notify" [(ngModel)]="settings.notifyDownloads">
                    <label class="custom-control-label" for="tftp-notify">下载完成后通知</label>
                </div>
            </div>
        </div>

        <details class="mb-3">
            <summary class="text-muted">可靠性选项</summary>
            <div class="form-row mt-2">
                <div class="form-group col-md-6">
                    <label>响应超时（毫秒）</label>
                    <input class="form-control" type="number" min="250" max="60000" [(ngModel)]="settings.timeoutMs" [disabled]="state.running">
                </div>
                <div class="form-group col-md-6">
                    <label>重试次数</label>
                    <input class="form-control" type="number" min="0" max="20" [(ngModel)]="settings.retries" [disabled]="state.running">
                </div>
            </div>
        </details>

        <div class="d-flex align-items-center mb-2">
            <span class="status-dot mr-2" [class.running]="state.running"></span>
            <strong>{{ state.running ? 'TFTP 服务端运行中' : 'TFTP 服务端已停止' }}</strong>
            <span class="badge badge-info ml-2" *ngIf="state.activeTransfers">{{ state.activeTransfers }} 个传输</span>
            <div class="ml-auto">
                <button class="btn btn-sm btn-link text-muted" (click)="server.clearLogs()" [disabled]="!state.logs.length">清空日志</button>
                <button class="btn btn-success ml-1" *ngIf="!state.running" (click)="start()" [disabled]="starting">
                    <i class="fa fa-play mr-1"></i>{{ starting ? '启动中…' : '启动服务端' }}
                </button>
                <button class="btn btn-danger ml-1" *ngIf="state.running" (click)="server.stop()">
                    <i class="fa fa-stop mr-1"></i>停止服务端
                </button>
            </div>
        </div>

        <div class="server-log">
            <div *ngIf="!state.logs.length" class="text-muted">服务端输出将显示在这里</div>
            <div *ngFor="let log of state.logs" [class.text-success]="log.level === 'success'" [class.text-danger]="log.level === 'error'">
                [{{ formatTime(log.timestamp) }}] {{ log.message }}
            </div>
        </div>
        <div class="text-danger mt-2" *ngIf="error">{{ error }}</div>
    `,
    styles: [`
        :host { display: block; }
        label { margin-bottom: .25rem; }
        summary { cursor: pointer; user-select: none; }
        .local-addresses { min-height: 31px; display: flex; align-items: center; flex-wrap: wrap; }
        .status-dot { width: 10px; height: 10px; border-radius: 50%; background: #6c757d; display: inline-block; }
        .status-dot.running { background: #28a745; box-shadow: 0 0 7px rgba(40, 167, 69, .8); }
        .server-log { height: 175px; overflow: auto; padding: .65rem; border: 1px solid rgba(127, 127, 127, .3); border-radius: .25rem; background: rgba(0, 0, 0, .18); font-family: Consolas, monospace; font-size: 12px; white-space: pre-wrap; }
    `],
})
export class TftpServerComponent implements OnInit, OnDestroy {
    settings: TftpServerSettings = { ...defaultTftpServerSettings }
    state: TftpServerState = { running: false, activeTransfers: 0, logs: [] }
    localAddresses: string[] = []
    starting = false
    error = ''

    private subscription?: Subscription

    constructor (
        private readonly config: ConfigService,
        public readonly server: TftpServerService,
        private readonly zone: NgZone,
        private readonly changeDetector: ChangeDetectorRef,
    ) { }

    ngOnInit (): void {
        let cached: Partial<TftpServerSettings> = {}
        try {
            cached = JSON.parse(localStorage.getItem(serverSettingsStorageKey) ?? '{}')
        } catch { }
        this.settings = {
            ...defaultTftpServerSettings,
            ...(this.config.store.tftp?.server ?? {}),
            ...cached,
            ...(this.server.activeSettings ?? {}),
        }
        this.localAddresses = this.server.getLocalIPv4Addresses()
        this.subscription = this.server.state$.subscribe(state => {
            this.zone.run(() => {
                this.state = state
                this.changeDetector.markForCheck()
            })
        })
    }

    ngOnDestroy (): void {
        this.subscription?.unsubscribe()
    }

    async chooseDirectory (): Promise<void> {
        const directory = await this.server.chooseRootDirectory()
        if (directory) {
            this.settings.rootDirectory = directory
            await this.saveSettings()
        }
    }

    async start (): Promise<void> {
        this.error = ''
        if (!this.validate()) return
        this.starting = true
        await this.saveSettings()
        try {
            await this.server.start(this.settings)
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error)
        } finally {
            this.starting = false
        }
    }

    formatTime (timestamp: number): string {
        return new Date(timestamp).toLocaleTimeString(undefined, { hour12: false })
    }

    private validate (): boolean {
        if (!this.settings.rootDirectory.trim()) this.error = '请选择固件所在的 TFTP 根目录'
        else if (!Number.isInteger(Number(this.settings.port)) || Number(this.settings.port) < 1 || Number(this.settings.port) > 65535) this.error = '监听端口必须在 1 到 65535 之间'
        else if (!Number.isInteger(Number(this.settings.blockSize)) || Number(this.settings.blockSize) < 8 || Number(this.settings.blockSize) > 65464) this.error = 'TFTP 缓冲区必须在 8 到 65464 字节之间'
        else if (this.settings.autoStop && (!Number.isInteger(Number(this.settings.autoStopSeconds)) || Number(this.settings.autoStopSeconds) < 1 || Number(this.settings.autoStopSeconds) > 86400)) this.error = '自动停止时间必须在 1 到 86400 秒之间'
        return !this.error
    }

    private async saveSettings (): Promise<void> {
        localStorage.setItem(serverSettingsStorageKey, JSON.stringify(this.settings))
        if (!this.config.store.tftp) this.config.store.tftp = {}
        if (!this.config.store.tftp.server) this.config.store.tftp.server = {}
        Object.assign(this.config.store.tftp.server, this.settings)
        await this.config.save()
    }
}
