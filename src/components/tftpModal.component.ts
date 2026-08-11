import { ChangeDetectorRef, Component, NgZone, OnDestroy, OnInit } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { Subscription } from 'rxjs'
import { ConfigService } from 'tabby-core'

import { defaultTftpServerSettings, defaultTftpSettings, TftpPluginSettings } from '../config'
import { TftpService } from '../services/tftp.service'
import { TftpProgress } from '../tftp/client'

@Component({
    selector: 'tabby-tftp-modal',
    template: `
        <div class="modal-header">
            <h5 class="modal-title"><i class="fa fa-exchange-alt mr-2"></i>TFTP 文件传输与固件服务</h5>
            <button type="button" class="close" aria-label="关闭" (click)="activeModal.dismiss()">
                <span aria-hidden="true">&times;</span>
            </button>
        </div>

        <div class="mode-tabs px-3 pt-3">
            <div class="btn-group w-100">
                <button class="btn" [class.btn-primary]="mode === 'server'" [class.btn-outline-secondary]="mode !== 'server'" (click)="mode = 'server'">
                    <i class="fa fa-server mr-1"></i>固件 TFTP 服务端
                </button>
                <button class="btn" [class.btn-primary]="mode === 'client'" [class.btn-outline-secondary]="mode !== 'client'" (click)="mode = 'client'">
                    <i class="fa fa-exchange-alt mr-1"></i>TFTP 客户端
                </button>
            </div>
        </div>

        <div class="modal-body" *ngIf="mode === 'server'">
            <tabby-tftp-server></tabby-tftp-server>
        </div>

        <div class="modal-body" *ngIf="mode === 'client'">
            <div class="alert alert-warning py-2 small">
                TFTP 没有身份认证和加密。请仅在可信局域网中使用。
            </div>

            <div class="form-row">
                <div class="form-group col-md-8">
                    <label>主机或 IP 地址</label>
                    <input class="form-control" [(ngModel)]="settings.host" placeholder="例如 192.168.1.10" [disabled]="busy">
                </div>
                <div class="form-group col-md-4">
                    <label>端口</label>
                    <input class="form-control" type="number" min="1" max="65535" [(ngModel)]="settings.port" [disabled]="busy">
                </div>
            </div>

            <div class="form-group">
                <label>远端文件名</label>
                <input class="form-control" [(ngModel)]="settings.remoteFilename"
                    placeholder="下载时必填；上传留空则使用本地文件名" [disabled]="busy">
                <small class="form-text text-muted">TFTP 不支持浏览远端目录，路径格式由服务端决定。</small>
            </div>

            <details class="mb-3">
                <summary class="text-muted">高级选项</summary>
                <div class="form-row mt-2">
                    <div class="form-group col-md-4">
                        <label>块大小</label>
                        <input class="form-control" type="number" min="8" max="65464" [(ngModel)]="settings.blockSize" [disabled]="busy">
                    </div>
                    <div class="form-group col-md-4">
                        <label>超时（毫秒）</label>
                        <input class="form-control" type="number" min="250" max="60000" [(ngModel)]="settings.timeoutMs" [disabled]="busy">
                    </div>
                    <div class="form-group col-md-4">
                        <label>重试次数</label>
                        <input class="form-control" type="number" min="0" max="20" [(ngModel)]="settings.retries" [disabled]="busy">
                    </div>
                </div>
            </details>

            <div class="transfer-status" *ngIf="status">
                <div class="d-flex align-items-center mb-1">
                    <strong>{{ status.direction === 'upload' ? '上传' : '下载' }}</strong>
                    <span class="ml-auto text-muted">{{ formatBytes(status.transferred) }}<span *ngIf="status.total !== undefined"> / {{ formatBytes(status.total) }}</span></span>
                </div>
                <ngb-progressbar [type]="progressType" [value]="percent" [striped]="busy" [animated]="busy"></ngb-progressbar>
                <div class="d-flex small mt-1">
                    <span [class.text-danger]="status.state === 'error'">{{ status.message }}</span>
                    <span class="ml-auto" *ngIf="status.speed > 0">{{ formatBytes(status.speed) }}/s</span>
                </div>
            </div>
            <div class="text-danger mt-2" *ngIf="validationError">{{ validationError }}</div>
        </div>

        <div class="modal-footer">
            <button class="btn btn-outline-secondary" (click)="activeModal.close()">关闭</button>
            <ng-container *ngIf="mode === 'client'">
                <button class="btn btn-outline-danger" *ngIf="busy" (click)="cancel()"><i class="fa fa-stop mr-1"></i>取消传输</button>
                <button class="btn btn-primary" *ngIf="!busy" (click)="upload()"><i class="fa fa-upload mr-1"></i>上传</button>
                <button class="btn btn-success" *ngIf="!busy" (click)="download()"><i class="fa fa-download mr-1"></i>下载</button>
            </ng-container>
        </div>
    `,
    styles: [`
        :host { display: block; }
        summary { cursor: pointer; user-select: none; }
        .transfer-status { border: 1px solid rgba(127, 127, 127, .25); border-radius: .25rem; padding: .75rem; }
        .modal-body label { margin-bottom: .25rem; }
        .mode-tabs .btn { flex: 1; }
    `],
})
export class TftpModalComponent implements OnInit, OnDestroy {
    mode: 'server' | 'client' = 'server'
    settings: TftpPluginSettings = { ...defaultTftpSettings, server: { ...defaultTftpServerSettings } }
    status: TftpProgress | null = null
    validationError = ''
    private subscription?: Subscription

    constructor (
        public readonly activeModal: NgbActiveModal,
        private readonly config: ConfigService,
        public readonly tftp: TftpService,
        private readonly zone: NgZone,
        private readonly changeDetector: ChangeDetectorRef,
    ) { }

    get busy (): boolean { return this.tftp.busy }

    get percent (): number {
        if (!this.status) return 0
        if (this.status.state === 'completed') return 100
        if (this.status.total === undefined) return this.busy ? 100 : 0
        if (this.status.total === 0) return 100
        return Math.min(100, Math.round(this.status.transferred * 100 / this.status.total))
    }

    get progressType (): string {
        if (this.status?.state === 'error' || this.status?.state === 'cancelled') return 'danger'
        if (this.status?.state === 'completed') return 'success'
        return 'info'
    }

    ngOnInit (): void {
        const stored = this.config.store.tftp ?? {}
        this.settings = {
            ...defaultTftpSettings,
            ...stored,
            server: { ...defaultTftpServerSettings, ...(stored.server ?? {}) },
        }
        this.subscription = this.tftp.progress$.subscribe(status => {
            this.zone.run(() => {
                this.status = status
                this.changeDetector.markForCheck()
            })
        })
    }

    ngOnDestroy (): void { this.subscription?.unsubscribe() }

    async upload (): Promise<void> {
        if (!this.validate(false)) return
        await this.execute(() => this.tftp.upload(this.settings))
    }

    async download (): Promise<void> {
        if (!this.validate(true)) return
        await this.execute(() => this.tftp.download(this.settings))
    }

    cancel (): void { this.tftp.cancel() }

    formatBytes (value: number): string {
        if (!Number.isFinite(value) || value <= 0) return '0 B'
        const units = ['B', 'KB', 'MB', 'GB', 'TB']
        const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)))
        const amount = value / Math.pow(1024, index)
        return `${amount >= 100 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`
    }

    private async execute (operation: () => Promise<unknown>): Promise<void> {
        this.validationError = ''
        if (!this.config.store.tftp) this.config.store.tftp = {}
        Object.assign(this.config.store.tftp, {
            host: this.settings.host,
            port: this.settings.port,
            remoteFilename: this.settings.remoteFilename,
            blockSize: this.settings.blockSize,
            timeoutMs: this.settings.timeoutMs,
            retries: this.settings.retries,
        })
        await this.config.save()
        try { await operation() } catch (error) {
            this.validationError = error instanceof Error ? error.message : String(error)
        }
    }

    private validate (requireRemoteFilename: boolean): boolean {
        this.validationError = ''
        if (!this.settings.host.trim()) this.validationError = '请填写 TFTP 主机地址'
        else if (requireRemoteFilename && !this.settings.remoteFilename.trim()) this.validationError = '下载时必须填写远端文件名'
        else if (!Number.isInteger(Number(this.settings.port)) || Number(this.settings.port) < 1 || Number(this.settings.port) > 65535) this.validationError = '端口必须在 1 到 65535 之间'
        else if (!Number.isInteger(Number(this.settings.blockSize)) || Number(this.settings.blockSize) < 8 || Number(this.settings.blockSize) > 65464) this.validationError = '块大小必须在 8 到 65464 之间'
        else if (!Number.isInteger(Number(this.settings.timeoutMs)) || Number(this.settings.timeoutMs) < 250 || Number(this.settings.timeoutMs) > 60000) this.validationError = '超时时间必须在 250 到 60000 毫秒之间'
        else if (!Number.isInteger(Number(this.settings.retries)) || Number(this.settings.retries) < 0 || Number(this.settings.retries) > 20) this.validationError = '重试次数必须在 0 到 20 之间'
        return !this.validationError
    }
}
