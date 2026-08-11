import { ConfigProvider } from 'tabby-core'

export interface TftpPluginSettings {
    host: string
    port: number
    remoteFilename: string
    blockSize: number
    timeoutMs: number
    retries: number
    server: TftpServerSettings
}

export interface TftpServerSettings {
    rootDirectory: string
    bindAddress: string
    port: number
    blockSize: number
    timeoutMs: number
    retries: number
    autoStop: boolean
    autoStopSeconds: number
    notifyDownloads: boolean
}

export const defaultTftpServerSettings: TftpServerSettings = {
    rootDirectory: '',
    bindAddress: '0.0.0.0',
    port: 69,
    blockSize: 8192,
    timeoutMs: 3000,
    retries: 5,
    autoStop: false,
    autoStopSeconds: 360,
    notifyDownloads: true,
}

export const defaultTftpSettings: TftpPluginSettings = {
    host: '',
    port: 69,
    remoteFilename: '',
    blockSize: 1468,
    timeoutMs: 3000,
    retries: 5,
    server: { ...defaultTftpServerSettings },
}

export class TftpConfigProvider extends ConfigProvider {
    defaults = {
        tftp: { ...defaultTftpSettings },
    }

    platformDefaults = { }
}
